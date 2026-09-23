import type { Catalog, CommandRunResult } from "./catalog.js";
import type { CommitInput, CommitResult } from "./changes.js";
import type { EntityId, GraphSummary } from "./entities.js";
import type { LogEntry } from "./log.js";
import type { ReadQuery, ReadResult } from "./query.js";
import type { TopoEvent } from "./events.js";

// ---------- S1：DaemonClient port（blueprint §1.1） ----------

export interface DaemonClient {
  connect(opts?: { root?: string; graph?: string }): Promise<Session>;
}

export interface Session {
  readonly graphId: string;
  /** daemon 会话指纹：变化 ⇒ 模块集/目录可能全变，须重拉 */
  readonly instanceId: string;
  status(): Promise<GraphSummary>;
  read(query?: ReadQuery): Promise<ReadResult>;
  log(opts?: { limit?: number }): Promise<readonly LogEntry[]>;
  commit(input: CommitInput): Promise<CommitResult>;
  undo(steps?: number): Promise<CommitResult>;
  redo(steps?: number): Promise<CommitResult>;
  catalog(module?: string): Promise<Catalog>;
  run(
    commandId: string,
    opts?: { target?: EntityId; input?: unknown },
  ): Promise<CommandRunResult>;
  /** fromRevision 回放免全量；hello 必为首事件 */
  events(
    listener: (e: TopoEvent) => void,
    opts?: { fromRevision?: number },
  ): Promise<Unsubscribe>;
  close(): Promise<void>;
}

export type Unsubscribe = () => void | Promise<void>;
