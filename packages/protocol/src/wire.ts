import type { CommitInput, CommitResult } from "./changes.js";
import type { Catalog, CommandRunResult } from "./catalog.js";
import type { EntityId, GraphSummary } from "./entities.js";
import type { LogEntry } from "./log.js";
import type { ReadQuery, ReadResult } from "./query.js";
import type { TopoEvent } from "./events.js";
import type { TopoErrorInit } from "./errors.js";

// ---------- IPC wire（client 与 daemon 的传输契约；纯数据 + 纯编解码，零依赖） ----------
// 这不是 blueprint §1 的图形契约，而是 client(IpcClient) 与 daemon(IpcServer) 两端必须一致
// 的传输信封；按"契约类型集中在 protocol"的红线放在这里，避免 client←daemon 循环。

export type IpcRequest =
  // hello.root 可选（D22）：web 客户端不知道工作区路径——省略 = 即服务 daemon
  // 自身的 root/graph，不做比对；提供了仍比对（IPC 语义不变）。
  | { id: string; op: "hello"; root?: string; graph?: string }
  | { id: string; op: "status" }
  | { id: string; op: "read"; query?: ReadQuery }
  | { id: string; op: "log"; limit?: number }
  | { id: string; op: "commit"; input: CommitInput }
  | { id: string; op: "undo"; steps?: number }
  | { id: string; op: "redo"; steps?: number }
  | { id: string; op: "catalog"; module?: string }
  | { id: string; op: "run"; commandId: string; opts?: { target?: EntityId; input?: unknown } }
  | { id: string; op: "events"; fromRevision?: number }
  | { id: string; op: "unlisten"; token: string }
  | { id: string; op: "shutdown" };

export type IpcResponse =
  | { id: string; ok: true; result: unknown; instanceId: string }
  | { id: string; ok: false; error: TopoErrorInit; instanceId: string };

/** daemon 主动推送 */
export type IpcPush = { event: TopoEvent };

export type IpcMessage = IpcResponse | IpcPush;

export type IpcResultMap = {
  hello: { graphId: string; revision: number };
  status: GraphSummary;
  read: ReadResult;
  log: readonly LogEntry[];
  commit: CommitResult;
  undo: CommitResult;
  redo: CommitResult;
  catalog: Catalog;
  run: CommandRunResult;
  events: { token: string };
  unlisten: { ok: true };
  shutdown: { ok: true };
};

export function encodeLine(m: IpcMessage | IpcRequest): string {
  return JSON.stringify(m) + "\n";
}

/** NDJSON 行缓冲解码器（跨 chunk 粘包安全） */
export function createLineDecoder(onMessage: (m: IpcMessage) => void): {
  push(chunk: string): void;
  end(): void;
} {
  let buf = "";
  return {
    push(chunk: string) {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim().length === 0) continue;
        try {
          onMessage(JSON.parse(line) as IpcMessage);
        } catch {
          // 忽略无法解析的行（不应发生；守护进程与客户端同仓库同版本）
        }
      }
    },
    end() {
      if (buf.trim().length > 0) {
        try {
          onMessage(JSON.parse(buf) as IpcMessage);
        } catch {
          /* 尾部残行丢弃 */
        }
      }
      buf = "";
    },
  };
}
