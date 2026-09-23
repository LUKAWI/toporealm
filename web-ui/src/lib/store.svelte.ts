// Web 编辑器状态流：把 Session 契约（blueprint §1.1，WsClient 传输）接入 Svelte 5 runes，
// 供外壳、画布、详情抽屉与编辑面板共享。冲突不静默覆盖——IF_REVISION_MISMATCH / 补丁缺口
// 进入 recovery 态全量重读自愈（不变量 I3）；reset 事件（外部编辑/daemon 重启）作废目录
// 缓存并重拉（blueprint §5，D22 裁决③）。
import { WsClient } from "@lukawi/toporealm-client/browser";
import {
  isRecoverableError,
  isRelation,
  PatchGapError,
  WebGraphState,
  type CanvasSelection,
  type Catalog,
  type Change,
  type CommandRunResult,
  type CommitResult,
  type Entity,
  type EntityId,
  type GraphSnapshot,
  type GraphSummary,
  type ReadResult,
  type RelationEntity,
  type Session,
  type TopoEvent,
} from "./protocol";

export { displayOf, titleOf } from "./protocol";

/** 冲突/patch gap 的可恢复错误态。 */
export interface RecoveryState {
  code: string;
  message: string;
}

export type { CanvasSelection, Change, CommandRunResult, Entity, EntityId, GraphSnapshot, GraphSummary, RelationEntity };
export { PatchGapError, WebGraphState };

export class WebGraphStore {
  // ── 响应式状态（组件直接读取）──
  snapshot = $state<GraphSnapshot | null>(null);
  history = $state<{ canUndo: boolean; canRedo: boolean }>({ canUndo: false, canRedo: false });
  /** daemon 命令目录（模块状态 + kinds 投影 + appliesTo 命令；reset 后作废重拉） */
  catalog = $state<Catalog | null>(null);
  loading = $state(true);
  error = $state("");
  recovery = $state<RecoveryState | null>(null);
  actionMessage = $state("");
  readOnly = $state(false);
  selection = $state<CanvasSelection | null>(null);
  searchQuery = $state("");
  kindFilter = $state("");

  /** 图级互斥（1.0 daemon 单图服务，无切图；保留在途写互斥） */
  writing = $state(false);

  /** 视图命令：工具轨缩放按钮 → 画布执行（画布不存在时为 no-op）。 */
  zoomRequest = $state<{ kind: "in" | "out" | "fit"; seq: number } | null>(null);
  /** 视图命令：搜索/图例跳转 → 画布平移居中到目标节点。 */
  locateRequest = $state<{ nodeId: string; seq: number } | null>(null);
  private commandSeq = 0;

  /** 编辑器状态：null = 关闭；mode 决定表单形态，targetId 预填编辑目标或连接 source。 */
  editor = $state<{ mode: "create-object" | "edit-object" | "create-relation" | "edit-relation"; targetId?: string; sourceId?: string } | null>(null);

  openEditor(mode: "create-object" | "edit-object" | "create-relation" | "edit-relation", ids: { targetId?: string; sourceId?: string } = {}): void {
    if (this.readOnly) {
      this.actionMessage = "只读模式已禁用编辑。";
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
  private unsubscribe: (() => void) | null = null;
  private reloading = false;
  private session: Session | null = null;

  /** 会话来源（测试注入缝）；缺省 = 浏览器同源 WS（D22）。 */
  provider: () => Promise<Session> = async () => new WsClient().connect();

  constructor(provider?: () => Promise<Session>) {
    if (provider !== undefined) this.provider = provider;
  }

  get revision(): number {
    return this.snapshot?.revision ?? 0;
  }

  get objects(): readonly Entity[] {
    return this.snapshot?.objects ?? [];
  }

  get relations(): readonly RelationEntity[] {
    return this.snapshot?.relations ?? [];
  }

  get selectedObject(): Entity | undefined {
    return this.selection?.type === "object" ? this.snapshot?.objects.find((object) => object.id === this.selection?.id) : undefined;
  }

  get selectedRelation(): RelationEntity | undefined {
    return this.selection?.type === "relation" ? this.snapshot?.relations.find((relation) => relation.id === this.selection?.id) : undefined;
  }

  select(next: CanvasSelection | null): void {
    this.selection = next;
  }

  clearFilters(): void {
    this.searchQuery = "";
    this.kindFilter = "";
  }

  /** 首次加载：连接 → 全量读取 → 目录；失败进错误态（骨架屏退场，给出重试）。 */
  async load(): Promise<void> {
    this.loading = true;
    this.error = "";
    try {
      this.session = await this.provider();
      const [read, status, catalog] = await Promise.all([
        this.session.read(),
        this.session.status(),
        this.session.catalog(),
      ]);
      this.graphState = new WebGraphState(this.toSnapshot(this.session, read));
      this.snapshot = this.graphState.snapshot;
      this.history = { canUndo: status.canUndo, canRedo: status.canRedo };
      this.catalog = catalog;
      this.recovery = null;
      this.connectEvents();
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : "图快照读取失败";
    } finally {
      this.loading = false;
    }
  }

  /** ReadResult（扁平 entities）→ GraphSnapshot（对象/关系分桶，blueprint §1）。 */
  private toSnapshot(session: Session, read: ReadResult): GraphSnapshot {
    return {
      graphId: session.graphId,
      revision: read.revision,
      objects: read.entities.filter((entity): entity is Entity => !isRelation(entity)),
      relations: read.entities.filter(isRelation),
    };
  }

  /** 冲突/缺口/reset 后的重新读取入口：恢复到 daemon 真相，目录缓存作废重拉，清除 recovery 态。 */
  async reload(): Promise<void> {
    this.recovery = null;
    await this.load();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    void this.session?.close().catch(() => {});
    this.session = null;
  }

  /**
   * 提交变更。带 ifRevision 乐观护航；IF_REVISION_MISMATCH / 本地缺口进入 recovery 态
   * 并保留本地快照，同时把错误抛回调用方（表单保留输入）。非恢复类错误原样上抛。
   */
  async commit(input: { changes: readonly Change[]; label?: string }): Promise<CommitResult> {
    if (this.readOnly) throw Object.assign(new Error("只读模式已禁用编辑。"), { code: "READ_ONLY" });
    if (this.writing) throw Object.assign(new Error("已有写操作正在进行。"), { code: "WRITE_IN_PROGRESS" });
    if (!this.session || !this.graphState) throw Object.assign(new Error("图快照尚未加载，请先刷新。"), { code: "NO_SNAPSHOT" });
    this.writing = true;
    try {
      let result: CommitResult;
      try {
        result = await this.session.commit({
          changes: input.changes,
          ...(input.label !== undefined ? { label: input.label } : {}),
          ifRevision: this.graphState.revision,
        });
        this.absorb(result);
      } catch (cause) {
        if (isRecoverableError(cause)) this.recovery = { code: cause.code, message: cause.message };
        throw cause;
      }
      return result;
    } finally {
      this.writing = false;
    }
  }

  async undo(): Promise<CommitResult | void> {
    return this.runHistoryAction("undo");
  }

  async redo(): Promise<CommitResult | void> {
    return this.runHistoryAction("redo");
  }

  /**
   * 模块命令：目录 id（ns.name）+ 可选 target；返回的 commits 序列按 patch 顺序回灌本地视图。
   */
  async run(commandId: string, opts?: { target?: EntityId; input?: unknown }): Promise<CommandRunResult> {
    if (this.readOnly) throw Object.assign(new Error("只读模式已禁用模块命令。"), { code: "READ_ONLY" });
    if (this.writing) throw Object.assign(new Error("已有写操作正在进行。"), { code: "WRITE_IN_PROGRESS" });
    if (!this.session) throw Object.assign(new Error("图快照尚未加载，请先刷新。"), { code: "NO_SNAPSHOT" });
    this.writing = true;
    try {
      const result = await this.session.run(commandId, opts);
      for (const commit of result.commits ?? []) {
        try {
          this.absorb(commit);
        } catch (cause) {
          if (isRecoverableError(cause)) this.recovery = { code: cause.code, message: cause.message };
          throw cause;
        }
      }
      return result;
    } finally {
      this.writing = false;
    }
  }

  private absorb(result: CommitResult): void {
    if (!this.graphState) return;
    // 自己提交的回执与实时事件双重到达：只应用更新者（先到先得，revision 单调）
    if (result.patch.toRevision > this.graphState.revision) this.graphState.applyPatch(result.patch);
    if (this.graphState) this.snapshot = this.graphState.snapshot;
    this.history = { canUndo: result.canUndo, canRedo: result.canRedo };
  }

  private connectEvents(): void {
    if (!this.session) return;
    this.unsubscribe?.();
    const session = this.session;
    void session
      .events((event) => this.receiveEvent(event), { fromRevision: this.revision })
      .then((un) => {
        if (this.session !== session) un();
        else this.unsubscribe = un;
      })
      .catch(() => {
        /* 事件订阅失败：下一次 reload 重建 */
      });
  }

  private receiveEvent(event: TopoEvent): void {
    if (!this.graphState || !this.snapshot) return;
    if (event.type === "hello") {
      // 订阅锚点（带 fromRevision）：daemon 顶比本地新且没有回放时，靠缺口路径自愈
      return;
    }
    if (event.type === "reset") {
      // 外部编辑 / daemon 重启：目录缓存作废，全量重读自愈（blueprint §5）
      void this.reloadFromEvent(
        event.reason === "external-edit" ? "已采纳外部编辑，读取完整快照。" : "daemon 已重启，目录缓存作废并重新读取。",
      );
      return;
    }
    // commit 事件：补丁缺口 → 全量重读（不变量 I3 自愈）
    if (event.patch.toRevision <= this.revision) return;
    if (event.patch.fromRevision !== this.revision) {
      this.recovery = { code: "PATCH_GAP", message: `实时更新存在版本缺口：当前 r${this.revision}，收到 r${event.patch.fromRevision}。` };
      void this.reloadFromEvent("检测到实时更新缺口，已重新读取完整快照。");
      return;
    }
    try {
      this.graphState.applyPatch(event.patch);
    } catch (cause) {
      if (isRecoverableError(cause)) {
        this.recovery = { code: cause.code, message: cause.message };
        void this.reloadFromEvent("检测到实时更新缺口，已重新读取完整快照。");
      }
      return;
    }
    this.snapshot = this.graphState.snapshot;
    void this.refreshHistory();
  }

  private async reloadFromEvent(message: string): Promise<void> {
    if (this.reloading) return;
    this.reloading = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    try {
      await this.reload();
      if (!this.error) this.actionMessage = message;
    } finally {
      this.reloading = false;
    }
  }

  private async refreshHistory(): Promise<void> {
    if (!this.session) return;
    try {
      const st = await this.session.status();
      this.history = { canUndo: st.canUndo, canRedo: st.canRedo };
    } catch {
      // 历史可用性刷新失败不影响本次事件应用。
    }
  }

  private async runHistoryAction(kind: "undo" | "redo"): Promise<CommitResult | void> {
    this.actionMessage = "";
    if (this.readOnly) {
      this.actionMessage = "只读模式已禁用历史写操作。";
      return;
    }
    if (this.writing) {
      this.actionMessage = "已有写操作正在进行。";
      return;
    }
    if (!this.session || !this.graphState) {
      this.actionMessage = "图快照尚未加载";
      return;
    }
    if ((kind === "undo" && !this.history.canUndo) || (kind === "redo" && !this.history.canRedo)) {
      this.actionMessage = kind === "undo" ? "没有可撤销的操作" : "没有可重做的操作";
      return;
    }
    this.writing = true;
    try {
      const result = kind === "undo" ? await this.session.undo() : await this.session.redo();
      this.absorb(result);
      this.actionMessage = kind === "undo" ? "已撤销" : "已重做";
      return result;
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
