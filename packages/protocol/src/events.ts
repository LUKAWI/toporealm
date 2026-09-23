import type { GraphPatch, CommitResult } from "./changes.js";
import type { Origin } from "./entities.js";

// ---------- 事件（blueprint §1） ----------

export type TopoEvent =
  /** 连接/订阅后首事件，必为此 */
  | { type: "hello"; graphId: string; revision: number }
  /** commit/undo/redo/external 全走此事件 */
  | {
      type: "commit";
      revision: number;
      patch: GraphPatch;
      origin: Origin;
      label?: string;
    }
  /** 客户端应全量重读 */
  | { type: "reset"; reason: "external-edit" | "daemon-restarted" };

/** 模块命令运行（M2 起有内容；M1 daemon 无模块，恒 UNKNOWN_COMMAND） */
export type RunResult = CommitResult;
