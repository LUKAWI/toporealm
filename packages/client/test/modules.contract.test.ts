import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import type { Session } from "@lukawi/toporealm-protocol";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IpcClient } from "../src/ipc.js";
import { MemoryClient } from "../src/memory.js";
import { waitFor } from "./contract.js";

// ---------- M2 模块缝在 memory/IPC 两 adapter 复跑（blueprint §8：传输一致性） ----------
// catalog()/run() 进 wire 契约；命令→钩子 veto→所有权全链路打公共缝。

const fixturesDir = fileURLToPath(
  new URL("../../../tests/fixtures/modules/", import.meta.url),
);

function bindingYaml(entries: Record<string, string>): string {
  return (
    Object.entries(entries)
      .map(([id, dir]) => `${id}:\n  source: path\n  path: ${JSON.stringify(dir)}`)
      .join("\n") + "\n"
  );
}

const fixturePath = (name: string): string => path.join(fixturesDir, name);

interface ModuleSuiteContext {
  root: string;
  connect(): Promise<Session>;
}

export function runModuleSuite(getCtx: () => ModuleSuiteContext): void {
  let ctx: ModuleSuiteContext;
  let s: Session;
  let n = 0;

  beforeEach(async () => {
    ctx = getCtx();
    s = await ctx.connect();
  });

  afterEach(async () => {
    await s.close();
  });

  describe("模块缝（memory/IPC 两 adapter 复跑；blueprint §9 M2）", () => {
    it("catalog 目录真实性：modules/kinds/commands 过 wire 不走样", async () => {
      const cat = await s.catalog();
      expect(cat.modules).toEqual([
        { id: "example", version: "1.0.0", namespace: "example" },
        { id: "workflow-mini", version: "1.0.0", namespace: "wf" },
      ]);
      const kinds = Object.fromEntries(cat.kinds.map((k) => [k.kind, k]));
      expect(kinds["wf.task"]).toMatchObject({ owner: "wf", color: "#3b82f6" });
      expect(kinds["example.card"]).toMatchObject({ owner: "example" });
      const ids = cat.commands.map((c) => c.id);
      for (const want of ["example.create-card", "wf.start", "wf.pass", "wf.next"]) {
        expect(ids).toContain(want);
      }
    });

    it("catalog(module) 过滤：按 id 或 namespace", async () => {
      const byNs = await s.catalog("wf");
      expect(byNs.modules.map((m) => m.id)).toEqual(["workflow-mini"]);
      expect(byNs.commands.map((c) => c.id)).toEqual(["wf.start", "wf.pass", "wf.next"]);
      const byId = await s.catalog("example");
      expect(byId.commands.every((c) => c.id.startsWith("example."))).toBe(true);
      expect(byId.commands.length).toBeGreaterThan(0);
    });

    it("run 全链路：命令提交落图、commits 回显、日志 origin 如实", async () => {
      const uniq = `t-${(n++).toString(36)}-${Date.now().toString(36)}`;
      await s.commit({
        changes: [{ op: "put", kind: "wf.task", id: uniq, payload: { title: "T", status: "pending" } }],
      });
      const before = (await s.status()).revision;
      const r = await s.run("wf.start", { target: uniq });
      expect(r.message).toBe(`started ${uniq}`);
      expect(r.commits?.map((c) => c.revision)).toEqual([before + 1]);
      const got = await s.read({ ids: [uniq] });
      expect(got.entities[0]?.payload?.status).toBe("running");
      const log = await s.log({ limit: 3 });
      expect(log.at(-1)).toMatchObject({ origin: "module:workflow-mini", label: `wf.start ${uniq}` });
    });

    it("run：UNKNOWN_COMMAND 带 did-you-mean（来自目录）", async () => {
      const err = await s.run("wf.strt").catch((e: unknown) => e as { code: string; details?: { suggestions?: string[] } });
      expect(err.code).toBe("UNKNOWN_COMMAND");
      expect(err.details?.suggestions).toContain("wf.start");
    });

    it("run：appliesTo 兑现——缺 target → INVALID_INPUT", async () => {
      const err = await s.run("wf.start").catch((e: unknown) => e as { code: string; details?: { appliesTo?: string } });
      expect(err.code).toBe("INVALID_INPUT");
      expect(err.details?.appliesTo).toBe("wf.task");
    });

    it("run：全局命令（无 appliesTo）不需要 target", async () => {
      const r = await s.run("wf.next");
      expect(Array.isArray((r.data as { tasks?: string[] }).tasks)).toBe(true);
    });

    it("钩子 veto：poison 载荷被结构化否决（details.vetoes[]）", async () => {
      const err = await s.run("example.create-card", { input: { poison: true } }).catch((e: unknown) => e as { code: string; message: string; details?: { vetoes?: { reason: string }[] } });
      expect(err.code).toBe("VETOED");
      expect(err.details?.vetoes).toHaveLength(1);
      expect(err.details?.vetoes?.[0]?.reason).toContain("poison");
    });

    it("钩子对一切来源生效：cli 直改 wf.task 非法流转 → VETOED", async () => {
      const uniq = `v-${(n++).toString(36)}-${Date.now().toString(36)}`;
      await s.commit({
        changes: [{ op: "put", kind: "wf.task", id: uniq, payload: { status: "pending" } }],
      });
      await expect(
        s.commit({ changes: [{ op: "merge", id: uniq, payload: { status: "passed" } }] }),
      ).rejects.toMatchObject({ code: "VETOED" });
      // 否决零副作用
      const got = await s.read({ ids: [uniq] });
      expect(got.entities[0]?.payload?.status).toBe("pending");
    });

    it("所有权法经缝可见：模块提交 origin 即 module:<id>（日志可审计）", async () => {
      const r = await s.run("example.create-card", { input: { title: "Own" } });
      expect(r.commits?.length).toBeGreaterThan(0);
      const log = await s.log({ limit: 2 });
      expect(log.at(-1)?.origin).toBe("module:example");
    });
  });
}

// ---------- memory：同一工作区贯穿（每用例 connect 新开 in-process daemon） ----------

async function makeWorkspace(bindings: Record<string, string>): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-modmem-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "g1");
  await fsp.writeFile(
    path.join(root, ".toporealm", "modules.yaml"),
    bindingYaml(bindings),
    "utf8",
  );
  return root;
}

let memRoot: string;

beforeAll(async () => {
  memRoot = await makeWorkspace({
    example: fixturePath("example"),
    "workflow-mini": fixturePath("workflow-mini"),
  });
});

describe("模块缝 × MemoryClient", () => {
  runModuleSuite(() => {
    const client = new MemoryClient();
    return {
      root: memRoot,
      connect: () => client.connect({ root: memRoot, graph: "g1" }),
    };
  });
});

// ---------- IPC：真实 daemon（toporeald）装载同一绑定 ----------

let ipcRoot: string;

beforeAll(async () => {
  ipcRoot = await makeWorkspace({
    "workflow-mini": fixturePath("workflow-mini"), // 故意逆序：依赖拓扑排序在 daemon 内生效
    example: fixturePath("example"),
  });
});

describe("模块缝 × IpcClient（真实 daemon）", () => {
  runModuleSuite(() => {
    const client = new IpcClient();
    return {
      root: ipcRoot,
      connect: () => client.connect({ root: ipcRoot, graph: "g1" }),
    };
  });

  it(
    "模块集变化：hello 复验摘要 → 旧 daemon SESSION_STALE 自旋退出 → 重拉装载新模块集",
    async () => {
      const root2 = await makeWorkspace({
        example: fixturePath("example"),
        "workflow-mini": fixturePath("workflow-mini"),
      });
      const client = new IpcClient();
      const s1 = await client.connect({ root: root2, graph: "g1" });
      expect((await s1.catalog()).modules.map((m) => m.id)).toContain("workflow-mini");
      // 收窄绑定集（剩下的 example 可独立启动）
      await fsp.writeFile(
        path.join(root2, ".toporealm", "modules.yaml"),
        bindingYaml({ example: fixturePath("example") }),
        "utf8",
      );
      // 下次触达：hello 摘要不符 → 旧 daemon 退场 → 新 daemon 装载新模块集
      const s2 = await client.connect({ root: root2, graph: "g1" });
      const cat2 = await s2.catalog();
      expect(cat2.modules.map((m) => m.id)).toEqual(["example"]);
      expect(cat2.commands.map((c) => c.id)).not.toContain("wf.start");
      expect(cat2.commands.map((c) => c.id)).toContain("example.create-card");
      // 旧会话已作废
      await waitFor(async () => {
        try {
          await s1.status();
          return false;
        } catch (e) {
          return (e as { code?: string }).code === "SESSION_STALE";
        }
      });
      await s2.close();
    },
    30_000,
  );

  it("M6：requires 缺失 → daemon 启动大声失败，connect 拿到 MISSING_MODULE", async () => {
    const root3 = await makeWorkspace({
      "workflow-mini": fixturePath("workflow-mini"), // example 未绑定
    });
    const client = new IpcClient();
    const err = await client
      .connect({ root: root3, graph: "g1" })
      .catch((e: unknown) => e as { code?: string });
    // 拉起方（toporeald）装载失败退出 → connect 侧以传输失败收场；
    // 模块失败细节在 daemon stderr（M6 大声失败本体由 S2/装载面断言）。
    expect(["MISSING_MODULE", "DAEMON_UNREACHABLE"]).toContain(err.code);
  }, 30_000);
});
