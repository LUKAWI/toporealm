import type { CoreErrorShape } from "./types.js";

export class CoreError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(shape: CoreErrorShape) {
    super(shape.message);
    this.name = "CoreError";
    this.code = shape.code;
    this.details = shape.details;
  }
}

export class RevisionConflictError extends CoreError {
  constructor(expected: number, actual: number) {
    super({
      code: "REVISION_CONFLICT",
      message: `图 revision 已从 ${expected} 变为 ${actual}，拒绝覆盖较新的数据。`,
      details: { expectedRevision: expected, actualRevision: actual },
    });
    this.name = "RevisionConflictError";
  }
}

export class HistoryBoundaryError extends CoreError {
  constructor(direction: "undo" | "redo") {
    super({
      code: direction === "undo" ? "NO_UNDO" : "NO_REDO",
      message: direction === "undo" ? "没有可撤销的操作。" : "没有可重做的操作。",
    });
    this.name = "HistoryBoundaryError";
  }
}

export class GraphLockError extends CoreError {
  constructor(path: string) {
    super({
      code: "GRAPH_LOCKED",
      message: `图正在被另一个写入者修改：${path}`,
      details: { lockPath: path },
    });
    this.name = "GraphLockError";
  }
}
