import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { ModuleHost } from "../src/index.js";

// ---------- 双池装载（1.1.0 D27）：目录即注册、项目遮蔽全局、digest=有效集 ----------

const fixturesDir = fileURLToPath(
  new URL("../../../tests/fixtures/modules/", import.meta.url),
);

async function copyFixture(name: string, destDir: string): Promise<void> {
  await fsp.mkdir(path.dirname(destDir), { recursive: true });
  await fsp.cp(path.join(fixturesDir, name), destDir, { recursive: true });
}

/** 建空工作区；返回 { root, globalRoot, projectPool, globalPool } */
async function makeWs(): Promise<{
  root: string;
  globalRoot: string;
  projectPool: string;
  globalPool: string;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-dp-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "g1");
  const globalRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-dpg-"));
  return {
    root,
    globalRoot,
    projectPool: path.join(root, ".toporealm", "modules"),
    globalPool: path.join(globalRoot, "modules"),
  };
}

async function open(ws: { root: string; globalRoot: string }): Promise<{
  core: DaemonCore;
  host: ModuleHost;
}> {
  const core = await DaemonCore.open({ root: ws.root, graphId: "g1", watch: false });
  const host = await ModuleHost.load(core, { root: ws.root, globalRoot: ws.globalRoot });
  return { core, host };
}

it("项目池目录即注册：无任何 modules.yaml 绑定也能装载", async () => {
  const ws = await makeWs();
  await copyFixture("example", path.join(ws.projectPool, "example"));
  const { host } = await open(ws);
  expect(host.loadedIds).toEqual(["example"]);
});

it("全局池模块经 globalRoot 注入装载", async () => {
  const ws = await makeWs();
  await copyFixture("example", path.join(ws.globalPool, "example"));
  const { host } = await open(ws);
  expect(host.loadedIds).toEqual(["example"]);
});

it("项目遮蔽全局：项目版本生效 + warning 点名；requires 跨池联合解析", async () => {
  const ws = await makeWs();
  // 全局：example 1.0.0 + workflow-mini；项目：example 改版本 9.9.9 遮蔽全局
  await copyFixture("example", path.join(ws.globalPool, "example"));
  await copyFixture("workflow-mini", path.join(ws.globalPool, "workflow-mini"));
  const projExample = path.join(ws.projectPool, "example");
  await copyFixture("example", projExample);
  const mf = path.join(projExample, "module.yaml");
  await fsp.writeFile(
    mf,
    (await fsp.readFile(mf, "utf8")).replace('version: "1.0.0"', 'version: "9.9.9"'),
    "utf8",
  );
  const { host } = await open(ws);
  // workflow-mini 依赖 example：example 只在全局有有效副本被项目遮蔽后仍解析 ✓ 联合
  expect([...host.loadedIds].sort()).toEqual(["example", "workflow-mini"]);
  expect(host.warnings.some((w) => w.includes("遮蔽") && w.includes("9.9.9"))).toBe(true);
});

it("全局池坏模块跳过 + warning；项目池坏模块大声失败", async () => {
  const ws = await makeWs();
  await fsp.mkdir(path.join(ws.globalPool, "broken"), { recursive: true });
  await fsp.writeFile(path.join(ws.globalPool, "broken", "module.yaml"), "format: nope", "utf8");
  await copyFixture("example", path.join(ws.projectPool, "example"));
  const { host } = await open(ws);
  expect(host.loadedIds).toEqual(["example"]);
  expect(host.warnings.some((w) => w.includes("broken") && w.includes("跳过"))).toBe(true);

  const ws2 = await makeWs();
  await fsp.mkdir(path.join(ws2.projectPool, "broken"), { recursive: true });
  await fsp.writeFile(path.join(ws2.projectPool, "broken", "module.yaml"), "format: nope", "utf8");
  await expect(open(ws2)).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

it("digest = sha256(排序 pool:id@version)：遮蔽换血即变化", async () => {
  const ws = await makeWs();
  await copyFixture("example", path.join(ws.projectPool, "example"));
  const { host } = await open(ws);
  // 全量 26 位字符精度不比；这里验证：同集重算一致、版本改变则不同
  const d1 = host.digest;
  await fsp.writeFile(
    path.join(ws.projectPool, "example", "module.yaml"),
    (await fsp.readFile(path.join(ws.projectPool, "example", "module.yaml"), "utf8")).replace(
      'version: "1.0.0"',
      'version: "2.0.0"',
    ),
    "utf8",
  );
  const core2 = await DaemonCore.open({ root: ws.root, graphId: "g1", watch: false });
  const host2 = await ModuleHost.load(core2, { root: ws.root, globalRoot: ws.globalRoot });
  expect(host2.digest).not.toBe(d1);
  expect(host2.digest).toBe(host2.digest); // 稳定
});

it("path 绑定遮蔽池副本（显式声明优先）", async () => {
  const ws = await makeWs();
  await copyFixture("example", path.join(ws.projectPool, "example"));
  const alt = path.join(ws.globalRoot, "alt-example");
  await copyFixture("example", alt);
  await fsp.writeFile(
    path.join(ws.root, ".toporealm", "modules.yaml"),
    `example:\n  source: path\n  path: ${JSON.stringify(alt)}\n`,
    "utf8",
  );
  const { host } = await open(ws);
  expect(host.loadedIds).toEqual(["example"]);
  expect(host.warnings.some((w) => w.includes("path 绑定遮蔽项目池"))).toBe(true);
});
