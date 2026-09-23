import path from "node:path";
import crypto from "node:crypto";
import {
  TopoError,
  type IpcRequest,
  type IpcResponse,
  type TopoEvent,
} from "@lukawi/toporealm-protocol";
import type { DaemonCore } from "@lukawi/toporealm-daemon-core";
import {
  ModuleHost,
  currentModuleBindingDigest,
} from "@lukawi/toporealm-module-host";

// ---------- wire 分发器（D22 裁决①）：IPC（CLI）与 WS（Web）共用同一请求语义 ----------
//
// 传输只负责字节流；op 语义（hello 过期判定 / 事件订阅 token / 提交 origin）在此一处，
// daemon 的 IPC server 与 web 的 WS endpoint 各自构造实例。事件扇出同源：两者都走
// core.events 的单一订阅面（blueprint §5 多客户端）。

export interface WireContext {
  core: DaemonCore;
  host: ModuleHost;
  /** 本传输的提交来源：IPC = "cli"（或 daemon 配置），WS = "web" */
  origin: "cli" | "web";
  /** 每次请求的活性回调（daemon 空闲计时） */
  onActivity?: () => void;
  /** hello 判定过期（换图/换 root/模块集变化）→ daemon 自旋退出（D5/§5） */
  onStale: () => void;
}

/** 本连接的下行通道：响应与事件推送共用 */
export type WireSend = (msg: IpcResponse | { event: TopoEvent }) => void;

export function createWireDispatcher(
  ctx: WireContext,
  send: WireSend,
): { handle: (req: IpcRequest) => Promise<void>; dispose: () => void } {
  const { core, host } = ctx;
  /** 本连接的事件订阅：token → 退订函数 */
  const subscribers = new Map<string, () => void>();
  /** 连接关闭时退订全部事件（防止扇出到死通道） */
  const dispose = (): void => {
    for (const un of subscribers.values()) un();
    subscribers.clear();
  };

  const ok = (id: string, result: unknown): void =>
    send({ id, ok: true, instanceId: core.instanceId, result });
  const fail = (id: string, err: unknown): void =>
    send({
      id,
      ok: false,
      instanceId: core.instanceId,
      error:
        err instanceof TopoError
          ? err.toJSON()
          : {
              code: "DAEMON_UNREACHABLE",
              message: `daemon internal error: ${String(err)}`,
            },
    });

  async function handle(req: IpcRequest): Promise<void> {
    ctx.onActivity?.();
    try {
      if (req.op === "hello") {
        // root/graph 提供了才比对（D22：web 客户端不知工作区路径，可省略）
        const rootMismatch =
          req.root !== undefined &&
          path.resolve(req.root) !== path.resolve(core.root);
        if (rootMismatch || (req.graph !== undefined && req.graph !== core.graphId)) {
          // 换图/换 root：如实拒绝 + 旧 daemon 自旋退出（D5：下次触达自动拉起新的）
          send({
            id: req.id,
            ok: false,
            instanceId: core.instanceId,
            error: {
              code: "SESSION_STALE",
              message: `daemon 正在服务图 "${core.graphId}"，与请求的 ${req.graph ?? "(未指定)"} 不符`,
              fix: "直接重试：客户端会自动拉起服务目标图的 daemon",
            },
          });
          setTimeout(() => ctx.onStale(), 50);
          return;
        }
        // 模块集失效检测（blueprint §5）：modules.yaml 摘要变化 = 模块集过期 →
        // 如实拒绝 + 自旋退出，客户端下次触达拉起装载新模块集的 daemon
        if ((await currentModuleBindingDigest(core.root)) !== host.digest) {
          send({
            id: req.id,
            ok: false,
            instanceId: core.instanceId,
            error: {
              code: "SESSION_STALE",
              message: "工作区模块集已变化（modules.yaml），本 daemon 的模块集已过期",
              fix: "直接重试：客户端会自动拉起装载新模块集的 daemon",
            },
          });
          setTimeout(() => ctx.onStale(), 50);
          return;
        }
        ok(req.id, { graphId: core.graphId, revision: core.revision });
        return;
      }
      switch (req.op) {
        case "status":
          ok(req.id, core.status());
          return;
        case "read":
          ok(req.id, core.read(req.query));
          return;
        case "log":
          ok(req.id, core.tailLog(req.limit ?? 50));
          return;
        case "commit":
          ok(req.id, await core.commit(req.input, ctx.origin));
          return;
        case "undo":
          ok(req.id, await core.undo(req.steps ?? 1, ctx.origin));
          return;
        case "redo":
          ok(req.id, await core.redo(req.steps ?? 1, ctx.origin));
          return;
        case "catalog":
          ok(req.id, host.catalog(req.module));
          return;
        case "run":
          ok(req.id, await host.run(req.commandId, req.opts));
          return;
        case "events": {
          const token = crypto.randomUUID();
          const listener = (e: TopoEvent): void => send({ event: e });
          const un = core.events(
            listener,
            req.fromRevision !== undefined
              ? { fromRevision: req.fromRevision }
              : undefined,
          );
          subscribers.set(token, un);
          ok(req.id, { token });
          return;
        }
        case "unlisten": {
          const un = subscribers.get(req.token);
          if (un) {
            un();
            subscribers.delete(req.token);
          }
          ok(req.id, { ok: true });
          return;
        }
        case "shutdown":
          ok(req.id, { ok: true });
          setTimeout(() => ctx.onStale(), 20);
          return;
      }
    } catch (err) {
      fail(req.id, err);
    }
  }

  return { handle, dispose };
}