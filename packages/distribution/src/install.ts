import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { TopoError, isValidEntityId } from "@lukawi/toporealm-protocol";
import { globalPaths, workspacePaths } from "@lukawi/toporealm-daemon-core";
import { parse } from "yaml";
import { readBindingsRaw, writeBinding } from "./modules-yaml.js";

// ---------- 模块安装器（blueprint §2 distribution / §1.6 D23①） ----------
//
// npm 来源：`npm pack <spec> --ignore-scripts`（禁安装脚本 = 安装期唯一执法点）→ 解包 →
//   校验 v2 清单 → 落位 .toporealm/modules/<id>/。
// 本地路径来源：直接复制，同落位。
// 两者都写 .toporealm-source.json 所有权标记 + modules.yaml 绑定（source: workspace）；
// 卸载只删带标记的模块目录。全程文件层冷路径，不触碰运行中的 daemon——绑定文件摘要
// 变化即模块集过期（§5），daemon 由客户端下次触达自动重拉。

export const SOURCE_MARKER = ".toporealm-source.json";

export interface SourceMarker {
  format: "toporealm.module-source/v1";
  id: string;
  version: string;
  origin: { type: "npm"; spec: string } | { type: "path"; path: string };
  installedAt: string;
}

export interface InstallOptions {
  root: string;
  /** 1.1.0 D27：装进全局池（所有项目生效）；缺省 = 项目池（仅本项目） */
  global?: boolean;
  /** 测试注入：全局目录根（缺省按 TOPOREALM_HOME / ~/.toporealm 解析） */
  globalRoot?: string;
  /** npm spec（name / name@version / 本地目录）或本地目录 */
  source: string;
  /** 缺省自动判定：现存目录 = path，否则按 npm spec；测试可显式指定（npm 流程可对本地目录 pack） */
  kind?: "npm" | "path";
  /** 测试注入：npm/tar 子进程环境（win32 下默认前置 System32 到 PATH，D23④） */
  env?: NodeJS.ProcessEnv;
}

export interface InstallResult {
  id: string;
  version: string;
  namespace: string;
  dir: string;
  origin: SourceMarker["origin"];
  /** 提示语：daemon 下次触达自动装载新模块集 */
  note: string;
}

interface ManifestProbe {
  id: string;
  namespace: string;
  version: string;
  format: string;
}

// ---------- 子进程（D23④：win32 前置 System32 到 PATH，规避 Git Bash 的 GNU tar 破坏 npm pack） ----------

function childEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = { ...process.env, ...extra };
  if (process.platform === "win32") {
    const system32 = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");
    base["PATH"] = `${system32}${path.delimiter}${base["PATH"] ?? ""}`;
  }
  return base;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    c.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    c.once("error", reject);
    c.once("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** node 自带的 npm-cli.js：绕开 Windows 上 spawn .cmd 需要shell 的限制（CVE-2024-27980 后一律 EINVAL）。 */
function npmCommand(env: NodeJS.ProcessEnv): { cmd: string; args: string[] } {
  if (process.platform !== "win32") return { cmd: "npm", args: [] };
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return { cmd: process.execPath, args: [npmCli] };
}

function failNpm(step: string, spec: string, r: RunResult): never {
  throw new TopoError({
    code: "INVALID_INPUT",
    message: `npm ${step} 失败（${spec}）：${(r.stderr || r.stdout).trim().slice(0, 400)}`,
    hint: "npm 来源要求本机 npm 可用；网络/registry 问题先手动 npm pack 验证",
  });
}

/** npm pack 输出取 tarball 名：--json（多行数组，可能前置通知行）与非 json（末行文件名）两种形态都认。 */
function parsePackFilename(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  try {
    const arr = JSON.parse(trimmed.slice(trimmed.indexOf("["))) as { filename?: string }[];
    if (Array.isArray(arr)) {
      const f = arr[0]?.filename;
      if (typeof f === "string" && f.length > 0) return f;
    }
  } catch {
    /* fall through：非 json 形态 */
  }
  const lines = trimmed.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const last = lines.at(-1);
  return last !== undefined && last.endsWith(".tgz") ? last : undefined;
}

// ---------- 清单探测（npm 包与本地目录共用） ----------

async function probeManifest(dir: string): Promise<ManifestProbe> {
  let raw: Record<string, unknown> | undefined;
  // package.json "toporealm" 字段指向清单（fixture 包形态）；缺省 module.yaml 在包根
  let manifestRel = "module.yaml";
  try {
    const pkgText = await fsp.readFile(path.join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(pkgText) as Record<string, unknown>;
    if (typeof pkg["toporealm"] === "string" && pkg["toporealm"].length > 0) {
      manifestRel = pkg["toporealm"];
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `来源目录的 package.json 无法解析：${dir}`,
        details: { dir },
      });
    }
  }
  try {
    const text = await fsp.readFile(path.join(dir, manifestRel), "utf8");
    raw = parse(text) as Record<string, unknown>;
  } catch {
    raw = undefined;
  }
  if (!raw || typeof raw !== "object") {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `来源缺少模块清单（${manifestRel}）：${dir}`,
      hint: "npm 包用 package.json 的 \"toporealm\" 字段指向 module.yaml；本地目录把 module.yaml 放在根",
    });
  }
  if (raw["format"] !== "toporealm.module/v2") {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `模块清单不是 toporealm.module/v2（${String(raw["format"] ?? "缺 format")}）`,
      hint: "1.0 只安装 v2 清单；0.x 模块由各自仓库先升级（声明投影参考 toporealm migrate 报告）",
      details: { format: String(raw["format"] ?? "") },
    });
  }
  for (const key of ["id", "namespace", "version"] as const) {
    if (typeof raw[key] !== "string" || (raw[key] as string).length === 0) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `模块清单缺少必填字段 "${key}"`,
        details: { field: key },
      });
    }
  }
  const id = raw["id"] as string;
  if (!isValidEntityId(id) || /\s/.test(id)) {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `模块 id 非法："${id}"（将用作 .toporealm/modules/ 目录名）`,
    });
  }
  return {
    id,
    namespace: raw["namespace"] as string,
    version: raw["version"] as string,
    format: "toporealm.module/v2",
  };
}

// ---------- 安装 ----------

function projectModulesDir(root: string): string {
  return path.join(workspacePaths(root).topoDir, "modules");
}

function bindingsFile(root: string): string {
  return path.join(workspacePaths(root).topoDir, "modules.yaml");
}

/** 全局池位：确保目录存在（写路径惰性创建，D26）。 */
function globalModulesDir(opts: { globalRoot?: string }): string {
  const base =
    opts.globalRoot !== undefined
      ? opts.globalRoot
      : globalPaths().root;
  return path.join(base, "modules");
}

/** 安装落位：--global → 全局池（惰性确保）；否则项目池（已存在）。 */
async function placementDir(opts: { global?: boolean; globalRoot?: string; root: string }): Promise<string> {
  if (!opts.global) return projectModulesDir(opts.root);
  const dir = globalModulesDir(opts);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function markInstalled(
  dir: string,
  probe: ManifestProbe,
  origin: SourceMarker["origin"],
): Promise<void> {
  const marker: SourceMarker = {
    format: "toporealm.module-source/v1",
    id: probe.id,
    version: probe.version,
    origin,
    installedAt: new Date().toISOString(),
  };
  await fsp.writeFile(path.join(dir, SOURCE_MARKER), JSON.stringify(marker, null, 2) + "\n", "utf8");
}

async function installFromDir(
  placementDir: string,
  stagedSourceDir: string,
  origin: SourceMarker["origin"],
  opts: { writeProjectBinding: boolean; root: string },
): Promise<InstallResult> {
  const probe = await probeManifest(stagedSourceDir);
  const finalDir = path.join(placementDir, probe.id);
  let exists = false;
  try {
    await fsp.access(finalDir);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    throw new TopoError({
      code: "ID_EXISTS",
      message: `模块 "${probe.id}" 已安装（${finalDir}）`,
      hint: "更新 = 先卸载再安装（模块集启动冻结，更新后需重启 daemon）",
      fix: `toporealm module rm ${probe.id}`,
      details: { module: probe.id, dir: finalDir },
    });
  }
  // 同卷暂存 + rename：.toporealm/modules/.staging-* → <id>（跨卷复制已在 cp 完成）
  const staging = path.join(placementDir, `.staging-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.mkdir(staging, { recursive: true });
  try {
    await fsp.cp(stagedSourceDir, staging, { recursive: true });
    await markInstalled(staging, probe, origin);
    await fsp.rename(staging, finalDir);
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  // 1.1.0 D27：目录即注册——项目池不再写绑定（modules.yaml 只剩 path 职责）
  return {
    id: probe.id,
    version: probe.version,
    namespace: probe.namespace,
    dir: finalDir,
    origin,
    note: opts.writeProjectBinding
      ? "已装项目池；daemon 下次触达自动装载新模块集"
      : "已装全局池（所有项目生效）；daemon 下次触达自动装载新模块集",
  };
}

async function installFromNpm(opts: InstallOptions): Promise<InstallResult> {
  const env = childEnv(opts.env);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-pack-"));
  try {
    const npm = npmCommand(env);
    const r = await run(
      npm.cmd,
      [...npm.args, "pack", opts.source, "--ignore-scripts", "--json", "--pack-destination", tmp],
      env,
      tmp,
    );
    if (r.code !== 0) failNpm("pack", opts.source, r);
    const filename = parsePackFilename(r.stdout);
    if (!filename) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `npm pack 未返回 tarball 名（${opts.source}）`,
        details: { stdout: r.stdout.slice(0, 400) },
      });
    }
    // 解包（npm tarball 顶层有 package/ 前缀，strip 掉）
    const pkgDir = path.join(tmp, "pkg");
    await fsp.mkdir(pkgDir, { recursive: true });
    const t = await run(
      process.platform === "win32"
        ? path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
        : "tar",
      ["-xzf", path.join(tmp, filename), "-C", pkgDir, "--strip-components", "1"],
      env,
    );
    if (t.code !== 0) failNpm("tar 解包", filename, t);
    // return await：finally 的 tmp 清理必须等 installFromDir 结束——裸 return 会让
    // rm 与安装体内的 probe/cp 竞态（tmp 在脚下被删）
    const placement = await placementDir(opts);
    return await installFromDir(placement, pkgDir, { type: "npm", spec: opts.source }, {
      writeProjectBinding: !opts.global,
      root: opts.root,
    });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function installModule(opts: InstallOptions): Promise<InstallResult> {
  // 自动判定：现存目录 = path 来源；否则一律按 npm spec（npm pack 本身也接受本地目录，
  // 测试即用显式 kind: "npm" 对 fixture 目录走完整 pack 流程）
  const kind = opts.kind ?? ((await isDir(opts.source)) ? "path" : "npm");
  if (kind === "npm") return installFromNpm(opts);
  const abs = path.resolve(opts.source);
  if (!(await isDir(abs))) {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `本地模块目录不存在：${abs}`,
      details: { path: abs },
    });
  }
  const placement = await placementDir(opts);
  return installFromDir(placement, abs, { type: "path", path: abs }, {
    writeProjectBinding: !opts.global,
    root: opts.root,
  });
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// ---------- 卸载 / 列表 ----------

export interface RemoveOptions {
  root: string;
  id: string;
  /** 1.1.0 D27：从全局池卸载 */
  global?: boolean;
  /** 测试注入：全局目录根 */
  globalRoot?: string;
}

export interface RemoveResult {
  id: string;
  removedDir: string;
  note: string;
}

export async function removeModule(opts: RemoveOptions): Promise<RemoveResult> {
  const dir = opts.global
    ? path.join(globalModulesDir(opts), opts.id)
    : path.join(projectModulesDir(opts.root), opts.id);
  // 卸载只删自己带标记的目录：无标记 = 可能是用户手写/外来目录，拒绝
  let marker: SourceMarker | undefined;
  try {
    marker = JSON.parse(await fsp.readFile(path.join(dir, SOURCE_MARKER), "utf8")) as SourceMarker;
  } catch {
    marker = undefined;
  }
  if (!marker || marker.format !== "toporealm.module-source/v1" || marker.id !== opts.id) {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `模块 "${opts.id}" 没有安装器所有权标记（${SOURCE_MARKER}），拒绝删除`,
      hint: "只有 toporealm module add 安装的目录可卸载；path 绑定与外来目录手工管理",
      details: { module: opts.id, dir },
    });
  }
  // 项目池卸载顺带清 legacy 绑定（workspace 残留）；path 绑定手工管理，拒绝误删
  if (!opts.global) {
    const bindings = await readBindingsRaw(bindingsFile(opts.root));
    const binding = bindings[opts.id];
    if (binding && binding.source === "path") {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `模块 "${opts.id}" 是 path 绑定，不由安装器卸载`,
        hint: "先手工删除 modules.yaml 中的绑定条目",
        details: { module: opts.id, binding },
      });
    }
    if (binding) await writeBinding(bindingsFile(opts.root), opts.id, undefined);
  }
  await fsp.rm(dir, { recursive: true, force: true });
  return {
    id: opts.id,
    removedDir: dir,
    note: opts.global
      ? "已从全局池卸载；daemon 下次触达自动装载新模块集"
      : "已从项目池卸载；daemon 下次触达自动装载新模块集",
  };
}

export interface ModuleListEntry {
  id: string;
  /** 有效集来源池（遮蔽解析后） */
  pool: "global" | "project" | "path";
  version?: string;
  namespace?: string;
  /** 安装器来源（带标记时） */
  origin?: SourceMarker["origin"];
  /** 装载解析后的目录 */
  dir?: string;
  /** 被更高优先级副本遮蔽（global 常见；仅 list 展示，不参与有效集） */
  shadowed?: boolean;
  /** 目录存在但清单损坏 */
  broken?: string;
}

/** 双池 + path 绑定全量列表（含被遮蔽副本；daemon 有效集以 discover 为准）。 */
export async function listModules(
  root: string,
  opts: { globalRoot?: string } = {},
): Promise<ModuleListEntry[]> {
  const out: ModuleListEntry[] = [];
  const globalBase = opts.globalRoot !== undefined ? opts.globalRoot : globalPaths().root;
  const globalPool = path.join(globalBase, "modules");
  const projectPool = projectModulesDir(root);

  const scanPool = async (
    poolDir: string,
    pool: "global" | "project",
  ): Promise<Map<string, ModuleListEntry>> => {
    const map = new Map<string, ModuleListEntry>();
    let names: string[] = [];
    try {
      names = (await fsp.readdir(poolDir)).filter((n) => !n.startsWith("."));
    } catch {
      return map;
    }
    for (const id of names.sort()) {
      const dir = path.join(poolDir, id);
      const entry: ModuleListEntry = { id, pool, dir };
      try {
        const probe = await probeManifest(dir);
        entry.version = probe.version;
        entry.namespace = probe.namespace;
        let origin: SourceMarker["origin"] | undefined;
        try {
          const marker = JSON.parse(
            await fsp.readFile(path.join(dir, SOURCE_MARKER), "utf8"),
          ) as SourceMarker;
          if (marker.format === "toporealm.module-source/v1") origin = marker.origin;
        } catch {
          origin = undefined;
        }
        if (origin !== undefined) entry.origin = origin;
      } catch (err) {
        entry.broken = err instanceof TopoError ? err.message : String(err);
      }
      map.set(id, entry);
    }
    return map;
  };

  const globals = await scanPool(globalPool, "global");
  const projects = await scanPool(projectPool, "project");

  const bindings = await readBindingsRaw(bindingsFile(root));
  const paths = new Map<string, ModuleListEntry>();
  for (const [id, binding] of Object.entries(bindings)) {
    if (binding.source !== "path" || !binding.path) continue;
    const dir = path.isAbsolute(binding.path) ? binding.path : path.resolve(root, binding.path);
    const entry: ModuleListEntry = { id, pool: "path", dir };
    try {
      const probe = await probeManifest(dir);
      entry.version = probe.version;
      entry.namespace = probe.namespace;
    } catch (err) {
      entry.broken = err instanceof TopoError ? err.message : String(err);
    }
    paths.set(id, entry);
  }

  // 展示顺序：path > project > global；被遮蔽者带 shadowed 标注
  for (const [id, e] of paths) {
    if (projects.has(id)) projects.get(id)!.shadowed = true;
    if (globals.has(id)) globals.get(id)!.shadowed = true;
    out.push(e);
  }
  for (const [id, e] of projects) {
    if (globals.has(id)) globals.get(id)!.shadowed = true;
    out.push(e);
  }
  for (const [, e] of globals) out.push(e);
  return out;
}

// 供上层（plugin.json / 同步标记）取生成器版本
export function distributionVersion(): string {
  return (
    JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
      version: string;
    }
  ).version;
}
