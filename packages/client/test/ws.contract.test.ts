import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { serveDaemon, type RunningDaemon } from "@lukawi/toporealm-daemon";
import { afterAll, beforeAll } from "vitest";
import { WsClient } from "../src/ws.js";
import {
  runSessionContractSuite,
  waitFor,
  type ContractSuiteContext,
} from "./contract.js";

// ---------- S1 契约在 WS adapter 上复跑（blueprint §8：同一套用例三 adapter 复跑） ----------
// 传输面：daemon 进程内 serveDaemon + WsClient（wire 信封 /ws，D22）。

let root: string;
let daemon: RunningDaemon;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-ws-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "g1");
  daemon = await serveDaemon({
    root,
    graph: "g1",
    idleMs: 0,
    web: { port: 0 },
  });
});

afterAll(async () => {
  await daemon.stop();
});

function makeCtx(): ContractSuiteContext {
  const client = new WsClient();
  return {
    root,
    graphId: "g1",
    connect: () =>
      client.connect({
        url: `ws://127.0.0.1:${daemon.web?.port}/ws`,
        root,
      }),
    absorbExternal: async (s, probeId) => {
      // daemon 端真实 fs.watch + 去抖 → 轮询等吸收
      await waitFor(
        async () => (await s.read({ ids: [probeId] })).entities.length > 0,
        8000,
      );
    },
    expectedOrigin: "web", // WS 传输的提交来源如实为 "web"（D22）
  };
}

runSessionContractSuite(makeCtx);
