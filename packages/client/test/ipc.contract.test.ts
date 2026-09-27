import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { afterAll, beforeAll } from "vitest";
import { IpcClient } from "../src/ipc.js";
import {
  runSessionContractSuite,
  waitFor,
  type ContractSuiteContext,
} from "./contract.js";
import { isolateGlobalHome } from "../../../tests/test-env.js";

// ---------- S1 契约在 IPC adapter 上复跑（blueprint §8：同一套用例，只补传输一致性） ----------
// 测试隔离（1.2.0 G5）：TOPOREALM_HOME 指向一次性空目录；daemon 子进程 spawn 继承
// 父 env，隔离同样覆盖自动拉起的 toporeald（防开发机 ~/.toporealm 全局池泄漏）。

let root: string;
let restoreHome: (() => void) | undefined;

beforeAll(async () => {
  restoreHome = (await isolateGlobalHome()).restore;
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-ipc-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "g1");
});

afterAll(() => {
  restoreHome?.();
});

function makeCtx(): ContractSuiteContext {
  const client = new IpcClient();
  return {
    root,
    graphId: "g1",
    connect: () => client.connect({ root, graph: "g1" }),
    absorbExternal: async (s, probeId) => {
      // 真实 fs.watch（daemon 端）+ 去抖 → 轮询等吸收
      await waitFor(
        async () => (await s.read({ ids: [probeId] })).entities.length > 0,
        8000,
      );
    },
  };
}

runSessionContractSuite(makeCtx);
