import fsp from "node:fs/promises";
import path from "node:path";
import { globalPaths, workspacePaths } from "@lukawi/toporealm-daemon-core";

// ---------- 技能索引（1.1.0 D28 / 评审 Y4）：池即唯一存储的读取面 ----------
//
// `toporealm skills index` 的实现：扫描全局池与项目池各模块的 skills/ 目录，
// 读 SKILL.md frontmatter（name + description），产出「技能名 · 模块 · 描述 · 路径」索引。
// 硬约束：纯文件层，绝不拉起 daemon；无工作区/空池 → 空索引 exit 0；
// 坏 frontmatter / 缺 SKILL.md / 超大文件 → 跳过该技能（索引不是注册面，容错优先）；
// 跨模块重名技能并列输出（靠 module 列消歧，不静默去重）。

export interface SkillIndexEntry {
  name: string;
  module: string;
  /** 模块所在池 */
  pool: "global" | "project";
  description: string;
  /** SKILL.md 绝对路径（agent 用 Read 按此加载全文） */
  path: string;
}

const MAX_SKILL_MD_BYTES = 256 * 1024;
const MAX_DESCRIPTION_CHARS = 120;

/** 解析 SKILL.md 的 YAML frontmatter（仅取 name/description；解析失败 = null → 跳过）。 */
function parseFrontmatter(
  text: string,
): { name: string; description: string } | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const block = text.slice(3, end);
  const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  const description =
    /^description:\s*(.+)$/m.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
  if (!description) return null;
  const oneLine = description.split(/\s+/).join(" ");
  return {
    name,
    description:
      oneLine.length > MAX_DESCRIPTION_CHARS
        ? oneLine.slice(0, MAX_DESCRIPTION_CHARS - 1) + "…"
        : oneLine,
  };
}

async function scanModuleSkills(
  moduleDir: string,
  moduleId: string,
  pool: "global" | "project",
): Promise<SkillIndexEntry[]> {
  const skillsDir = path.join(moduleDir, "skills");
  let names: string[];
  try {
    names = await fsp.readdir(skillsDir);
  } catch {
    return []; // 模块不带 skills：合法
  }
  const out: SkillIndexEntry[] = [];
  for (const skillDir of names.sort()) {
    if (skillDir.startsWith(".")) continue;
    const file = path.join(skillsDir, skillDir, "SKILL.md");
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      continue; // 目录无 SKILL.md：不是技能，跳过
    }
    if (stat.size > MAX_SKILL_MD_BYTES) continue;
    let text: string;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    if (fm === null) continue;
    out.push({
      name: fm.name,
      module: moduleId,
      pool,
      description: fm.description,
      path: file,
    });
  }
  return out;
}

/**
 * 技能索引：全局池 + 项目池（cwd 工作区；无工作区 = 仅全局池）。
 * 纯文件层；重名技能并列输出。永不抛出工作区类错误（读不到 = 空段）。
 */
export async function skillsIndex(opts: {
  root?: string;
  globalRoot?: string;
} = {}): Promise<SkillIndexEntry[]> {
  const out: SkillIndexEntry[] = [];
  const globalBase = opts.globalRoot ?? globalPaths().root;
  // 全局池（无目录 = 空）
  let globalIds: string[] = [];
  try {
    globalIds = (await fsp.readdir(path.join(globalBase, "modules"))).filter(
      (n) => !n.startsWith("."),
    );
  } catch {
    /* 空池 */
  }
  for (const id of globalIds.sort()) {
    out.push(
      ...(await scanModuleSkills(path.join(globalBase, "modules", id), id, "global")),
    );
  }
  // 项目池（cwd 无工作区 = 跳过）
  if (opts.root !== undefined) {
    let projectIds: string[] = [];
    try {
      projectIds = (
        await fsp.readdir(workspacePaths(opts.root).topoDir + path.sep + "modules")
      ).filter((n) => !n.startsWith("."));
    } catch {
      /* 无工作区/空池 */
    }
    for (const id of projectIds.sort()) {
      out.push(
        ...(await scanModuleSkills(
          path.join(workspacePaths(opts.root).topoDir, "modules", id),
          id,
          "project",
        )),
      );
    }
  }
  return out;
}

/** 人类可读索引（stdout 注入会话上下文的形态）；空索引 = 空串。 */
export function formatSkillIndex(entries: readonly SkillIndexEntry[]): string {
  return entries
    .map(
      (e) =>
        `- ${e.name}（模块 ${e.module}，${e.pool}）：${e.description}\n  全文：${e.path}`,
    )
    .join("\n");
}
