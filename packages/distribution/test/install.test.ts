import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { MemoryClient } from "@lukawi/toporealm-client";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { afterAll, describe, expect, it } from "vitest";
import { installModule, listModules, removeModule, SOURCE_MARKER } from "../src/install.js";
import { readBindingsRaw } from "../src/modules-yaml.js";

// ---------- M4 安装器（blueprint §2 distribution / §1.6 D23①） ----------
// npm 来源走真实 `npm pack --ignore-scripts`（对 fixture 本地包 pack，离线可复现）；
// 断言落位、所有权标记、modules.yaml 绑定、卸载只删带标记目录、daemon 装载全链路。

const fixtures = (p: string): string =>
  fileURLToPath(new URL(`../../../tests/fixtures/${p}`, import.meta.url));

const cardsV2 = fixtures("packages/cards-v2");
const exampleV1 = fixtures("packages/example-module"); // 0.x v1 清单：安装必须拒绝
const exampleV2 = fixtures("modules/example"); // v2 裸目录（本地路径来源）

/**
 * D23④：win32 下 npm 可能解析到 Git Bash 的 GNU tar 而失败——测试在用例内部把
 * System32 前置到子进程 PATH（bsdtar 优先），不依赖外部 shell 环境。
 */
function testEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, npm_config_yes: "true" };
  if (process.platform === "win32") {
    const system32 = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");
    env["PATH"] = `${system32}${path.delimiter}${env["PATH"] ?? ""}`;
  }
  return env;
}

describe("模块安装器（npm pack --ignore-scripts / 本地路径 / 所有权标记）", () => {
  const roots: string[] = [];

  async function makeWorkspace(): Promise<string> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-dist-"));
    roots.push(root);
    await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
    await DaemonCore.createGraph(root, "g1");
    return root;
  }

  afterAll(async () => {
    for (const r of roots) {
      await fsp.rm(r, { recursive: true, force: true }).catch(() => {});
    }
  });

  it(
    "npm 来源：pack --ignore-scripts → 落位 .toporealm/modules/<id>/ + 标记（目录即注册，无绑定，D27）",
    async () => {
      const root = await makeWorkspace();
      const r = await installModule({ root, source: cardsV2, kind: "npm", env: testEnv() });
      expect(r.id).toBe("cards");
      expect(r.version).toBe("1.0.0");
      expect(r.namespace).toBe("cards");
      const dir = path.join(root, ".toporealm", "modules", "cards");
      expect(r.dir).toBe(dir);
      // 落位内容：清单与入口都在（tarball 的 package/ 前缀已 strip）
      await expect(fsp.access(path.join(dir, "module.yaml"))).resolves.toBeUndefined();
      await expect(fsp.access(path.join(dir, "index.js"))).resolves.toBeUndefined();
      // 所有权标记
      const marker = JSON.parse(await fsp.readFile(path.join(dir, SOURCE_MARKER), "utf8")) as {
        format: string;
        id: string;
        origin: { type: string; spec: string };
      };
      expect(marker.format).toBe("toporealm.module-source/v1");
      expect(marker.id).toBe("cards");
      expect(marker.origin.type).toBe("npm");
      expect(marker.origin.spec).toBe(cardsV2);
      // D27：目录即注册——不再写绑定（modules.yaml 只剩 path 职责）
      await expect(
        fsp.access(path.join(root, ".toporealm", "modules.yaml")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
    60_000,
  );

  it(
    "★M4 验收：npm 包安装的模块被 daemon 装载（MemoryClient 目录可见）",
    async () => {
      const root = await makeWorkspace();
      await installModule({ root, source: cardsV2, kind: "npm", env: testEnv() });
      const client = new MemoryClient();
      const s = await client.connect({ root, graph: "g1" });
      try {
        const cat = await s.catalog();
        expect(cat.modules).toContainEqual({ id: "cards", version: "1.0.0", namespace: "cards" });
        expect(cat.commands.map((c) => c.id)).toContain("cards.count-cards");
        const run = await s.run("cards.count-cards");
        expect(run.message).toBe("0 card(s)");
      } finally {
        await s.close();
      }
    },
    60_000,
  );

  it("本地路径来源：复制落位，标记 origin.type=path；裸 v2 目录（无 package.json）也认", async () => {
    const root = await makeWorkspace();
    const r = await installModule({ root, source: exampleV2 });
    expect(r.id).toBe("example");
    expect(r.origin).toMatchObject({ type: "path", path: path.resolve(exampleV2) });
    const marker = JSON.parse(
      await fsp.readFile(path.join(r.dir, SOURCE_MARKER), "utf8"),
    ) as { origin: { type: string } };
    expect(marker.origin.type).toBe("path");
  });

  it("重复安装同 id → ID_EXISTS，fix 指向 module rm", async () => {
    const root = await makeWorkspace();
    await installModule({ root, source: exampleV2 });
    await expect(installModule({ root, source: exampleV2 })).rejects.toMatchObject({
      code: "ID_EXISTS",
      fix: "toporealm module rm example",
    });
  });

  it("0.x v1 清单拒绝安装（1.0 只装 v2；提示指向模块本体仓库升级）", async () => {
    const root = await makeWorkspace();
    await expect(installModule({ root, source: exampleV1 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    // 失败零副作用：无落位、无绑定
    await expect(fsp.access(path.join(root, ".toporealm", "modules", "example"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("卸载：删带标记目录 + 绑定；无标记目录拒绝删除；foreign 目录与绑定共存", async () => {
    const root = await makeWorkspace();
    const r = await installModule({ root, source: exampleV2 });
    // 用户在模块目录里放了自己的文件（模拟共享目录里的外来内容）
    const foreign = path.join(r.dir, "user-notes.md");
    await fsp.writeFile(foreign, "mine", "utf8");
    const res = await removeModule({ root, id: "example" });
    expect(res.removedDir).toBe(r.dir);
    await expect(fsp.access(r.dir)).rejects.toMatchObject({ code: "ENOENT" });
    const bindings = await readBindingsRaw(path.join(root, ".toporealm", "modules.yaml"));
    expect(bindings["example"]).toBeUndefined();

    // 无标记目录 → 拒绝
    const foreignDir = path.join(root, ".toporealm", "modules", "handmade");
    await fsp.mkdir(foreignDir, { recursive: true });
    await fsp.writeFile(path.join(foreignDir, "module.yaml"), "format: toporealm.module/v2\nid: handmade\n", "utf8");
    await fsp.writeFile(
      path.join(root, ".toporealm", "modules.yaml"),
      "handmade:\n  source: workspace\n",
      "utf8",
    );
    await expect(removeModule({ root, id: "handmade" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    // 外来目录原样保留
    await expect(fsp.access(foreignDir)).resolves.toBeUndefined();
  });

  it("list：path 绑定/项目池/全局池三段如实列出（含遮蔽标注，D27）", async () => {
    const root = await makeWorkspace();
    await installModule({ root, source: exampleV2 });
    const globalRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-glist-"));
    await fsp.mkdir(path.join(globalRoot, "modules"), { recursive: true });
    await fsp.cp(exampleV2, path.join(globalRoot, "modules", "example"), { recursive: true });
    await fsp.writeFile(
      path.join(root, ".toporealm", "modules.yaml"),
      ["byref:", "  source: path", `  path: ${JSON.stringify(exampleV2)}`, ""].join("\n"),
      "utf8",
    );
    const rows = await listModules(root, { globalRoot });
    const projectCopy = rows.find((r) => r.pool === "project" && r.id === "example");
    expect(projectCopy).toMatchObject({ pool: "project", version: "1.0.0", namespace: "example" });
    expect(projectCopy?.origin).toMatchObject({ type: "path" });
    expect(rows.find((r) => r.id === "byref")).toMatchObject({ pool: "path", version: "1.0.0" });
    const globalCopy = rows.find((r) => r.pool === "global" && r.id === "example");
    expect(globalCopy).toMatchObject({ pool: "global", shadowed: true });
  });

  it("global 安装/卸载：落全局池、marker 校验同项目池（D27）", async () => {
    const root = await makeWorkspace();
    const globalRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-ginst-"));
    const r = await installModule({ root, source: exampleV2, global: true, globalRoot });
    expect(r.dir).toBe(path.join(globalRoot, "modules", "example"));
    expect(r.note).toContain("全局池");
    await expect(
      installModule({ root, source: exampleV2, global: true, globalRoot }),
    ).rejects.toMatchObject({ code: "ID_EXISTS" });
    const res = await removeModule({ root, id: "example", global: true, globalRoot });
    expect(res.removedDir).toBe(path.join(globalRoot, "modules", "example"));
    await expect(fsp.access(path.join(globalRoot, "modules", "example"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
