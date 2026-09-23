import fsp from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { workspacePaths } from "@lukawi/toporealm-daemon-core";
import { distributionVersion } from "./install.js";
import { readBindingsRaw } from "./modules-yaml.js";

// ---------- host sync（blueprint §2 distribution / §1.6 D23②） ----------
//
// 两宿主、两种打包形态、两种钩子格式，绝不混用（D15/D23②）：
//   claude-code = 自包含 plugin 目录 .toporealm/hosts/claude-code/
//     （.claude-plugin/plugin.json + skills/toporealm/SKILL.md + hooks/hooks.json，
//       钩子 = Claude Code 格式 hooks.SessionStart[].hooks[].{type:"command"}）
//   pi = 原生项目级发现位（.pi/skills/toporealm/SKILL.md + .pi/extensions/toporealm/index.js，
//       扩展 = pi 格式 export default (pi) => pi.on("session_start", …)，只读入场摘要）
// 基座 skill 正文同源（Agent Skills 标准 frontmatter），宿主差异只在包装与钩子。
// 每个受管目录写 .toporealm-sync.json 所有权标记（生成器、模块集、文件清单）；
// 重同步只替换标记清单内的文件，用户手写文件永不触碰。模块自身 skills 的投影随 M5 交付。

export const SYNC_MARKER = ".toporealm-sync.json";

export type HostId = "claude-code" | "pi";

export const ALL_HOSTS: readonly HostId[] = ["claude-code", "pi"];

export interface HostSyncOptions {
  root: string;
  /** 缺省 = 两宿主全量（CLI --host claude-code|pi|all） */
  hosts?: readonly HostId[];
}

export interface HostSyncReport {
  host: HostId;
  /** 投影根目录 */
  dir: string;
  /** 本次写入/替换的文件（相对投影根） */
  files: string[];
}

export interface HostSyncResult {
  hosts: HostSyncReport[];
  /** 参与投影的模块集（来自 modules.yaml 绑定；global 跳过） */
  modules: { id: string; version: string; namespace: string }[];
}

interface SyncMarker {
  format: "toporealm.host-sync/v1";
  host: HostId;
  generator: string;
  syncedAt: string;
  modules: { id: string; version: string }[];
  /** 标记清单：重同步只动这些文件 */
  files: string[];
}

// ---------- 基座 skill 正文（两宿主同源；Agent Skills 标准 frontmatter） ----------

function baseSkill(modules: { id: string; version: string; namespace: string }[]): string {
  const moduleLines =
    modules.length === 0
      ? "（本工作区尚未绑定模块；`toporealm module add <npm包|路径>` 安装）"
      : modules
          .map(
            (m) =>
              `- ${m.id} @ ${m.version}（namespace: ${m.namespace}，kind 前缀 \`${m.namespace}.*\`，命令即 \`toporealm ${m.namespace}.<name>\`）`,
          )
          .join("\n");
  return `---
name: toporealm
description: 使用 TopoRealm 图工作区：查状态、读写实体、建关系、撤销、发现模块命令。当任务涉及拓扑图、任务图、实体关系或本工作区的 TopoRealm 图数据时使用。
---

# TopoRealm — 图工作区 CLI

单属主 daemon 持有图；你经 \`toporealm\` CLI 读写，绝不直接改图文件。

## 主干路径

\`\`\`bash
toporealm status                 # 当前图/revision/kind 计数/undo redo 可用性
toporealm find <k=v>...          # 发现实体（如 find status=doing）
toporealm read <id>              # 单点邻域（实体 + 触达关系）
toporealm set <id> k=v           # 浅合并改载荷（k=null 删键；--replace 整体替换）
toporealm add <kind> [--id X] [--payload '<json>']   # 新建对象
toporealm link <src> <tgt> --kind ns.rel             # 建关系
toporealm rm <id>                # 删除
toporealm undo [N] / redo [N]    # 撤销/重做
toporealm log -n 5               # 提交日志
\`\`\`

任何命令加 --json 得机器信封 \`{ok, data, revision, instanceId}\`；错误带 code/hint/fix，
fix 是可直接复制的下一句命令。目录永远是真相：\`toporealm cmds\` 自省已装载模块的全部命令。

## 本工作区的模块

${moduleLines}

模块命令是顶层子命令（\`<ns.name> [target] [--input '<json>']\`）；输入 schema 用
\`toporealm help <ns.name>\` 查看。
`;
}

// ---------- claude-code：plugin 打包（Claude Code 钩子格式） ----------

function claudePluginFiles(modules: { id: string; version: string; namespace: string }[]): Record<string, string> {
  const plugin = {
    name: "toporealm",
    description:
      "TopoRealm graph workspace plugin: CLI-first access to a single-owner daemon graph, with per-module commands.",
    version: distributionVersion(),
  };
  const hooks = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [{ type: "command", command: "toporealm status" }],
        },
      ],
    },
  };
  return {
    ".claude-plugin/plugin.json": JSON.stringify(plugin, null, 2) + "\n",
    "skills/toporealm/SKILL.md": baseSkill(modules),
    "hooks/hooks.json": JSON.stringify(hooks, null, 2) + "\n",
  };
}

// ---------- pi：extension/skills 打包（pi 扩展格式；原生项目级发现位） ----------

const PI_EXTENSION_INDEX = `// TopoRealm pi 扩展（toporealm host sync 生成；重同步按 .toporealm-sync.json 清单管理）。
// 只读入场摘要：会话启动时执行 toporealm status 并提示。绝不改图、绝不注册写工具。
export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      const { stdout } = await run("toporealm", ["status"], { timeout: 10_000 });
      const brief = String(stdout).trim().split("\\n").slice(0, 4).join(" | ");
      if (brief && ctx?.ui?.notify) ctx.ui.notify("TopoRealm: " + brief, "info");
    } catch {
      // 无工作区/无 daemon/toporealm 不在 PATH：入场摘要缺席即可，不阻塞会话
    }
  });
}
`;

function piFiles(modules: { id: string; version: string; namespace: string }[]): { skillsDir: string; extDir: string; files: Record<string, string> } {
  return {
    skillsDir: path.join(".pi", "skills", "toporealm"),
    extDir: path.join(".pi", "extensions", "toporealm"),
    files: {
      "SKILL.md": baseSkill(modules),
      "index.js": PI_EXTENSION_INDEX,
    },
  };
}

// ---------- 所有权标记管理的写入 ----------

/**
 * 重同步一个受管目录：先按旧标记清单删除上次写入的文件（只删这些），再写本次文件，
 * 最后落新标记。标记不存在 = 首次同步；标记里的文件被用户改过也照替换（投影归 sync 管），
 * 清单外的用户文件永不触碰。
 */
async function syncManagedDir(
  dir: string,
  host: HostId,
  files: Record<string, string>,
  modules: { id: string; version: string }[],
): Promise<string[]> {
  const markerFile = path.join(dir, SYNC_MARKER);
  let previous: SyncMarker | undefined;
  try {
    const parsed = JSON.parse(await fsp.readFile(markerFile, "utf8")) as SyncMarker;
    if (parsed.format === "toporealm.host-sync/v1" && parsed.host === host) previous = parsed;
  } catch {
    previous = undefined;
  }
  if (previous !== undefined) {
    for (const rel of previous.files) {
      if (rel in files) continue; // 本次也要写，直接覆盖
      await fsp.rm(path.join(dir, rel), { force: true }).catch(() => {});
    }
  }
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, "utf8");
    written.push(rel);
  }
  const marker: SyncMarker = {
    format: "toporealm.host-sync/v1",
    host,
    generator: `toporealm@${distributionVersion()}`,
    syncedAt: new Date().toISOString(),
    modules,
    files: [...written, SYNC_MARKER],
  };
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(markerFile, JSON.stringify(marker, null, 2) + "\n", "utf8");
  // 清理上次有、这次没有的空目录（尽力而为）
  if (previous !== undefined) {
    for (const rel of previous.files) {
      const dir_ = path.dirname(path.join(dir, rel));
      await fsp.rmdir(dir_).catch(() => {});
      await fsp.rmdir(path.dirname(dir_)).catch(() => {});
    }
  }
  return written;
}

// ---------- 入口 ----------

export async function hostSync(opts: HostSyncOptions): Promise<HostSyncResult> {
  const hosts = opts.hosts ?? ALL_HOSTS;
  for (const h of hosts) {
    if (!ALL_HOSTS.includes(h)) {
      throw new TypeError(`未知宿主 "${h}"（合法：${ALL_HOSTS.join(" | ")}）`);
    }
  }
  const bindings = await readBindingsRaw(path.join(workspacePaths(opts.root).topoDir, "modules.yaml"));
  const modules: { id: string; version: string; namespace: string }[] = [];
  for (const [id, binding] of Object.entries(bindings)) {
    if (binding.source === "global") continue; // 与装载面同口径：global 跳过
    const dir =
      binding.source === "path" && binding.path
        ? path.resolve(opts.root, binding.path)
        : path.join(workspacePaths(opts.root).topoDir, "modules", id);
    try {
      const raw = parse(await fsp.readFile(path.join(dir, "module.yaml"), "utf8")) as Record<string, unknown>;
      if (raw && typeof raw === "object" && typeof raw["version"] === "string" && typeof raw["namespace"] === "string") {
        modules.push({ id, version: raw["version"], namespace: raw["namespace"] });
      }
    } catch {
      // 绑定在、清单读不到：不进投影（安装器/装载面会另行点名）
    }
  }

  const out: HostSyncReport[] = [];
  for (const host of hosts) {
    if (host === "claude-code") {
      const dir = path.join(workspacePaths(opts.root).topoDir, "hosts", "claude-code");
      const files = claudePluginFiles(modules);
      const written = await syncManagedDir(dir, host, files, modules);
      out.push({ host, dir, files: written });
    } else {
      const { skillsDir, extDir, files } = piFiles(modules);
      const ws = workspacePaths(opts.root).root;
      // pi 用原生项目级发现位：两个受管目录各带一份标记
      const skillFiles = { "SKILL.md": files["SKILL.md"] as string };
      const extFiles = { "index.js": files["index.js"] as string };
      const w1 = await syncManagedDir(path.join(ws, skillsDir), host, skillFiles, modules);
      const w2 = await syncManagedDir(path.join(ws, extDir), host, extFiles, modules);
      out.push({
        host,
        dir: path.join(ws, ".pi"),
        files: [...w1.map((f) => path.join(skillsDir, f)), ...w2.map((f) => path.join(extDir, f))],
      });
    }
  }
  return { hosts: out, modules };
}
