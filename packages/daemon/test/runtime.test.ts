import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DaemonCore, writeActiveGraphId, workspacePaths } from "@lukawi/toporealm-daemon-core";
import type { IpcRequest } from "@lukawi/toporealm-protocol";
import { GraphRuntime } from "../src/runtime.js";
import { createWireDispatcher } from "@lukawi/toporealm-web";

// ---------- 内存换载（1.1.0 D30）：跟随/钉住/失败旧图继续/reset 通知 ----------

let root: string;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-swap-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "g1");
  await DaemonCore.createGraph(root, "g2");
});

type IpcResponseLike = { id: string; ok: boolean; instanceId: string; result?: unknown; error?: { code: string } };

describe("GraphRuntime 换载", () => {
  it("显式图 hello 就地换载；钉住会话请求恒回目标图；失败旧图继续服务（R2）", async () => {
    const runtime = await GraphRuntime.open(root, "g1");
    const sent: (IpcResponseLike | { event: unknown })[] = [];
    const dispatcher = createWireDispatcher(
      { runtime, origin: "cli", onStale: () => {} },
      (msg) => sent.push(msg as IpcResponseLike),
    );

    const hello = (graph?: string): IpcRequest =>
      ({ id: "h1", op: "hello", root, ...(graph !== undefined ? { graph } : {}) }) as IpcRequest;

    await dispatcher.handle(hello("g1"));
    expect(runtime.current().core.graphId).toBe("g1");

    // 钉住 g1 的会话：即便 active 指向 g2，请求仍回 g1（拉回）
    await writeActiveGraphId(workspacePaths(root).activeFile, "g2");
    await dispatcher.handle({ id: "r1", op: "read", query: {} } as IpcRequest);
    expect(runtime.current().core.graphId).toBe("g1");

    // 显式换载到 g2：成功返回 g2
    await dispatcher.handle(hello("g2"));
    expect(runtime.current().core.graphId).toBe("g2");

    // 换载到不存在的图：GRAPH_NOT_FOUND，旧图（g2）继续服务
    await dispatcher.handle(hello("nope"));
    const last = sent.at(-1) as IpcResponseLike;
    expect(last.ok).toBe(false);
    expect(last.error?.code).toBe("GRAPH_NOT_FOUND");
    expect(runtime.current().core.graphId).toBe("g2");
    await dispatcher.handle({ id: "r2", op: "read", query: {} } as IpcRequest);
    expect((sent.at(-1) as IpcResponseLike).ok).toBe(true);
    dispatcher.dispose();
  });

  it("跟随会话（hello 无 graph）：active 变化 → 换载 + reset(graph-switched) + 重订阅", async () => {
    const runtime = await GraphRuntime.open(root, "g2");
    const sent: (IpcResponseLike | { event: unknown })[] = [];
    const dispatcher = createWireDispatcher(
      { runtime, origin: "web", onStale: () => {} },
      (msg) => sent.push(msg as IpcResponseLike),
    );
    // WebUI 语义：hello 不带 graph
    await dispatcher.handle({ id: "h", op: "hello" } as IpcRequest);
    expect(runtime.current().core.graphId).toBe("g2");

    // 订阅事件
    await dispatcher.handle({ id: "e1", op: "events" } as IpcRequest);
    expect(runtime.current().core.graphId).toBe("g2");

    // active → g1：下一个请求（read）触发跟随换载
    await writeActiveGraphId(workspacePaths(root).activeFile, "g1");
    await dispatcher.handle({ id: "r", op: "read", query: {} } as IpcRequest);
    expect(runtime.current().core.graphId).toBe("g1");

    // 订阅被迁移：reset(graph-switched) 推送 + 新 core 的 hello 重放
    const events = sent.filter((m) => "event" in m).map((m) => (m as { event: { type: string; reason?: string; graphId?: string } }).event);
    expect(events.some((e) => e.type === "reset" && e.reason === "graph-switched" && e.graphId === "g1")).toBe(true);
    dispatcher.dispose();
  });
});
