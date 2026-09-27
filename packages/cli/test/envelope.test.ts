import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { MemoryClient } from "@lukawi/toporealm-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { Argv } from "../src/usage.js";
import { isolateGlobalHome } from "../../../tests/test-env.js";

// ---------- CLI golden 信封 + 退出码表驱动（blueprint §8：MemoryClient 后端） ----------
// 测试隔离（1.2.0 G5）：TOPOREALM_HOME 指向一次性空目录，防开发机 ~/.toporealm
// 全局池模块泄漏进 MemoryClient → ModuleHost.load（其只读 process.env，不看 deps.env）。

let root: string;
let restoreHome: (() => void) | undefined;

beforeAll(async () => {
  restoreHome = (await isolateGlobalHome()).restore;
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-cli-"));
});

afterAll(() => {
  restoreHome?.();
});

function makeDeps(cwd: string) {
  const collected = { out: "", err: "" };
  const client = new MemoryClient();
  return {
    deps: {
      clientFactory: () => client,
      cwd,
      env: {},
      out: (s: string) => {
        collected.out += s;
      },
      err: (s: string) => {
        collected.err += s;
      },
    },
    collected,
  };
}

async function exec(args: string[], cwd = root) {
  const { deps, collected } = makeDeps(cwd);
  const code = await run(args, deps);
  return { code, ...collected };
}

function jsonOf(r: { code: number; out: string; err: string }): Record<string, unknown> {
  return JSON.parse(r.code === 0 ? r.out : r.err) as Record<string, unknown>;
}

describe("CLI --json 信封 + 退出码", () => {
  it("new：初始化工作区并选中；重复 new → 领域错误(1)；非法 id → 用法错误(2)", async () => {
    const r = await exec(["--json", "creategraph", "flow"]);
    expect(r.code).toBe(0);
    expect(jsonOf(r)).toMatchObject({ ok: true, data: { graph: "flow" } });
    const dup = await exec(["--json", "creategraph", "flow"]);
    expect(dup.code).toBe(1);
    expect(jsonOf(dup)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    const bad = await exec(["--json", "creategraph", "a/b"]);
    expect(bad.code).toBe(2);
    // use 不存在的图 → 领域错误(1)
    const miss = await exec(["--json", "use", "nope"]);
    expect(miss.code).toBe(1);
    expect(jsonOf(miss)).toMatchObject({ ok: false, error: { code: "GRAPH_NOT_FOUND" } });
  });

  it("add：created id 回显；status 形状", async () => {
    const r = await exec([
      "--json",
      "add",
      "wf.task",
      "--id",
      "t1",
      "--payload",
      JSON.stringify({ title: "A", status: "todo" }),
    ]);
    expect(r.code).toBe(0);
    expect(jsonOf(r)).toMatchObject({
      ok: true,
      data: { id: "t1", created: [] }, // 显式 id 不进 created（只回显 daemon 分配的匿名 id）
      revision: 1,
    });
    expect(jsonOf(r).instanceId).toBeTruthy();
    const anon = await exec(["--json", "add", "wf.task"]);
    expect(anon.code).toBe(0);
    const anonId = (jsonOf(anon) as { data: { id: string } }).data.id;
    expect(anonId).not.toBe("t1");
    const st = await exec(["--json", "status"]);
    const data = (jsonOf(st) as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ graphId: "flow", revision: 2, canUndo: true });
    expect((data.counts as Record<string, number>)["wf.task"]).toBe(2);
  });

  it("set：浅合并 / null 删键 / --replace", async () => {
    const r = await exec(["--json", "set", "t1", "status=done", "n=3"]);
    expect(r.code).toBe(0);
    let rd = jsonOf(await exec(["--json", "read", "t1"]));
    expect((rd as { data: { entity: { payload: Record<string, unknown> } } }).data.entity.payload).toEqual({
      title: "A",
      status: "done",
      n: 3,
    });
    await exec(["--json", "set", "t1", "n=null"]);
    rd = jsonOf(await exec(["--json", "read", "t1"]));
    expect(
      (rd as { data: { entity: { payload: Record<string, unknown> } } }).data.entity.payload,
    ).toEqual({ title: "A", status: "done" });
    const rp = await exec([
      "--json",
      "set",
      "t1",
      "--replace",
      "--payload",
      JSON.stringify({ title: "A2" }),
    ]);
    expect(rp.code).toBe(0);
    rd = jsonOf(await exec(["--json", "read", "t1"]));
    expect(
      (rd as { data: { entity: { payload: Record<string, unknown> } } }).data.entity.payload,
    ).toEqual({ title: "A2" });
    // set 到不存在的 id：did-you-mean
    const typo = await exec(["--json", "set", "t1x", "status=done"]);
    expect(typo.code).toBe(1);
    const errEnvelope = jsonOf(typo) as { error: { code: string; details?: { suggestions?: string[] }; hint?: string } };
    expect(errEnvelope.error.code).toBe("UNKNOWN_ID");
    expect(errEnvelope.error.details?.suggestions).toContain("t1");
    expect(errEnvelope.error.hint).toContain("t1");
  });

  it("link：无关系类型时缺 --kind → 用法错误(2)；单一关系类型可省 --kind", async () => {
    await exec(["--json", "add", "wf.task", "--id", "t2"]);
    const noKind = await exec(["--json", "link", "t1", "t2"]);
    expect(noKind.code).toBe(2);
    const withKind = await exec(["--json", "link", "t1", "t2", "--kind", "wf.blocks"]);
    expect(withKind.code).toBe(0);
    const inferred = await exec(["--json", "link", "t2", "t1"]);
    expect(inferred.code).toBe(0);
    const dangling = await exec(["--json", "rm", "t1"]);
    expect(dangling.code).toBe(1);
    const env = jsonOf(dangling) as { error: { code: string; fix?: string; details?: { edges?: unknown[] } } };
    expect(env.error.code).toBe("DANGLING_RELATION");
    expect(env.error.fix).toContain("rm ");
    expect(env.error.details?.edges).toHaveLength(2);
  });

  it("read/find：过滤 + 投影 + 单点邻域", async () => {
    await exec(["--json", "set", "t1", "status=done"]);
    const single = await exec(["--json", "read", "t1"]);
    const singleData = (jsonOf(single) as { data: { entity: { id: string }; relations: unknown[] } }).data;
    expect(singleData.entity.id).toBe("t1");
    expect(singleData.relations.length).toBeGreaterThanOrEqual(1);
    const proj = jsonOf(
      await exec(["--json", "read", "--kind", "wf.task", "--fields", "id", "--limit", "1"]),
    ) as { data: { entities: Record<string, unknown>[] } };
    expect(proj.data.entities).toHaveLength(1);
    expect(Object.keys(proj.data.entities[0] as object)).toEqual(["id"]);
    const found = jsonOf(await exec(["--json", "find", "status=done", "--kind", "wf.task"])) as {
      data: { entities: { id: string }[] };
    };
    expect(found.data.entities.map((e) => e.id)).toContain("t1");
    // --fields 逗号写法（blueprint §4 示例拼写）：逗号与重复 flag 等价
    const comma = jsonOf(
      await exec(["--json", "find", "status=done", "--fields", "id,status"]),
    ) as { data: { entities: Record<string, unknown>[] } };
    expect(comma.data.entities.length).toBeGreaterThanOrEqual(1);
    for (const e of comma.data.entities) {
      expect(Object.keys(e).sort()).toEqual(["id", "payload"]);
      expect((e.payload as Record<string, unknown>).status).toBe("done");
    }
    const repeated = jsonOf(
      await exec(["--json", "find", "status=done", "--fields", "id", "--fields", "status"]),
    ) as { data: { entities: Record<string, unknown>[] } };
    expect(repeated.data.entities).toEqual(comma.data.entities);
    // 非法值：空字段/空段本地即报用法错误（exit 2），不静默投进 core 得到空投影
    const emptyMid = await exec(["--json", "read", "--fields", "id,,status"]);
    expect(emptyMid.code).toBe(2);
    expect(jsonOf(emptyMid)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    const emptyTail = await exec(["--json", "read", "--fields", "id,"]);
    expect(emptyTail.code).toBe(2);
  });

  it("B1：find 多 --kind 取并集（core where 是交集，多 kind 不得恒空）；单 kind 行为不变", async () => {
    await exec(["--json", "add", "wf.note", "--id", "n1", "--payload", JSON.stringify({ tag: "multi" })]);
    await exec(["--json", "set", "t1", "tag=multi"]);
    // 多 kind：两种 kind 命中的并集（修复前 where 交集语义恒为空集）
    const both = jsonOf(
      await exec(["--json", "find", "tag=multi", "--kind", "wf.task", "--kind", "wf.note"]),
    ) as { data: { entities: { id: string; kind: string }[] } };
    expect(both.data.entities.map((e) => e.id).sort()).toEqual(["n1", "t1"]);
    expect(both.data.entities.map((e) => e.kind).sort()).toEqual(["wf.note", "wf.task"]);
    // 单 kind：维持单次 read，行为不变
    const one = jsonOf(
      await exec(["--json", "find", "tag=multi", "--kind", "wf.note"]),
    ) as { data: { entities: { id: string }[] } };
    expect(one.data.entities.map((e) => e.id)).toEqual(["n1"]);
    // 无 kind：行为不变
    const none = jsonOf(await exec(["--json", "find", "tag=multi"])) as {
      data: { entities: { id: string }[] };
    };
    expect(none.data.entities.map((e) => e.id).sort()).toEqual(["n1", "t1"]);
  });

  it("F2：--fields 投影缺 kind 时人类输出省略方括号段（不出现 [undefined]）", async () => {
    const projected = await exec(["read", "--kind", "wf.task", "--fields", "id"]);
    expect(projected.code).toBe(0);
    expect(projected.out).not.toContain("[undefined]");
    expect(projected.out).toContain("t1");
    // 对照：完整读出的实体仍带 [kind] 段
    const full = await exec(["read", "--kind", "wf.task"]);
    expect(full.out).toContain("[wf.task]");
  });

  it("undo/redo/log", async () => {
    const before = (jsonOf(await exec(["--json", "status"])) as { revision: number }).revision;
    const u = jsonOf(await exec(["--json", "undo"])) as { revision: number };
    expect(u.revision).toBe(before + 1);
    const r = jsonOf(await exec(["--json", "redo"])) as { revision: number };
    expect(r.revision).toBe(u.revision + 1);
    const log = jsonOf(await exec(["--json", "log", "-n", "3"])) as {
      revision: number;
      data: { entries: { kind: string; origin: string; revision: number }[] };
    };
    expect(log.data.entries.length).toBeGreaterThan(0);
    expect(log.data.entries.at(-1)?.kind).toBe("commit");
    expect(log.data.entries.at(-1)?.origin).toBe("cli");
    expect(log.revision).toBeGreaterThan(0); // 信封补 revision 字段
  });

  it("用法错误(2) / 环境错误(1) / 人类模式输出", async () => {
    const unknownVerb = await exec(["--json", "frobnicate"]);
    expect(unknownVerb.code).toBe(2);
    expect(jsonOf(unknownVerb)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    const suggest = await exec(["stats"]);
    expect(suggest.err).toContain("status"); // did-you-mean 落到最接近动词
    const human = await exec(["status"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("flow @ rev");
    expect(() => JSON.parse(human.out)).toThrow();
    const noWsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-nows-"));
    const noWs = await exec(["--json", "status"], noWsRoot);
    expect(noWs.code).toBe(1);
    expect(jsonOf(noWs)).toMatchObject({ ok: false, error: { code: "NO_WORKSPACE" } });
  });

  it("B3：CLI 本地内部错误不再伪装 daemon 不可达——message 前缀 + details.local，退出码语义不变(1)", async () => {
    const collected = { out: "", err: "" };
    const code = await run(["--json", "status"], {
      clientFactory: () => {
        throw new Error("boom: 本地炸了");
      },
      cwd: root,
      env: {},
      out: (s: string) => (collected.out += s),
      err: (s: string) => (collected.err += s),
    });
    expect(code).toBe(1); // 领域错误退出码语义不变
    const envelope = JSON.parse(collected.err) as {
      ok: boolean;
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("DAEMON_UNREACHABLE"); // 错误码封闭集不破
    expect(envelope.error.message).toContain("cli internal error:");
    expect(envelope.error.message).toContain("boom");
    expect(envelope.error.details?.["local"]).toBe(true);
    // 人类模式同样带前缀
    const human = { out: "", err: "" };
    const humanCode = await run(["status"], {
      clientFactory: () => {
        throw new Error("boom: 本地炸了");
      },
      cwd: root,
      env: {},
      out: (s: string) => (human.out += s),
      err: (s: string) => (human.err += s),
    });
    expect(humanCode).toBe(1);
    expect(human.err).toContain("cli internal error:");
  });

  it("B8：help version 落未知命令路径（exit 2 + did-you-mean + --version 指路）；--version 旗标不受影响", async () => {
    const r = await exec(["--json", "help", "version"]);
    expect(r.code).toBe(2);
    const envelope = jsonOf(r) as { error: { message: string } };
    expect(envelope.error.message).toContain('未知命令 "version"');
    expect(envelope.error.message).toContain("--version");
    // help 文本不再把 version 列为动词，改为 --version 旗标说明
    const h = await exec(["help"]);
    expect(h.out).not.toContain("help [cmd] / version");
    expect(h.out).toContain("--version");
    // 旗标路径不受影响
    const v = await exec(["--version"]);
    expect(v.code).toBe(0);
    expect(v.out).toContain("toporealm");
  });

  it("graphs 列表带 current 标记", async () => {
    const r = jsonOf(await exec(["--json", "graphs"])) as {
      data: { graphs: { id: string; current: boolean }[] };
    };
    expect(r.data.graphs.map((g) => g.id)).toContain("flow");
    expect(r.data.graphs.find((g) => g.id === "flow")?.current).toBe(true);
  });
});

// ---------- M2 CLI：cmds / 模块命令顶层路由 / help 目录聚合（golden 信封，MemoryClient 后端） ----------

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

describe("M2 CLI：模块命令面", () => {
  it(
    "cmds [--module ns] / <ns.name> [target] [--input json] / help 动态聚合 / did-you-mean 来自目录",
    async () => {
      // 绑定 fixture 模块到既有工作区（graph "flow"，.toporealm 已由 new 建立）
      await fsp.writeFile(
        path.join(root, ".toporealm", "modules.yaml"),
        bindingYaml({
          example: path.join(fixturesDir, "example"),
          "workflow-mini": path.join(fixturesDir, "workflow-mini"),
        }),
        "utf8",
      );
      await DaemonCore.createGraph(root, "modflow");
      await exec(["--json", "use", "modflow"]);

      // cmds：目录自省（modules/kinds/commands）
      const cmds = jsonOf(await exec(["--json", "cmds"]));
      expect(cmds).toMatchObject({ ok: true });
      const cat = cmds as unknown as {
        data: {
          modules: { id: string }[];
          commands: { id: string }[];
          kinds: { kind: string; owner?: string }[];
        };
      };
      expect(cat.data.modules.map((m) => m.id)).toEqual(["example", "workflow-mini"]);
      expect(cat.data.commands.map((c) => c.id)).toContain("wf.start");
      expect(cat.data.kinds.find((k) => k.kind === "wf.task")?.owner).toBe("wf");

      // cmds --module ns：按 namespace 收窄
      const byNs = jsonOf(await exec(["--json", "cmds", "--module", "wf"])) as unknown as {
        data: { modules: { id: string }[]; commands: { id: string }[] };
      };
      expect(byNs.data.modules.map((m) => m.id)).toEqual(["workflow-mini"]);
      expect(byNs.data.commands.map((c) => c.id)).toEqual(["wf.start", "wf.pass", "wf.next"]);

      // <ns.name> [target]：target 命令全链路（提交 + created 回显 + revision 信封）
      await exec([
        "--json", "add", "wf.task", "--id", "cli-t",
        "--payload", JSON.stringify({ title: "CLI", status: "pending" }),
      ]);
      const start = jsonOf(await exec(["--json", "wf.start", "cli-t"]));
      expect(start).toMatchObject({ ok: true });
      const startData = (start as { data: { message: string; commits: { revision: number }[] }, revision: number }).data;
      expect(startData.message).toBe("started cli-t");
      expect(startData.commits).toHaveLength(1);
      const rd = jsonOf(await exec(["--json", "read", "cli-t"])) as {
        data: { entity: { payload: { status: string } } };
      };
      expect(rd.data.entity.payload.status).toBe("running");

      // did-you-mean 来自目录（领域错误 1，不是用法错误 2）
      const typo = await exec(["--json", "wf.strt"]);
      expect(typo.code).toBe(1);
      const typoEnv = jsonOf(typo) as { error: { code: string; details?: { suggestions?: string[] } } };
      expect(typoEnv.error.code).toBe("UNKNOWN_COMMAND");
      expect(typoEnv.error.details?.suggestions).toContain("wf.start");

      // appliesTo 兑现：缺 target → INVALID_INPUT（exit 1）
      const noTarget = await exec(["--json", "wf.start"]);
      expect(noTarget.code).toBe(1);
      expect(jsonOf(noTarget)).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT", details: { appliesTo: "wf.task" } },
      });

      // --input JSON：全局命令（无 target）+ schema 只是说明书
      const card = jsonOf(
        await exec(["--json", "example.create-card", "--input", JSON.stringify({ title: "Cli Card" })]),
      ) as { data: { message: string; commits: unknown[] } };
      expect(card.data.message).toContain("created");
      expect(card.data.commits).toHaveLength(1);

      // help = core 静态表 + 目录动态聚合
      const help = await exec(["help"]);
      expect(help.out).toContain("cmds [--module ns]");
      expect(help.out).toContain("模块命令");
      expect(help.out).toContain("example.create-card");
      // help <ns.name>：单条命令文档
      const helpCmd = await exec(["help", "wf.start"]);
      expect(helpCmd.out).toContain("appliesTo: wf.task");
      expect(helpCmd.out).toContain("--input '<json>'");
    },
    60_000,
  );
});

// ---------- F1：Argv.positionals 过滤未消费的 flag token（语义收紧） ----------

describe("Argv 位置参数（F1）", () => {
  it("positionals 不再包含 -- 开头的未消费 token；已消费 flag 的常规流程不回归", () => {
    // 未知/漏吃的 flag 不再误当位置参数
    expect(new Argv(["--unknown", "t1"]).positionals()).toEqual(["t1"]);
    // module add --global 风格：flag 先吃、位置参数后取
    const g = new Argv(["--global", "some-pkg"]);
    expect(g.flag("--global")).toBe(true);
    expect(g.positionals()).toEqual(["some-pkg"]);
    // flag 在后的写法也不回归（以现有用例场景为准）
    const g2 = new Argv(["some-pkg", "--global"]);
    expect(g2.flag("--global")).toBe(true);
    expect(g2.positionals()).toEqual(["some-pkg"]);
    // find：k=v 位置参数 + --kind 值段，互不干扰
    const f = new Argv(["status=done", "--kind", "wf.task"]);
    expect(f.values("--kind")).toEqual(["wf.task"]);
    expect(f.positionals()).toEqual(["status=done"]);
    // 非 flag 的 - 开头短值不受影响（如 undo -n 场景的 "-1" 类 token 不误删）
    expect(new Argv(["-1"]).positionals()).toEqual(["-1"]);
  });
});
