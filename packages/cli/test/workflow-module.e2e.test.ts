import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// ---------- M5 集成验收（blueprint §9）：真实 workflow 模块经本地 path 安装 →
// daemon 装载 → cmds 可见 wf.* 目录 → run 一条 wf.* 命令端到端走通 ----------
//
// 模块来源 = 同级 toporealm-workflow 仓库（TOPOREALM_WORKFLOW_REPO 可覆盖）；
// dist 缺失时先就地构建；同级仓库缺失则显式跳过（发布门在 workflow 仓库独立成立）。

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function workflowRepo(): string {
  return process.env["TOPOREALM_WORKFLOW_REPO"] ?? path.resolve(repoRoot, "..", "toporealm-workflow");
}

interface CliResult {
  code: number;
  out: string;
  err: string;
}

function runCli(bin: string, args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const c = spawnSync(process.execPath, [bin, ...args], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      env: process.env,
    });
    if (c.error) reject(c.error);
    else resolve({ code: c.status ?? -1, out: c.stdout ?? "", err: c.stderr ?? "" });
  });
}

it(
  "workflow 模块本地 path 安装 → daemon 装载 → cmds 可见 → wf.* 命令端到端",
  async () => {
    const repo = workflowRepo();
    if (!fsSync.existsSync(path.join(repo, "module.yaml"))) {
      console.warn(`[skip] workflow 模块仓库不存在：${repo}（设 TOPOREALM_WORKFLOW_REPO 指向它）`);
      return;
    }
    // dist 缺失 → 就地构建（模块仓库 pretest/test 也会构建；此处自愈）
    if (!fsSync.existsSync(path.join(repo, "dist", "index.js"))) {
      const build = spawnSync("npm", ["run", "build"], { cwd: repo, encoding: "utf8", shell: process.platform === "win32" });
      expect(build.status).toBe(0);
    }

    // 本地 path 安装 = 复制模块发布面（module.yaml + dist + skills + package.json），
    // 不复制 src/test/node_modules（installFromDir 全量复制源目录，先staging）
    const staged = await fsp.mkdtemp(path.join(os.tmpdir(), "wf-stage-"));
    for (const entry of ["module.yaml", "dist", "skills", "package.json", "README.md", "CHANGELOG.md"]) {
      const src = path.join(repo, entry);
      if (!fsSync.existsSync(src)) continue;
      await fsp.cp(src, path.join(staged, entry), { recursive: true });
    }

    const ws = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-wfe2e-"));
    const bin = fileURLToPath(new URL("../bin/toporealm.mjs", import.meta.url));
    const cli = (args: string[]) => runCli(bin, args, ws);
    const jsonOf = (r: CliResult): unknown => JSON.parse(r.code === 0 ? r.out : r.err);

    // ① 新图 + 本地 path 安装（installer 自动判定：现存目录 = path 来源）
    expect((await cli(["--json", "new", "delivery"])).code).toBe(0);
    const add = await cli(["--json", "module", "add", staged]);
    expect(add.code).toBe(0);
    expect(jsonOf(add)).toMatchObject({ ok: true, data: { id: "workflow", namespace: "wf", origin: { type: "path" } } });

    // ② daemon 装载（首条 daemon 缝命令自动拉起）：cmds 可见 wf.* 目录
    const cmds = await cli(["--json", "cmds"]);
    expect(cmds.code).toBe(0);
    const cat = jsonOf(cmds) as { data: { modules: { id: string; namespace: string }[]; commands: { id: string }[] } };
    expect(cat.data.modules).toEqual([{ id: "workflow", version: "1.0.0", namespace: "wf" }]);
    const cmdIds = cat.data.commands.map((c) => c.id);
    expect(cmdIds).toContain("wf.create-task");
    expect(cmdIds).toContain("wf.next-actions");
    expect(cmdIds.filter((id) => id.startsWith("wf."))).toHaveLength(12);

    // ③ run 端到端：create → transition ready → claim → next-actions（调度前沿可见）
    const create = await cli(["--json", "wf.create-task", "--input", JSON.stringify({ id: "t1", label: "写作" })]);
    expect(create.code).toBe(0);
    expect(jsonOf(create)).toMatchObject({ ok: true, data: { message: "workflow: create task t1" } });
    expect(
      (await cli(["--json", "wf.transition-task", "t1", "--input", JSON.stringify({ status: "ready" })])).code,
    ).toBe(0);
    expect(
      (await cli(["--json", "wf.claim-task", "t1", "--input", JSON.stringify({ claimBy: "agent-a" })])).code,
    ).toBe(0);
    const next = await cli(["--json", "wf.next-actions"]);
    expect(next.code).toBe(0);
    const model = (jsonOf(next) as { data: { data: { running: { id: string; assignedTo?: string }[] } } }).data.data;
    expect(model.running.map((t) => t.id)).toEqual(["t1"]);
    expect(model.running[0]?.assignedTo).toBe("agent-a");

    // ④ 领域门禁在真 daemon 上生效：running → passed 无证据被钩子 VETOED（退出码 1）
    const bad = await cli(["--json", "wf.transition-task", "t1", "--input", JSON.stringify({ status: "passed" })]);
    expect(bad.code).toBe(1);
    expect(jsonOf(bad)).toMatchObject({ ok: false, error: { code: "VETOED" } });
    expect((jsonOf(bad) as { error: { message: string } }).error.message).toContain("TASK_NOT_COMPLETE");

    // ⑤ 图事实与 undo（用户的手）可回退认领；read <id> 信封 data = { entity, relations }
    const read = await cli(["--json", "read", "t1"]);
    expect(jsonOf(read)).toMatchObject({ ok: true, data: { entity: { id: "t1", payload: { status: "running" } } } });
    expect((await cli(["--json", "undo"])).code).toBe(0);
    const after = jsonOf(await cli(["--json", "read", "t1"])) as {
      data: { entity: { payload: { status: string; assignedTo?: string } } };
    };
    expect(after.data.entity.payload.status).toBe("ready");
    expect(after.data.entity.payload.assignedTo).toBeUndefined();
  },
  120_000,
);
