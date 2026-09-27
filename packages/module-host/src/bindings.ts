import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { TopoError } from "@lukawi/toporealm-protocol";
import { atomicWriteFile, workspacePaths } from "@lukawi/toporealm-daemon-core";
import { parse, stringify } from "yaml";

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
  const doc = (() => {
    // G2-8：损坏的 modules.yaml 此前抛裸 YAMLParseError 绕过封闭错误码——大声失败
    // 行为不变，但码契约缺位且不带文件路径。包成 TopoError(INVALID_INPUT) + 路径。
    try {
      return parse(raw) as unknown;
    } catch (err) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `modules.yaml 无法解析（${modulesFile(root)}）：${err instanceof Error ? err.message : String(err)}`,
        hint: "形如：example: { source: path, path: ../modules/example }",
        details: { file: modulesFile(root) },
      });
    }
  })();
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

/**
 * 写入单个绑定（保留其他条目；binding 为 undefined = 删除该键）。
 * C3：写前经 readModuleBindings 全量校验读入——文件损坏时大声失败（裸解析错误
 * 已在 G2-8 包成 TopoError(INVALID_INPUT) + 路径），不再像安装器旧私有实现那样静默跳过坏条目
 * 后整体重写（那会顺手把坏条目洗掉，掩盖绑定文件已损的事实）。
 * B4：原子写（同目录 tmp + rename，EPERM/EACCES/EBUSY 短退避）——与 graph.yaml/
 * endpoint 同一机制，防 Windows 杀软/索引器瞬时锁导致绑定文件半写损坏。
 */
export async function writeModuleBinding(
  root: string,
  id: string,
  binding: ModuleBinding | undefined,
): Promise<void> {
  const { bindings } = await readModuleBindings(root);
  if (binding === undefined) delete bindings[id];
  else bindings[id] = binding;
  await atomicWriteFile(modulesFile(root), stringify(bindings, { lineWidth: 0 }));
}

