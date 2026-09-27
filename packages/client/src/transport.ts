import {
  TopoError,
  type Catalog,
  type CommandRunResult,
  type CommitInput,
  type CommitResult,
  type EntityId,
  type GraphSummary,
  type IpcMessage,
  type IpcRequest,
  type IpcResponse,
  type IpcResultMap,
  type LogEntry,
  type ReadQuery,
  type ReadResult,
  type TopoEvent,
  type Unsubscribe,
} from "@lukawi/toporealm-protocol";

// ---------- SessionTransport：三 adapter（ipc/ws/memory）的共享会话传输基座（blueprint §1.11 D40） ----------
//
// 1.0/1.1 三 adapter 各自手写 Session 的 10 个方法与请求管道（pending 表/超时/failAll/
// listener 扇出，ipc 与 ws 近乎同构）。本基座把管道收敛为一处，IpcResultMap（wire.ts，
// 原零使用死代码）转正为 op→result 的类型脊柱：request 按 op 泛型解析返回值，Session
// 方法骨架只写一次。三 adapter 只覆盖各自的「传输策略」：
//   · 字节怎么发（sendRequest）：ipc = NDJSON 行帧写 socket；ws = JSON 文本帧；
//     memory = 直连 DaemonCore/ModuleHost（dispatch 按 op 落到进程内调用，不走 wire）。
//   · 请求落地策略（dispatch）：缺省 = request；ws 覆写为重连窗口排队（requestQueued）。
//   · 连接怎么建/断（建连、重连、drop 处理、close）——全部留在 adapter。
//   · instanceId 失效策略（adoptInstance）与订阅策略（ensureSubscribed）——各 adapter
//     语义不同（ipc 首响固定指纹；ws 重连握手无条件下接受 + fromRevision 重订），留缝覆写。
// 超时（30s）、排队上限（ws 150×100ms）、错误信封与 TopoError.fromJSON 重建语义：
// wire 侧（ipc/ws）共用本基座的同一份实现，memory 直接得到原生 TopoError——三处一致。
// 本文件零 node 依赖（只用标准定时器与 Promise）：ws.ts/浏览器出口经此类保持浏览器可用。

/** Session 方法骨架涉及的全部 wire op（IpcResultMap 键面） */
export type SessionOp = keyof IpcResultMap;

/** 按 op 泛型的 wire 请求（IpcRequest 的单成员 + op 字面量推断位） */
export type TypedRequest<O extends SessionOp> = IpcRequest & { op: O };

/** 在途请求登记（pending 表条目） */
export type PendingEntry = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

const REQUEST_TIMEOUT_MS = 30_000;

export abstract class SessionTransport {
  protected dead = false;
  /** daemon 订阅 token（ipc 退订/重订共用；ws 重连后按 fromRevision 重订前先退订） */
  protected subToken: string | null = null;
  private next = 1;
  private readonly pending = new Map<string, PendingEntry>();
  protected readonly listeners = new Set<(e: TopoEvent) => void>();

  protected nextId(): string {
    return String(this.next++);
  }

  // ---------- Session 契约骨架（10 法只写一次；经 dispatch 落到各 adapter 策略） ----------

  async status(): Promise<GraphSummary> {
    const res = await this.dispatch({ id: this.nextId(), op: "status" });
    this.absorbRevision(res);
    return res;
  }

  async read(query?: ReadQuery): Promise<ReadResult> {
    const res = await this.dispatch({
      id: this.nextId(),
      op: "read",
      ...(query !== undefined ? { query } : {}),
    });
    this.absorbRevision(res);
    return res;
  }

  async log(opts?: { limit?: number }): Promise<readonly LogEntry[]> {
    return this.dispatch({
      id: this.nextId(),
      op: "log",
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    });
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    const res = await this.dispatch({ id: this.nextId(), op: "commit", input });
    this.absorbRevision(res);
    return res;
  }

  async undo(steps?: number): Promise<CommitResult> {
    const res = await this.dispatch({
      id: this.nextId(),
      op: "undo",
      ...(steps !== undefined ? { steps } : {}),
    });
    this.absorbRevision(res);
    return res;
  }

  async redo(steps?: number): Promise<CommitResult> {
    const res = await this.dispatch({
      id: this.nextId(),
      op: "redo",
      ...(steps !== undefined ? { steps } : {}),
    });
    this.absorbRevision(res);
    return res;
  }

  async catalog(module?: string): Promise<Catalog> {
    return this.dispatch({
      id: this.nextId(),
      op: "catalog",
      ...(module !== undefined ? { module } : {}),
    });
  }

  async run(
    commandId: string,
    opts?: { target?: EntityId; input?: unknown },
  ): Promise<CommandRunResult> {
    return this.dispatch({
      id: this.nextId(),
      op: "run",
      commandId,
      ...(opts !== undefined ? { opts } : {}),
    });
  }

  abstract close(): Promise<void>;

  async events(
    listener: (e: TopoEvent) => void,
    opts?: { fromRevision?: number },
  ): Promise<Unsubscribe> {
    this.listeners.add(listener);
    try {
      await this.ensureSubscribed(opts);
    } catch (err) {
      this.onSubscribeFailed(listener);
      throw err;
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.teardownSubscription();
    };
  }

  // ---------- adapter 策略缝 ----------

  /** 请求落地策略：缺省 = wire request；ws 覆写为重连排队；memory 覆写为进程内直调 */
  protected dispatch<O extends SessionOp>(
    req: TypedRequest<O>,
  ): Promise<IpcResultMap[O]> {
    return this.request(req);
  }

  /** 字节怎么上 wire（ipc：NDJSON 行帧；ws：JSON 文本帧）；memory 直连不经过此缝 */
  protected abstract sendRequest(req: IpcRequest): void;

  /** 发送前的就绪检查（ws：连接不在场且不在重连 → SESSION_STALE「连接未就绪」）；null = 就绪 */
  protected checkNotReady(): TopoError | null {
    return null;
  }

  /** events 首次订阅策略（ipc：取 subToken；ws：subscribed 位 + fromRevision 缺省取本地基准） */
  protected async ensureSubscribed(_opts?: {
    fromRevision?: number;
  }): Promise<void> {}

  /** 订阅失败善后（ws：摘除该监听者并复位 subscribed；ipc：维持原状——监听者留在集合） */
  protected onSubscribeFailed(_listener: (e: TopoEvent) => void): void {}

  /** 最后一个监听者退订（缺省：退订 token；ws 覆写另需复位 subscribed 位） */
  protected teardownSubscription(): void {
    this.sendUnlisten();
  }

  /**
   * 响应侧 instanceId 指纹策略；返回 true = 已处理（不走 resolve/reject 常规路径）。
   * ipc：首响固定指纹，变化 = daemon 重启 → 会话作废 + reset 广播；
   * ws：重连握手期无条件下接受（adoptingInstance），存活期变化同 ipc 语义。
   */
  protected adoptInstance(_m: IpcResponse, _p: PendingEntry): boolean {
    return false;
  }

  /** 带修订号的结果落地钩子（ws：推进 lastRevision 基准；ipc/memory：无操作） */
  protected absorbRevision(_res: { revision: number }): void {}

  // ---------- 共享管道（三 adapter 唯一份） ----------

  /** 按 op 泛型的请求：dead 检查 → 就绪检查 → pending 登记 + 30s 超时 → 发送。
   *  返回类型由 IpcResultMap 脊柱按 op 解析，调用方无需 as 断言。 */
  protected request<O extends SessionOp>(
    req: TypedRequest<O>,
  ): Promise<IpcResultMap[O]> {
    if (this.dead) {
      return Promise.reject(
        new TopoError({ code: "SESSION_STALE", message: "会话已失效", fix: "重新 connect" }),
      );
    }
    const notReady = this.checkNotReady();
    if (notReady !== null) return Promise.reject(notReady);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(req.id);
        if (p !== undefined) {
          this.pending.delete(req.id);
          p.reject(
            new TopoError({ code: "DAEMON_UNREACHABLE", message: "daemon 响应超时" }),
          );
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(req.id, {
        resolve: (v) => resolve(v as IpcResultMap[O]),
        reject,
        timer,
      });
      try {
        this.sendRequest(req);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(req.id);
        reject(err);
      }
    });
  }

  protected failAll(err: TopoError): void {
    for (const [, p] of [...this.pending]) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** 事件扇出（监听器异常不阻断广播） */
  protected emit(e: TopoEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* 监听器异常不阻断广播 */
      }
    }
  }

  /** wire 消息入口：ipc 的 NDJSON 行解码与 ws 的帧解析都汇到这里分发 */
  protected onWireMessage(m: IpcMessage): void {
    if ("event" in m) {
      this.onEvent(m.event);
      return;
    }
    this.handleResponse(m);
  }

  /** 事件落地策略（ws 覆写：hello/commit 对齐 lastRevision 基准 + 缺口自愈）；缺省直接扇出 */
  protected onEvent(e: TopoEvent): void {
    this.emit(e);
  }

  private handleResponse(m: IpcResponse): void {
    const p = this.pending.get(m.id);
    if (p === undefined) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (this.adoptInstance(m, p)) return;
    if (m.ok) p.resolve(m.result);
    else p.reject(TopoError.fromJSON(m.error));
  }

  /** 退订当前 token（fire-and-forget；幂等：无 token 即空操作） */
  protected sendUnlisten(): void {
    if (this.subToken === null) return;
    const token = this.subToken;
    this.subToken = null;
    void this.request({ id: this.nextId(), op: "unlisten", token }).catch(
      () => {},
    );
  }
}
