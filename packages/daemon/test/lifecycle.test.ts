import { spawn, type ChildProcess } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { expect, it } from "vitest";
import { readEndpoint } from "../src/index.js";

// ---------- daemon 生命周期专项（blueprint §8）：单属主互斥 / 空闲退出 ----------

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const toporealdMjs = fileURLToPath(
  new URL("../bin/toporeald.mjs", import.meta.url),
);

function spawnDaemon(args: string[]): ChildProcess {
  return spawn(process.execPath, [toporealdMjs, ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
}

function exitCodeOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 10000,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timeout");
    await sleep(60);
  }
}

async function makeWorkspace(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-life-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "g1");
  return root;
}

it("单属主互斥：第二个 daemon 立即退出 (exit 1)，原属主不受影响", async () => {
  const root = await makeWorkspace();
  const d1 = spawnDaemon(["--root", root, "--graph", "g1", "--idle-ms", "0"]);
  try {
    await waitFor(async () => (await readEndpoint(root)) !== null);
    const d2 = spawnDaemon(["--root", root, "--graph", "g1", "--idle-ms", "0"]);
    const code = await exitCodeOf(d2);
    expect(code).toBe(1);
    expect(await readEndpoint(root)).not.toBeNull();
  } finally {
    d1.kill();
  }
}, 20000);

it("空闲退出：idle 到点自动退出并清理 endpoint", async () => {
  const root = await makeWorkspace();
  const d1 = spawnDaemon(["--root", root, "--graph", "g1", "--idle-ms", "300"]);
  await waitFor(async () => (await readEndpoint(root)) !== null);
  const code = await exitCodeOf(d1);
  expect(code).toBe(0);
  expect(await readEndpoint(root)).toBeNull();
}, 20000);
