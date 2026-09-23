import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  type IpcMessage,
  type IpcRequest,
} from "@lukawi/toporealm-protocol";
import type { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { ModuleHost } from "@lukawi/toporealm-module-host";
import { createWireDispatcher, type WireContext } from "./dispatch.js";
import { createStaticHandler } from "./static.js";

// ---------- web 伺服（blueprint §2/§5 + D22）：daemon 内 HTTP 静态产物 + /ws 事件端点 ----------
//
// 与 IPC 共用同一 wire 分发器与事件扇出（core.events 单一订阅面）；提交 origin = "web"。

export interface WebServerOptions {
  core: DaemonCore;
  host: ModuleHost;
  /** 监听端口；0 = 临时口（默认，D22 端口解析序的末位） */
  port?: number;
  /** 静态产物目录；缺省 = 不挂静态（纯 WS） */
  staticDir?: string;
  /** 每次请求活性回调（daemon 空闲计时） */
  onActivity?: () => void;
  /** hello 判定过期 / shutdown → daemon 自旋退出 */
  onStop: () => void;
}

export interface RunningWebServer {
  /** 实际监听端口（--port 0 时由 OS 分配） */
  port: number;
  /** 浏览器入口 URL */
  url: string;
  close(): Promise<void>;
}

export async function startWebServer(
  opts: WebServerOptions,
): Promise<RunningWebServer> {
  const serveStatic = opts.staticDir
    ? createStaticHandler(opts.staticDir)
    : null;

  const server = http.createServer((req, res) => {
    if (!serveStatic || req.url?.startsWith("/ws")) {
      res.writeHead(404).end();
      return;
    }
    void serveStatic(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws: WebSocket) => {
    opts.onActivity?.();
    const dispatcher = createWireDispatcher(
      {
        core: opts.core,
        host: opts.host,
        origin: "web",
        onActivity: opts.onActivity,
        onStale: opts.onStop,
      } satisfies WireContext,
      (msg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    );
    ws.on("message", (data: unknown) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return; // 无法解析的帧忽略（与 IPC 行解码同策略）
      }
      if (msg !== null && typeof msg === "object" && "op" in msg) {
        void dispatcher.handle(msg as IpcRequest);
      }
    });
    ws.on("close", () => dispatcher.dispose());
    ws.on("error", () => dispatcher.dispose());
  });

  const port = opts.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actual =
    address !== null && typeof address === "object" ? address.port : port;

  return {
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close();
        server.close(() => resolve());
        for (const c of wss.clients) c.terminate();
      }),
  };
}

/** 类型自检：wire 消息（响应/推送）在 WS 上是纯 JSON 帧 */
export type WebWireMessage = IpcMessage;
