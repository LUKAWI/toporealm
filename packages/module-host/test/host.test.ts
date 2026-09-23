import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { TopoError } from "@lukawi/toporealm-protocol";
import { ModuleHost, moduleBindingDigest } from "../src/index.js";
import exampleFixture from "../../../tests/fixtures/modules/example/index.js";

// ---------- S2：fixture 模块直 activate 进内存 daemon（blueprint §8） ----------
// 所有权法、钩子 veto、目录自省、注册冻结全部在真缝上测。

const fixturesDir = fileURLToPath(
  new URL("../../../tests/fixtures/modules/", import.meta.url),
);

/** 绑定表 → modules.yaml 文本（path 来源；JSON 双引号写法兼容 Windows 反斜杠路径） */
function bindingYaml(entries: Record<string, string>): string {
  return (
    Object.entries(entries)
      .map(([id, dir]) => `${id}:\n  source: path\n  path: ${JSON.stringify(dir)}`)
      .join("\n") + "\n"
  );
}

const fixturePath = (name: string): string =>
  path.join(fixturesDir, name);

async function tmpWorkspace(
  bindings?: Record<string, string>,
): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-mh-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "g1");
  if (bindings) {
    await fsp.writeFile(
      path.join(root, ".toporealm", "modules.yaml"),
      bindingYaml(bindings),
      "utf8",
    );
  }
  return root;
}

async function openWithModules(
  root: string,
  bindings?: Record<string, string>,
): Promise<{ core: DaemonCore; host: ModuleHost }> {
  const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
  const host = await ModuleHost.load(core, { root });
  return { core, host };
}

describe("S2 装载：发现/声明解析/拓扑排序/activate 恰好一次", () => {
  it("装载 example + workflow-mini：目录聚合为真（modules/kinds/commands），requires 拓扑序", async () => {
    // modules.yaml 故意逆序：workflow-mini 在前，依赖 example 在后 → 装载仍必须 example 先
    const root = await tmpWorkspace({
      "workflow-mini": fixturePath("workflow-mini"),
      example: fixturePath("example"),
    });
    const { core, host } = await openWithModules(root);
    expect(host.loadedIds).toEqual(["example", "workflow-mini"]);
    const cat = host.catalog();
    expect(cat.modules).toEqual([
      { id: "example", version: "1.0.0", namespace: "example" },
      { id: "workflow-mini", version: "1.0.0", namespace: "wf" },
    ]);
    const kinds = Object.fromEntries(cat.kinds.map((k) => [k.kind, k]));
    expect(kinds["example.card"]).toMatchObject({
      owner: "example",
      color: "#f59e0b",
    });
    expect(kinds["wf.task"]).toMatchObject({ owner: "wf", color: "#3b82f6" });
    expect(kinds["wf.blocks"]).toMatchObject({ owner: "wf" });
    const cmdIds = cat.commands.map((c) => c.id);
    expect(cmdIds).toEqual(
      expect.arrayContaining([
        "example.create-card",
        "example.scribble",
        "example.steal",
        "wf.start",
        "wf.pass",
        "wf.next",
      ]),
    );
    // 目录条目 = 注册事实：title 必载，appliesTo/input 透传
    const start = cat.commands.find((c) => c.id === "wf.start");
    expect(start).toMatchObject({ module: "workflow-mini", target: "wf.task", title: "开始任务：status → running" });
    const create = cat.commands.find((c) => c.id === "example.create-card");
    expect((create?.input as { type?: string })?.type).toBe("object");
    // 声明 ui.titleKey 不改变 core 信封（core 不解释载荷）
    expect(core.status().modules).toEqual(["example", "workflow-mini"]);
    core.dispose();
  });

  it("activate 恰好一次：每轮 load 计数恰好 +1", async () => {
    const before = (exampleFixture as { activations: number }).activations;
    const root = await tmpWorkspace({ example: fixturePath("example") });
    const { core, host } = await openWithModules(root);
    expect((exampleFixture as { activations: number }).activations).toBe(before + 1);
    expect(host.loadedIds).toEqual(["example"]);
    core.dispose();
    // 二次装载（第二个 daemon 实例）→ 再 +1，不是复用
    const { core: core2, host: host2 } = await openWithModules(root);
    expect((exampleFixture as { activations: number }).activations).toBe(before + 2);
    expect(host2.loadedIds).toEqual(["example"]);
    core2.dispose();
  });

  it("workflow-mini 恰好激活一次（每次 load 计数恰好 +1）", async () => {
    const wf = (await import(
      pathToFileURL(path.join(fixturePath("workflow-mini"), "index.js")).href
    )) as { default: { activations: number } };
    const root = await tmpWorkspace({
      example: fixturePath("example"),
      "workflow-mini": fixturePath("workflow-mini"),
    });
    const before = wf.default.activations;
    const { core } = await openWithModules(root);
    expect(wf.default.activations).toBe(before + 1);
    core.dispose();
  });

  it("M6：requires.modules 缺失 → 启动大声失败并点名缺失 + fix", async () => {
    const root = await tmpWorkspace({ "workflow-mini": fixturePath("workflow-mini") });
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    const err = await ModuleHost.load(core, { root }).catch((e: unknown) => e);
    expect(TopoError.is(err)).toBe(true);
    expect((err as TopoError).code).toBe("MISSING_MODULE");
    expect((err as TopoError).message).toContain("example");
    expect((err as TopoError).details).toMatchObject({
      module: "workflow-mini",
      missing: ["example"],
    });
    expect((err as TopoError).fix).toContain("toporealm module add example");
    core.dispose();
  });

  it("循环依赖 → 启动大声失败并点名环内模块", async () => {
    const root = await tmpWorkspace();
    for (const [id, req] of [
      ["mod-a", "mod-b"],
      ["mod-b", "mod-a"],
    ] as const) {
      const dir = path.join(root, ".toporealm", "modules", id);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, "module.yaml"),
        `format: toporealm.module/v2\nid: ${id}\nnamespace: ${id}\nversion: "1.0.0"\nrequires:\n  modules: [${req}]\nentry: ./index.js\n`,
        "utf8",
      );
      await fsp.writeFile(
        path.join(dir, "index.js"),
        "export default { activate() {} };\n",
        "utf8",
      );
    }
    await fsp.writeFile(
      path.join(root, ".toporealm", "modules.yaml"),
      bindingYaml({ "mod-a": path.join(root, ".toporealm", "modules", "mod-a") }) +
        bindingYaml({ "mod-b": path.join(root, ".toporealm", "modules", "mod-b") }),
      "utf8",
    );
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    const err = await ModuleHost.load(core, { root }).catch((e: unknown) => e);
    expect((err as TopoError).code).toBe("INVALID_INPUT");
    expect((err as TopoError).message).toContain("循环");
    core.dispose();
  });

  it("非 v2 声明 / 绑定键与 id 不一致 → 启动大声失败", async () => {
    const root = await tmpWorkspace();
    const dir = path.join(root, "legacy-mod");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, "module.yaml"),
      "format: toporealm.module/v1\nid: legacy\nnamespace: legacy\nversion: \"0.1.0\"\nentry: ./index.js\n",
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, ".toporealm", "modules.yaml"),
      bindingYaml({ legacy: dir }),
      "utf8",
    );
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    const err = await ModuleHost.load(core, { root }).catch((e: unknown) => e);
    expect((err as TopoError).code).toBe("INVALID_INPUT");
    expect((err as TopoError).message).toContain("toporealm.module/v2");
    core.dispose();
  });

  it("无 modules.yaml = 空模块集：装载成功，目录只有活图 kind", async () => {
    const root = await tmpWorkspace();
    const { core, host } = await openWithModules(root);
    expect(host.loadedIds).toEqual([]);
    expect(host.catalog().commands).toEqual([]);
    expect(host.catalog().kinds).toEqual([]);
    expect(moduleBindingDigest(null)).toBe(host.digest);
    core.dispose();
  });
});

describe("S2 命令分发：target 存在性 + appliesTo 兑现 + did-you-mean", () => {
  it("全链路：create-card 提交 + after-commit 排队补 stamp（revision 前进 2，事件不嵌套）", async () => {
    const root = await tmpWorkspace({
      example: fixturePath("example"),
      "workflow-mini": fixturePath("workflow-mini"),
    });
    const { core, host } = await openWithModules(root);
    const r = await host.run("example.create-card", {
      input: { title: "Hello" },
    });
    expect(r.message).toContain("@ rev 1");
    // commits = 命令经 api.commit 的真实提交（排队追加走 core 内部队列，不重复计）
    expect(r.commits).toHaveLength(1);
    expect(r.commits?.map((c) => c.revision)).toEqual([1]);
    // after-commit 钩子的排队 merge 已追加：revision 2、payload 带标记
    expect(core.revision).toBe(2);
    const card = core.read({ kinds: ["example.card"] }).entities[0];
    expect(card?.payload).toMatchObject({ title: "Hello", source: "example-module" });
    // 提交日志：主提交 + 排队追加都入账
    const labels = core.tailLog().map((e) => e.label);
    expect(labels).toContain("example.create-card");
    expect(labels).toContain("example stamp");
    expect(core.tailLog().at(-1)?.origin).toBe("module:example");
    core.dispose();
  });

  it("UNKNOWN_COMMAND 带 did-you-mean（来自目录）", async () => {
    const root = await tmpWorkspace({ example: fixturePath("example") });
    const { core, host } = await openWithModules(root);
    const err = await host.run("example.create-cardd").catch((e: unknown) => e);
    expect((err as TopoError).code).toBe("UNKNOWN_COMMAND");
    expect((err as TopoError).details?.suggestions).toContain("example.create-card");
    core.dispose();
  });

  it("appliesTo：缺 target / 目标不存在 / 主类型不符 / 兑现通过", async () => {
    const root = await tmpWorkspace({
      example: fixturePath("example"),
      "workflow-mini": fixturePath("workflow-mini"),
    });
    const { core, host } = await openWithModules(root);
    // 缺 target（appliesTo 命令）
    const noTarget = await host.run("wf.start").catch((e: unknown) => e);
    expect((noTarget as TopoError).code).toBe("INVALID_INPUT");
    expect((noTarget as TopoError).details).toMatchObject({ appliesTo: "wf.task" });
    // 目标不存在：UNKNOWN_ID + did-you-mean
    await core.commit(
      { changes: [{ op: "put", kind: "wf.task", id: "task-1", payload: { title: "T", status: "pending" } }] },
      "cli",
    );
    const ghost = await host.run("wf.start", { target: "task-1x" }).catch((e: unknown) => e);
    expect((ghost as TopoError).code).toBe("UNKNOWN_ID");
    expect((ghost as TopoError).details?.suggestions).toContain("task-1");
    // 主类型不符：appliesTo 不兑现
    await core.commit(
      { changes: [{ op: "put", kind: "example.card", id: "card-1", payload: {} }] },
      "cli",
    );
    const wrongKind = await host.run("wf.start", { target: "card-1" }).catch((e: unknown) => e);
    expect((wrongKind as TopoError).code).toBe("INVALID_INPUT");
    expect((wrongKind as TopoError).message).toContain("wf.task");
    // 全局命令不需要 target
    const next = await host.run("wf.next");
    expect((next.data as { tasks: string[] }).tasks).toEqual(["task-1"]);
    // 兑现通过：status pending → running
    const ok = await host.run("wf.start", { target: "task-1" });
    expect(ok.message).toBe("started task-1");
    expect(core.read({ ids: ["task-1"] }).entities[0]?.payload?.status).toBe("running");
    core.dispose();
  });

  it("INVALID_INPUT 只做结构检查：input 非映射即拒；schema 不是门禁（坏 schema 值放行）", async () => {
    const root = await tmpWorkspace({ example: fixturePath("example") });
    const { core, host } = await openWithModules(root);
    const bad = await host.run("example.create-card", { input: [1, 2] }).catch((e: unknown) => e);
    expect((bad as TopoError).code).toBe("INVALID_INPUT");
    // schema 说 title 是 string；但 schema 是说明书：数字照样进来（不执法）
    const r = await host.run("example.create-card", { input: { title: 42 } });
    expect(r.commits).toHaveLength(1); // schema 不执法：主提交成功；排队 stamp 不计
    expect(core.read({ kinds: ["example.card"] }).entities[0]?.payload?.title).toBe(42);
    core.dispose();
  });
});

describe("S2 钩子与执法：VETOED 结构化否决 / 所有权 / 词汇偏差 warning", () => {
  it("before-commit veto：VETOED 带 details.vetoes[]；钩子对一切来源生效（含 cli）", async () => {
    const root = await tmpWorkspace({
      example: fixturePath("example"),
      "workflow-mini": fixturePath("workflow-mini"),
    });
    const { core, host } = await openWithModules(root);
    // 经命令链触发 example 钩子
    const poison = await host
      .run("example.create-card", { input: { poison: true } })
      .catch((e: unknown) => e);
    expect((poison as TopoError).code).toBe("VETOED");
    const vetoes = ((poison as TopoError).details as { vetoes: { reason: string }[] })
      .vetoes;
    expect(vetoes).toHaveLength(1);
    expect(vetoes[0]?.reason).toContain("poison");
    // cli 来源也被 workflow-mini 钩子把关（钩子对一切来源生效）
    await core.commit(
      { changes: [{ op: "put", kind: "wf.task", id: "t1", payload: { status: "pending" } }] },
      "cli",
    );
    const illegal = await core
      .commit(
        { changes: [{ op: "merge", id: "t1", payload: { status: "passed" } }] },
        "cli",
      )
      .catch((e: unknown) => e);
    expect((illegal as TopoError).code).toBe("VETOED");
    expect((illegal as TopoError).message).toContain("pending");
    // 否决零副作用
    expect(core.read({ ids: ["t1"] }).entities[0]?.payload?.status).toBe("pending");
    expect(core.status().counts["example.card"]).toBeUndefined();
    core.dispose();
  });

  it("命令链 veto：wf.pass 在 pending 任务上被本模块钩子否决；先 start 则通过", async () => {
    const root = await tmpWorkspace({
      example: fixturePath("example"),
      "workflow-mini": fixturePath("workflow-mini"),
    });
    const { core, host } = await openWithModules(root);
    await core.commit(
      { changes: [{ op: "put", kind: "wf.task", id: "t2", payload: { status: "pending" } }] },
      "cli",
    );
    const vetoed = await host.run("wf.pass", { target: "t2" }).catch((e: unknown) => e);
    expect((vetoed as TopoError).code).toBe("VETOED");
    expect((vetoed as TopoError).message).toContain("pending");
    await host.run("wf.start", { target: "t2" });
    const ok = await host.run("wf.pass", { target: "t2" });
    expect(ok.message).toBe("passed t2");
    expect(core.read({ ids: ["t2"] }).entities[0]?.payload?.status).toBe("passed");
    core.dispose();
  });

  it("所有权法：模块越界写他人命名空间 → OWNERSHIP_VIOLATION（core 执法）", async () => {
    const root = await tmpWorkspace({
      example: fixturePath("example"),
      "workflow-mini": fixturePath("workflow-mini"),
    });
    const { core, host } = await openWithModules(root);
    const err = await host.run("example.steal").catch((e: unknown) => e);
    expect((err as TopoError).code).toBe("OWNERSHIP_VIOLATION");
    expect((err as TopoError).details).toMatchObject({ module: "example", kind: "wf.task" });
    expect(core.read({ ids: ["stolen"] }).entities).toHaveLength(0);
    core.dispose();
  });

  it("声明词汇偏差：写入未声明 kind 提交成功 + 记 warning（不执法，D8）", async () => {
    const root = await tmpWorkspace({ example: fixturePath("example") });
    const { core, host } = await openWithModules(root);
    const r = await host.run("example.scribble");
    expect(r.message).toContain("scribbled");
    expect(core.read({ kinds: ["example.scribble"] }).entities).toHaveLength(1);
    expect(
      host.warnings.some(
        (w) => w.includes("example.scribble") && w.includes("未声明"),
      ),
    ).toBe(true);
    core.dispose();
  });

  it("form 注册：kind → FormSpec 投影可读（M3 WebUI 面）；目录投影随 D24② 过缝", async () => {
    const root = await tmpWorkspace({
      example: fixturePath("example"),
      "workflow-mini": fixturePath("workflow-mini"),
    });
    const { core, host } = await openWithModules(root);
    expect(host.form("example.card")?.fields.map((f) => f.name)).toEqual(["title", "pinned"]);
    const wfForm = host.form("wf.task");
    expect(wfForm?.fields.find((f) => f.name === "status")?.options).toContain("running");
    expect(host.form("nope.thing")).toBeUndefined();
    // D24②：catalog() 把 form 注册面投影进目录（仅非空时携带）；scope 收窄按命名空间
    const cat = host.catalog();
    const forms = Object.fromEntries((cat.forms ?? []).map((f) => [f.kind, f.form]));
    expect(forms["example.card"]?.fields.map((f) => f.name)).toEqual(["title", "pinned"]);
    expect(forms["wf.task"]?.fields.some((f) => f.name === "status")).toBe(true);
    const wfCat = host.catalog("wf");
    expect((wfCat.forms ?? []).map((f) => f.kind)).toEqual(["wf.task"]);
    core.dispose();
  });

  it("模块命令抛鸭子类型领域错误 → 分发面认领重建为 TopoError（D24④）", async () => {
    const root = await tmpWorkspace();
    const dir = path.join(root, ".toporealm", "modules", "duck-mod");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, "module.yaml"),
      `format: toporealm.module/v2\nid: duck-mod\nnamespace: duck\nversion: "1.0.0"\nentry: ./index.js\n`,
      "utf8",
    );
    // 自包含模块持不到 TopoError 类身份：普通对象 + 封闭集 code + 消息
    await fsp.writeFile(
      path.join(dir, "index.js"),
      `export default { activate(api) {
        api.command({ name: "boom", title: "抛鸭子类型领域错误" }, () => {
          throw { name: "TopoError", code: "INVALID_INPUT", message: "领域输入不合法", hint: "按 hint 修正", fix: "toporealm cmds", details: { why: "demo" } };
        });
        api.command({ name: "plain", title: "抛普通错误" }, () => {
          throw new Error("真内部错误");
        });
      } };\n`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, ".toporealm", "modules.yaml"),
      bindingYaml({ "duck-mod": dir }),
      "utf8",
    );
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    const host = await ModuleHost.load(core, { root });
    const err = await host.run("duck.boom").catch((e: unknown) => e);
    expect(TopoError.is(err)).toBe(true);
    expect((err as TopoError).code).toBe("INVALID_INPUT");
    expect((err as TopoError).message).toBe("领域输入不合法");
    expect((err as TopoError).hint).toBe("按 hint 修正");
    expect((err as TopoError).details).toEqual({ why: "demo" });
    // 形状不符（普通 Error）原样上抛 → wire 层归 DAEMON_UNREACHABLE，不在分发面伪造领域码
    const plain = await host.run("duck.plain").catch((e: unknown) => e);
    expect(TopoError.is(plain)).toBe(false);
    core.dispose();
  });
});

describe("S2 注册面冻结（LATE_REGISTRATION）", () => {
  it("activate 返回后再注册 command/hook/form → LATE_REGISTRATION", async () => {
    const root = await tmpWorkspace();
    const dir = path.join(root, "late-mod");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, "module.yaml"),
      `format: toporealm.module/v2\nid: late-mod\nnamespace: late\nversion: "1.0.0"\nentry: ./index.js\n`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(dir, "index.js"),
      `
const key = "__toporealm_late_catch__";
export default {
  activate(api) {
    // activate 内合法注册
    api.command({ name: "ontime", title: "on time" }, () => ({ message: "ok" }));
    // 返回后再注册（异步逃逸）——期望 LATE_REGISTRATION
    setTimeout(() => {
      try {
        api.command({ name: "late", title: "late" }, () => ({}));
        globalThis[key] = null;
      } catch (e) {
        globalThis[key] = e;
      }
    }, 0);
  },
};
`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, ".toporealm", "modules.yaml"),
      bindingYaml({ "late-mod": dir }),
      "utf8",
    );
    const { core, host } = await openWithModules(root);
    // 目录在冻结时定格：迟到的注册不出现
    expect(host.catalog().commands.map((c) => c.id)).toEqual(["late.ontime"]);
    for (let i = 0; i < 50 && globalThis.__toporealm_late_catch__ === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const late = globalThis.__toporealm_late_catch__ as TopoError | null;
    expect(TopoError.is(late)).toBe(true);
    expect(late?.code).toBe("LATE_REGISTRATION");
    expect(late?.details).toMatchObject({ module: "late-mod" });
    delete (globalThis as { __toporealm_late_catch__?: unknown }).__toporealm_late_catch__;
    core.dispose();
  });
});
