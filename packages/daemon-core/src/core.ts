import fs from "node:fs";
import crypto from "node:crypto";
import {
  TopoError,
  isRelation,
  isValidEntityId,
  isValidKind,
  kindNamespace,
  suggestClosest,
  type AfterCommitEvent,
  type AfterCommitHook,
  type BeforeCommitHook,
  type Catalog,
  type Change,
  type CommitCandidate,
  type CommitInput,
  type CommitResult,
  type Entity,
  type EntityId,
  type EntityRecord,
  type GraphPatch,
  type GraphSnapshot,
  type GraphSummary,
  type Kind,
  type LogEntry,
  type Origin,
  type ReadQuery,
  type ReadResult,
  type RelationEntity,
  type StoredLogEntry,
  type TopoEvent,
  type Unsubscribe,
} from "@lukawi/toporealm-protocol";
import { endpointAddress, graphPaths, type GraphPaths } from "./paths.js";
import {
  appendLogLine,
  createGraphDir,
  loadEntities,
  loadManifest,
  readLog,
  removeEntityFile,
  rewriteLog,
  saveManifest,
  writeEntity,
  type GraphManifestV2,
} from "./store.js";

// ---------- DaemonCore：单属主图内核（blueprint §5 提交管线） ----------
//
// 管线固定序（模块作者唯一需要背的顺序；M1 无模块装载，钩子注册面为空但管线就位）：
//   id/kind 解析 → 所有权法（仅 module 来源）→ 悬空边检查（集合整体）
//   → before-commit 钩子（同步，first-veto 短路，禁再入）
//   → 原子应用 + .log 追加 + 游标维护
//   → after-commit 钩子 → 事件广播（commit 事件，origin 如实）
//
// 红线自查：core 执法仅所有权法 + 悬空边两条；core 不解释 payload；
// 图事实面只有 read / commit / undo / redo（无 validate）。

export interface DaemonCoreOptions {
  root: string;
  graphId: string;
  /** 默认 true：文件监视吸收外部编辑 */
  watch?: boolean;
  /** 活动回调（daemon 入口用于空闲计时） */
  onActivity?: () => void;
}

const EXTERNAL_DEBOUNCE_MS = 120;

export class DaemonCore {
  readonly root: string;
  readonly graphId: string;
  readonly instanceId = crypto.randomUUID();
  /** daemon endpoint（同一 root 恒定；getter 避免字段初始化时序问题） */
  get endpoint(): { transport: "pipe" | "socket"; address: string } {
    return endpointAddress(this.root);
  }
  /** 冷启动装载耗时（ms）——空图硬约束 <100ms 的断言点 */
  loadMs = 0;

  private readonly p: GraphPaths;
  private readonly onActivity: (() => void) | undefined;
  private manifest: GraphManifestV2;
  private objects = new Map<EntityId, Entity>();
  private relations = new Map<EntityId, RelationEntity>();
  private logEntries: StoredLogEntry[] = [];
  /** 游标 = 已应用日志条数；undo/redo 移动游标，不追加日志 */
  private cursor = 0;
  private revision_ = 0;

  private beforeHooks: BeforeCommitHook[] = [];
  private afterHooks: AfterCommitHook[] = [];
  private listeners = new Set<(e: TopoEvent) => void>();
  private watchers: fs.FSWatcher[] = [];
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;
  /** 正在落盘时抑制监视回调（内容比对本身也是安全网） */
  private persistDepth = 0;
  private disposed = false;

  private constructor(opts: DaemonCoreOptions, manifest: GraphManifestV2) {
    this.root = opts.root;
    this.graphId = manifest.id || opts.graphId;
    this.p = graphPaths(opts.root, opts.graphId);
    this.manifest = manifest;
    this.revision_ = manifest.revision;
    this.onActivity = opts.onActivity;
  }

  get revision(): number {
    return this.revision_;
  }

  static async open(opts: DaemonCoreOptions): Promise<DaemonCore> {
    const p = graphPaths(opts.root, opts.graphId);
    const t0 = performance.now();
    const manifest = await loadManifest(p);
    const disk = await loadEntities(p);
    const log = await readLog(p);
    const core = new DaemonCore(opts, manifest);
    core.objects = disk.objects;
    core.relations = disk.relations;
    core.logEntries = log;
    // 游标钳制到合法区间（磁盘被手改时的自愈）
    core.cursor = Math.max(0, Math.min(manifest.undoCursor, log.length));
    core.loadMs = performance.now() - t0;
    if (opts.watch !== false) core.startWatch();
    return core;
  }

  /** 新建图目录（工作区文件层操作，M1 由 CLI 的 new 调用） */
  static async createGraph(
    root: string,
    graphId: string,
    label?: string,
  ): Promise<void> {
    const p = graphPaths(root, graphId);
    await createGraphDir(p, {
      format: "toporealm.graph/v2",
      id: graphId,
      ...(label !== undefined ? { label } : {}),
      revision: 0,
      undoCursor: 0,
      modules: [],
    });
  }

  private touch(): void {
    this.onActivity?.();
  }

  // ---------- 图事实面：read / commit / undo / redo ----------

  status(): GraphSummary {
    this.touch();
    const counts: Record<Kind, number> = {};
    for (const e of this.objects.values())
      counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    for (const r of this.relations.values())
      counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    return {
      graphId: this.graphId,
      revision: this.revision_,
      counts,
      modules: this.manifest.modules,
      canUndo: this.cursor > 0,
      canRedo: this.cursor < this.logEntries.length,
    };
  }

  read(query?: ReadQuery): ReadResult {
    this.touch();
    const ids = query?.ids ? new Set(query.ids) : undefined;
    const kinds = query?.kinds ? new Set(query.kinds) : undefined;
    const where = query?.where ?? [];
    const out: EntityRecord[] = [];
    for (const r of [...this.objects.values(), ...this.relations.values()]) {
      if (ids && !ids.has(r.id)) continue;
      if (kinds && !kinds.has(r.kind)) continue;
      if (!matchWhere(r, where)) continue;
      out.push(project(r, query?.fields));
    }
    return { revision: this.revision_, entities: out };
  }

  /** 提交日志尾读（只返回已应用段；undo/redo 不入日志，D17 裁决②） */
  tailLog(limit = 50): LogEntry[] {
    this.touch();
    const applied = this.logEntries.slice(0, this.cursor);
    const tail = limit > 0 ? applied.slice(-limit) : [];
    return tail.map((e) => ({
      revision: e.revision,
      kind: e.kind,
      origin: e.origin,
      ...(e.label !== undefined ? { label: e.label } : {}),
      time: e.time,
    }));
  }

  async commit(input: CommitInput, origin: Origin): Promise<CommitResult> {
    if (
      input.ifRevision !== undefined &&
      input.ifRevision !== this.revision_
    ) {
      throw new TopoError({
        code: "IF_REVISION_MISMATCH",
        message: `期望 revision ${input.ifRevision}，实际已是 ${this.revision_}`,
        hint: "并发护航生效：另一客户端先改了图；重读后带新 revision 重试",
        fix: "toporealm status",
        details: { expected: input.ifRevision, actual: this.revision_ },
      });
    }
    if (!Array.isArray(input.changes) || input.changes.length === 0) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: "提交必须包含至少一个变更（changes[]）",
      });
    }
    return this.convert({
      kind: "commit",
      origin,
      ...(input.label !== undefined ? { label: input.label } : {}),
      changes: input.changes,
      append: true,
    });
  }

  async undo(steps: number, origin: Origin): Promise<CommitResult> {
    if (!Number.isInteger(steps) || steps < 1) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `undo 步数必须是正整数，得到 ${steps}`,
      });
    }
    if (this.cursor === 0) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: "没有可撤销的提交",
        hint: "canUndo 为 false：游标已在日志起点",
        details: { canUndo: false },
      });
    }
    let last: CommitResult | undefined;
    for (let i = 0; i < steps && this.cursor > 0; i++) {
      const entry = this.logEntries[this.cursor - 1];
      if (!entry) break;
      last = await this.convert({
        kind: "undo",
        origin,
        changes: entry.inverse,
        append: false,
      });
    }
    return (
      last ?? {
        revision: this.revision_,
        created: [],
        patch: emptyPatch(this.revision_),
        canUndo: this.cursor > 0,
        canRedo: this.cursor < this.logEntries.length,
      }
    );
  }

  async redo(steps: number, origin: Origin): Promise<CommitResult> {
    if (!Number.isInteger(steps) || steps < 1) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `redo 步数必须是正整数，得到 ${steps}`,
      });
    }
    if (this.cursor >= this.logEntries.length) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: "没有可重做的提交",
        hint: "canRedo 为 false：游标已在日志末端",
        details: { canRedo: false },
      });
    }
    let last: CommitResult | undefined;
    for (let i = 0; i < steps && this.cursor < this.logEntries.length; i++) {
      const entry = this.logEntries[this.cursor];
      if (!entry) break;
      last = await this.convert({
        kind: "redo",
        origin,
        changes: entry.changes,
        append: false,
      });
    }
    return (
      last ?? {
        revision: this.revision_,
        created: [],
        patch: emptyPatch(this.revision_),
        canUndo: this.cursor > 0,
        canRedo: this.cursor < this.logEntries.length,
      }
    );
  }

  // ---------- 命令目录与模块命令（M1 无模块：恒空/恒 UNKNOWN_COMMAND） ----------

  catalog(): Catalog {
    this.touch();
    const kinds = new Set<Kind>();
    for (const o of this.objects.values()) kinds.add(o.kind);
    for (const r of this.relations.values()) kinds.add(r.kind);
    return {
      modules: this.manifest.modules.map((id) => ({
        id,
        version: "0.0.0",
        namespace: id,
      })),
      kinds: [...kinds].sort().map((kind) => {
        const ns = kindNamespace(kind);
        return ns ? { kind, owner: ns } : { kind };
      }),
      commands: [],
    };
  }

  run(commandId: string): never {
    this.touch();
    throw new TopoError({
      code: "UNKNOWN_COMMAND",
      message: `未知命令 "${commandId}"`,
      hint: "M1 未装载模块，命令目录为空；目录自省：toporealm cmds（M2 交付）",
      details: {
        commandId,
        suggestions: suggestClosest(commandId, []),
      },
    });
  }

  // ---------- 钩子注册面（M2 模块装载点；M1 无人调用，管线已就位） ----------

  registerBeforeCommitHook(hook: BeforeCommitHook): void {
    this.beforeHooks.push(hook);
  }

  registerAfterCommitHook(hook: AfterCommitHook): void {
    this.afterHooks.push(hook);
  }

  // ---------- 事件 ----------

  events(
    listener: (e: TopoEvent) => void,
    opts?: { fromRevision?: number },
  ): Unsubscribe {
    this.touch();
    // hello 必为首事件
    listener({ type: "hello", graphId: this.graphId, revision: this.revision_ });
    const from = opts?.fromRevision;
    if (from !== undefined && from !== this.revision_) {
      if (from < this.revision_) {
        const tail = this.logEntries.slice(this.cursor);
        const contiguous =
          tail.length === this.revision_ - from &&
          tail.every((e, i) => e.revision === from + 1 + i);
        if (contiguous && tail.every((e) => e.patch !== undefined)) {
          // 回放免全量：日志段连续且带 patch
          for (const e of tail) {
            listener({
              type: "commit",
              revision: e.revision,
              patch: e.patch as GraphPatch,
              origin: e.origin,
              ...(e.label !== undefined ? { label: e.label } : {}),
            });
          }
        } else {
          listener({ type: "reset", reason: "daemon-restarted" });
        }
      } else {
        // 客户端 revision 领先 daemon（daemon 重启过）→ 全量重读
        listener({ type: "reset", reason: "daemon-restarted" });
      }
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(e: TopoEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* 监听器异常不阻断广播 */
      }
    }
  }

  // ---------- 提交管线（唯一转换通道：commit/undo/redo/external 全走这里） ----------

  private async convert(plan: {
    kind: LogEntry["kind"];
    origin: Origin;
    label?: string;
    changes: readonly Change[];
    append: boolean;
  }): Promise<CommitResult> {
    this.touch();
    // ①②③ id/kind 解析 → 所有权法 → 悬空边（normalize 内联，全程在副本上模拟）
    const norm = this.normalize(plan.origin, plan.changes);
    const revision = this.revision_ + 1;

    // ④ before-commit 钩子（同步、first-veto 短路、禁再入）
    if (this.beforeHooks.length > 0) {
      const candidate: CommitCandidate = {
        revision,
        before: this.snapshot(this.revision_),
        after: snapshotFrom(this.graphId, norm.objects, norm.relations, revision),
        changes: norm.changes,
        origin: plan.origin,
      };
      for (const hook of this.beforeHooks) {
        const r = hook(candidate);
        if (r && typeof r === "object" && "veto" in r) {
          throw new TopoError({
            code: "VETOED",
            message: `提交被领域钩子否决：${r.veto}`,
            hint: "领域校验由模块钩子执法；按否决理由调整变更后重试",
            details: {
              vetoes: [
                {
                  reason: r.veto,
                  ...(r.details !== undefined ? { details: r.details } : {}),
                },
              ],
            },
          });
        }
      }
    }

    const entry: StoredLogEntry = {
      revision,
      kind: plan.kind,
      origin: plan.origin,
      ...(plan.label !== undefined ? { label: plan.label } : {}),
      time: new Date().toISOString(),
      changes: norm.changes,
      inverse: norm.inverse,
      patch: norm.patch,
    };
    const truncating = plan.append && this.cursor < this.logEntries.length;
    const nextCursor = plan.append
      ? this.cursor + 1
      : plan.kind === "undo"
        ? this.cursor - 1
        : this.cursor + 1;

    // ⑤ 原子应用：实体文件 → .log → graph.yaml（最后写 = 提交标记）
    this.persistDepth++;
    try {
      for (const rec of norm.upserts.values()) {
        await writeEntity(this.p, rec);
      }
      for (const [id, expectRelation] of norm.deletes) {
        await removeEntityFile(this.p, id, expectRelation);
      }
      if (plan.append) {
        if (truncating) {
          // undo 后的新提交：截断 redo 段再追加
          await rewriteLog(this.p, [...this.logEntries.slice(0, this.cursor), entry]);
        } else {
          await appendLogLine(this.p, entry);
        }
      }
      await saveManifest(this.p, {
        ...this.manifest,
        revision,
        undoCursor: nextCursor,
      });
    } finally {
      this.persistDepth--;
    }

    // 内存生效（磁盘已成功）
    this.objects = norm.objects;
    this.relations = norm.relations;
    this.revision_ = revision;
    this.manifest = { ...this.manifest, revision, undoCursor: nextCursor };
    if (plan.append) {
      this.logEntries = truncating
        ? [...this.logEntries.slice(0, this.cursor), entry]
        : [...this.logEntries, entry];
      this.cursor = this.logEntries.length;
    } else if (plan.kind === "undo") {
      this.cursor -= 1;
    } else {
      this.cursor += 1;
    }

    // ⑥ after-commit 钩子（同步排队；其 commit 走队列追加——M2 落实队列，M1 空注册面）
    if (this.afterHooks.length > 0) {
      const evt: AfterCommitEvent = {
        revision,
        patch: norm.patch,
        origin: plan.origin,
        ...(plan.label !== undefined ? { label: plan.label } : {}),
      };
      for (const h of this.afterHooks) {
        try {
          h(evt);
        } catch {
          /* 钩子异常不阻断 */
        }
      }
    }

    // ⑦ 广播 commit 事件（origin 如实）
    this.emit({
      type: "commit",
      revision,
      patch: norm.patch,
      origin: plan.origin,
      ...(plan.label !== undefined ? { label: plan.label } : {}),
    });

    return {
      revision,
      created: norm.created,
      patch: norm.patch,
      canUndo: this.cursor > 0,
      canRedo: this.cursor < this.logEntries.length,
    };
  }

  /**
   * 变更规范化（①②③ 阶段，全程模拟在副本上，抛错即无副作用）：
   * - pass1 处理 put（rel 端点可引用同批创建的对象——悬空检查针对集合整体，I2）
   * - pass2 按原始顺序处理 rel/merge/del
   * - 逆变更按序计算，undo 时倒序应用
   */
  private normalize(
    origin: Origin,
    rawChanges: readonly Change[],
  ): {
    changes: Change[];
    inverse: Change[];
    patch: GraphPatch;
    objects: Map<EntityId, Entity>;
    relations: Map<EntityId, RelationEntity>;
    upserts: Map<EntityId, EntityRecord>;
    deletes: Map<EntityId, boolean>;
    created: EntityId[];
  } {
    const objects = new Map(this.objects);
    const relations = new Map(this.relations);
    const changes: Change[] = [];
    const inverse: Change[] = [];
    const created: EntityId[] = [];
    const upserts = new Map<EntityId, EntityRecord>();
    const deletes = new Map<EntityId, boolean>();
    const patchObjects = {
      added: [] as Entity[],
      updated: [] as Entity[],
      deleted: [] as EntityId[],
    };
    const patchRelations = {
      added: [] as RelationEntity[],
      updated: [] as RelationEntity[],
      deleted: [] as EntityId[],
    };

    const genId = (kind: string): EntityId => {
      const base =
        (kind.split(".").pop() ?? "e").replace(/[^\w-]/g, "").slice(0, 24) ||
        "e";
      for (;;) {
        const id = `${base}-${crypto.randomBytes(4).toString("hex")}`;
        if (!objects.has(id) && !relations.has(id)) return id;
      }
    };

    // ---- pass 1: put ----
    rawChanges.forEach((c, i) => {
      if (!c || typeof c !== "object" || typeof c.op !== "string") {
        throw new TopoError({
          code: "INVALID_INPUT",
          message: `changes[${i}] 不是合法变更`,
        });
      }
      if (c.op !== "put") return;
      const id = c.id ?? genId(c.kind ?? "e");
      if (!isValidEntityId(id)) {
        throw new TopoError({
          code: "INVALID_INPUT",
          message: `实体 id 非法："${id}"（禁 / \\ : 空格与控制字符，且不得为 Windows 保留名）`,
          details: { id, changeIndex: i },
        });
      }
      if (relations.has(id)) {
        throw new TopoError({
          code: "ID_EXISTS",
          message: `id "${id}" 已被关系占用；对象与关系共用 id 空间`,
          details: { id, conflict: "relation" },
        });
      }
      let kind = c.kind;
      const prev = objects.get(id);
      if (kind === undefined) {
        if (!prev) {
          throw new TopoError({
            code: "INVALID_INPUT",
            message: `put 新建对象必须提供 kind（id "${id}" 不存在）`,
            details: { id },
          });
        }
        kind = prev.kind;
      }
      if (!isValidKind(kind)) {
        throw new TopoError({
          code: "INVALID_INPUT",
          message: `主类型非法："${String(kind)}"`,
          details: { kind, changeIndex: i },
        });
      }
      checkOwnership(origin, kind, i);
      const payload = c.payload ?? {};
      const next: Entity = { id, kind, payload };
      inverse.push(
        prev
          ? { op: "put", id, kind: prev.kind, payload: prev.payload }
          : { op: "del", id },
      );
      if (prev) patchObjects.updated.push(next);
      else {
        patchObjects.added.push(next);
        // created 只回显 daemon 分配的匿名 id（blueprint §1）
        if (c.id === undefined) created.push(id);
      }
      objects.set(id, next);
      upserts.set(id, next);
      deletes.delete(id);
      changes.push({ op: "put", kind, id, payload });
    });

    // ---- pass 2: rel / merge / del ----
    rawChanges.forEach((c, i) => {
      if (c.op === "rel") {
        const id = c.id ?? genId(c.kind);
        if (!isValidEntityId(id)) {
          throw new TopoError({
            code: "INVALID_INPUT",
            message: `实体 id 非法："${id}"`,
            details: { id, changeIndex: i },
          });
        }
        if (objects.has(id)) {
          throw new TopoError({
            code: "ID_EXISTS",
            message: `id "${id}" 已被对象占用；对象与关系共用 id 空间`,
            details: { id, conflict: "object" },
          });
        }
        if (!isValidKind(c.kind)) {
          throw new TopoError({
            code: "INVALID_INPUT",
            message: `主类型非法："${String(c.kind)}"`,
            details: { kind: c.kind, changeIndex: i },
          });
        }
        checkOwnership(origin, c.kind, i);
        // 悬空边检查（集合整体：端点可为同批 put 创建）
        const missing: EntityId[] = [];
        if (!objects.has(c.source)) missing.push(c.source);
        if (!objects.has(c.target)) missing.push(c.target);
        if (missing.length > 0) {
          throw new TopoError({
            code: "DANGLING_RELATION",
            message: `关系端点不存在：${missing.join(", ")}`,
            hint: "先创建端点对象（同一提交内创建也可），或改指已存在的对象",
            fix: `toporealm add ${c.kind} --id ${c.source}`,
            details: {
              relations: [
                { id, kind: c.kind, source: c.source, target: c.target },
              ],
              missing,
            },
          });
        }
        const prev = relations.get(id);
        inverse.push(
          prev
            ? {
                op: "rel",
                id,
                kind: prev.kind,
                source: prev.source,
                target: prev.target,
                payload: prev.payload,
                ...(prev.direction !== undefined
                  ? { direction: prev.direction }
                  : {}),
              }
            : { op: "del", id },
        );
        const payload = c.payload ?? {};
        const next: RelationEntity = {
          id,
          kind: c.kind,
          source: c.source,
          target: c.target,
          payload,
        };
        if (c.direction !== undefined) next.direction = c.direction;
        if (prev) patchRelations.updated.push(next);
        else patchRelations.added.push(next);
        relations.set(id, next);
        upserts.set(id, next);
        deletes.delete(id);
        changes.push({
          op: "rel",
          kind: c.kind,
          id,
          source: c.source,
          target: c.target,
          payload,
          ...(c.direction !== undefined ? { direction: c.direction } : {}),
        });
        return;
      }
      if (c.op === "merge") {
        const obj = objects.get(c.id);
        const rel = relations.get(c.id);
        const target = obj ?? rel;
        if (!target) {
          const candidates = [...objects.keys(), ...relations.keys()];
          throw new TopoError({
            code: "UNKNOWN_ID",
            message: `实体不存在："${c.id}"`,
            hint: didYouMeanHint(c.id, candidates),
            details: {
              id: c.id,
              suggestions: suggestClosest(c.id, candidates),
            },
          });
        }
        checkOwnership(origin, target.kind, i);
        if (
          !c.payload ||
          typeof c.payload !== "object" ||
          Array.isArray(c.payload)
        ) {
          throw new TopoError({
            code: "INVALID_INPUT",
            message: "merge 需要 payload 映射（值 null = 删键）",
          });
        }
        // 逆变更：逐键恢复旧值；原无此键 → null（删）
        const invPayload: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(c.payload)) {
          invPayload[k] = k in target.payload ? (target.payload[k] ?? null) : null;
        }
        inverse.push({ op: "merge", id: c.id, payload: invPayload });
        const nextPayload = { ...target.payload };
        for (const [k, v] of Object.entries(c.payload)) {
          if (v === null) delete nextPayload[k];
          else nextPayload[k] = v;
        }
        if (obj) {
          const next: Entity = { ...obj, payload: nextPayload };
          objects.set(c.id, next);
          upserts.set(c.id, next);
          patchObjects.updated.push(next);
        } else if (rel) {
          const next: RelationEntity = { ...rel, payload: nextPayload };
          relations.set(c.id, next);
          upserts.set(c.id, next);
          patchRelations.updated.push(next);
        }
        changes.push({ op: "merge", id: c.id, payload: c.payload });
        return;
      }
      if (c.op === "del") {
        const obj = objects.get(c.id);
        const rel = relations.get(c.id);
        if (!obj && !rel) {
          const candidates = [...objects.keys(), ...relations.keys()];
          throw new TopoError({
            code: "UNKNOWN_ID",
            message: `实体不存在："${c.id}"`,
            hint: didYouMeanHint(c.id, candidates),
            details: {
              id: c.id,
              suggestions: suggestClosest(c.id, candidates),
            },
          });
        }
        checkOwnership(origin, (obj ?? rel)!.kind, i);
        if (obj) objects.delete(c.id);
        if (rel) relations.delete(c.id);
        // 悬空边检查：删除后仍存活的引用
        const edges: { id: EntityId; kind: Kind; source: EntityId; target: EntityId }[] = [];
        for (const r of relations.values()) {
          if (r.source === c.id || r.target === c.id) {
            edges.push({ id: r.id, kind: r.kind, source: r.source, target: r.target });
          }
        }
        if (edges.length > 0) {
          throw new TopoError({
            code: "DANGLING_RELATION",
            message: `不能删除 "${c.id}"：仍有 ${edges.length} 条关系引用它`,
            hint: "先删除或改接这些关系（rm <关系id>），再删本实体",
            fix: `toporealm rm ${edges[0]?.id ?? ""}`,
            details: { deleted: c.id, edges },
          });
        }
        inverse.push(
          obj
            ? { op: "put", id: c.id, kind: obj.kind, payload: obj.payload }
            : {
                op: "rel",
                id: c.id,
                kind: rel!.kind,
                source: rel!.source,
                target: rel!.target,
                payload: rel!.payload,
                ...(rel!.direction !== undefined
                  ? { direction: rel!.direction }
                  : {}),
              },
        );
        if (obj) patchObjects.deleted.push(c.id);
        else patchRelations.deleted.push(c.id);
        deletes.set(c.id, !obj);
        upserts.delete(c.id);
        changes.push({ op: "del", id: c.id });
        return;
      }
      if (c.op !== "put") {
        throw new TopoError({
          code: "INVALID_INPUT",
          message: `未知变更 op："${String((c as { op?: unknown }).op)}"`,
          details: { changeIndex: i },
        });
      }
    });

    return {
      changes,
      inverse,
      patch: {
        fromRevision: this.revision_,
        toRevision: this.revision_ + 1,
        objects: patchObjects,
        relations: patchRelations,
      },
      objects,
      relations,
      upserts,
      deletes,
      created,
    };
  }

  // ---------- 外部编辑吸收（文件监视 → 同一管线，origin "external"） ----------

  /** 与磁盘比对；有差异则以 external 转换吸收（入日志、可 undo），并广播 reset。 */
  async reconcileExternal(): Promise<boolean> {
    if (this.disposed || this.persistDepth > 0 || this.reconciling) return false;
    this.reconciling = true;
    try {
      const disk = await loadEntities(this.p);
      const changes: Change[] = [];
      for (const [id, d] of disk.objects) {
        const m = this.objects.get(id);
        if (
          !m ||
          m.kind !== d.kind ||
          JSON.stringify(m.payload) !== JSON.stringify(d.payload)
        ) {
          changes.push({ op: "put", id, kind: d.kind, payload: d.payload });
        }
      }
      for (const [id, d] of disk.relations) {
        const m = this.relations.get(id);
        if (
          !m ||
          m.kind !== d.kind ||
          m.source !== d.source ||
          m.target !== d.target ||
          (m.direction ?? "directed") !== (d.direction ?? "directed") ||
          JSON.stringify(m.payload) !== JSON.stringify(d.payload)
        ) {
          changes.push({
            op: "rel",
            id,
            kind: d.kind,
            source: d.source,
            target: d.target,
            payload: d.payload,
            ...(d.direction !== undefined ? { direction: d.direction } : {}),
          });
        }
      }
      // 删除：先关系后对象
      for (const id of this.relations.keys()) {
        if (!disk.relations.has(id)) changes.push({ op: "del", id });
      }
      for (const id of this.objects.keys()) {
        if (!disk.objects.has(id)) changes.push({ op: "del", id });
      }
      if (changes.length === 0) return false;
      let applied = false;
      try {
        await this.convert({
          kind: "external",
          origin: "external",
          label: "external edit",
          changes,
          append: true,
        });
        applied = true;
      } catch {
        // 执法拒绝（如手改产生悬空边）：保持内存态，不回写、不循环
        applied = false;
      }
      if (applied) {
        // commit 事件已由 convert 广播；再发 reset 提示客户端全量重读（blueprint §3）
        this.emit({ type: "reset", reason: "external-edit" });
      }
      return applied;
    } finally {
      this.reconciling = false;
    }
  }

  private scheduleReconcile(): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      this.reconcileExternal().catch(() => {});
    }, EXTERNAL_DEBOUNCE_MS);
  }

  private startWatch(): void {
    for (const dir of [this.p.objects, this.p.relations, this.p.dir]) {
      try {
        const w = fs.watch(dir, () => this.scheduleReconcile());
        w.on("error", () => {
          /* 目录被删等：静默（daemon 崩溃由 endpoint/pid 机制兜底） */
        });
        this.watchers.push(w);
      } catch {
        /* 目录尚不存在等 */
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
    this.listeners.clear();
  }

  private snapshot(revision: number): GraphSnapshot {
    return snapshotFrom(this.graphId, this.objects, this.relations, revision);
  }
}

// ---------- 纯辅助 ----------

function snapshotFrom(
  graphId: string,
  objects: Map<EntityId, Entity>,
  relations: Map<EntityId, RelationEntity>,
  revision: number,
): GraphSnapshot {
  return {
    graphId,
    revision,
    objects: [...objects.values()],
    relations: [...relations.values()],
  };
}

function emptyPatch(revision: number): GraphPatch {
  return {
    fromRevision: revision,
    toRevision: revision,
    objects: { added: [], updated: [], deleted: [] },
    relations: { added: [], updated: [], deleted: [] },
  };
}

/** 所有权法（执法二之一）：只约束 module:* 来源；cli/web/external/migrate 豁免（人是图最终属主）。 */
function checkOwnership(origin: Origin, kind: Kind, changeIndex: number): void {
  if (!origin.startsWith("module:")) return;
  const moduleId = origin.slice("module:".length);
  const ns = kindNamespace(kind);
  if (ns === null || ns === moduleId) return; // 公共/无主 kind 或本模块命名空间
  throw new TopoError({
    code: "OWNERSHIP_VIOLATION",
    message: `模块 "${moduleId}" 不能触碰主类型 "${kind}"（所有权法：只能写 ${moduleId}.* 或公共/无主类型）`,
    hint: "跨模块协作走图数据面：读他人实体、建自己命名空间的关系",
    details: { module: moduleId, kind, changeIndex },
  });
}

function matchWhere(
  r: EntityRecord,
  where: readonly { kind?: Kind; eq?: Record<string, unknown> }[],
): boolean {
  for (const w of where) {
    if (w.kind !== undefined && w.kind !== r.kind) return false;
    if (w.eq) {
      for (const [k, v] of Object.entries(w.eq)) {
        if (r.payload[k] !== v) return false;
      }
    }
  }
  return true;
}

/** fields 投影：id / kind / source / target / payload.<key> */
function project(
  r: EntityRecord,
  fields: readonly string[] | undefined,
): EntityRecord {
  if (!fields || fields.length === 0) return r;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f === "id") out.id = r.id;
    else if (f === "kind") out.kind = r.kind;
    else if (f === "source" && "source" in r) out.source = r.source;
    else if (f === "target" && "target" in r) out.target = r.target;
    else if (f.startsWith("payload.")) {
      const key = f.slice("payload.".length);
      if (key in r.payload) {
        const p = (out.payload ?? {}) as Record<string, unknown>;
        p[key] = r.payload[key];
        out.payload = p;
      }
    }
  }
  return out as unknown as EntityRecord;
}

function didYouMeanHint(input: string, candidates: readonly string[]): string {
  const s = suggestClosest(input, candidates, 1);
  return s.length > 0 ? `是不是想用 "${s[0]}"？` : "用 toporealm find 查现存实体";
}
