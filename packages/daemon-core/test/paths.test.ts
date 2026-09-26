import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureGlobalDir, globalPaths, graphPaths, workspacePaths } from "../src/index.js";

// ---------- 全局目录（1.1.0 D26）：TOPOREALM_HOME 覆盖 + 惰性确保 ----------

describe("workspace/graph 布局（1.1.0 D26）", () => {
  it("图存储收编进 .toporealm/graphs/<id>", () => {
    const ws = workspacePaths("R");
    expect(ws.graphsDir).toBe(path.join("R", ".toporealm", "graphs"));
    const gp = graphPaths("R", "dev");
    expect(gp.dir).toBe(path.join("R", ".toporealm", "graphs", "dev"));
    expect(gp.manifest).toBe(path.join(gp.dir, "graph.yaml"));
    expect(gp.log).toBe(path.join(gp.dir, ".log"));
  });
});

describe("globalPaths", () => {
  it("缺省解析到 ~/.toporealm，不触盘", () => {
    const g = globalPaths();
    expect(g.root).toBe(path.join(os.homedir(), ".toporealm"));
    expect(g.modulesDir).toBe(path.join(os.homedir(), ".toporealm", "modules"));
  });

  it("TOPOREALM_HOME 覆盖（含空白包夹与相对路径 resolve）", () => {
    const g = globalPaths({ TOPOREALM_HOME: "  /tmp/topo-home-test  " });
    expect(g.root).toBe(path.resolve("/tmp/topo-home-test"));
    expect(g.modulesDir).toBe(path.join(path.resolve("/tmp/topo-home-test"), "modules"));
  });

  it("空白字符串的覆盖视为未设置", () => {
    const g = globalPaths({ TOPOREALM_HOME: "   " });
    expect(g.root).toBe(path.join(os.homedir(), ".toporealm"));
  });
});

describe("ensureGlobalDir", () => {
  it("惰性创建 <home>/modules 并返回全局根；幂等", async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-home-"));
    const root1 = await ensureGlobalDir({ TOPOREALM_HOME: home });
    expect(root1).toBe(home);
    await expect(fsp.stat(path.join(home, "modules"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    const root2 = await ensureGlobalDir({ TOPOREALM_HOME: home });
    expect(root2).toBe(home);
  });

  it("不覆盖已存在的池位内容", async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-home-"));
    await fsp.mkdir(path.join(home, "modules", "some-module"), { recursive: true });
    await ensureGlobalDir({ TOPOREALM_HOME: home });
    await expect(fsp.stat(path.join(home, "modules", "some-module"))).resolves.toBeTruthy();
  });
});
