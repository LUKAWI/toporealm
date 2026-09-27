import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeActiveGraphId, workspacePaths, DaemonCore } from "@lukawi/toporealm-daemon-core";
import type { IpcRequest } from "@lukawi/toporealm-protocol";
import { GraphRuntime } from "@lukawi/toporealm-daemon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWireDispatcher } from "../src/dispatch.js";
import { isolateGlobalHome } from "../../../tests/test-env.js";

// ---------- G2-6 未知 wire op 有响应 + G2-12 换载重订阅/reset 瑕疵 ----------

type Sent =
  | { id: string; ok: boolean; error?: { code: string; message: string }; result?: unknown }
  | { event: { type: string; reason?: string; graphId?: string; revision?: number } };

let root: string;
let restoreHome: (() => void) | undefined;

beforeAll(async () => {
  restoreHome = (await isolateGlobalHome()).restore;
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-dispatch-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "g1");
  await DaemonCore.createGraph(root, "g2");
  // g2 预置两笔提交：换载后若仍带旧 fromRevision 重订，会被错误回放成 commit 事件
  const core = await DaemonCore.open({ root, graphId: "g2", watch: false });
  await core.commit({ changes: [{ op: "put", kind: "k", id: "a", payload: {} }] }, "cli");
  await core.commit({ changes: [{ op: "put", kind: "k", id: "b", payload: {} }] }, "cli");
  core.dispose();
});

afterAll(() => {
  restoreHome?.();
});

function makeDispatcher(runtime: GraphRuntime, sent: Sent[]) {
  return createWireDispatcher({ runtime, origin: "web", onStale: () => {} }, (msg) =>
    sent.push(msg as Sent),
  );
}

describe("G2-6 未知 wire op", () => {
  it("回 UNKNOWN_COMMAND 错误响应 + 原请求 id（不再悬挂 30s）", async () => {
    const runtime = await GraphRuntime.open(root, "g1");
    const sent: Sent[] = [];
    const d = makeDispatcher(runtime, sent);
    await d.handle({ id: "h", op: "hello" } as IpcRequest);
    await d.handle({ id: "u1", op: "bogus" } as unknown as IpcRequest);
    const resp = sent.find((m) => "id" in m && m.id === "u1") as
      | { id: string; ok: boolean; error?: { code: string } }
      | undefined;
    expect(resp).toBeDefined();
    expect(resp?.ok).toBe(false);
    expect(resp?.error?.code).toBe("UNKNOWN_COMMAND");
    d.dispose();
    runtime.dispose();
  });
});

describe("G2-12 换载重订阅", () => {
  it("有活跃订阅：reset(graph-switched) 只推一次 + 新 core hello 携带新图；旧 fromRevision 不再回放出 commit 事件", async () => {
    const runtime = await GraphRuntime.open(root, "g1");
    const sent: Sent[] = [];
    const d = makeDispatcher(runtime, sent);
    await d.handle({ id: "h", op: "hello" } as IpcRequest);
    await d.handle({ id: "e", op: "events", fromRevision: 0 } as IpcRequest);

    // active → g2；下一请求触发跟随换载
    await writeActiveGraphId(workspacePaths(root).activeFile, "g2");
    await d.handle({ id: "r", op: "read", query: {} } as IpcRequest);
    expect(runtime.current().core.graphId).toBe("g2");

    const events = sent
      .filter((m) => "event" in m)
      .map((m) => (m as { event: { type: string; reason?: string; graphId?: string; revision?: number } }).event);
    // 换载前的订阅 hello（g1）+ 换载后新 core hello（g2）
    const hellos = events.filter((e) => e.type === "hello");
    expect(hellos.length).toBe(2);
    expect(hellos[0]?.graphId).toBe("g1");
    expect(hellos[1]?.graphId).toBe("g2");
    // reset(graph-switched) 恰一次，指向新图
    const resets = events.filter((e) => e.type === "reset" && e.reason === "graph-switched");
    expect(resets).toHaveLength(1);
    expect(resets[0]?.graphId).toBe("g2");
    // 关键：换载后不得回放出任何 commit 事件（旧图的 fromRevision 语义对新图无意义）
    expect(events.filter((e) => e.type === "commit")).toEqual([]);
    d.dispose();
    runtime.dispose();
  });

  it("无活跃订阅的连接：换载不推 reset（纯请求会话零噪声）", async () => {
    const runtime = await GraphRuntime.open(root, "g1");
    const sent: Sent[] = [];
    const d = makeDispatcher(runtime, sent);
    await d.handle({ id: "h", op: "hello" } as IpcRequest);

    await writeActiveGraphId(workspacePaths(root).activeFile, "g1"); // 先确保 stamp 消费
    await writeActiveGraphId(workspacePaths(root).activeFile, "g2");
    await d.handle({ id: "r", op: "read", query: {} } as IpcRequest);
    expect(runtime.current().core.graphId).toBe("g2");

    expect(sent.filter((m) => "event" in m)).toEqual([]);
    d.dispose();
    runtime.dispose();
  });
});
