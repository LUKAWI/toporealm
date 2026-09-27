import {
  TopoError,
  type DaemonClient,
  type IpcMessage,
  type IpcRequest,
  type IpcResponse,
  type IpcResultMap,
  type Session,
  type TopoEvent,
} from "@lukawi/toporealm-protocol";
import {
  PendingEntry,
  SessionTransport,
  type SessionOp,
  type TypedRequest,
} from "./transport.js";
// ---------- WsClient：浏览器/Node 的 WS 传输实现（blueprint §2/§5 + D22/D40） ----------
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

/**
 * WS 会话 = 共享传输基座（transport.ts）+ WS 传输策略（D40）：
 * 10 个 Session 方法与 pending/超时/failAll/扇出管道都在基座，这里保留 WS 个性——
 * 重连（指数退避）、fromRevision 重订与缺口自愈（I3/A2）、instanceId 重连握手采纳、
 * 重连窗口请求排队、连接就绪检查、userClosed/close 语义。
 */
export class WsSession extends SessionTransport implements Session {
  graphId = "";
  instanceId = "";
  /** 客户端已吸收到的图 revision（hello/read/commit/事件都对齐；I3 缺口检测基准） */
  private lastRevision: number | null = null;
  private ws: WsLike | null = null;
  private subscribed = false;
  /** 订阅请求在途（带 fromRevision 时 hello 事件不改写 lastRevision——客户端落后是常态） */
  private subscribing = false;
  private subscribingWithFrom = false;
  private userClosed = false;
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
    super();
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
    const res = await this.request({
      id: this.nextId(),
      op: "hello",
      ...(graph !== undefined ? { graph } : {}),
    });
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
        this.onWireMessage(JSON.parse(String(data)) as IpcMessage);
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
      await new Promise((r) => setTimeout(r, Math.min(cap, base * 2 ** (attempt - 1))));
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
      // A2b：重连窗口回放。若 daemon revision 领先本地（退避窗口内有提交），
      // 保留本地基准并以其重订——daemon 会回放 (本地, 现顶] 窗口；
      // 修复前此处无条件覆写 lastRevision 再重订 → 窗口内提交永不补送且无 reset。
      // 若 daemon 未领先（回退/换血），采用服务端值（instanceId 变化路径已有 reset 广播兜底）。
      const localRevision = this.lastRevision;
      const behind = localRevision !== null && res.revision > localRevision;
      if (!behind) this.lastRevision = res.revision;
      if (oldInstance !== "" && oldInstance !== this.instanceId) {
        // daemon 重启：目录缓存作废 → 广播 reset，客户端全量重读（§5）
        this.emit({ type: "reset", reason: "daemon-restarted" });
      }
      if (this.subscribed && this.subToken === null) {
        try {
          await this.sendSubscribe(behind ? (localRevision ?? undefined) : undefined);
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

  // ---------- 传输策略覆写（基座缝） ----------

  /** Session 方法走重连排队：重连窗口内的请求等重连完成后发送（会话透明续用，不立即失败） */
  protected override dispatch<O extends SessionOp>(
    req: TypedRequest<O>,
  ): Promise<IpcResultMap[O]> {
    return this.requestQueued(req);
  }

  /** 字节策略：JSON 文本帧 */
  protected override sendRequest(req: IpcRequest): void {
    this.ws?.send(JSON.stringify(req));
  }

  /** 连接就绪检查：连接不在场且不在重连 → 请求立即失败（等重连完成后重试） */
  protected override checkNotReady(): TopoError | null {
    if (this.ws === null || (this.ws.readyState !== WS_OPEN && !this.reconnecting)) {
      return new TopoError({
        code: "SESSION_STALE",
        message: "连接未就绪",
        fix: "等待自动重连完成后重试",
      });
    }
    return null;
  }

  /** instanceId 指纹：重连握手无条件下接受（变化才广播 reset）；连接存活期变化同 IPC 语义 */
  protected override adoptInstance(m: IpcResponse, p: PendingEntry): boolean {
    if (this.adoptingInstance) {
      // 重连握手响应：无条件下接受新 instanceId（变化才广播 reset）
      this.adoptingInstance = false;
      const changed = this.instanceId !== "" && m.instanceId !== this.instanceId;
      this.instanceId = m.instanceId;
      if (!m.ok) {
        p.reject(TopoError.fromJSON(m.error));
        return true;
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
      return true;
    }
    if (this.instanceId === "") {
      this.instanceId = m.instanceId;
      return false;
    }
    if (m.instanceId !== this.instanceId) {
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
      return true;
    }
    return false;
  }

  /** 事件落地：hello/commit 对齐 lastRevision 基准 + 缺口自愈（I3/A2），再扇出 */
  protected override onEvent(e: TopoEvent): void {
    if (e.type === "hello") {
      // 带 fromRevision 订阅时 hello 只是锚点：客户端落后是常态，不改写基准
      if (!(this.subscribing && this.subscribingWithFrom)) {
        this.lastRevision = e.revision;
      }
    } else if (e.type === "commit") {
      if (this.lastRevision !== null && e.patch.fromRevision !== this.lastRevision) {
        // 不变量 I3：补丁缺口 → 重订阅回放自愈（回放不了 daemon 发 reset，客户端全量重读）。
        // A2：先捕获缺口起点（推进前的 lastRevision）再推进基准——resync 的回放起点
        // 必须是推进前的值，daemon 回放条件 revision > from 才能覆盖缺口区间；
        // 修复前先 bump 再 resync → 缺口事件永不补齐。重复事件被 store 单调吸收，无害。
        const missedFrom = this.lastRevision;
        this.lastRevision = e.patch.toRevision;
        void this.resync(missedFrom);
      } else {
        this.lastRevision = e.patch.toRevision;
      }
    }
    this.emit(e);
  }

  /**
   * 重连窗口内的请求：等重连完成后发送（排队预算是 WS 个性）。
   * 批次 D 魔数对齐：排队预算 = 重连退避总预算（随 WsReconnectOptions 计算，缺省
   * 30 次 × 200ms→2s ≈ 53s）——此前固定 150×100ms = 15s，重连循环仍存活时排队
   * 会提前放弃。预算耗尽后交给 request() 的既有语义如实失败/挂起。
   */
  private async requestQueued<O extends SessionOp>(
    req: TypedRequest<O>,
  ): Promise<IpcResultMap[O]> {
    let waited = 0;
    const budget = this.reconnectBackoffBudgetMs();
    while (waited < budget && this.reconnecting && !this.dead) {
      await new Promise((r) => setTimeout(r, 100));
      waited += 100;
    }
    return this.request(req);
  }

  /** 重连退避总预算（ms）：Σ min(maxDelay, base·2^n)；reconnect:false = 0（不排队）。 */
  private reconnectBackoffBudgetMs(): number {
    if (this.reconnect === false) return 0;
    const max = this.reconnect.maxAttempts ?? 30;
    const base = this.reconnect.baseDelayMs ?? 200;
    const cap = this.reconnect.maxDelayMs ?? 2000;
    let total = 0;
    for (let i = 0; i < max; i++) total += Math.min(cap, base * 2 ** i);
    return total;
  }

  /** 首次订阅：subscribed 位 + fromRevision 缺省取本地基准（回放免全量，I3） */
  protected override async ensureSubscribed(
    opts?: { fromRevision?: number },
  ): Promise<void> {
    if (!this.subscribed) {
      this.subscribed = true;
      const from = opts?.fromRevision ?? this.lastRevision ?? undefined;
      await this.sendSubscribe(from);
    }
  }

  /** 订阅失败：摘除该监听者并复位 subscribed 位（下次 events 重试订阅） */
  protected override onSubscribeFailed(listener: (e: TopoEvent) => void): void {
    this.listeners.delete(listener);
    this.subscribed = false;
  }

  /** 最后一个监听者退订：退订 token + 复位 subscribed 位 */
  protected override teardownSubscription(): void {
    if (this.subToken !== null) {
      this.sendUnlisten();
      this.subscribed = false;
    }
  }

  /** 带修订号的结果推进本地基准（I3 缺口检测基准；单调取大） */
  protected override absorbRevision(res: { revision: number }): void {
    this.lastRevision = Math.max(this.lastRevision ?? 0, res.revision);
  }

  private async sendSubscribe(from?: number): Promise<void> {
    this.subscribing = true;
    this.subscribingWithFrom = from !== undefined;
    try {
      const res = await this.request({
        id: this.nextId(),
        op: "events",
        ...(from !== undefined ? { fromRevision: from } : {}),
      });
      this.subToken = res.token;
    } finally {
      this.subscribing = false;
      this.subscribingWithFrom = false;
    }
  }

  /** I3 自愈：退订旧 token → 带 fromRevision 重订阅（daemon 回放补洞或发 reset）。
   *  from 显式传入时用它作回放起点（缺口场景：推进前的 lastRevision，A2）。 */
  private async resync(from?: number): Promise<void> {
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
      await this.sendSubscribe(from ?? this.lastRevision ?? undefined);
    } catch {
      /* 连接问题：重连路径会恢复订阅 */
    } finally {
      this.resyncing = false;
    }
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
