import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { MemoryClient } from "@lukawi/toporealm-client";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { TopoError } from "@lukawi/toporealm-protocol";
import { readModuleBindings } from "@lukawi/toporealm-module-host";
import { afterAll, describe, expect, it } from "vitest";
import { installModule, listModules, removeModule, run, SOURCE_MARKER } from "../src/install.js";

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
    const bindings = (await readModuleBindings(root)).bindings;
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

  it(
    "B7：子进程超时 kill 并抛 TopoError(INVALID_INPUT)，消息含超时摘要；正常子进程不受影响",
    async () => {
      const err: unknown = await run(
        process.execPath,
        ["-e", "setInterval(() => {}, 60_000);"], // 挂起的 fake 子进程
        process.env,
        undefined,
        300, // 注入短超时
      ).then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(TopoError);
      const topo = err as TopoError;
      expect(topo.code).toBe("INVALID_INPUT"); // 封闭集内既有码，不新造
      expect(topo.message).toContain("超时");
      expect(topo.message).toContain("300ms");
      // 对照组：快速完成的子进程照常 resolve
      await expect(
        run(process.execPath, ["-e", "process.exit(0)"], process.env, undefined, 10_000),
      ).resolves.toMatchObject({ code: 0 });
    },
    15_000,
  );

  // ---------- G2-9 损坏模块自愈（blueprint D42）+ G2-10③④ ----------

  it("G2-9：坏清单模块——无 --force 拒绝且错误指路 --force；有 --force 删除成功", async () => {
    const root = await makeWorkspace();
    const brokenDir = path.join(root, ".toporealm", "modules", "brokenmod");
    // 用户手工拷进来一个清单损坏的目录（marker 同损）→ daemon 装载大声失败的典型现场
    await fsp.mkdir(brokenDir, { recursive: true });
    await fsp.writeFile(path.join(brokenDir, "module.yaml"), "format: nope\n", "utf8");
    // 无 --force：拒绝，报错直指清理命令
    const noForce: unknown = await removeModule({ root, id: "brokenmod" }).then(
      () => null,
      (e) => e,
    );
    expect(noForce).toBeInstanceOf(TopoError);
    const topo = noForce as TopoError;
    expect(topo.code).toBe("INVALID_INPUT");
    expect(topo.message).toContain("清单不可读");
    expect(topo.fix).toBe("toporealm module rm brokenmod --force");
    await expect(fsp.access(brokenDir)).resolves.toBeUndefined(); // 原样保留
    // 有 --force：豁免所有权检查，删除成功
    const res = await removeModule({ root, id: "brokenmod", force: true });
    expect(res.removedDir).toBe(brokenDir);
    await expect(fsp.access(brokenDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("G2-9：清单可读的无标记外来目录不受 --force 影响（marker 执法不变）", async () => {
    const root = await makeWorkspace();
    const handmade = path.join(root, ".toporealm", "modules", "handmade");
    await fsp.mkdir(handmade, { recursive: true });
    // C3 后「清单可读」= 通过装载同款严格解析（必填字段含 entry）——此处给全合法清单
    await fsp.writeFile(
      path.join(handmade, "module.yaml"),
      "format: toporealm.module/v2\nid: handmade\nnamespace: handmade\nversion: 1.0.0\nentry: ./index.js\n",
      "utf8",
    );
    // 完整合法清单 + 无 marker：--force 也不豁免
    await expect(removeModule({ root, id: "handmade", force: true })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("所有权标记"),
    });
    await expect(fsp.access(handmade)).resolves.toBeUndefined();
    // 带标记的正常模块：--force 与行为无关，照常删除（执法路径不回归）
    const r = await installModule({ root, source: exampleV2 });
    await removeModule({ root, id: r.id, force: true });
    await expect(fsp.access(r.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("G2-10③：rm 未安装的 id 报「未安装」，不再误报「无所有权标记」", async () => {
    const root = await makeWorkspace();
    const err: unknown = await removeModule({ root, id: "never-installed" }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(TopoError);
    expect((err as TopoError).message).toContain("未安装");
    expect((err as TopoError).message).not.toContain("所有权标记");
  });

  it("G2-10④：不存在形如本地路径的 source → 友好报错（不再当 npm spec 去 pack）", async () => {
    const root = await makeWorkspace();
    // 绝对路径不存在
    const abs = path.join(root, "no-such-module");
    await expect(installModule({ root, source: abs })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("本地模块目录不存在"),
    });
    // 相对路径不存在（带 ./）
    await expect(installModule({ root, source: "./also-missing" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("本地模块目录不存在"),
    });
    // 对照：@scope 包名缺 registry 仍走 npm（报 npm 错，不是「目录不存在」）
    const npmErr: unknown = await installModule({ root, source: "@scope/definitely-not-here" }).then(
      () => null,
      (e) => e,
    );
    expect(npmErr).toBeInstanceOf(TopoError);
    expect((npmErr as TopoError).message).not.toContain("本地模块目录不存在");
  }, 30_000);

  it("G2-10④补充：存在的 .tgz 文件不被「目录不存在」拦截，照旧走 npm pack（tarball 直装）", async () => {
    const root = await makeWorkspace();
    // 用 fixture 目录打一个真 tarball（npm pack 接受本地 tarball，原样返回其路径）
    const tgz = path.join(root, "fake-1.0.0.tgz");
    await fsp.writeFile(tgz, "not-a-real-tar");
    const err: unknown = await installModule({ root, source: tgz }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(TopoError);
    // 走到 npm pack 流程后报的是 pack/manifest 类错误，而不是「本地模块目录不存在」
    expect((err as TopoError).message).not.toContain("本地模块目录不存在");
  }, 30_000);

  // ---------- C3 清单解析归一：安装期与装载期同一解析器、同一形状校验 ----------

  /** 造一个清单内容可定制的本地模块目录（path 来源安装的最小现场）。 */
  async function makeModuleDir(moduleYaml: string): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-c3-mod-"));
    roots.push(dir);
    await fsp.writeFile(path.join(dir, "module.yaml"), moduleYaml, "utf8");
    return dir;
  }

  it("C3：requires.modules 非 string[] → 安装期 INVALID_INPUT（不再装进去后装载期才炸）", async () => {
    const root = await makeWorkspace();
    const src = await makeModuleDir(
      [
        "format: toporealm.module/v2",
        "id: badreq",
        "namespace: badreq",
        'version: "1.0.0"',
        "entry: ./index.js",
        "requires:",
        '  modules: "cards"', // 形状坏：必须是 string[]
      ].join("\n"),
    );
    const err: unknown = await installModule({ root, source: src }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(TopoError);
    const topo = err as TopoError;
    expect(topo.code).toBe("INVALID_INPUT"); // 封闭集内既有码
    expect(topo.message).toContain("requires.modules");
    expect(topo.message).toContain(src); // 安装期报错含来源路径
    // 失败零副作用：无落位
    await expect(
      fsp.access(path.join(root, ".toporealm", "modules", "badreq")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("C3：缺 entry 的清单安装期即拒（该清单装载期必炸，seam 前移）", async () => {
    const root = await makeWorkspace();
    const src = await makeModuleDir(
      "format: toporealm.module/v2\nid: noentry\nnamespace: noentry\nversion: 1.0.0\n",
    );
    await expect(installModule({ root, source: src })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("entry"),
    });
    await expect(
      fsp.access(path.join(root, ".toporealm", "modules", "noentry")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("C3：modules.yaml 损坏 → 安装器大声失败（rm/list 不再静默当空绑定降级）", async () => {
    const root = await makeWorkspace();
    const r = await installModule({ root, source: exampleV2 });
    await fsp.writeFile(
      path.join(root, ".toporealm", "modules.yaml"),
      "example: { source: path\n  broken: [unclosed\n",
      "utf8",
    );
    await expect(listModules(root)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // rm 不再因「绑定读失败被吞」绕过 path 绑定保护直接删目录
    await expect(removeModule({ root, id: r.id })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(fsp.access(r.dir)).resolves.toBeUndefined(); // 目录原样保留
  });
});
