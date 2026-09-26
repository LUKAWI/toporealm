import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatSkillIndex, skillsIndex } from "../src/skills.js";

// ---------- 技能索引（1.1.0 D28/Y4）：池扫描 + 容错 + 并列消歧 ----------

function makeModule(
  dir: string,
  id: string,
  skills: { name: string; description: string }[],
  broken = false,
): Promise<void> {
  return (async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, "module.yaml"),
      `format: toporealm.module/v2\nid: ${id}\nnamespace: ${id}\nversion: "1.0.0"\nentry: ./index.js\n`,
      "utf8",
    );
    for (const s of skills) {
      const skillDir = path.join(dir, "skills", s.name);
      await fsp.mkdir(skillDir, { recursive: true });
      await fsp.writeFile(
        path.join(skillDir, "SKILL.md"),
        s.broken !== undefined
          ? "no frontmatter here"
          : `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n# ${s.name}\n`,
        "utf8",
      );
    }
  })();
}

async function makeWorld(): Promise<{ root: string; globalRoot: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-si-"));
  const globalRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-sig-"));
  return { root, globalRoot };
}

describe("skillsIndex", () => {
  it("扫全局池 + 项目池；frontmatter 解析；路径绝对（D28）", async () => {
    const { root, globalRoot } = await makeWorld();
    await makeModule(path.join(globalRoot, "modules", "workflow"), "workflow", [
      { name: "workflow-design", description: "设计 workflow 拓扑与阶段" },
    ]);
    await makeModule(path.join(root, ".toporealm", "modules", "cards"), "cards", [
      { name: "card-sort", description: "卡片排序技巧" },
    ]);
    const entries = await skillsIndex({ root, globalRoot });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      name: "workflow-design",
      module: "workflow",
      pool: "global",
    });
    expect(path.isAbsolute(entries[0].path)).toBe(true);
    expect(entries[0].path).toContain("SKILL.md");
    expect(entries[1]).toMatchObject({ name: "card-sort", module: "cards", pool: "project" });
  });

  it("重名技能跨模块并列输出（不静默去重，Y4③）", async () => {
    const { root, globalRoot } = await makeWorld();
    await makeModule(path.join(globalRoot, "modules", "a"), "a", [
      { name: "shared-skill", description: "A 版" },
    ]);
    await makeModule(path.join(root, ".toporealm", "modules", "b"), "b", [
      { name: "shared-skill", description: "B 版" },
    ]);
    const entries = await skillsIndex({ root, globalRoot });
    const shared = entries.filter((e) => e.name === "shared-skill");
    expect(shared).toHaveLength(2);
    expect(shared.map((e) => e.module).sort()).toEqual(["a", "b"]);
  });

  it("坏 frontmatter / 无 SKILL.md / 隐藏目录 → 跳过（Y4①）", async () => {
    const { root, globalRoot } = await makeWorld();
    const mod = path.join(globalRoot, "modules", "wf");
    await fsp.mkdir(mod, { recursive: true });
    await fsp.writeFile(path.join(mod, "module.yaml"), "format: toporealm.module/v2\nid: wf\n", "utf8");
    const skills = path.join(mod, "skills");
    await fsp.mkdir(path.join(skills, "bad-fm"), { recursive: true });
    await fsp.writeFile(path.join(skills, "bad-fm", "SKILL.md"), "没有 frontmatter", "utf8");
    await fsp.mkdir(path.join(skills, "empty-dir"), { recursive: true });
    await fsp.mkdir(path.join(skills, ".hidden"), { recursive: true });
    await fsp.writeFile(path.join(skills, ".hidden", "SKILL.md"), "---\nname: x\ndescription: y\n---\n", "utf8");
    const entries = await skillsIndex({ root, globalRoot });
    expect(entries).toEqual([]);
  });

  it("无工作区（root 缺省）仅列全局池；空池 = 空索引（Y4②）", async () => {
    const { globalRoot } = await makeWorld();
    expect(await skillsIndex({ globalRoot })).toEqual([]);
    await makeModule(path.join(globalRoot, "modules", "solo"), "solo", [
      { name: "only-one", description: "唯一技能" },
    ]);
    const entries = await skillsIndex({ globalRoot });
    expect(entries).toHaveLength(1);
    expect(formatSkillIndex(entries)).toContain("only-one");
    expect(formatSkillIndex(entries)).toContain("SKILL.md");
  });
});
