// ---------- 错误码封闭集（blueprint §1.1 全表；只增不改义） ----------

export const TOPO_ERROR_CODES = [
  // 环境
  "NO_WORKSPACE",
  "NO_CURRENT_GRAPH",
  "GRAPH_NOT_FOUND",
  // 实体
  "UNKNOWN_ID",
  "UNKNOWN_KIND",
  "ID_EXISTS",
  // 执法
  "DANGLING_RELATION",
  "OWNERSHIP_VIOLATION",
  // 钩子
  "VETOED",
  // 命令
  "UNKNOWN_COMMAND",
  "INVALID_INPUT",
  // 并发
  "IF_REVISION_MISMATCH",
  // 传输
  "DAEMON_UNREACHABLE",
  "SESSION_STALE",
] as const;

export type TopoErrorCode = (typeof TOPO_ERROR_CODES)[number];

export interface TopoErrorInit {
  code: TopoErrorCode;
  message: string;
  /** 人话下一步 */
  hint?: string;
  /** 可整句复制执行的命令 */
  fix?: string;
  details?: Record<string, unknown>;
}

export class TopoError extends Error {
  readonly code: TopoErrorCode;
  readonly hint?: string;
  readonly fix?: string;
  readonly details?: Record<string, unknown>;

  constructor(init: TopoErrorInit) {
    super(init.message);
    this.name = "TopoError";
    this.code = init.code;
    if (init.hint !== undefined) this.hint = init.hint;
    if (init.fix !== undefined) this.fix = init.fix;
    if (init.details !== undefined) this.details = init.details;
  }

  toJSON(): TopoErrorInit {
    const out: TopoErrorInit = { code: this.code, message: this.message };
    if (this.hint !== undefined) out.hint = this.hint;
    if (this.fix !== undefined) out.fix = this.fix;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }

  static is(e: unknown): e is TopoError {
    return e instanceof TopoError;
  }

  /** wire 重建（丢原型链后恢复） */
  static fromJSON(o: unknown): TopoError {
    if (
      o !== null &&
      typeof o === "object" &&
      typeof (o as TopoErrorInit).code === "string" &&
      typeof (o as TopoErrorInit).message === "string"
    ) {
      return new TopoError(o as TopoErrorInit);
    }
    return new TopoError({
      code: "DAEMON_UNREACHABLE",
      message: String(o),
    });
  }
}
