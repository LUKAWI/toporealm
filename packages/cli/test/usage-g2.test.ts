import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { MemoryClient } from "@lukawi/toporealm-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Argv, CORE_VERBS, perVerbHelp } from "../src/usage.js";
import { isolateGlobalHome } from "../../../tests/test-env.js";
import { execGolden, jsonOf } from "./golden.js";

// ---------- G2 批次 CLI 侧：解析陷阱与可观测性（usage/read/find/undo/--version/help） ----------

let root: string;
let restoreHome: (() => void) | undefined;

beforeAll(async () => {
  restoreHome = (await isolateGlobalHome()).restore;
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-g2-cli-"));
});

afterAll(() => {
  restoreHome?.();
});

async function exec(args: string[], cwd = root) {
  return execGolden(args, cwd, () => new MemoryClient());
}

describe("G2-2 Argv 可重复单值 flag（--kind 不再吞位置参数）", () => {
  it("Argv 单元：--kind 每次出现取一个值；k=v / id 落回 positionals", () => {
    // 修复前：find --kind X k=v → k=v 被吞进 kind
    const f = new Argv(["--kind", "wf.task", "status=done"]);
    expect(f.values("--kind")).toEqual(["wf.task"]);
    expect(f.positionals()).toEqual(["status=done"]);
    // 修复前：read --kind X <id> → id 被吞当 kind，静默返回整类
    const r = new Argv(["--kind", "wf.task", "t1"]);
    expect(r.values("--kind")).toEqual(["wf.task"]);
    expect(r.positionals()).toEqual(["t1"]);
    // 重复 flag 语义不变
    const two = new Argv(["--kind", "a", "--kind", "b", "k=v"]);
    expect(two.values("--kind")).toEqual(["a", "b"]);
    expect(two.positionals()).toEqual(["k=v"]);
    // 值缺失/下一个是 flag：不吞 flag
    const guard = new Argv(["--kind", "--fields", "id"]);
    expect(guard.values("--kind")).toEqual([]);
    expect(guard.values("--fields")).toEqual(["id"]);
  });

  it("find --kind X k=v（flag 在前的文档写法）正常执行", async () => {
    await exec(["--json", "creategraph", "g2a"]);
    await exec([
      "--json", "add", "wf.task", "--id", "t1",
      "--payload", JSON.stringify({ title: "A", status: "todo" }),
    ]);
    const r = jsonOf(
      await exec(["--json", "find", "--kind", "wf.task", "status=todo"]),
    ) as { data: { entities: { id: string }[] } };
    expect(r.data.entities.map((e) => e.id)).toContain("t1");
  });

  it("read --kind X <id> → 显式用法错误 exit 2（不再静默返回整类数据）", async () => {
    const r = await exec(["--json", "read", "--kind", "wf.task", "t1"]);
    expect(r.code).toBe(2);
    const env = jsonOf(r) as { error: { code: string; message: string } };
    expect(env.error.code).toBe("INVALID_INPUT");
    expect(env.error.message).toContain("互斥");
  });

  it("三态不回归：read <id> 单点邻域 / read --kind X 全类过滤 / read --kind X --kind Y 过滤", async () => {
    // 单点邻域（无旗标）
    const single = jsonOf(await exec(["--json", "read", "t1"])) as {
      data: { entity: { id: string }; relations: unknown[] };
    };
    expect(single.data.entity.id).toBe("t1");
    expect(Array.isArray(single.data.relations)).toBe(true);
    // 全类过滤（无 id）
    const byKind = jsonOf(await exec(["--json", "read", "--kind", "wf.task"])) as {
      data: { entities: { id: string }[] };
    };
    expect(byKind.data.entities.map((e) => e.id)).toEqual(["t1"]);
    // 多 kind 过滤：不存在的 kind 与存在的取不到交集之外的东西——只验证不再吞 token
    await exec(["--json", "add", "wf.note", "--id", "n1", "--payload", JSON.stringify({ title: "N" })]);
    const twoKinds = jsonOf(
      await exec(["--json", "find", "--kind", "wf.task", "--kind", "wf.note", "title=N"]),
    ) as { data: { entities: { id: string }[] } };
    expect(twoKinds.data.entities.map((e) => e.id)).toEqual(["n1"]);
  });
});

describe("G2-3 undo/redo 谎报步数", () => {
  it("undo 99（仅 1 步可撤）→ 打印/信封实际步数 1；正常步数不回归", async () => {
    await exec(["--json", "creategraph", "g2b"]);
    await exec(["--json", "add", "wf.task", "--id", "u1"]);
    // 仅 1 步可撤，请求 99 → 钳位并如实报告（人类模式）
    const overHuman = await exec(["undo", "99"]);
    expect(overHuman.code).toBe(0);
    expect(overHuman.out).toContain("undid 1 step(s)");
    expect(overHuman.out).toContain("钳位");
    // 游标已在起点：再 undo 99 → 领域错误（core 拒绝），与钳位不同态
    expect((await exec(["--json", "undo", "99"])).code).toBe(1);
    // redo 同理（人类模式钳位提示）
    const overRedo = await exec(["redo", "99"]);
    expect(overRedo.code).toBe(0);
    expect(overRedo.out).toContain("redid 1 step(s)");
    expect(overRedo.out).toContain("钳位");
    // 信封模式：data.steps = 实际步数（先 undo 制造可重做段，redo 99 被钳到 1）
    await exec(["--json", "add", "wf.task", "--id", "u2"]);
    await exec(["--json", "undo"]);
    const redoEnv = jsonOf(await exec(["--json", "redo", "99"])) as { data: { steps: number } };
    expect(redoEnv.data.steps).toBe(1);
    // 缺省 1 步：steps 1 且信封 revision 自洽
    await exec(["--json", "add", "wf.task", "--id", "u3"]);
    const exact = await exec(["--json", "undo"]);
    expect(exact.code).toBe(0);
    const env = jsonOf(exact) as { data: { steps: number; revision: number }; revision: number };
    expect(env.data.steps).toBe(1);
    expect(env.revision).toBe(env.data.revision);
  });
});

describe("G2-10 杂项", () => {
  beforeAll(async () => {
    await exec(["--json", "creategraph", "g2c"]);
  });

  it("① 含 - 的错拼动词也走 did-you-mean（死分支已删）", async () => {
    const r = await exec(["--json", "create-graph", "x"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("creategraph");
  });

  it("② --version 单独使用生效；动词后出现 → 用法错误 exit 2", async () => {
    const v = await exec(["--version"]);
    expect(v.code).toBe(0);
    expect(v.out).toContain("toporealm");
    const vJson = await exec(["--json", "--version"]);
    expect(vJson.code).toBe(0);
    const abuse = await exec(["--json", "status", "--version"]);
    expect(abuse.code).toBe(2);
    const env = jsonOf(abuse) as { error: { message: string } };
    expect(env.error.message).toContain("--version");
    expect(env.error.message).toContain("D29");
  });

  it("⑤ help <核心动词> 打印该动词用法行；help <模块命令> 行为不变", async () => {
    const h = await exec(["help", "read"]);
    expect(h.code).toBe(0);
    expect(h.out).toContain("toporealm read");
    expect(h.out).toContain("--kind");
    expect(h.out).not.toContain("module add"); // 不再甩整篇
    const hu = await exec(["help", "undo"]);
    expect(hu.out).toContain("undo [N] / redo [N]");
    expect(hu.out).toContain("实际步数");
    // 单元：redo 也命中 undo/redo 共行
    expect(perVerbHelp("redo")).toContain("undo");
    // 未知词与模块命令路径不回归
    const unknown = await exec(["--json", "help", "readx"]);
    expect(unknown.code).toBe(2);
    const helpText = await exec(["help"]);
    expect(helpText.out).toContain("模块命令");
  });

  it("⑥ discover：CORE_VERBS 收录 + 帮助段与 per-verb help 提取（D45）", async () => {
    expect(CORE_VERBS).toContain("discover");
    // help 全文图事实面段收录 discover
    const full = await exec(["help"]);
    expect(full.out).toContain("discover");
    // help discover：单动词用法行（静态帮助单一真相提取，含续行说明）
    const hv = await exec(["help", "discover"]);
    expect(hv.code).toBe(0);
    expect(hv.out).toContain("用法：toporealm discover");
    expect(hv.out).toContain("status + 命令目录 + 技能索引");
    expect(hv.out).toContain("{status, commands, skills, warnings}");
  });
});
