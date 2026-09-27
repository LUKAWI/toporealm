import { afterEach, describe, expect, it } from "vitest";
import type { TopoEvent } from "@lukawi/toporealm-protocol";
import { WsClient } from "../src/ws.js";
import { waitFor } from "./contract.js";

// ---------- A2 回归：WsSession 回放双缺陷（缺口路径 + 重连窗口路径） ----------
//
// 用假 WS 内存传输模拟（真实 daemon 不会产生跳号、不会丢窗口，只能在此注入）：
//  1. 缺口路径：服务端跳号推 patch（6 号缺失、实况直推 7）→ 客户端必须以推进前的
//     lastRevision（缺口起点 5）重订；daemon 回放条件 revision > from 才能覆盖缺口。
//     修复前先 bump（→7）再 resync → 缺口事件（6）永不补齐，违反 I3。
//  2. 重连窗口：断线期间提交（6、7）→ 重连握手 revision=7 领先本地 5 → 客户端必须
//     保留本地基准重订让 daemon 回放窗口。修复前握手覆写 lastRevision 再重订 →
//     窗口内提交永不补送且无 reset（3/3 运行复现）。
//  3. daemon 回退（revision 未领先）：采用服务端值，全新订阅不带 from。
//
// 假传输与真实 daemon 同序：订阅的 hello 锚点/回放先于 token 响应——
// 客户端 subscribingWithFrom 锚定窗口内的 hello 不改写 lastRevision。

interface WireRequest {
  id: string;
  op: string;
  fromRevision?: number;
  token?: string;
}

type ConnHandler = (ev: unknown) => void;

let currentServer: FakeServer | null = null;
const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

/** 客户端侧连接（WsLike 形状；一个实例 = 一条连接，重连产生新实例） */
class FakeClientConn {
  readyState = 1;
  private readonly handlers = new Map<string, ConnHandler[]>();

  constructor(private readonly server: FakeServer) {
    // open 异步派发：connectWs 在构造返回后才挂 open 监听
    setTimeout(() => {
      this.server.conns.add(this);
      this.dispatch("open", {});
    }, 0);
  }

  addEventListener(type: string, cb: ConnHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(cb);
    this.handlers.set(type, list);
  }

  send(data: string): void {
    this.server.receive(JSON.parse(data) as WireRequest, this);
  }

  close(): void {
    this.readyState = 3;
    this.dispatch("close", {});
  }

  /** 服务端 → 客户端推帧 */
  push(msg: unknown): void {
    this.dispatch("message", { data: JSON.stringify(msg) });
  }

  /** 服务端断开连接 */
  drop(): void {
    this.readyState = 3;
    this.server.conns.delete(this);
    this.dispatch("close", {});
  }

  private dispatch(type: string, ev: unknown): void {
    for (const cb of [...(this.handlers.get(type) ?? [])]) cb(ev);
  }
}

/** globalThis.WebSocket 替身（envWebSocket 按 (url) 构造） */
class FakeWebSocket extends FakeClientConn {
  constructor(_url: string) {
    super(currentServer as FakeServer);
  }
}

/** 假 wire 服务端：hello / events（含 fromRevision 回放）/ unlisten 最小语义 */
class FakeServer {
  revision: number;
  readonly graphId = "g";
  readonly instanceId = "fake-instance-1";
  /** 已发生的 commit 事件（回放脚本，revision 升序） */
  readonly script: TopoEvent[] = [];
  /** 收到的全部请求（断言重订起点用） */
  readonly requests: WireRequest[] = [];
  readonly conns = new Set<FakeClientConn>();

  constructor(revision: number) {
    this.revision = revision;
  }

  receive(req: WireRequest, conn: FakeClientConn): void {
    this.requests.push(req);
    if (req.op === "hello") {
      conn.push({
        id: req.id,
        ok: true,
        instanceId: this.instanceId,
        result: { graphId: this.graphId, revision: this.revision },
      });
      return;
    }
    if (req.op === "events") {
      // 与真实 daemon 同序：hello 锚点/回放先于 token 响应
      conn.push({
        event: { type: "hello", graphId: this.graphId, revision: this.revision },
      });
      const from = req.fromRevision;
      if (from !== undefined && from < this.revision) {
        for (const e of this.script) {
          if (e.type === "commit" && e.revision > from) conn.push({ event: e });
        }
      }
      conn.push({
        id: req.id,
        ok: true,
        instanceId: this.instanceId,
        result: { token: `t-${this.requests.length}` },
      });
      return;
    }
    if (req.op === "unlisten") {
      conn.push({
        id: req.id,
        ok: true,
        instanceId: this.instanceId,
        result: { ok: true },
      });
    }
  }

  /** 服务端推进：记录可回放事件并抬升 revision */
  commit(rev: number): TopoEvent {
    const e: TopoEvent = {
      type: "commit",
      revision: rev,
      origin: "cli",
      patch: {
        fromRevision: rev - 1,
        toRevision: rev,
        objects: { added: [], updated: [], deleted: [] },
        relations: { added: [], updated: [], deleted: [] },
      },
    };
    this.script.push(e);
    this.revision = Math.max(this.revision, rev);
    return e;
  }

  /** 实况推送（可刻意跳号制造缺口） */
  pushLive(e: TopoEvent): void {
    for (const c of [...this.conns]) c.push({ event: e });
  }

  dropAll(): void {
    for (const c of [...this.conns]) c.drop();
  }
}

function useFakeServer(revision: number): FakeServer {
  const server = new FakeServer(revision);
  currentServer = server;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  return server;
}

afterEach(() => {
  currentServer = null;
  (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
});

describe("WsSession 回放（A2：缺口路径 + 重连窗口）", () => {
  it("缺口自愈：跳号 patch → 以推进前基准（缺口起点）重订，缺口事件被回放补齐", async () => {
    const server = useFakeServer(5);
    const url = "ws://fake/gap";
    const s = await new WsClient({ url, reconnect: false }).connect({ url });
    const seen: TopoEvent[] = [];
    const un = await s.events((e) => seen.push(e));
    expect(seen.map((e) => e.type)).toEqual(["hello"]); // 订阅锚点

    // 服务端已产生 6、7，但实况只推 7（跳号制造缺口）
    const e6 = server.commit(6);
    const e7 = server.commit(7);
    server.pushLive(e7);

    // 缺口触发 resync：以推进前 lastRevision=5 重订 → 回放补齐 6、7
    await waitFor(() => seen.some((e) => e.type === "commit" && e.revision === 6));
    await waitFor(() => seen.some((e) => e.type === "commit" && e.revision === 7));
    const eventsReqs = server.requests.filter((r) => r.op === "events");
    expect(eventsReqs.length).toBeGreaterThanOrEqual(2);
    // 修复前此处 = 7（bump 后值）→ 回放条件 revision > from 永不覆盖缺口
    expect(eventsReqs.at(-1)?.fromRevision).toBe(5);

    // 补齐后基准连续：实况 8 正常吸收，不再触发重订
    const eventsBefore = eventsReqs.length;
    const requestsBefore = server.requests.length;
    server.pushLive(server.commit(8));
    await waitFor(() => seen.some((e) => e.type === "commit" && e.revision === 8));
    expect(server.requests.filter((r) => r.op === "events").length).toBe(eventsBefore);
    expect(server.requests.length).toBe(requestsBefore);
    await un();
    await s.close();
  });

  it("重连窗口回放：断线期间的提交经重订补齐（握手不覆写回放起点）", async () => {
    const server = useFakeServer(5);
    const url = "ws://fake/window";
    const s = await new WsClient({
      url,
      reconnect: { maxAttempts: 50, baseDelayMs: 5, maxDelayMs: 20 },
    }).connect({ url });
    const seen: TopoEvent[] = [];
    const un = await s.events((e) => seen.push(e));
    const instanceId = s.instanceId;

    // 断线；退避窗口内服务端推进 6、7
    server.dropAll();
    server.commit(6);
    server.commit(7);

    // 自动重连：握手 revision=7 领先本地 5 → 保留本地基准重订 → daemon 回放窗口
    await waitFor(
      () => seen.some((e) => e.type === "commit" && e.revision === 6),
      8000,
    );
    await waitFor(() => seen.some((e) => e.type === "commit" && e.revision === 7));
    const eventsReqs = server.requests.filter((r) => r.op === "events");
    // 修复前此处 = 7（握手覆写值）→ 窗口内提交永不补送
    expect(eventsReqs.at(-1)?.fromRevision).toBe(5);
    // instanceId 未变：不误报 daemon 重启（无 reset）；会话透明续用
    expect(seen.some((e) => e.type === "reset")).toBe(false);
    expect(s.instanceId).toBe(instanceId);

    // 会话续用：实况 8 正常到达
    server.pushLive(server.commit(8));
    await waitFor(() => seen.some((e) => e.type === "commit" && e.revision === 8));
    await un();
    await s.close();
  });

  it("重连遇 daemon 回退（revision 未领先）：采用服务端基准，全新订阅不带 from", async () => {
    const server = useFakeServer(5);
    const url = "ws://fake/rewind";
    const s = await new WsClient({
      url,
      reconnect: { maxAttempts: 50, baseDelayMs: 5, maxDelayMs: 20 },
    }).connect({ url });
    const seen: TopoEvent[] = [];
    const un = await s.events((e) => seen.push(e));

    // daemon 换血回退到 revision 3（如旧备份恢复）；客户端本地还停在 5
    server.dropAll();
    server.revision = 3;

    await waitFor(
      () => server.requests.filter((r) => r.op === "events").length >= 2,
      8000,
    );
    const eventsReqs = server.requests.filter((r) => r.op === "events");
    expect(eventsReqs).toHaveLength(2);
    expect(eventsReqs.at(-1)?.fromRevision).toBeUndefined();
    // 服务端基准被采用：其后实况 4 无缺口直达（不触发重订）
    server.pushLive(server.commit(4));
    await waitFor(() => seen.some((e) => e.type === "commit" && e.revision === 4));
    expect(server.requests.filter((r) => r.op === "events").length).toBe(2);
    await un();
    await s.close();
  });
});
