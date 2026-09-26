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
  currentModuleSetDigest,
} from "@lukawi/toporealm-module-host";

// ---------- wire 分发器（D22 裁决①）：IPC（CLI）与 WS（Web）共用同一请求语义 ----------
//
// 传输只负责字节流；op 语义（hello 过期判定 / 事件订阅 token / 提交 origin）在此一处。
// 1.1.0 D30：core/host 不再固定——经 runtime 提供者按请求解析；hello 显式图 → 就地换载
//（失败如实上抛，旧图继续服务，评审 R2）；非 hello 请求先跟随 active 再入 op 门（与换载互斥）；
// 换载后重订阅事件并推送 reset/graph-switched。

/** daemon 的当前图运行时（daemon 包 GraphRuntime 实现此形状；web 不 import daemon 包） */
export interface WireRuntime {
  /** 实例身份（runtime 级稳定：换载不变，仅 daemon 重启才变化） */
  instanceId(): string;
  current(): { core: DaemonCore; host: ModuleHost };
  /** 跟随 active 指针（必要时换载；失败吞掉——跟随语义） */
  maybeSwap(): Promise<void>;
  /** 显式目标图：必要时换载；失败如实上抛（R2） */
  ensureGraph(graphId: string): Promise<void>;
  /** 请求门：与换载互斥（Y2） */
  beginOp(): Promise<void>;
  endOp(): void;
  /** 换载通知：连接重订阅事件 + 推送 reset */
  onSwap(cb: (pair: { core: DaemonCore; host: ModuleHost }) => void): () => void;
}

export interface WireContext {
  runtime: WireRuntime;
  /** 本传输的提交来源：IPC = "cli"（或 daemon 配置），WS = "web" */
  origin: "cli" | "web";
  /** 每次请求的活性回调（daemon 空闲计时） */
  onActivity?: () => void;
  /** hello 判定过期（换 root/模块集变化）→ daemon 自旋退出（D5/§5） */
  onStale: () => void;
}

/** 本连接的下行通道：响应与事件推送共用 */
export type WireSend = (msg: IpcResponse | { event: TopoEvent }) => void;

export function createWireDispatcher(
  ctx: WireContext,
  send: WireSend,
): { handle: (req: IpcRequest) => Promise<void>; dispose: () => void } {
  /** 本连接的事件订阅：token → { listener, fromRevision, un }（换载重订阅用） */
  const subscribers = new Map<
    string,
    {
      listener: (e: TopoEvent) => void;
      fromRevision?: number;
      un: () => void;
    }
  >();
  /** 换载通知：重订阅全部 token 到新 core + 推送 reset（graph-switched） */
  const offSwap = ctx.runtime.onSwap((pair) => {
    for (const sub of subscribers.values()) {
      sub.un();
      sub.un = pair.core.events(
        sub.listener,
        sub.fromRevision !== undefined ? { fromRevision: sub.fromRevision } : undefined,
      );
    }
    send({
      event: { type: "reset", reason: "graph-switched", graphId: pair.core.graphId },
    });
  });
  /** 会话钉住的图：hello 带显式 graph 时设置（CLI 语义——本会话恒服务该图，D30） */
  let pinnedGraph: string | undefined;
  /** 连接关闭时退订全部事件（防止扇出到死通道） */
  const dispose = (): void => {
    offSwap();
    for (const sub of subscribers.values()) sub.un();
    subscribers.clear();
  };

  const ok = (id: string, result: unknown): void =>
    send({
      id,
      ok: true,
      instanceId: ctx.runtime.instanceId(),
      result,
    });
  const fail = (id: string, err: unknown): void =>
    send({
      id,
      ok: false,
      instanceId: ctx.runtime.instanceId(),
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
        const cur = ctx.runtime.current();
        // root 不符 = 连错 daemon（daemon 按 root 寻址恒定）→ 如实拒绝 + 自旋退出（D5）
        const rootMismatch =
          req.root !== undefined &&
          path.resolve(req.root) !== path.resolve(cur.core.root);
        if (rootMismatch) {
          send({
            id: req.id,
            ok: false,
            instanceId: cur.core.instanceId,
            error: {
              code: "SESSION_STALE",
              message: "daemon 服务的工作区与请求的 root 不符",
              fix: "直接重试：客户端会自动拉起正确工作区的 daemon",
            },
          });
          setTimeout(() => ctx.onStale(), 50);
          return;
        }
        // 1.1.0 D30：显式图 → 就地换载（失败如实上抛，旧图继续服务）并钉住本会话；
        // 省略图（WebUI）→ 跟随 active，且此后每个请求持续跟随（前端自动重载语义）
        if (req.graph !== undefined) {
          await ctx.runtime.ensureGraph(req.graph);
          pinnedGraph = req.graph;
        } else {
          await ctx.runtime.maybeSwap();
        }
        const core = ctx.runtime.current().core;
        // 模块集失效检测（blueprint §5）：有效集摘要变化 → 自旋退出，客户端拉起新模块集 daemon
        const host = ctx.runtime.current().host;
        if (
          (await currentModuleSetDigest(core.root, host.globalRoot)) !==
          host.digest
        ) {
          send({
            id: req.id,
            ok: false,
            instanceId: core.instanceId,
            error: {
              code: "SESSION_STALE",
              message: "工作区模块集已变化，本 daemon 的模块集已过期",
              fix: "直接重试：客户端会自动拉起装载新模块集的 daemon",
            },
          });
          setTimeout(() => ctx.onStale(), 50);
          return;
        }
        ok(req.id, { graphId: core.graphId, revision: core.revision });
        return;
      }

      // 非 hello：钉住会话确保仍在目标图（跨会话换载后拉回）；跟随会话跟随 active（Y3）
      if (pinnedGraph !== undefined) await ctx.runtime.ensureGraph(pinnedGraph);
      else await ctx.runtime.maybeSwap();
      await ctx.runtime.beginOp();
      try {
        const { core, host } = ctx.runtime.current();
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
            const sub = {
              listener,
              ...(req.fromRevision !== undefined ? { fromRevision: req.fromRevision } : {}),
              un: core.events(
                listener,
                req.fromRevision !== undefined
                  ? { fromRevision: req.fromRevision }
                  : undefined,
              ),
            };
            subscribers.set(token, sub);
            ok(req.id, { token });
            return;
          }
          case "unlisten": {
            const sub = subscribers.get(req.token);
            if (sub) {
              sub.un();
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
      } finally {
        ctx.runtime.endOp();
      }
    } catch (err) {
      fail(req.id, err);
    }
  }

  return { handle, dispose };
}
