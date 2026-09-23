import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  createLineDecoder,
  encodeLine,
  TopoError,
  type IpcMessage,
  type IpcRequest,
  type IpcResponse,
  type TopoEvent,
} from "@lukawi/toporealm-protocol";
import { DaemonCore, endpointAddress } from "@lukawi/toporealm-daemon-core";
import {
  ModuleHost,
  currentModuleBindingDigest,
} from "@lukawi/toporealm-module-host";

// ---------- IpcServer：单属主 daemon 的接入面（CLI 现，Web M3 复用同一扇出） ----------

export interface ServeDaemonOptions {
  root: string;
  graph: string;
  /** 空闲退出毫秒；0 = 永不（默认 30000，blueprint §5） */
  idleMs?: number;
  /** 传输来源 → 提交 origin（M1 仅 CLI；web 在 M3 加入） */
  origin?: "cli" | "web";
}

export interface RunningDaemon {
  instanceId: string;
  graphId: string;
  /** 已装载模块 id（模块集启动冻结） */
  modules: readonly string[];
  /** 装载期 warning（声明词汇偏差等） */
  warnings: readonly string[];
  /** 图装载耗时（冷启动断言用） */
  loadMs: number;
  stopped: Promise<void>;
  stop(): Promise<void>;
}

export async function serveDaemon(
  opts: ServeDaemonOptions,
): Promise<RunningDaemon> {
  const idleMs = opts.idleMs ?? 30_000;
  const origin = opts.origin ?? "cli";
  const connections = new Set<net.Socket>();
  let stopRequested = false;
  let idleTimer: NodeJS.Timeout | null = null;

  const core = await DaemonCore.open({
    root: opts.root,
    graphId: opts.graph,
    watch: true,
  });
  // 模块装载（模块集启动冻结）：requires 缺失/声明损坏 → 启动大声失败（M6）
  const host = await ModuleHost.load(core, { root: opts.root });

  let resolveStopped!: () => void;
  const stopped = new Promise<void>((r) => (resolveStopped = r));

  const refreshIdle = (): void => {
    if (idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void stop(), idleMs);
  };

  async function stop(): Promise<void> {
    if (stopRequested) return stopped;
    stopRequested = true;
    if (idleTimer) clearTimeout(idleTimer);
    for (const c of connections) c.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    core.dispose();
    resolveStopped();
  }

  const server = net.createServer((socket) => {
    connections.add(socket);
    refreshIdle();
    /** 本连接的事件订阅：token → 退订函数 */
    const subscribers = new Map<string, () => void>();
    socket.on("close", () => {
      connections.delete(socket);
      for (const un of subscribers.values()) un();
      subscribers.clear();
    });
    const send = (line: string): void => {
      if (!socket.destroyed) socket.write(line);
    };
    const respond = (res: IpcResponse): void => send(encodeLine(res));
    const ok = (id: string, result: unknown): void =>
      respond({ id, ok: true, instanceId: core.instanceId, result });
    const fail = (id: string, err: unknown): void =>
      respond({
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

    const decode = createLineDecoder((raw: IpcMessage) => {
      if (!("op" in raw)) return; // 服务器只接收请求
      void handle(raw as IpcRequest);
    });

    async function handle(req: IpcRequest): Promise<void> {
      refreshIdle();
      try {
        if (req.op === "hello") {
          const sameRoot = path.resolve(req.root) === path.resolve(opts.root);
          if (!sameRoot || (req.graph !== undefined && req.graph !== core.graphId)) {
            // 换图/换 root：如实拒绝 + 旧 daemon 自旋退出（D5：下次触达自动拉起新的）
            respond({
              id: req.id,
              ok: false,
              instanceId: core.instanceId,
              error: {
                code: "SESSION_STALE",
                message: `daemon 正在服务图 "${core.graphId}"，与请求的 ${req.graph ?? "(未指定)"} 不符`,
                fix: "直接重试：客户端会自动拉起服务目标图的 daemon",
              },
            });
            setTimeout(() => void stop(), 50);
            return;
          }
          // 模块集失效检测（blueprint §5）：modules.yaml 摘要变化 = 模块集过期 →
          // 如实拒绝 + 自旋退出，客户端下次触达拉起装载新模块集的 daemon
          if ((await currentModuleBindingDigest(opts.root)) !== host.digest) {
            respond({
              id: req.id,
              ok: false,
              instanceId: core.instanceId,
              error: {
                code: "SESSION_STALE",
                message: "工作区模块集已变化（modules.yaml），本 daemon 的模块集已过期",
                fix: "直接重试：客户端会自动拉起装载新模块集的 daemon",
              },
            });
            setTimeout(() => void stop(), 50);
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
            ok(req.id, await core.commit(req.input, origin));
            return;
          case "undo":
            ok(req.id, await core.undo(req.steps ?? 1, origin));
            return;
          case "redo":
            ok(req.id, await core.redo(req.steps ?? 1, origin));
            return;
          case "catalog":
            ok(req.id, host.catalog(req.module));
            return;
          case "run":
            ok(req.id, await host.run(req.commandId, req.opts));
            return;
          case "events": {
            const token = crypto.randomUUID();
            const listener = (e: TopoEvent): void =>
              send(encodeLine({ event: e }));
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
            setTimeout(() => void stop(), 20);
            return;
        }
      } catch (err) {
        fail(req.id, err);
      }
    }

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => decode.push(chunk));
    socket.on("error", () => {
      /* 连接级错误由 close 统一清理 */
    });
  });

  const ep = endpointAddress(opts.root);
  if (ep.transport === "socket") {
    try {
      fs.unlinkSync(ep.address);
    } catch {
      /* 不存在 */
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ep.address, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  refreshIdle();
  return {
    instanceId: core.instanceId,
    graphId: core.graphId,
    modules: host.loadedIds,
    warnings: host.warnings,
    loadMs: core.loadMs,
    stopped,
    stop,
  };
}
