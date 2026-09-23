import {
  TopoError,
  type Catalog,
  type CommandRunResult,
  type CommitInput,
  type CommitResult,
  type DaemonClient,
  type EntityId,
  type GraphSummary,
  type IpcRequest,
  type IpcResponse,
  type LogEntry,
  type ReadQuery,
  type ReadResult,
  type Session,
  type TopoEvent,
  type Unsubscribe,
} from "@lukawi/toporealm-protocol";
// ---------- WsClient：浏览器/Node 的 WS 传输实现（blueprint §2/§5 + D22） ----------
//
// 同一 Session 契约的第三 adapter：WS 文本帧 = wire 信封（IpcRequest/IpcResponse/IpcPush），
// 与 IPC 共用同一分发语义与同一事件扇出。D22 重连语义：
//   · 异常断线自动重连（指数退避，次数可配）；
//   · 重连成功带 fromRevision = 本地最后 revision 重新订阅（daemon 回放补洞 / 发 reset
//     自愈，不变量 I3）；事件途中发现补丁缺口同样触发重订阅回放；
//   · 重连握手发现 instanceId 变化 = SESSION_STALE：在途请求失败 + 向监听者广播
//     reset(daemon-restarted)（目录缓存作废重拉，§5）；会话对象透明续用于新 daemon。
// 依赖环境提供标准 WebSocket（浏览器 / Node ≥22）。
// 断线瞬间在途的请求按传输一致性语义失败（DAEMON_UNREACHABLE），会话恢复后可重试。

export interface WsReconnectOptions {
  /** 最大尝试次数（默认 30；0 = 不自动重连） */
  maxAttempts?: number;
  /** 首次退避毫秒（默认 200） */
  baseDelayMs?: number;
  /** 退避上限毫秒（默认 2000） */
  maxDelayMs?: number;
}

export interface WsClientOptions {
  /** ws(s)://host:port/ws；缺省时浏览器取当前页面源，Node 由 root 的 endpoint.webPort 推导 */
  url?: string;
  /** 异常断线自动重连；false = 关闭（默认开启：30 次 × 200ms→2s 退避） */
  reconnect?: WsReconnectOptions | false;
  /** 连接超时毫秒（默认 10000） */
  connectTimeoutMs?: number;
}

/** 环境标准 WebSocket 的最小结构面（避免依赖 DOM lib） */
interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    cb: (ev: unknown) => void,
  ): void;
}

const WS_OPEN = 1;
const REQUEST_TIMEOUT_MS = 30_000;

function envWebSocket(): {
  new (url: string): unknown;
} {
  const ws = (globalThis as { WebSocket?: abstract new (url: string) => unknown })
    .WebSocket;
  if (ws === undefined) {
    throw new TopoError({
      code: "DAEMON_UNREACHABLE",
      message: "当前环境没有 WebSocket（需要浏览器或 Node ≥22）",
    });
  }
  return ws as new (url: string) => unknown;
}

function connectWs(url: string, timeoutMs: number): Promise<WsLike> {
  const WS = envWebSocket();
  return new Promise<WsLike>((resolve, reject) => {
    let settled = false;
    let ws: WsLike;
    try {
      ws = new WS(url) as unknown as WsLike;
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
      reject(new Error("websocket connect timeout"));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("websocket connect failed"));
    });
    ws.addEventListener("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("websocket closed before open"));
    });
  });
}

/** 浏览器缺省 URL：同源 /ws */
export function defaultWsUrl(): string | undefined {
  const loc = (
    globalThis as {
      location?: { protocol: string; host: string };
    }
  ).location;
  if (loc === undefined) return undefined;
  return `ws${loc.protocol === "https:" ? "s" : ""}://${loc.host}/ws`;
}

export class WsClient implements DaemonClient {
  constructor(private readonly opts: WsClientOptions = {}) {}

  async connect(
    connectOpts?: { url?: string; root?: string; graph?: string },
  ): Promise<Session> {
    const url = connectOpts?.url ?? this.opts.url ?? defaultWsUrl();
    if (url === undefined) {
      throw new TopoError({
        code: "DAEMON_UNREACHABLE",
        message: "无法确定 web daemon 的 WS 地址",
        hint: "connect({ url }) 显式指定；浏览器同源可自动推导；Node 侧用 wsUrlFromEndpoint(root) 推导",
      });
    }
    const session = new WsSession(url, this.opts);
    await session.open(connectOpts?.graph);
    return session;
  }
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class WsSession implements Session {
  graphId = "";
  instanceId = "";
  /** 客户端已吸收到的图 revision（hello/read/commit/事件都对齐；I3 缺口检测基准） */
  private lastRevision: number | null = null;
  private ws: WsLike | null = null;
  private next = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(e: TopoEvent) => void>();
  private subToken: string | null = null;
  private subscribed = false;
  /** 订阅请求在途（带 fromRevision 时 hello 事件不改写 lastRevision——客户端落后是常态） */
  private subscribing = false;
  private subscribingWithFrom = false;
  private userClosed = false;
  private dead = false;
  private reconnecting = false;
  private resyncing = false;
  /** 重连握手期：接受（可能变化的）instanceId，不触发在途失败路径 */
  private adoptingInstance = false;
  private readonly reconnect: WsReconnectOptions | false;
  private readonly connectTimeoutMs: number;

  constructor(
    private readonly url: string,
    opts: WsClientOptions,
  ) {
    this.reconnect =
      opts.reconnect === undefined
        ? { maxAttempts: 30, baseDelayMs: 200, maxDelayMs: 2000 }
        : opts.reconnect;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  }

  /** 首次连接：open + hello 握手 */
  async open(graph?: string): Promise<void> {
    this.ws = await connectWs(this.url, this.connectTimeoutMs).catch(
      (err: unknown) => {
        throw new TopoError({
          code: "DAEMON_UNREACHABLE",
          message: `web daemon 连接失败：${this.url}`,
          hint: err instanceof Error ? err.message : String(err),
        });
      },
    );
    this.attach();
    const res = (await this.request({
      id: this.nextId(),
      op: "hello",
      ...(graph !== undefined ? { graph } : {}),
    })) as { graphId: string; revision: number };
    this.graphId = res.graphId;
    this.lastRevision = res.revision;
  }

  // ---------- 连接生命周期 ----------

  private attach(): void {
    const ws = this.ws;
    if (ws === null) return;
    ws.addEventListener("message", (ev: unknown) => {
      const data = (ev as { data?: unknown }).data;
      try {
        this.onMessage(
          JSON.parse(String(data)) as IpcResponse | { event: TopoEvent },
        );
      } catch {
        /* 无法解析的帧忽略 */
      }
    });
    ws.addEventListener("close", () => void this.onDrop());
    ws.addEventListener("error", () => {
      /* close 随后到来；统一在 onDrop 处理 */
    });
  }

  private async onDrop(): Promise<void> {
    if (this.userClosed || this.dead || this.reconnecting) return;
    // 服务端订阅随连接关闭而清理：丢弃旧 token，重连后按 fromRevision 重订（D22 裁决③）
    this.subToken = null;
    this.failAll(
      new TopoError({
        code: "DAEMON_UNREACHABLE",
        message: "与 web daemon 的连接已断开",
        fix: "会话自动重连后重试",
      }),
    );
    if (this.reconnect === false) {
      this.dead = true;
      return;
    }
    this.reconnecting = true;
    const max = this.reconnect.maxAttempts ?? 30;
    const base = this.reconnect.baseDelayMs ?? 200;
    const cap = this.reconnect.maxDelayMs ?? 2000;
    for (let attempt = 1; attempt <= max; attempt++) {
      if (this.userClosed || this.dead) {
        this.reconnecting = false;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.min(cap, base * attempt)));
      let ws: WsLike;
      try {
        ws = await connectWs(this.url, this.connectTimeoutMs);
      } catch {
        continue;
      }
      this.ws = ws;
      this.attach();
      // 重连握手（D22 裁决③）：接受新 instanceId；被拒（如模块集过期自旋）→ 下一轮
      const oldInstance = this.instanceId;
      this.adoptingInstance = true;
      let res: { graphId: string; revision: number };
      try {
        res = (await this.request({
          id: this.nextId(),
          op: "hello",
        })) as { graphId: string; revision: number };
      } catch {
        continue;
      }
      this.reconnecting = false;
      this.graphId = res.graphId;
      this.lastRevision = res.revision;
      if (oldInstance !== "" && oldInstance !== this.instanceId) {
        // daemon 重启：目录缓存作废 → 广播 reset，客户端全量重读（§5）
        this.emit({ type: "reset", reason: "daemon-restarted" });
      }
      if (this.subscribed && this.subToken === null) {
        try {
          await this.sendSubscribe(this.lastRevision ?? undefined);
        } catch {
          /* 重订阅失败 → 下次事件缺口触发 resync 兜底 */
        }
      }
      return;
    }
    this.reconnecting = false;
    this.dead = true;
    this.failAll(
      new TopoError({
        code: "DAEMON_UNREACHABLE",
        message: `web daemon 重连失败（已尝试 ${max} 次）：${this.url}`,
        fix: "刷新页面或检查 daemon 是否在运行",
      }),
    );
  }

  // ---------- wire 消息 ----------

  private onMessage(m: IpcResponse | { event: TopoEvent }): void {
    if ("event" in m) {
      this.onEvent(m.event);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (this.adoptingInstance) {
      // 重连握手响应：无条件下接受新 instanceId（变化才广播 reset）
      this.adoptingInstance = false;
      const changed = this.instanceId !== "" && m.instanceId !== this.instanceId;
      this.instanceId = m.instanceId;
      if (!m.ok) {
        p.reject(TopoError.fromJSON(m.error));
        return;
      }
      if (changed) {
        this.failAll(
          new TopoError({
            code: "SESSION_STALE",
            message: "daemon 已重启（instanceId 变化），目录缓存作废",
            fix: "全量重读（监听 reset 事件自愈）",
          }),
        );
      }
      p.resolve(m.result);
      return;
    }
    if (this.instanceId === "") {
      this.instanceId = m.instanceId;
    } else if (m.instanceId !== this.instanceId) {
      // 连接存活期间 daemon 被整体替换（WS 上罕见）——兜底同 IPC 语义
      this.instanceId = m.instanceId;
      this.failAll(
        new TopoError({
          code: "SESSION_STALE",
          message: "daemon 已重启（instanceId 变化），目录缓存作废",
          fix: "全量重读（监听 reset 事件自愈）",
        }),
      );
      this.emit({ type: "reset", reason: "daemon-restarted" });
      p.reject(
        new TopoError({ code: "SESSION_STALE", message: "daemon 已重启（instanceId 变化）" }),
      );
      return;
    }
    if (m.ok) p.resolve(m.result);
    else p.reject(TopoError.fromJSON(m.error));
  }

  private onEvent(e: TopoEvent): void {
    if (e.type === "hello") {
      // 带 fromRevision 订阅时 hello 只是锚点：客户端落后是常态，不改写基准
      if (!(this.subscribing && this.subscribingWithFrom)) {
        this.lastRevision = e.revision;
      }
    } else if (e.type === "commit") {
      if (this.lastRevision !== null && e.patch.fromRevision !== this.lastRevision) {
        // 不变量 I3：补丁缺口 → 重订阅回放自愈（回放不了 daemon 发 reset，客户端全量重读）
        this.lastRevision = e.patch.toRevision;
        void this.resync();
      } else {
        this.lastRevision = e.patch.toRevision;
      }
    }
    this.emit(e);
  }

  private emit(e: TopoEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* 监听器异常不阻断广播 */
      }
    }
  }

  private failAll(err: TopoError): void {
    for (const [, p] of [...this.pending]) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private nextId(): string {
    return String(this.next++);
  }

  private request(req: IpcRequest): Promise<unknown> {
    if (this.dead) {
      return Promise.reject(
        new TopoError({ code: "SESSION_STALE", message: "会话已失效", fix: "重新 connect" }),
      );
    }
    if (this.ws === null || (this.ws.readyState !== WS_OPEN && !this.reconnecting)) {
      return Promise.reject(
        new TopoError({
          code: "SESSION_STALE",
          message: "连接未就绪",
          fix: "等待自动重连完成后重试",
        }),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(req.id)) {
          reject(
            new TopoError({ code: "DAEMON_UNREACHABLE", message: "daemon 响应超时" }),
          );
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(req.id, { resolve, reject, timer });
      try {
        this.ws?.send(JSON.stringify(req));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(req.id);
        reject(err);
      }
    });
  }

  /** 重连窗口内的请求：等重连完成后发送（会话透明续用，不立即失败） */
  private async requestQueued(req: IpcRequest): Promise<unknown> {
    for (let i = 0; i < 150 && this.reconnecting && !this.dead; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.request(req);
  }

  // ---------- Session 契约 ----------

  async status(): Promise<GraphSummary> {
    const st = (await this.requestQueued({
      id: this.nextId(),
      op: "status",
    })) as GraphSummary;
    this.absorb(st.revision);
    return st;
  }

  async read(query?: ReadQuery): Promise<ReadResult> {
    const res = (await this.requestQueued({
      id: this.nextId(),
      op: "read",
      ...(query !== undefined ? { query } : {}),
    })) as ReadResult;
    this.absorb(res.revision);
    return res;
  }

  async log(opts?: { limit?: number }): Promise<readonly LogEntry[]> {
    return (await this.requestQueued({
      id: this.nextId(),
      op: "log",
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    })) as readonly LogEntry[];
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    const r = (await this.requestQueued({
      id: this.nextId(),
      op: "commit",
      input,
    })) as CommitResult;
    this.absorb(r.revision);
    return r;
  }

  async undo(steps?: number): Promise<CommitResult> {
    const r = (await this.requestQueued({
      id: this.nextId(),
      op: "undo",
      ...(steps !== undefined ? { steps } : {}),
    })) as CommitResult;
    this.absorb(r.revision);
    return r;
  }

  async redo(steps?: number): Promise<CommitResult> {
    const r = (await this.requestQueued({
      id: this.nextId(),
      op: "redo",
      ...(steps !== undefined ? { steps } : {}),
    })) as CommitResult;
    this.absorb(r.revision);
    return r;
  }

  async catalog(module?: string): Promise<Catalog> {
    return (await this.requestQueued({
      id: this.nextId(),
      op: "catalog",
      ...(module !== undefined ? { module } : {}),
    })) as Catalog;
  }

  async run(
    commandId: string,
    opts?: { target?: EntityId; input?: unknown },
  ): Promise<CommandRunResult> {
    return (await this.requestQueued({
      id: this.nextId(),
      op: "run",
      commandId,
      ...(opts !== undefined ? { opts } : {}),
    })) as CommandRunResult;
  }

  async events(
    listener: (e: TopoEvent) => void,
    opts?: { fromRevision?: number },
  ): Promise<Unsubscribe> {
    this.listeners.add(listener);
    if (!this.subscribed) {
      this.subscribed = true;
      const from = opts?.fromRevision ?? this.lastRevision ?? undefined;
      try {
        await this.sendSubscribe(from);
      } catch (err) {
        this.listeners.delete(listener);
        this.subscribed = false;
        throw err;
      }
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.subToken !== null) {
        const token = this.subToken;
        this.subToken = null;
        this.subscribed = false;
        void this.request({ id: this.nextId(), op: "unlisten", token }).catch(
          () => {},
        );
      }
    };
  }

  private async sendSubscribe(from?: number): Promise<void> {
    this.subscribing = true;
    this.subscribingWithFrom = from !== undefined;
    try {
      const res = (await this.request({
        id: this.nextId(),
        op: "events",
        ...(from !== undefined ? { fromRevision: from } : {}),
      })) as { token: string };
      this.subToken = res.token;
    } finally {
      this.subscribing = false;
      this.subscribingWithFrom = false;
    }
  }

  /** I3 自愈：退订旧 token → 带 fromRevision 重订阅（daemon 回放补洞或发 reset） */
  private async resync(): Promise<void> {
    if (this.resyncing || !this.subscribed) return;
    this.resyncing = true;
    try {
      if (this.subToken !== null) {
        const old = this.subToken;
        this.subToken = null;
        await this.request({
          id: this.nextId(),
          op: "unlisten",
          token: old,
        }).catch(() => {});
      }
      await this.sendSubscribe(this.lastRevision ?? undefined);
    } catch {
      /* 连接问题：重连路径会恢复订阅 */
    } finally {
      this.resyncing = false;
    }
  }

  private absorb(revision: number): void {
    this.lastRevision = Math.max(this.lastRevision ?? 0, revision);
  }

  async close(): Promise<void> {
    this.userClosed = true;
    this.dead = true;
    if (this.subToken !== null) {
      const token = this.subToken;
      this.subToken = null;
      try {
        this.ws?.send(JSON.stringify({ id: this.nextId(), op: "unlisten", token }));
      } catch {
        /* 忽略 */
      }
    }
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
    this.failAll(new TopoError({ code: "SESSION_STALE", message: "会话已关闭" }));
  }
}
