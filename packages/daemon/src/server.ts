import net from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  createLineDecoder,
  encodeLine,
  type IpcMessage,
  type IpcRequest,
} from "@lukawi/toporealm-protocol";
import { DaemonCore, endpointAddress } from "@lukawi/toporealm-daemon-core";
import { ModuleHost } from "@lukawi/toporealm-module-host";
import { GraphRuntime } from "./runtime.js";
import {
  startWebServer,
  createWireDispatcher,
  type RunningWebServer,
} from "@lukawi/toporealm-web";

// ---------- IpcServer + web 伺服：单属主 daemon 的接入面（blueprint §5 + D22） ----------
//
// op 语义（hello 过期判定 / 订阅 token / 提交 origin）住在 @lukawi/toporealm-web 的
// createWireDispatcher——IPC 与 WS 共用同一分发器与同一事件扇出（core.events）。

export interface ServeDaemonOptions {
  root: string;
  graph: string;
  /** 空闲退出毫秒；0 = 永不（默认 30000，blueprint §5） */
  idleMs?: number;
  /** IPC 连接的提交来源（默认 "cli"；WS 连接恒为 "web"） */
  origin?: "cli";
  /** web 伺服（D22：随 daemon 常开）；false = 关闭 */
  web?: { port?: number; staticDir?: string } | false;
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
  /** web 伺服（未开启 = null） */
  web: RunningWebServer | null;
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

  // 1.1.0 D30：当前图状态进 GraphRuntime——换载在请求入口就地发生（core/host 随之变化）
  const runtime = await GraphRuntime.open(opts.root, opts.graph);
  const core = runtime.current().core;
  const host = runtime.current().host;

  let resolveStopped!: () => void;
  const stopped = new Promise<void>((r) => (resolveStopped = r));

  async function stop(): Promise<void> {
    if (stopRequested) return stopped;
    stopRequested = true;
    if (idleTimer) clearTimeout(idleTimer);
    for (const c of connections) c.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    if (web) await web.close();
    core.dispose();
    resolveStopped();
  }

  const refreshIdle = (): void => {
    if (idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    // 空闲 = 无连接且无请求（D22 裁决④：打开中的 WS/IPC 连接视作活动——
    // WS 连接不产生请求也要计入，否则「开着页面盯图」30 秒后 daemon 退出）
    idleTimer = setTimeout(() => {
      if (connections.size > 0 || (web !== null && web.clientCount() > 0)) {
        refreshIdle();
        return;
      }
      void stop();
    }, idleMs);
  };

  // web 伺服（D22 裁决②）：随 daemon 常开；hello 过期判定与 shutdown → 自旋退出
  const web =
    opts.web === false
      ? null
      : await startWebServer({
          runtime,
          port: opts.web?.port,
          ...(opts.web?.staticDir !== undefined
            ? { staticDir: opts.web.staticDir }
            : {}),
          onActivity: () => refreshIdle(),
          onStop: () => void stop(),
        });

  const server = net.createServer((socket) => {
    connections.add(socket);
    refreshIdle();
    const dispatcher = createWireDispatcher(
      { runtime, origin, onStale: () => void stop() },
      (msg) => send(encodeLine(msg)),
    );
    socket.on("close", () => {
      connections.delete(socket);
      dispatcher.dispose();
    });
    const send = (line: string): void => {
      if (!socket.destroyed) socket.write(line);
    };

    const decode = createLineDecoder((raw: IpcMessage) => {
      if (!("op" in raw)) return; // 服务器只接收请求
      void dispatcher.handle(raw as IpcRequest);
    });

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => decode.push(chunk));
    socket.on("error", () => {
      /* 连接级错误由 close 统一清理 */
    });
  });

  const ep = endpointAddress(opts.root);
  if (ep.transport === "socket") {
    // D33：listen 前确保 socket 父目录存在（libuv 把 bind 的 ENOENT 转成
    // EACCES，症状极具误导性），再清掉崩溃残留的陈旧 socket。
    await fsp.mkdir(path.dirname(ep.address), { recursive: true });
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
  if (ep.transport === "socket") {
    // D33：tmpdir 是共享目录，socket 文件限属主读写，防他用户连接
    await fsp.chmod(ep.address, 0o600).catch(() => {});
  }

  refreshIdle();
  return {
    instanceId: core.instanceId,
    graphId: core.graphId,
    modules: host.loadedIds,
    warnings: host.warnings,
    loadMs: core.loadMs,
    web,
    stopped,
    stop,
  };
}
