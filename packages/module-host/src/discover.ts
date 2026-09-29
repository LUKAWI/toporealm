import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { TopoError } from "@lukawi/toporealm-protocol";
import { globalPoolDirAt, projectPoolDir } from "@lukawi/toporealm-daemon-core";
import { parse } from "yaml";
import { readModuleBindings } from "./bindings.js";
import type { ModuleManifestV2 } from "@lukawi/toporealm-protocol";

// ---------- 双池发现（1.1.0 D27）：安装位置即作用域，装了就生效 ----------
//
// 有效模块集 = 项目池 ∪ 全局池 ∪ path 绑定，遮蔽规则：path（显式声明）> project > global。
// 项目池坏模块大声失败；全局池坏模块跳过 + warning（不毒死所有工作区，评审 Y1）。
// digest = sha256(排序的 `pool:id@version`)——哈希遮蔽解析后的有效集，id 并集与文件原文
// 都不合规（评审 Y1：遮蔽换血必须触发模块集过期）。

export type ModulePool = "global" | "project" | "path";

export interface PoolEntry {
  id: string;
  dir: string;
  pool: ModulePool;
  manifest: ModuleManifestV2;
}

export interface DiscoveryResult {
  /** 遮蔽解析后的有效集（不含被遮蔽副本） */
  effective: PoolEntry[];
  warnings: string[];
}

/** parseModuleManifest 选项（1.2.0 C3 清单解析归一）。 */
export interface ParseModuleManifestOptions {
  /**
   * 严格度开关，缺省 true（装载期语义）。false 仅豁免「绑定键一致」类检查
   * （boundId 与清单 id 的比对）——安装期 id 来自清单本身，尚无绑定键可比。
   * format / 必填字段（含 entry）与 requires/kinds 形状校验、规范化不受影响：
   * 两场景同规，装不进 daemon 的清单在安装期即报，错误不再后移一个 seam。
   */
  strict?: boolean;
  /**
   * 清单文件名（相对 dir），缺省 module.yaml。npm 包形态由 package.json 的
   * "toporealm" 字段指位，安装器传入实际相对路径。
   */
  manifestFile?: string;
}

/**
 * 解析 module.yaml（v2 声明）；strict（缺省）时 id 必须与目录名/绑定键一致。
 * host 与双池发现共用；安装器/列表以 strict:false 借用同一实现（C3，取代
 * distribution 的私有宽松 probe）。
 */
export async function parseModuleManifest(
  dir: string,
  boundId: string,
  opts?: ParseModuleManifestOptions,
): Promise<ModuleManifestV2> {
  const manifestName = opts?.manifestFile ?? "module.yaml";
  const file = path.join(dir, manifestName);
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `模块 "${boundId}" 缺少 ${manifestName}（${dir}）`,
        details: { module: boundId, dir },
      });
    }
    throw err;
  }
  const raw = parse(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `模块 "${boundId}" 的 ${manifestName} 不是映射（${file}）`,
    });
  }
  if (raw.format !== "toporealm.module/v2") {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `模块 "${boundId}" 的 ${manifestName} 不是 toporealm.module/v2 格式（${file}）`,
      details: { module: boundId, format: String(raw.format) },
    });
  }
  for (const key of ["id", "namespace", "version", "entry"] as const) {
    if (typeof raw[key] !== "string" || (raw[key] as string).length === 0) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `模块 "${boundId}" 的 ${manifestName} 缺少必填字段 "${key}"`,
        details: { module: boundId, field: key },
      });
    }
  }
  const id = raw.id as string;
  if (opts?.strict !== false && id !== boundId) {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `绑定键 "${boundId}" 与 module.yaml id "${id}" 不一致`,
      details: { boundId, manifestId: id },
    });
  }
  return {
    format: "toporealm.module/v2",
    id,
    namespace: raw.namespace as string,
    version: raw.version as string,
    entry: raw.entry as string,
    ...(raw.requires !== undefined ? { requires: normRequires(raw.requires, boundId) } : {}),
    ...(raw.kinds !== undefined ? { kinds: normKinds(raw.kinds, boundId) } : {}),
    ...(raw.ui !== undefined && typeof raw.ui === "object" && raw.ui !== null
      ? { ui: normUi(raw.ui) }
      : {}),
  };
}

function normRequires(
  raw: unknown,
  moduleId: string,
): { modules: readonly string[] } {
  const r = raw as { modules?: unknown };
  if (r.modules !== undefined && !Array.isArray(r.modules)) {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `模块 "${moduleId}" 的 requires.modules 必须是字符串数组`,
    });
  }
  return {
    modules: (r.modules ?? []).map(String),
  };
}

function normKinds(
  raw: unknown,
  moduleId: string,
): { objects?: readonly string[]; relations?: readonly string[] } {
  const k = raw as { objects?: unknown; relations?: unknown };
  const norm = (v: unknown, field: string): readonly string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `模块 "${moduleId}" 的 kinds.${field} 必须是字符串数组`,
      });
    }
    return v.map(String);
  };
  return { objects: norm(k.objects, "objects"), relations: norm(k.relations, "relations") };
}

/**
 * ui.kinds per-kind 呈现声明规范化（D46）：只认 represent ∈ {"container","annotation"}
 * 两个字符串值，其余值/异形条目（非映射、标量、非对象 ui.kinds 本体）静默忽略——
 * 声明层只协调不执法（D8），不做执法报错。返回 undefined = 无任何有效声明。
 */
function normUiKinds(
  raw: unknown,
): Record<string, { represent: "container" | "annotation" }> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, { represent: "container" | "annotation" }> = {};
  for (const [kind, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const represent = (entry as { represent?: unknown }).represent;
    if (represent !== "container" && represent !== "annotation") continue;
    out[kind] = { represent };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** ui 段：color/icon/titleKey 等保持宽松透传，kinds 子映射走规范化（剥原键防未校验值漏入）。 */
function normUi(raw: object): ModuleManifestV2["ui"] {
  const { kinds: rawKinds, ...rest } = raw as Record<string, unknown>;
  const kinds = normUiKinds(rawKinds);
  return {
    ...(rest as ModuleManifestV2["ui"]),
    ...(kinds !== undefined ? { kinds } : {}),
  };
}

function isModuleDirName(name: string): boolean {
  // 隐藏/暂存目录不参与发现（安装器暂存 .staging-*）
  return !name.startsWith(".");
}

async function listPoolDirs(poolDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(poolDir);
  } catch {
    return []; // 池位不存在 = 空池
  }
  return entries.filter(isModuleDirName).map((n) => path.join(poolDir, n));
}

/**
 * 双池发现：返回遮蔽解析后的有效集。
 *
 * @param root        项目工作区根
 * @param globalRoot  全局目录根（TOPOREALM_HOME 解析结果）
 * @param pathBindings modules.yaml 中的 path 绑定（id → 绝对目录）
 */
export async function discoverModules(
  root: string,
  globalRoot: string,
  pathBindings: Record<string, string>,
): Promise<DiscoveryResult> {
  const warnings: string[] = [];
  const effective = new Map<string, PoolEntry>();

  // ① 全局池（先装低优先级，后写的覆盖先写的；池路径唯一出处 globalPoolDirAt，批次 D 收口）
  for (const dir of await listPoolDirs(globalPoolDirAt(globalRoot))) {
    const id = path.basename(dir);
    let manifest: ModuleManifestV2;
    try {
      manifest = await parseModuleManifest(dir, id);
    } catch (err) {
      warnings.push(
        `全局模块 "${id}" 清单损坏，跳过（${dir}）：${err instanceof TopoError ? err.message : String(err)}`,
      );
      continue;
    }
    effective.set(id, { id, dir, pool: "global", manifest });
  }

  // ② 项目池：坏模块大声失败；同 id 遮蔽全局（池路径唯一出处 projectPoolDir，C4 收口）
  for (const dir of await listPoolDirs(projectPoolDir(root))) {
    const id = path.basename(dir);
    const manifest = await parseModuleManifest(dir, id);
    if (effective.has(id)) {
      warnings.push(
        `模块 "${id}" 项目池遮蔽全局池副本（项目 ${manifest.version} 优先于全局 ${effective.get(id)!.manifest.version}）`,
      );
    }
    effective.set(id, { id, dir, pool: "project", manifest });
  }

  // ③ path 绑定：显式声明，遮蔽两池
  for (const [id, dir] of Object.entries(pathBindings)) {
    const manifest = await parseModuleManifest(dir, id);
    if (effective.has(id)) {
      warnings.push(
        `模块 "${id}" path 绑定遮蔽${effective.get(id)!.pool === "project" ? "项目池" : "全局池"}副本（${dir}）`,
      );
    }
    effective.set(id, { id, dir, pool: "path", manifest });
  }

  return { effective: [...effective.values()], warnings };
}

/** 模块集摘要：sha256(排序的 `pool:id@version`)；hello 复验基准（评审 Y1）。 */
export function moduleSetDigest(effective: readonly PoolEntry[]): string {
  const lines = effective
    .map((e) => `${e.pool}:${e.id}@${e.manifest.version}`)
    .sort();
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** hello 复验用：重算当前有效集摘要（path 绑定自行重读——复验语义即探测当前状态变化）。
 *  发现失败（如项目池被改坏）→ 返回不可匹配的哨兵值，让既有「摘要不符 → 自旋退出 →
 *  重拉装载大声失败」路径接管。 */
export async function currentModuleSetDigest(
  root: string,
  globalRoot: string,
): Promise<string> {
  try {
    const { bindings } = await readModuleBindings(root);
    const pathBindings: Record<string, string> = {};
    for (const [id, b] of Object.entries(bindings)) {
      if (b.source === "path" && b.path) {
        pathBindings[id] = path.isAbsolute(b.path) ? b.path : path.resolve(root, b.path);
      }
    }
    const { effective } = await discoverModules(root, globalRoot, pathBindings);
    return moduleSetDigest(effective);
  } catch (err) {
    return crypto
      .createHash("sha256")
      .update(`discovery-error:${err instanceof Error ? err.message : String(err)}`)
      .digest("hex");
  }
}
