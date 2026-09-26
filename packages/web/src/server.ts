import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  DaemonCore,
  graphPaths,
  loadManifest,
  workspacePaths,
} from "@lukawi/toporealm-daemon-core";
import { WebSocketServer, WebSocket } from "ws";
import {
  type IpcMessage,
  type IpcRequest,
} from "@lukawi/toporealm-protocol";
import { createWireDispatcher, type WireContext } from "./dispatch.js";
import { createStaticHandler } from "./static.js";

// ---------- web 伺服（blueprint §2/§5 + D22）：daemon 内 HTTP 静态产物 + /ws 事件端点 ----------
//
// 与 IPC 共用同一 wire 分发器与事件扇出（core.events 单一订阅面）；提交 origin = "web"。

export interface WebServerOptions {
  runtime: import("./dispatch.js").WireRuntime;
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
  /** 指定端口被占回退临时口时的原端口（D22 裁决②：如实记录） */
  fallbackFrom?: number;
  /** 打开中的 WS 连接数（空闲判定视作活动，D22 裁决④） */
  clientCount(): number;
  close(): Promise<void>;
}

export async function startWebServer(
  opts: WebServerOptions,
): Promise<RunningWebServer> {
  const serveStatic = opts.staticDir
    ? createStaticHandler(opts.staticDir)
    : null;

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/ws")) {
      res.writeHead(426).end();
      return;
    }
    // 1.1.0 D30：只读预览 API——图枚举 + 图快照（其它图的静态预览数据源）
    if (url === "/api/graphs" && req.method === "GET") {
      void handleGraphsList(req, res, opts.runtime);
      return;
    }
    const snapMatch = /^\/api\/graphs\/([^/]+)\/snapshot$/.exec(url);
    if (snapMatch && req.method === "GET") {
      void handleGraphSnapshot(req, res, opts.runtime, decodeURIComponent(snapMatch[1] ?? ""));
      return;
    }
    if (!serveStatic) {
      // D34：纯 WS 模式不装哑巴——明确告知为何没有界面（API/WS 不受影响）
      res
        .writeHead(503, { "content-type": "text/plain; charset=utf-8" })
        .end(
          "WebUI static assets not found — reinstall/upgrade @lukawi/toporealm, or set TOPOREALM_WEB_STATIC to a web-ui/dist directory. /api/* and /ws keep working.",
        );
      return;
    }
    void serveStatic(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  // ws 会把 http server 的 error 事件转发到自身（websocket-server.js addListeners）；
  // 若此处无监听者，emit('error') 会同步抛出并截断 server 自己的 error 监听链——
  // 绑定失败必须走 startWebServer 的回退逻辑，因此这里兜底吞掉（连接级错误由
  // 每 socket 的 error/close 处理，不需要从 wss 冒泡）。
  wss.on("error", () => {});
  wss.on("connection", (ws: WebSocket) => {
    opts.onActivity?.();
    const dispatcher = createWireDispatcher(
      {
        runtime: opts.runtime,
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
  let actual: number;
  let fallbackFrom: number | undefined;
  try {
    actual = await listenHttp(server, port);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (port !== 0 && (code === "EADDRINUSE" || code === "EACCES")) {
      // D22 裁决②：指定端口被占 → 回退临时口；回退事实经 fallbackFrom 如实上报
      fallbackFrom = port;
      actual = await listenHttp(server, 0);
    } else {
      throw err;
    }
  }

  return {
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    ...(fallbackFrom !== undefined ? { fallbackFrom } : {}),
    /** 打开中的 WS 连接数（D22 裁决④：空闲判定的活动面） */
    clientCount: () => wss.clients.size,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close();
        server.close(() => resolve());
        for (const c of wss.clients) c.terminate();
      }),
  };
}

/** 绑定 127.0.0.1:p 并返回实际端口；失败时错误上抛（error 监听一次性挂接） */
function listenHttp(server: http.Server, p: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      server.removeListener("error", onError);
    };
    server.once("error", onError);
    server.listen(p, "127.0.0.1", () => {
      cleanup();
      const address = server.address();
      resolve(address !== null && typeof address === "object" ? address.port : p);
    });
  });
}

/** 类型自检：wire 消息（响应/推送）在 WS 上是纯 JSON 帧 */
export type WebWireMessage = IpcMessage;


// ---------- 只读预览 API（1.1.0 D30） ----------

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function handleGraphsList(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: { current(): { core: DaemonCore } },
): Promise<void> {
  try {
    const core = runtime.current().core;
    const ws = workspacePaths(core.root);
    let names: string[] = [];
    try {
      names = (await fsp.readdir(ws.graphsDir)).filter((n) => !n.startsWith("."));
    } catch {
      /* 无 graphs 目录 = 空列表 */
    }
    const graphs: { id: string; label?: string; revision: number; current: boolean }[] = [];
    for (const id of names.sort()) {
      try {
        const m = await loadManifest(graphPaths(core.root, id));
        graphs.push({
          id,
          ...(m.label !== undefined ? { label: m.label } : {}),
          revision: m.revision,
          current: id === core.graphId,
        });
      } catch {
        /* 非 graph 目录跳过 */
      }
    }
    json(res, 200, { graphs });
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}

async function handleGraphSnapshot(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: { current(): { core: DaemonCore } },
  graphId: string,
): Promise<void> {
  let temp: DaemonCore | null = null;
  try {
    const current = runtime.current().core;
    let core = current;
    if (graphId !== current.graphId) {
      // 其它图：临时只读内核（不监视、不落盘）；读取失败（不存在/损坏）→ 明确报错，不重试（B3）
      try {
        temp = await DaemonCore.open({ root: current.root, graphId, watch: false });
      } catch {
        json(res, 404, { error: `图 "${graphId}" 不存在或不可读` });
        return;
      }
      core = temp;
    }
    const read = core.read({});
    const body = {
      graphId: core.graphId,
      revision: read.revision,
      current: graphId === current.graphId,
      entities: read.entities,
    };
    json(res, 200, body);
  } catch (err) {
    json(res, 500, { error: String(err) });
  } finally {
    if (temp !== null) temp.dispose();
  }
}
