import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  DaemonCore,
  waitForPidExit,
  workspacePaths,
  writeActiveGraphId,
} from "@lukawi/toporealm-daemon-core";
import { readEndpoint } from "@lukawi/toporealm-daemon";
import { beforeAll, describe, expect, it } from "vitest";
import { IpcClient } from "../src/ipc.js";
import { waitFor } from "./contract.js";

// ---------- IPC 传输一致性 + 生命周期（blueprint §8 生命周期专项） ----------

let root: string;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-ipct-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "g1");
  await DaemonCore.createGraph(root, "g2");
});

it("自动拉起：connect 透明 spawn；endpoint 复用（同 instanceId）", async () => {
  const client = new IpcClient();
  const s1 = await client.connect({ root, graph: "g1" });
  const ep = await readEndpoint(root);
  expect(ep?.pid).toBeGreaterThan(0);
  const s2 = await client.connect({ root, graph: "g1" });
  expect(s2.instanceId).toBe(s1.instanceId);
  expect(s2.graphId).toBe("g1");
  await s1.close();
  await s2.close();
});

it("daemon 被杀 → 自动重拉；instanceId 变化；旧会话 SESSION_STALE", async () => {
  const client = new IpcClient();
  const s1 = await client.connect({ root, graph: "g1" });
  const oldId = s1.instanceId;
  const ep = await readEndpoint(root);
  process.kill(ep!.pid);
  await waitForPidExit(ep!.pid);
  const s2 = await client.connect({ root, graph: "g1" });
  expect(s2.instanceId).not.toBe(oldId);
  await expect(s1.status()).rejects.toMatchObject({ code: "SESSION_STALE" });
  await s2.close();
}, 20000);

it("换图：旧 daemon 自旋退出，重连拿到新图会话", async () => {
  const client = new IpcClient();
  const s1 = await client.connect({ root, graph: "g1" });
  expect(s1.graphId).toBe("g1");
  await s1.close();
  await writeActiveGraphId(workspacePaths(root).activeFile, "g2");
  const s2 = await client.connect({ root, graph: "g2" });
  expect(s2.graphId).toBe("g2");
  await s2.close();
  // 旧图再次触达：又拉起服务 g1 的 daemon（每次触达自动拉起语义）
  const s3 = await client.connect({ root, graph: "g1" });
  expect(s3.graphId).toBe("g1");
  await s3.close();
}, 20000);

it("events 跨连接广播：第二会话可见第一会话的提交", async () => {
  const client = new IpcClient();
  const sa = await client.connect({ root, graph: "g1" });
  const sb = await client.connect({ root, graph: "g1" });
  const seen: string[] = [];
  const un = await sb.events((e) => seen.push(e.type));
  expect(seen).toEqual(["hello"]);
  const r = await sa.commit({
    changes: [{ op: "put", kind: "x", id: "bcast-1" }],
    label: "bcast",
  });
  await waitFor(async () => seen.includes("commit"));
  await un();
  expect(seen).toEqual(["hello", "commit"]);
  await sa.close();
  await sb.close();
});
