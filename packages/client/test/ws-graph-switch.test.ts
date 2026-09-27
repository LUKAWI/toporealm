import { afterEach, describe, expect, it } from "vitest";
import type { TopoEvent } from "@lukawi/toporealm-protocol";
import { WsClient } from "../src/ws.js";
import { waitFor } from "./contract.js";

// ---------- P2-1 回归：跟随会话 WS 重连跨图无 reset ----------
//
// 缺陷：WsSession 重连握手只比对 instanceId 不比对 graphId——跟随会话（hello 不带
// graph）断线期间 daemon 被切图，重连后以旧图 lastRevision 重订 → daemon 回放
// 新图补丁，客户端把别图补丁应用到旧图状态且无 reset。
//
// 修法：握手比对 graphId；变化 → reset(graph-switched)（graphId = 新图）+ 采用
// 服务端 revision + 重订不带 from（全新订阅）。图未变时维持 A2b 语义不变。
//
// 用假 WS 内存传输模拟（ws-replay.test.ts 同款装置，graphId 可变）：真实 daemon
// 的换载通知走 wire 推送，此处注入的是「断线期间换图」这一传输窗口态。

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

  push(msg: unknown): void {
    this.dispatch("message", { data: JSON.stringify(msg) });
  }

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

/** 假 wire 服务端：graphId 可变（模拟断线期间 daemon 换载到另一张图） */
class FakeServer {
  revision: number;
  graphId: string;
  readonly instanceId = "fake-instance-1";
  /** 当前图的已发生 commit 事件（回放脚本，revision 升序） */
  readonly script: TopoEvent[] = [];
  readonly requests: WireRequest[] = [];
  readonly conns = new Set<FakeClientConn>();

  constructor(graphId: string, revision: number) {
    this.graphId = graphId;
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

  pushLive(e: TopoEvent): void {
    for (const c of [...this.conns]) c.push({ event: e });
  }

  dropAll(): void {
    for (const c of [...this.conns]) c.drop();
  }
}

function useFakeServer(graphId: string, revision: number): FakeServer {
  const server = new FakeServer(graphId, revision);
  currentServer = server;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  return server;
}

afterEach(() => {
  currentServer = null;
  (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
});

describe("WsSession 重连跨图（P2-1）", () => {
  it("断线期间 daemon 换图：重连后 reset(graph-switched) + 全新订阅不带旧 from（无别图补丁回放）", async () => {
    // 跟随会话落在 g1，本地基准 5
    const server = useFakeServer("g1", 5);
    const url = "ws://fake/graph-switch";
    const s = await new WsClient({
      url,
      reconnect: { maxAttempts: 50, baseDelayMs: 5, maxDelayMs: 20 },
    }).connect({ url });
    expect(s.graphId).toBe("g1");
    const seen: TopoEvent[] = [];
    const un = await s.events((e) => seen.push(e));

    // 断线期间 daemon 换载到 g2（revision 9 领先本地 5——旧图基准对新图毫无意义）
    server.dropAll();
    server.graphId = "g2";
    server.commit(6);
    server.commit(7);
    server.commit(8);
    server.commit(9);

    // 修复前：无任何 reset，且以旧图 from=5 重订 → g2 的 6..9 补丁被回放进旧图状态
    await waitFor(
      () =>
        seen.some(
          (e) => e.type === "reset" && e.reason === "graph-switched",
        ),
      8000,
    );
    const switched = seen.find(
      (e) => e.type === "reset" && e.reason === "graph-switched",
    ) as { graphId?: string };
    expect(switched.graphId).toBe("g2");
    expect(s.graphId).toBe("g2");

    // 全新订阅：不带 fromRevision（修复前此处 = 5，触发别图回放）
    const eventsReqs = server.requests.filter((r) => r.op === "events");
    expect(eventsReqs.length).toBeGreaterThanOrEqual(2);
    expect(eventsReqs.at(-1)?.fromRevision).toBeUndefined();
    // 别图补丁未回放进旧图状态：6..9 的 commit 事件一个都不应出现
    expect(
      seen.some(
        (e) => e.type === "commit" && e.revision >= 6 && e.revision <= 9,
      ),
    ).toBe(false);

    // 全新订阅的 hello 锚点已采用服务端基准：实况 10 无缺口直达，不触发重订
    const eventsBefore = server.requests.filter((r) => r.op === "events").length;
    server.pushLive(server.commit(10));
    await waitFor(() => seen.some((e) => e.type === "commit" && e.revision === 10));
    expect(server.requests.filter((r) => r.op === "events").length).toBe(
      eventsBefore,
    );
    await un();
    await s.close();
  });
});
