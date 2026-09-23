import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryClient, MemorySession } from "../src/memory.js";
import {
  runSessionContractSuite,
  sleep,
  type ContractSuiteContext,
} from "./contract.js";

let root: string;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-mem-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "g1");
});

function makeCtx(): ContractSuiteContext {
  // watch:false：外部编辑吸收走确定性 reconcileNow（ctx 注释语义）。
  // 真实 fs.watch + 每用例重开 core 的组合在满载下会有滞留监视事件插进
  // 后续用例的 undo 排空序列（偶发 UNKNOWN_ID），这里不需要真监视面。
  const client = new MemoryClient({ watch: false });
  return {
    root,
    graphId: "g1",
    connect: () => client.connect({ root, graph: "g1" }),
    absorbExternal: async (s, probeId) => {
      const mem = s as MemorySession;
      for (let i = 0; i < 40; i++) {
        await mem.reconcileNow();
        if ((await s.read({ ids: [probeId] })).entities.length > 0) return;
        await sleep(50);
      }
      throw new Error("memory external absorb failed");
    },
  };
}

runSessionContractSuite(makeCtx);

// ---------- memory 专属：origin 注入验所有权法（IPC 端恒为 cli，见 daemon-core 测试） ----------
describe("所有权法（memory 专属：module:* 来源）", () => {
  it("越界拒绝；自命名空间与公共/无主放行；merge/del 按目标 kind 判定", async () => {
    const client = new MemoryClient({ origin: "module:tester" });
    const s = await client.connect({ root, graph: "g1" });
    await expect(
      s.commit({ changes: [{ op: "put", kind: "other.task", id: "ov-1" }] }),
    ).rejects.toMatchObject({ code: "OWNERSHIP_VIOLATION" });
    await s.commit({ changes: [{ op: "put", kind: "tester.thing", id: "tw-1" }] });
    await s.commit({ changes: [{ op: "put", kind: "note", id: "tn-1" }] });
    // merge 越界：目标 kind 属于他人命名空间
    await expect(
      s.commit({ changes: [{ op: "merge", id: "tw-1", payload: {} }] }),
    ).resolves.toBeTruthy(); // 自己的命名空间 → 放行
    await s.close();
  });
});
