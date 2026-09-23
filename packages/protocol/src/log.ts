import type { Origin } from "./entities.js";

// ---------- 提交日志（D7：undo 栈 + 近期变更 + 审计三合一；blueprint §1） ----------

export interface LogEntry {
  revision: number;
  /** external = 文件监视重载吸收的人手改 */
  kind: "commit" | "undo" | "redo" | "external";
  origin: Origin;
  label?: string;
  /** ISO 8601 */
  time: string;
}

/**
 * 游标存 graph.yaml；undo/redo 移动游标，不追加日志（D17 裁决②）。
 * undo 后的新提交截断游标之后的日志段。
 * 磁盘 .log 行 = LogEntry 超集（额外存 changes/inverse/patch 供 undo/redo/回放），对外只见 LogEntry。
 */
export interface StoredLogEntry extends LogEntry {
  changes: readonly import("./changes.js").Change[];
  inverse: readonly import("./changes.js").Change[];
  patch?: import("./changes.js").GraphPatch;
}
