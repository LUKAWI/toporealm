// TopoRealm pi 扩展（1.1.0 D28）：pi 包入口。
// ① resources_discover：把池中模块技能 + 基座 CLI 技能目录作为 skillPaths 贡献给 pi
//    （技能文件始终只存在于池中，pi 原生发现注册——零拷贝）。
// ② session_start：轻量入场摘要（toporealm status），缺席不阻塞会话。
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SKILL_DIRS_HINT = "TopoRealm 模块技能（toporealm skills index 可刷新索引）";

function globalRoot(): string {
  const override = process.env["TOPOREALM_HOME"];
  return override !== undefined && override.trim().length > 0
    ? path.resolve(override.trim())
    : path.join(os.homedir(), ".toporealm");
}

async function poolSkillDirs(poolDir: string): Promise<string[]> {
  let ids: string[] = [];
  try {
    ids = (await fsp.readdir(poolDir)).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const id of ids) {
    const dir = path.join(poolDir, id, "skills");
    try {
      const st = await fsp.stat(dir);
      if (st.isDirectory()) out.push(dir);
    } catch {
      /* 模块不带 skills：合法 */
    }
  }
  return out;
}

export default function (pi: {
  on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => void;
}) {
  pi.on("resources_discover", async (event: unknown) => {
    const cwd = (event as { cwd?: string }).cwd ?? process.cwd();
    const global = await poolSkillDirs(path.join(globalRoot(), "modules"));
    const project = await poolSkillDirs(path.join(cwd, ".toporealm", "modules"));
    const own = path.join(import.meta.dirname ?? ".", "..", "skills", "toporealm-cli");
    return { skillPaths: [...global, ...project, own] };
  });
  pi.on("session_start", async (_event: unknown, ctx: unknown) => {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      const { stdout } = await run("toporealm", ["status"], { timeout: 10_000 });
      const brief = String(stdout).trim().split("\n").slice(0, 4).join(" | ");
      if (brief && (ctx as { ui?: { notify?: (m: string, l: string) => void } })?.ui?.notify)
        (ctx as { ui: { notify: (m: string, l: string) => void } }).ui.notify("TopoRealm: " + brief, "info");
    } catch {
      /* 无工作区/无 daemon/CLI 不在 PATH：摘要缺席即可 */
    }
  });
}
