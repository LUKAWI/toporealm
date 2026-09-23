import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { hostSync, SYNC_MARKER } from "../src/hosts.js";

// ---------- M4 host sync（blueprint §2 distribution / §1.6 D23②） ----------
// claude-code = plugin 打包（Claude Code 钩子格式）；pi = extension/skills 打包（pi 扩展
// 格式）。两宿主钩子格式不得混用；所有权标记管理重同步，用户手写文件永不触碰。

const fixtures = (p: string): string =>
  fileURLToPath(new URL(`../../../tests/fixtures/${p}`, import.meta.url));

describe("host sync（claude-code plugin / pi extension+skills）", () => {
  const roots: string[] = [];

  async function makeWorkspace(withModules = true): Promise<string> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-hosts-"));
    roots.push(root);
    await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
    if (withModules) {
      // path 绑定指向 fixture v2 模块（裸目录形态，与装载面同一解析口径）
      const mod = fixtures("modules/example");
      const mod2 = fixtures("packages/cards-v2");
      await fsp.writeFile(
        path.join(root, ".toporealm", "modules.yaml"),
        `example:\n  source: path\n  path: ${JSON.stringify(mod)}\ncards:\n  source: path\n  path: ${JSON.stringify(mod2)}\n`,
        "utf8",
      );
    }
    return root;
  }

  afterAll(async () => {
    for (const r of roots) {
      await fsp.rm(r, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("claude-code：自包含 plugin 目录——plugin.json + SKILL.md + hooks.json（Claude 钩子格式）", async () => {
    const root = await makeWorkspace();
    const r = await hostSync({ root, hosts: ["claude-code"] });
    expect(r.hosts).toHaveLength(1);
    const dir = path.join(root, ".toporealm", "hosts", "claude-code");
    expect(r.hosts[0]?.dir).toBe(dir);
    expect(r.hosts[0]?.files.sort()).toEqual([
      ".claude-plugin/plugin.json",
      "hooks/hooks.json",
      "skills/toporealm/SKILL.md",
    ]);
    const plugin = JSON.parse(await fsp.readFile(path.join(dir, ".claude-plugin", "plugin.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect(plugin.name).toBe("toporealm");
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+/);
    // Claude Code 钩子格式：hooks.SessionStart[].hooks[].{type:command}
    const hooks = JSON.parse(await fsp.readFile(path.join(dir, "hooks", "hooks.json"), "utf8")) as {
      hooks: { SessionStart: { matcher: string; hooks: { type: string; command: string }[] }[] };
    };
    expect(hooks.hooks.SessionStart[0]?.matcher).toContain("startup");
    expect(hooks.hooks.SessionStart[0]?.hooks[0]).toMatchObject({ type: "command", command: "toporealm status" });
    // skill 正文带模块集
    const skill = await fsp.readFile(path.join(dir, "skills", "toporealm", "SKILL.md"), "utf8");
    expect(skill).toContain('name: toporealm');
    expect(skill).toContain("example");
    expect(skill).toContain("cards");
    // 所有权标记
    const marker = JSON.parse(await fsp.readFile(path.join(dir, SYNC_MARKER), "utf8")) as {
      format: string;
      host: string;
      files: string[];
    };
    expect(marker.format).toBe("toporealm.host-sync/v1");
    expect(marker.host).toBe("claude-code");
    expect(marker.files).toContain("skills/toporealm/SKILL.md");
  });

  it("pi：原生项目级发现位——.pi/skills/toporealm/SKILL.md + .pi/extensions/toporealm/index.js（pi 扩展格式）", async () => {
    const root = await makeWorkspace();
    const r = await hostSync({ root, hosts: ["pi"] });
    expect(r.hosts[0]?.dir).toBe(path.join(root, ".pi"));
    // skill 落原生发现位
    const skill = await fsp.readFile(path.join(root, ".pi", "skills", "toporealm", "SKILL.md"), "utf8");
    expect(skill).toContain("---\nname: toporealm");
    // 扩展 = pi 格式：export default (pi) + session_start；无 Claude 钩子格式文件
    const ext = await fsp.readFile(path.join(root, ".pi", "extensions", "toporealm", "index.js"), "utf8");
    expect(ext).toContain("export default function (pi)");
    expect(ext).toContain('pi.on("session_start"');
    await expect(fsp.access(path.join(root, ".pi", "extensions", "toporealm", "hooks.json"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("钩子格式不混用：claude 目录无 index.js，pi 树无 hooks.json/plugin.json", async () => {
    const root = await makeWorkspace();
    await hostSync({ root });
    const claudeDir = path.join(root, ".toporealm", "hosts", "claude-code");
    await expect(fsp.access(path.join(claudeDir, "index.js"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.access(path.join(root, ".pi", "hooks.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.access(path.join(root, ".pi", ".claude-plugin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("所有权标记管理：重同步替换自有文件、清单外用户文件永不触碰；失效模块从投影消失", async () => {
    const root = await makeWorkspace();
    await hostSync({ root });
    const skillPath = path.join(root, ".pi", "skills", "toporealm", "SKILL.md");
    // 用户手写文件进受管目录
    const userFile = path.join(root, ".pi", "skills", "toporealm", "my-notes.md");
    await fsp.writeFile(userFile, "mine", "utf8");
    // 用户改了自有投影（应被重同步恢复）
    await fsp.writeFile(skillPath, "vandalized", "utf8");
    // 模块集收窄：modules.yaml 只剩 example
    const mod = fixtures("modules/example");
    await fsp.writeFile(
      path.join(root, ".toporealm", "modules.yaml"),
      `example:\n  source: path\n  path: ${JSON.stringify(mod)}\n`,
      "utf8",
    );
    const r = await hostSync({ root });
    expect(r.modules.map((m) => m.id)).toEqual(["example"]);
    // 自有投影恢复 + 模块集更新
    const skill = await fsp.readFile(skillPath, "utf8");
    expect(skill).toContain("name: toporealm");
    expect(skill).not.toContain("cards @");
    // 用户文件还在
    await expect(fsp.access(userFile)).resolves.toBeUndefined();
  });

  it("空绑定工作区：投影照常生成，模块段落为引导文案", async () => {
    const root = await makeWorkspace(false);
    const r = await hostSync({ root });
    expect(r.modules).toEqual([]);
    const skill = await fsp.readFile(
      path.join(root, ".toporealm", "hosts", "claude-code", "skills", "toporealm", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("尚未绑定模块");
  });
});
