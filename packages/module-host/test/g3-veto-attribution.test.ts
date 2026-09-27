import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { TopoError } from "@lukawi/toporealm-protocol";
import { ModuleHost } from "../src/index.js";

// ---------- 1.2.0 G3-1（blueprint D37）：VETOED 点名否决模块 ----------
//
// host 注册钩子时包装归属：钩子返回 veto 对象 → 包装层直接抛
// TopoError(VETOED, details.vetoes=[{ module, reason, details? }])，
// 在 core 通用抛错（core 不知模块归属，只对 core 缝直注钩子兜底）前短路；
// core 的 for 循环收到异常经 try/finally 原样上抛，管线与 first-veto 顺序语义不变。

let isolatedGlobalRoot: string | undefined;

async function emptyGlobalRoot(): Promise<string> {
  if (isolatedGlobalRoot === undefined) {
    isolatedGlobalRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), "toporealm-g3-mh-global-"),
    );
  }
  return isolatedGlobalRoot;
}

afterAll(async () => {
  if (isolatedGlobalRoot !== undefined) {
    await fsp
      .rm(isolatedGlobalRoot, { recursive: true, force: true })
      .catch(() => {});
  }
});

/** 绑定表 → modules.yaml 文本（path 来源；JSON 双引号写法兼容 Windows 反斜杠路径） */
function bindingYaml(entries: Record<string, string>): string {
  return (
    Object.entries(entries)
      .map(([id, dir]) => `${id}:\n  source: path\n  path: ${JSON.stringify(dir)}`)
      .join("\n") + "\n"
  );
}

async function writeHookModule(
  root: string,
  id: string,
  activateBody: string,
): Promise<string> {
  const dir = path.join(root, ".toporealm", "modules", id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, "module.yaml"),
    `format: toporealm.module/v2\nid: ${id}\nnamespace: ${id}\nversion: "1.0.0"\nentry: ./index.js\n`,
    "utf8",
  );
  await fsp.writeFile(
    path.join(dir, "index.js"),
    `export default { activate(api) {\n${activateBody}\n} };\n`,
    "utf8",
  );
  return dir;
}

async function tmpWorkspace(
  modules: { id: string; body: string }[],
): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-g3-mh-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "g1");
  const bindings: Record<string, string> = {};
  for (const m of modules) {
    bindings[m.id] = await writeHookModule(root, m.id, m.body);
  }
  await fsp.writeFile(
    path.join(root, ".toporealm", "modules.yaml"),
    bindingYaml(bindings),
    "utf8",
  );
  return root;
}

async function openWithModules(
  root: string,
): Promise<{ core: DaemonCore; host: ModuleHost }> {
  const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
  const host = await ModuleHost.load(core, {
    root,
    globalRoot: await emptyGlobalRoot(),
  });
  return { core, host };
}

describe("G3-1（D37）VETOED details.vetoes[].module 归属", () => {
  it("双模块双钩子：第二个模块 veto → vetoes[0].module 指向它；消息含模块名；零副作用", async () => {
    const root = await tmpWorkspace([
      // mod-a 放行（调用计数）；mod-b 总是 veto（带 reason + details）
      { id: "mod-a", body: `globalThis.__g3_calls_a = (globalThis.__g3_calls_a ?? 0) + 1;` },
      {
        id: "mod-b",
        body: `api.hook("before-commit", () => ({ veto: "mod-b 拒绝此提交", details: { why: "g3" } }));`,
      },
    ]);
    const { core } = await openWithModules(root);
    const err = await core
      .commit({ changes: [{ op: "put", kind: "thing", id: "x1", payload: {} }] }, "cli")
      .catch((e: unknown) => e);
    expect(TopoError.is(err)).toBe(true);
    expect((err as TopoError).code).toBe("VETOED");
    // 点名：模块名进 details.vetoes[0].module（加法）与人类可读 message
    expect((err as TopoError).details).toMatchObject({
      vetoes: [{ module: "mod-b", reason: "mod-b 拒绝此提交", details: { why: "g3" } }],
    });
    expect((err as TopoError).message).toContain("mod-b");
    // 短路先于应用：零副作用
    expect(core.revision).toBe(0);
    expect(core.read({ ids: ["x1"] }).entities).toHaveLength(0);
    // 放行钩子先于否决钩子被调（注册序 = 激活序）
    expect((globalThis as { __g3_calls_a?: number }).__g3_calls_a).toBe(1);
    delete (globalThis as { __g3_calls_a?: number }).__g3_calls_a;
    core.dispose();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("first-veto 顺序不变：前位模块 veto 短路，后位钩子不再被调", async () => {
    const root = await tmpWorkspace([
      // 激活序 = 拓扑序（无依赖按字典序）：mod-a 先注册 → first-veto 命中 mod-a
      { id: "mod-a", body: `api.hook("before-commit", () => ({ veto: "mod-a 先否决" }));` },
      {
        id: "mod-b",
        body: `api.hook("before-commit", () => { globalThis.__g3_calls_b = (globalThis.__g3_calls_b ?? 0) + 1; return { veto: "mod-b" }; });`,
      },
    ]);
    const { core, host } = await openWithModules(root);
    expect(host.loadedIds).toEqual(["mod-a", "mod-b"]);
    const err = await core
      .commit({ changes: [{ op: "put", kind: "thing", id: "x2", payload: {} }] }, "cli")
      .catch((e: unknown) => e);
    expect(TopoError.is(err)).toBe(true);
    expect((err as TopoError).details).toMatchObject({
      vetoes: [{ module: "mod-a", reason: "mod-a 先否决" }],
    });
    // 短路：后位钩子未被调
    expect((globalThis as { __g3_calls_b?: number }).__g3_calls_b).toBeUndefined();
    core.dispose();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  });
});
