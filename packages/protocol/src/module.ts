import type { CatalogEntry } from "./catalog.js";
import type { Change, CommitInput, CommitResult, GraphPatch } from "./changes.js";
import type {
  Entity,
  EntityId,
  EntityRecord,
  GraphSnapshot,
  Kind,
  Origin,
} from "./entities.js";
import type { ReadQuery, ReadResult } from "./query.js";

// ---------- S2：模块 runtime API（blueprint §1.2；M1 仅契约类型，装载在 M2） ----------

/** 模块入口：ESM default export；daemon 启动时装载、activate 恰好一次 */
export interface ModuleEntryPoint {
  activate(api: ModuleApi): void | Promise<void>;
}

export interface ModuleApi {
  readonly self: Readonly<{ id: string; namespace: string; version: string }>;
  /** 同步（in-process 内存态） */
  read(query?: ReadQuery): ReadResult;
  /** 便捷直取，免全量 */
  get(id: EntityId): EntityRecord | undefined;
  byKind(kind: Kind): EntityRecord[];
  /** 所有权法执法点：以 module:<id> 身份提交；只能触碰 self.namespace.* 或公共/无主 kind */
  commit(input: CommitInput): CommitResult;
  /** 仅 activate 返回前合法（违者 LATE_REGISTRATION，M2 执法） */
  command(spec: CommandSpec, handler: CommandHandler): void;
  hook(name: "before-commit", fn: BeforeCommitHook): void;
  /** 可 api.commit——排队追加，不嵌套 */
  hook(name: "after-commit", fn: AfterCommitHook): void;
  /** WebUI inspector 载荷表单 */
  form(kind: Kind, form: FormSpec): void;
}

export interface CommandSpec {
  /** 本名；目录 id = `${namespace}.${name}` */
  name: string;
  /** 必填：agent 的唯一文档 */
  title: string;
  /** 绑定目标主类型；缺省 = 全局命令 */
  target?: Kind;
  /** JSON Schema 说明书（强烈建议写） */
  input?: object;
}

export interface CommandContext {
  target?: EntityRecord;
  input: Record<string, unknown>;
}

export interface CommandOutput {
  message?: string;
  data?: unknown;
}

export type CommandHandler = (
  ctx: CommandContext,
) => CommandOutput | Promise<CommandOutput>;

/** before-commit：双快照——钩子直接对候选图做领域判断（B） */
export interface CommitCandidate {
  /** 将成为的 revision */
  revision: number;
  /** 不可变 */
  before: GraphSnapshot;
  /** 候选图（不可变） */
  after: GraphSnapshot;
  changes: readonly Change[];
  /** 钩子对一切来源生效（含 undo/external/人） */
  origin: Origin;
  /**
   * 转换类别（D24①，core.stage 如实填写）：commit/external = 前向转换（领域门禁执法）；
   * undo/redo = 已过管线的提交的游标移动（撤销是用户的手——领域钩子据此豁免，M2）。
   * 可选：缺省按前向转换对待（保守执法）。
   */
  conversion?: "commit" | "undo" | "redo" | "external";
}

export type BeforeCommitHook = (
  c: CommitCandidate,
) => void | { veto: string; details?: Record<string, unknown> };

// v1 钩子必须同步（D17 默认值）；core 不聚合不排序；first-veto 短路；钩子内 commit → REENTRANT_COMMIT
export interface AfterCommitEvent {
  revision: number;
  patch: GraphPatch;
  origin: Origin;
  label?: string;
}

export type AfterCommitHook = (e: AfterCommitEvent) => void;

export interface FormSpec {
  fields: readonly {
    name: string;
    title?: string;
    type: "string" | "number" | "boolean" | "enum" | "text";
    options?: readonly string[];
    required?: boolean;
  }[];
}

export interface ModuleManifestV2 {
  format: "toporealm.module/v2";
  id: string;
  namespace: string;
  version: string;
  requires?: { modules?: readonly string[] };
  kinds?: { objects?: readonly string[]; relations?: readonly string[] };
  ui?: { color?: string; icon?: string; titleKey?: string };
  entry: string;
}

export type { CatalogEntry };
export type { Entity };
