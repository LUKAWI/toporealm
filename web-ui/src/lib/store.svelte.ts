// Web 编辑器状态流：把 protocol.ts 的 WebGraphState/ToporealmApi 接入 Svelte 5 runes，
// 供外壳、画布、详情抽屉与面板共享。revision 冲突不静默覆盖——进入 recovery 态等待用户重载。
import {
  GraphApiError,
  ToporealmApi,
  WebGraphState,
  type ActionResult,
  type CanvasSelection,
  type GraphObject,
  type GraphRelation,
  type GraphSnapshot,
  type GraphSummary,
  type GraphValidationResult,
  type HistoryStatus,
  type ModuleStatusResult,
  type MutationPlan,
  type MutationResult,
} from "./protocol";

/** 409 冲突 / patch gap 的可恢复错误态。 */
export interface RecoveryState {
  code: string;
  message: string;
}

export function isRecoverableError(error: unknown): error is GraphApiError {
  return error instanceof GraphApiError && (error.code === "REVISION_CONFLICT" || error.code === "PATCH_GAP");
}

export class WebGraphStore {
  // ── 响应式状态（组件直接读取）──
  snapshot = $state<GraphSnapshot | null>(null);
  history = $state<HistoryStatus>({ canUndo: false, canRedo: false });
  graphs = $state<GraphSummary[]>([]);
  moduleStatus = $state<ModuleStatusResult | null>(null);
  validation = $state<GraphValidationResult | null>(null);
  loading = $state(true);
  error = $state("");
  recovery = $state<RecoveryState | null>(null);
  actionMessage = $state("");
  readOnly = $state(false);
  selection = $state<CanvasSelection | null>(null);
  searchQuery = $state("");
  kindFilter = $state("");

  /** 图切换等需要整页等待的瞬时标记。 */
  switching = $state(false);
  /** Core 写请求在途；与切图互斥，避免全局 activeStore 在请求间被切换。 */
  writing = $state(false);

  /** 视图命令：工具轨缩放按钮 → 画布执行（画布不存在时为 no-op）。 */
  zoomRequest = $state<{ kind: "in" | "out" | "fit"; seq: number } | null>(null);
  /** 视图命令：搜索/图例跳转 → 画布平移居中到目标节点。 */
  locateRequest = $state<{ nodeId: string; seq: number } | null>(null);
  private commandSeq = 0;

  /** 编辑器状态：null = 关闭；mode 决定表单形态，targetId 预填编辑目标或连接 source。 */
  editor = $state<{ mode: "create-object" | "edit-object" | "create-relation" | "edit-relation"; targetId?: string; sourceId?: string } | null>(null);

  openEditor(mode: "create-object" | "edit-object" | "create-relation" | "edit-relation", ids: { targetId?: string; sourceId?: string } = {}): void {
    if (this.readOnly || this.switching) {
      this.actionMessage = this.switching ? "图切换中，编辑已暂时禁用。" : "只读模式已禁用编辑。";
      return;
    }
    this.editor = { mode, ...ids };
  }

  closeEditor(): void {
    this.editor = null;
  }

  requestZoom(kind: "in" | "out" | "fit"): void {
    this.zoomRequest = { kind, seq: ++this.commandSeq };
  }

  locateNode(nodeId: string): void {
    this.locateRequest = { nodeId, seq: ++this.commandSeq };
  }

  private graphState: WebGraphState | null = null;
  private readonly api: Pick<ToporealmApi, "readGraph" | "apply" | "undo" | "redo" | "history" | "listGraphs" | "switchGraph" | "modules" | "executeAction" | "validate" | "validateComplete">;

  constructor(api: Pick<ToporealmApi, "readGraph" | "apply" | "undo" | "redo" | "history" | "listGraphs" | "switchGraph" | "modules" | "executeAction" | "validate" | "validateComplete"> = new ToporealmApi()) {
    this.api = api;
  }

  get revision(): number {
    return this.snapshot?.revision ?? 0;
  }

  get objects(): GraphObject[] {
    return this.snapshot?.objects ?? [];
  }

  get relations(): GraphRelation[] {
    return this.snapshot?.relations ?? [];
  }

  get selectedObject(): GraphObject | undefined {
    return this.selection?.type === "object" ? this.snapshot?.objects.find((object) => object.id === this.selection?.id) : undefined;
  }

  get selectedRelation(): GraphRelation | undefined {
    return this.selection?.type === "relation" ? this.snapshot?.relations.find((relation) => relation.id === this.selection?.id) : undefined;
  }

  select(next: CanvasSelection | null): void {
    this.selection = next;
  }

  clearFilters(): void {
    this.searchQuery = "";
    this.kindFilter = "";
  }

  /** 首次加载；失败时进入错误态（骨架屏退场，给出重试）。 */
  async load(): Promise<void> {
    this.loading = true;
    this.error = "";
    try {
      const next = await this.api.readGraph();
      this.graphState = new WebGraphState(next);
      this.snapshot = this.graphState.snapshot;
      const [history, graphList] = await Promise.all([this.api.history(), this.api.listGraphs()]);
      this.history = history;
      this.graphs = graphList.graphs;
      await this.refreshModules();
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : "图快照读取失败";
    } finally {
      this.loading = false;
    }
  }

  /** 冲突/patch gap 后的重新读取入口：恢复到服务器真相，清除 recovery 态。 */
  async reload(): Promise<void> {
    this.recovery = null;
    await this.load();
  }

  async refreshModules(): Promise<void> {
    try {
      this.moduleStatus = await this.api.modules();
    } catch {
      this.moduleStatus = null;
    }
  }

  async runValidation(mode: "basic" | "complete"): Promise<void> {
    try {
      this.validation = mode === "basic" ? await this.api.validate() : await this.api.validateComplete();
      this.actionMessage = mode === "basic" ? "基础校验完成" : "完整校验完成";
    } catch (cause) {
      this.actionMessage = cause instanceof Error ? cause.message : "校验失败";
    }
  }

  /**
   * 提交编辑计划。带 expectedRevision；冲突/patch gap 时进入 recovery 态并保留本地快照，
   * 同时把错误抛回调用方（表单保留输入）。非恢复类错误原样上抛。
   */
  async commit(plan: MutationPlan): Promise<MutationResult> {
    if (this.readOnly) throw new GraphApiError("READ_ONLY", "只读模式已禁用编辑。", 403);
    if (this.switching) throw new GraphApiError("GRAPH_SWITCHING", "图切换中，不能提交编辑。", 409);
    if (this.writing) throw new GraphApiError("WRITE_IN_PROGRESS", "已有写操作正在进行。", 409);
    if (!this.graphState) throw new GraphApiError("NO_SNAPSHOT", "图快照尚未加载，请先刷新。", 400);
    this.writing = true;
    try {
      let result: MutationResult;
      try {
        result = await this.api.apply({ ...plan, expectedRevision: this.graphState.snapshot.revision });
        this.absorb(result);
      } catch (cause) {
        if (isRecoverableError(cause)) this.recovery = { code: cause.code, message: cause.message };
        throw cause;
      }
      try {
        this.graphs = (await this.api.listGraphs()).graphs;
      } catch {
        // 图列表刷新失败不影响本次提交结果。
      }
      await this.refreshModules();
      return result;
    } finally {
      this.writing = false;
    }
  }

  async undo(): Promise<void> {
    await this.runHistoryAction("undo");
  }

  async redo(): Promise<void> {
    await this.runHistoryAction("redo");
  }

  async switchGraph(id: string): Promise<void> {
    if (!id || id === this.snapshot?.manifest.id || this.switching) return;
    if (this.writing) {
      this.actionMessage = "写操作进行中，暂时不能切换图。";
      return;
    }
    this.switching = true;
    this.error = "";
    // 在切图请求发出前关闭旧图编辑上下文，避免服务端已切换而响应仍在途时
    // 旧表单向新图提交同 revision 的 MutationPlan。
    this.editor = null;
    this.selection = null;
    try {
      const result = await this.api.switchGraph(id);
      this.graphState = new WebGraphState(result.snapshot);
      this.snapshot = this.graphState.snapshot;
      this.history = result.history;
      this.clearFilters();
      this.validation = null;
      this.recovery = null;
      this.graphs = (await this.api.listGraphs()).graphs;
      await this.refreshModules();
      this.actionMessage = `已切换到图 ${this.snapshot.manifest.id}`;
    } catch (cause) {
      this.actionMessage = cause instanceof Error ? cause.message : "图切换失败";
    } finally {
      this.switching = false;
    }
  }

  async executeAction(operation: string, target: string | undefined, input: Record<string, unknown>, registryRevision?: number): Promise<ActionResult> {
    if (this.readOnly) throw new GraphApiError("READ_ONLY", "只读模式已禁用模块动作。", 403);
    if (this.switching) throw new GraphApiError("GRAPH_SWITCHING", "图切换中，不能执行模块动作。", 409);
    if (this.writing) throw new GraphApiError("WRITE_IN_PROGRESS", "已有写操作正在进行。", 409);
    this.writing = true;
    try {
      const result = await this.api.executeAction(operation, target, input, registryRevision);
      if (result.kind === "mutation") {
        try {
          this.absorb(result.mutation);
        } catch (cause) {
          if (isRecoverableError(cause)) this.recovery = { code: cause.code, message: cause.message };
          throw cause;
        }
        try {
          this.graphs = (await this.api.listGraphs()).graphs;
        } catch {
          // 列表刷新失败不影响动作结果。
        }
        await this.refreshModules();
      }
      return result;
    } finally {
      this.writing = false;
    }
  }

  private absorb(result: MutationResult): void {
    this.graphState?.applyPatch(result.patch);
    if (this.graphState) this.snapshot = this.graphState.snapshot;
    this.history = result.history;
  }

  private async runHistoryAction(kind: "undo" | "redo"): Promise<void> {
    this.actionMessage = "";
    if (this.readOnly) {
      this.actionMessage = "只读模式已禁用历史写操作。";
      return;
    }
    if (this.switching || this.writing) {
      this.actionMessage = this.switching ? "图切换中，历史写操作已暂时禁用。" : "已有写操作正在进行。";
      return;
    }
    if (!this.graphState) {
      this.actionMessage = "图快照尚未加载";
      return;
    }
    if ((kind === "undo" && !this.history.canUndo) || (kind === "redo" && !this.history.canRedo)) {
      this.actionMessage = kind === "undo" ? "没有可撤销的操作" : "没有可重做的操作";
      return;
    }
    this.writing = true;
    try {
      const result = kind === "undo" ? await this.api.undo(this.graphState.snapshot.revision) : await this.api.redo(this.graphState.snapshot.revision);
      this.absorb(result);
      this.actionMessage = kind === "undo" ? "已撤销" : "已重做";
    } catch (cause) {
      if (isRecoverableError(cause)) {
        this.recovery = { code: cause.code, message: cause.message };
        this.actionMessage = "";
      } else {
        this.actionMessage = cause instanceof Error ? cause.message : "历史操作失败";
      }
    } finally {
      this.writing = false;
    }
  }
}

export const store = new WebGraphStore();
