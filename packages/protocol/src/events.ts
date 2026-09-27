import type { GraphPatch } from "./changes.js";
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
  /** 客户端应全量重读（graph-switched：daemon 换载后推送，graphId = 换载后当前图，D30） */
  | {
      type: "reset";
      reason: "external-edit" | "daemon-restarted" | "graph-switched";
      graphId?: string;
    };
