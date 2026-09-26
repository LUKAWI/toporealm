import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { TopoError } from "@lukawi/toporealm-protocol";
import { workspacePaths } from "@lukawi/toporealm-daemon-core";
import { parse } from "yaml";

// ---------- modules.yaml 绑定（blueprint §3）：{ [id]: { source, path? } } ----------
// M2 支持本地来源：path（任意目录）与 workspace（.toporealm/modules/<id>/，M4 安装器
// 落位）；global 来源延后（D23①），装载时跳过并记 warning。

export interface ModuleBinding {
  source: "workspace" | "global" | "path";
  /** source=path 时的模块目录（相对工作区根或绝对路径） */
  path?: string;
}

export type ModulesBindings = Record<string, ModuleBinding>;

export function modulesFile(root: string): string {
  return path.join(workspacePaths(root).topoDir, "modules.yaml");
}

/** 读绑定文件。文件不存在 = 空绑定（不报错）；存在但非法 = 启动大声失败。 */
export async function readModuleBindings(root: string): Promise<{
  bindings: ModulesBindings;
  /** 原文（未绑定过 = null）；摘要计算用 */
  raw: string | null;
}> {
  let raw: string | null;
  try {
    raw = await fsp.readFile(modulesFile(root), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { bindings: {}, raw: null };
    }
    throw err;
  }
  const doc = parse(raw) as unknown;
  if (doc === undefined || doc === null) return { bindings: {}, raw };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: "modules.yaml 必须是「模块 id → 绑定」的映射",
      hint: "形如：example: { source: path, path: ../modules/example }",
    });
  }
  const bindings: ModulesBindings = {};
  for (const [id, value] of Object.entries(doc as Record<string, unknown>)) {
    if (!id || /\s/.test(id)) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `modules.yaml 绑定键非法："${id}"`,
      });
    }
    if (value === null || typeof value !== "object") {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `模块 "${id}" 的绑定必须是映射（{ source, path? }）`,
      });
    }
    const b = value as Record<string, unknown>;
    if (b.source !== "workspace" && b.source !== "global" && b.source !== "path") {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `模块 "${id}" 的 source 非法："${String(b.source)}"（合法：workspace | global | path）`,
      });
    }
    bindings[id] = {
      source: b.source,
      ...(b.path !== undefined ? { path: String(b.path) } : {}),
    };
  }
  return { bindings, raw };
}

