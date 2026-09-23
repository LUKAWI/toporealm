import net from "node:net";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  DaemonCore,
  endpointAddress,
  graphPaths,
} from "@lukawi/toporealm-daemon-core";
import {
  readEndpoint,
  serveDaemon,
  writeEndpoint,
  type RunningDaemon,
} from "@lukawi/toporealm-daemon";
import { IpcClient } from "../src/ipc.js";
import { WsClient } from "../src/ws.js";
import { wsUrlFromEndpoint } from "../src/lifecycle.js";
import type { TopoEvent } from "@lukawi/toporealm-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sleep, waitFor } from "./contract.js";

// ---------- WS 传输一致性 + web 生命周期（blueprint §5/§8 + D22） ----------
// 覆盖：双客户端并发（IPC+WS 同图互见）、外部编辑 → reset → 自愈、
// 断线重连 + instanceId 失效（SESSION_STALE / reset）、静态产物伺服、endpoint.webPort 发现面。

let root: string;
let daemon: RunningDaemon;
const wsBase = (): string => `ws://127.0.0.1:${(daemon.web as { port: number }).port}/ws`;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-wst-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "g1");
  daemon = await serveDaemon({ root, graph: "g1", idleMs: 0, web: { port: 0 } });
});

afterAll(async () => {
  await daemon.stop();
});

/** daemon 未写 endpoint（toporeald 才写）：IPC 附加用，按真实事实伪造一份 */
async function attachEndpointForIpc(): Promise<void> {
  const ep = endpointAddress(root);
  await writeEndpoint(root, {
    transport: ep.transport,
    address: ep.address,
    pid: process.pid,
    instanceId: daemon.instanceId,
    graphId: daemon.graphId,
    startedAt: new Date().toISOString(),
    ...(daemon.web !== null ? { webPort: daemon.web.port } : {}),
  });
}

describe("WS 传输一致性 + web 生命周期", () => {
  it("fromRevision 回放：断线窗口内的提交经重订阅补洞（I3 回放路径）", async () => {
    const client = new WsClient();
    const s = await client.connect({ url: wsBase() });
    const st = await s.status();
    const r = await s.commit({
      changes: [{ op: "put", kind: "rp", id: "ws-rp-1" }],
      label: "ws-replay",
    });
    const seen: TopoEvent[] = [];
    const un = await s.events((e) => seen.push(e), { fromRevision: st.revision });
    expect(seen[0]?.type).toBe("hello");
    expect(seen.some((e) => e.type === "commit" && e.revision === r.revision)).toBe(true);
    // 重放后客户端 revision 基准 = 图顶：后续实况事件无缺口
    const r2 = await s.commit({ changes: [{ op: "put", kind: "rp", id: "ws-rp-2" }] });
    await waitFor(() => seen.some((e) => e.type === "commit" && e.revision === r2.revision));
    await un();
    await s.close();
  });

  it("双客户端并发：IPC（CLI 缝）与 WS（web 缝）同图互见，origin 如实（共用扇出）", async () => {
    await attachEndpointForIpc();
    const ipc = await new IpcClient().connect({ root, graph: "g1" });
    const ws = await new WsClient().connect({ url: wsBase() });
    const wsSeen: TopoEvent[] = [];
    const ipcSeen: TopoEvent[] = [];
    const unWs = await ws.events((e) => wsSeen.push(e));
    const unIpc = await ipc.events((e) => ipcSeen.push(e));
    // IPC 提交 → WS 可见
    const r1 = await ipc.commit({
      changes: [{ op: "put", kind: "x", id: "duet-ipc" }],
      label: "from-ipc",
    });
    await waitFor(() => wsSeen.some((e) => e.type === "commit" && e.revision === r1.revision));
    // WS 提交 → IPC 可见，origin = "web"
    const r2 = await ws.commit({
      changes: [{ op: "put", kind: "x", id: "duet-ws" }],
      label: "from-web",
    });
    await waitFor(() => ipcSeen.some((e) => e.type === "commit" && e.revision === r2.revision));
    const webEv = ipcSeen.find(
      (e) => e.type === "commit" && e.revision === r2.revision,
    ) as { origin: string } | undefined;
    expect(webEv?.origin).toBe("web");
    await expect(ipc.status()).resolves.toMatchObject({ revision: r2.revision });
    await unWs();
    await unIpc();
    await ipc.close();
    await ws.close();
  }, 20000);

  it("外部编辑 → WS commit+reset 事件 → 全量重读自愈", async () => {
    const ws = await new WsClient().connect({ url: wsBase() });
    const seen: TopoEvent[] = [];
    const un = await ws.events((e) => seen.push(e));
    const p = graphPaths(root, "g1");
    await fsp.writeFile(
      path.join(p.objects, "hand-ws.yaml"),
      "id: hand-ws\nkind: hand\npayload:\n  by: human\n",
      "utf8",
    );
    await waitFor(() => seen.some((e) => e.type === "reset" && e.reason === "external-edit"), 8000);
    expect(seen.some((e) => e.type === "commit")).toBe(true);
    // 自愈 = 全量重读能看到外部实体
    await waitFor(async () => (await ws.read({ ids: ["hand-ws"] })).entities.length === 1, 8000);
    await un();
    await ws.close();
  }, 20000);

  it("断线重连：daemon 重启 → 自动重连 + reset(daemon-restarted) + 会话透明续用", async () => {
    // 固定端口专测：换独立图避免扰动其他用例的 daemon
    const root2 = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-wsr-"));
    await fsp.mkdir(path.join(root2, ".toporealm"), { recursive: true });
    await DaemonCore.createGraph(root2, "g1");
    const port = 27000 + Math.floor(Math.random() * 2000);
    const d1 = await serveDaemon({ root: root2, graph: "g1", idleMs: 0, web: { port } });
    const ws = await new WsClient({
      url: `ws://127.0.0.1:${port}/ws`,
      reconnect: { maxAttempts: 60, baseDelayMs: 50, maxDelayMs: 300 },
    }).connect();
    const oldInstance = ws.instanceId;
    const seen: TopoEvent[] = [];
    const un = await ws.events((e) => seen.push(e));
    await d1.stop(); // 断线（连接关闭）
    // 立即以新 daemon 接管同端口（模拟 daemon 重启部署）
    const d2 = await serveDaemon({ root: root2, graph: "g1", idleMs: 0, web: { port } });
    // 自动重连成功：instanceId 变化 + reset 广播 + 会话续用
    await waitFor(() => ws.instanceId !== oldInstance, 10000);
    await waitFor(() => seen.some((e) => e.type === "reset" && e.reason === "daemon-restarted"));
    const st = await ws.status(); // 透明续用：无需重新 connect
    expect(st.graphId).toBe("g1");
    // 重连后订阅恢复：新提交继续可见
    const r = await d2stopSafeCommit(d2);
    await waitFor(() => seen.some((e) => e.type === "commit" && e.revision === r.revision), 10000);
    await un();
    await ws.close();
    await d2.stop();
  }, 30000);

  it("静态产物伺服 + endpoint.webPort 发现面（wsUrlFromEndpoint）", async () => {
    // 独立 root：单属主约束下一 root 一 daemon
    const root3 = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-wss-"));
    await fsp.mkdir(path.join(root3, ".toporealm"), { recursive: true });
    await DaemonCore.createGraph(root3, "g1");
    const staticDir = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-static-"));
    await fsp.writeFile(
      path.join(staticDir, "index.html"),
      "<!doctype html><title>toporealm</title>",
      "utf8",
    );
    const d = await serveDaemon({
      root: root3,
      graph: "g1",
      idleMs: 0,
      web: { port: 0, staticDir },
    });
    const res = await fetch(`http://127.0.0.1:${d.web?.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("toporealm");
    // 发现面：endpoint.json 带 webPort → WsClient 从 root 推导 URL
    const ep0 = endpointAddress(root3);
    await writeEndpoint(root3, {
      transport: ep0.transport,
      address: ep0.address,
      pid: process.pid,
      instanceId: d.instanceId,
      graphId: d.graphId,
      startedAt: new Date().toISOString(),
      ...(d.web !== null ? { webPort: d.web.port } : {}),
    });
    const url = await wsUrlFromEndpoint(root3);
    expect(url).toBe(`ws://127.0.0.1:${d.web?.port}/ws`);
    const ws = await new WsClient().connect({ url });
    expect(await ws.status()).toMatchObject({ graphId: "g1" });
    await ws.close();
    const ep = await readEndpoint(root3);
    expect(ep?.webPort).toBe(d.web?.port);
    await d.stop();
  }, 20000);

  it("空闲判定：打开中的 WS 连接视作活动，零请求不退出（D22 裁决④）", async () => {
    const rootIdle = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-wsi-"));
    await fsp.mkdir(path.join(rootIdle, ".toporealm"), { recursive: true });
    await DaemonCore.createGraph(rootIdle, "g1");
    const d = await serveDaemon({ root: rootIdle, graph: "g1", idleMs: 300, web: { port: 0 } });
    try {
      const s = await new WsClient({
        url: `ws://127.0.0.1:${(d.web as { port: number }).port}/ws`,
        reconnect: false,
      }).connect();
      // 远超 idleMs 的零请求窗口：连接在场 → daemon 必须仍应答（否则「开着页面盯图」30s 失联）
      await sleep(800);
      await expect(s.status()).resolves.toMatchObject({ graphId: "g1" });
      // 连接关闭 → 无连接且无请求 → idle 到期自旋退出
      await s.close();
      await d.stopped;
    } finally {
      // 幂等兜底：断言失败路径下也收割 daemon（stop 幂等）
      await d.stop().catch(() => {});
    }
  }, 15000);

  it("web 端口被占回退临时口并如实记录 fallbackFrom（D22 裁决②）", async () => {
    const occ = net.createServer();
    await new Promise<void>((resolve) => occ.listen(0, "127.0.0.1", () => resolve()));
    const occupied = (occ.address() as AddressInfo).port;
    const rootP = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-wsp-"));
    await fsp.mkdir(path.join(rootP, ".toporealm"), { recursive: true });
    await DaemonCore.createGraph(rootP, "g1");
    let d: RunningDaemon | null = null;
    try {
      d = await serveDaemon({ root: rootP, graph: "g1", idleMs: 0, web: { port: occupied } });
      expect(d.web?.port).not.toBe(occupied);
      expect(d.web?.fallbackFrom).toBe(occupied);
      // 回退后的临时口真实可用
      const s = await new WsClient({
        url: `ws://127.0.0.1:${(d.web as { port: number }).port}/ws`,
        reconnect: false,
      }).connect();
      await expect(s.status()).resolves.toMatchObject({ graphId: "g1" });
      await s.close();
    } finally {
      if (d !== null) await d.stop();
      await new Promise<void>((resolve) => occ.close(() => resolve()));
    }
  }, 15000);
});

/** 重连用例的提交助手：经 daemon 的 WS 面提交（绕开会话归属，证明 daemon 活着） */
async function d2stopSafeCommit(d: RunningDaemon) {
  // 直接借一次临时 WS 会话提交，避免依赖已重连会话的时序
  const s = await new WsClient({
    url: `ws://127.0.0.1:${(d.web as { port: number }).port}/ws`,
    reconnect: false,
  }).connect();
  const r = await s.commit({ changes: [{ op: "put", kind: "x", id: "post-restart" }] });
  await s.close();
  return r;
}
