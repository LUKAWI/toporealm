import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/index.js";

// ---------- M4 分发动词的信封与退出码（blueprint §4 / §8：CLI golden 信封） ----------
// module/migrate/host sync 是工作区文件层冷路径（不触 daemon）；npm pack 全流程已在
// distribution 包测试覆盖（真实 npm pack --ignore-scripts），这里打 CLI 缝：信封形状、
// 退出码 0/1/2、path 来源安装、迁移报告透传、--host 过滤与非法值。

const fixtureModule = fileURLToPath(new URL("../../../tests/fixtures/modules/example", import.meta.url));
const legacyDir = fileURLToPath(new URL("../../../tests/fixtures/data/legacy-research", import.meta.url));

let root: string;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-cli-m4-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "g1");
  await fsp.writeFile(path.join(root, ".toporealm", "active"), "g1\n", "utf8");
});

async function exec(args: string[]) {
  const collected = { out: "", err: "" };
  const code = await run(args, {
    cwd: root,
    env: {},
    out: (s: string) => (collected.out += s),
    err: (s: string) => (collected.err += s),
  });
  return { code, ...collected };
}

function jsonOf(r: { code: number; out: string; err: string }): Record<string, unknown> {
  return JSON.parse(r.code === 0 ? r.out : r.err) as Record<string, unknown>;
}

describe("M4 分发动词：module / migrate / host sync", () => {
  it("module add（path 来源）→ 落位 + 绑定；list 如实回显；重复 add → 领域错误(1)", async () => {
    const r = await exec(["--json", "module", "add", fixtureModule]);
    expect(r.code).toBe(0);
    expect(jsonOf(r)).toMatchObject({ ok: true, data: { id: "example", version: "1.0.0" } });
    const installed = path.join(root, ".toporealm", "modules", "example");
    await expect(fsp.access(path.join(installed, ".toporealm-source.json"))).resolves.toBeUndefined();

    const dup = await exec(["--json", "module", "add", fixtureModule]);
    expect(dup.code).toBe(1);
    expect(jsonOf(dup)).toMatchObject({ ok: false, error: { code: "ID_EXISTS" } });

    const list = await exec(["--json", "module", "list"]);
    expect(list.code).toBe(0);
    const modules = (jsonOf(list) as { data: { modules: { id: string; source: string }[] } }).data.modules;
    expect(modules).toContainEqual(expect.objectContaining({ id: "example", source: "workspace" }));
  });

  it("module add --global → 用法错误(2)；未知子命令 → 用法错误(2)；缺参数 → 用法错误(2)", async () => {
    const g = await exec(["--json", "module", "add", "x", "--global"]);
    expect(g.code).toBe(2);
    const bad = await exec(["--json", "module", "upgrade", "x"]);
    expect(bad.code).toBe(2);
    const bare = await exec(["--json", "module", "add"]);
    expect(bare.code).toBe(2);
    const bareRm = await exec(["--json", "module", "rm"]);
    expect(bareRm.code).toBe(2);
  });

  it("module rm：删除带标记目录 + 绑定；再 rm → 领域错误(1)", async () => {
    const r = await exec(["--json", "module", "rm", "example"]);
    expect(r.code).toBe(0);
    expect(jsonOf(r)).toMatchObject({ ok: true, data: { id: "example" } });
    const again = await exec(["--json", "module", "rm", "example"]);
    expect(again.code).toBe(1);
    expect(jsonOf(again)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("migrate：报告进 --json 信封；新图落位并选中；--dry-run 标记如实", async () => {
    const r = await exec(["--json", "migrate", legacyDir]);
    expect(r.code).toBe(0);
    const report = (jsonOf(r) as { data: Record<string, unknown> }).data;
    expect(report).toMatchObject({
      dryRun: false,
      graph: { id: "legacy-research", revision: 7, undoCursor: 0 },
      objects: { migrated: 3, skipped: 0 },
    });
    expect((report["conflicts"] as unknown[]).length).toBe(3);
    expect(report["dangling"]).toEqual(["r-dangling"]);
    expect(await fsp.readFile(path.join(root, ".toporealm", "active"), "utf8")).toBe("legacy-research\n");

    // 同 id 再迁 → 领域错误(1)；缺参数 → 用法错误(2)
    const again = await exec(["--json", "migrate", legacyDir]);
    expect(again.code).toBe(1);
    expect(jsonOf(again)).toMatchObject({ ok: false, error: { code: "ID_EXISTS" } });
    const bare = await exec(["--json", "migrate"]);
    expect(bare.code).toBe(2);

    // --dry-run：ok 信封带 dryRun: true（用另一工作区避免 ID_EXISTS 干扰）
    const root2 = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-cli-m4-dry-"));
    await fsp.mkdir(path.join(root2, ".toporealm"), { recursive: true });
    await DaemonCore.createGraph(root2, "g1");
    await fsp.writeFile(path.join(root2, ".toporealm", "active"), "g1\n", "utf8");
    const collected = { out: "", err: "" };
    const code2 = await run(["--json", "migrate", legacyDir, "--dry-run"], {
      cwd: root2,
      env: {},
      out: (s: string) => (collected.out += s),
      err: (s: string) => (collected.err += s),
    });
    expect(code2).toBe(0);
    expect((JSON.parse(collected.out) as { data: { dryRun: boolean } }).data.dryRun).toBe(true);
    await fsp.rm(root2, { recursive: true, force: true }).catch(() => {});
  });

  it("host sync：默认两宿主；--host pi 过滤；非法 --host / 子命令 → 用法错误(2)", async () => {
    const r = await exec(["--json", "host", "sync"]);
    expect(r.code).toBe(0);
    const data = (jsonOf(r) as { data: { hosts: { host: string }[] } }).data;
    expect(data.hosts.map((h) => h.host).sort()).toEqual(["claude-code", "pi"]);

    const pi = await exec(["--json", "host", "sync", "--host", "pi"]);
    expect(pi.code).toBe(0);
    expect(
      (jsonOf(pi) as { data: { hosts: { host: string }[] } }).data.hosts.map((h) => h.host),
    ).toEqual(["pi"]);

    const badHost = await exec(["--json", "host", "sync", "--host", "codex"]);
    expect(badHost.code).toBe(2);
    const badSub = await exec(["--json", "host", "eject"]);
    expect(badSub.code).toBe(2);
  });

  it("help 收录分发动词；未知动词 did-you-mean 命中 migrate", async () => {
    const h = await exec(["--json", "help"]);
    expect(h.code).toBe(0);
    const verbs = (jsonOf(h) as { data: { verbs: string[] } }).data.verbs;
    for (const v of ["module", "migrate", "host"]) expect(verbs).toContain(v);
    const typo = await exec(["--json", "migrat"]);
    expect(typo.code).toBe(2);
    expect(typo.err).toContain("migrate");
  });
});
