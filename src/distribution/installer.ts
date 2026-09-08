import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import * as YAML from "yaml";
import type { ModuleManifest } from "../module-sdk/index.js";
import { CoreError } from "../core/index.js";

export type InstallScope = "workspace" | "global";

export interface InstallOptions {
  workspaceRoot: string;
  scope?: InstallScope;
  globalHome?: string;
  npmCommand?: string;
}

export interface InstalledModule {
  id: string;
  version: string;
  root: string;
  scope: InstallScope;
  sourceSpec: string;
}

interface SourceRecord extends InstalledModule {
  managedBy: "toporealm";
  installedAt: string;
}

interface BindingsFile {
  bindings?: Record<string, { source: "workspace" | "global" | "path"; path?: string; version?: string }>;
}

const SOURCE_FILE = "module-sources.yaml";

function parseYaml<T>(path: string): T {
  try {
    return YAML.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new CoreError({ code: "INVALID_MODULE_PACKAGE", message: `无法读取模块包文件：${path}`, details: { cause: error instanceof Error ? error.message : String(error) } });
  }
}

function writeYaml(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, YAML.stringify(value), "utf8");
}

function safeModuleId(id: string): void {
  if (!id || /[\\/:]/.test(id)) throw new CoreError({ code: "INVALID_MODULE_ID", message: `模块 id 无效：${id}` });
}

function ensureInside(root: string, path: string): string {
  const resolved = resolve(path);
  const escaped = relative(resolve(root), resolved).startsWith("..") || resolve(relative(resolve(root), resolved)) === ".";
  if (escaped) throw new CoreError({ code: "MODULE_PATH_ESCAPE", message: `模块包路径越出包目录：${path}` });
  return resolved;
}

function validatePackage(packageRoot: string): ModuleManifest {
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJson = parseYaml<Record<string, unknown>>(packageJsonPath);
  if (typeof packageJson.toporealm !== "string") throw new CoreError({ code: "INVALID_MODULE_PACKAGE", message: "package.json 缺少 toporealm 清单入口。" });
  const manifestPath = ensureInside(packageRoot, join(packageRoot, packageJson.toporealm));
  const manifest = parseYaml<ModuleManifest>(manifestPath);
  if (manifest.format !== "toporealm.module/v1" || typeof manifest.id !== "string" || typeof manifest.version !== "string") {
    throw new CoreError({ code: "INVALID_MODULE_PACKAGE", message: "module.yaml 缺少有效的 TopoRealm 身份。" });
  }
  safeModuleId(manifest.id);
  if (packageJson.version !== manifest.version) throw new CoreError({ code: "INVALID_MODULE_PACKAGE", message: `package.json version=${String(packageJson.version)} 与 module.yaml version=${manifest.version} 不一致。` });
  const scripts = packageJson.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts as Record<string, unknown> : {};
  if (["preinstall", "install", "postinstall"].some((name) => scripts[name] !== undefined)) throw new CoreError({ code: "MODULE_INSTALL_SCRIPT", message: "TopoRealm 模块禁止安装阶段脚本。" });
  if (packageJson.dependencies && typeof packageJson.dependencies === "object" && Object.keys(packageJson.dependencies as object).length > 0) throw new CoreError({ code: "MODULE_NOT_SELF_CONTAINED", message: "模块必须把普通运行时依赖打入 bundle，不能依赖外部 node_modules。" });
  if (existsSync(join(packageRoot, "node_modules"))) throw new CoreError({ code: "MODULE_NOT_SELF_CONTAINED", message: "模块包不能包含 node_modules。" });
  return manifest;
}

function readSourceRecords(path: string): SourceRecord[] {
  if (!existsSync(path)) return [];
  const parsed = parseYaml<{ modules?: SourceRecord[] }>(path);
  return Array.isArray(parsed.modules) ? parsed.modules : [];
}

function writeSourceRecord(path: string, record: SourceRecord): void {
  const records = readSourceRecords(path).filter((item) => !(item.id === record.id && item.scope === record.scope));
  records.push(record);
  writeYaml(path, { modules: records });
}

function readBindings(path: string): BindingsFile {
  if (!existsSync(path)) return { bindings: {} };
  const parsed = parseYaml<BindingsFile>(path);
  return parsed && typeof parsed === "object" ? parsed : { bindings: {} };
}

function writeWorkspaceBinding(workspaceRoot: string, id: string): void {
  const path = join(workspaceRoot, ".toporealm", "modules.yaml");
  const bindings = readBindings(path);
  const next = bindings.bindings ?? {};
  next[id] = { source: "workspace", path: `modules/${id}` };
  writeYaml(path, { ...bindings, bindings: next });
}

function removeWorkspaceBinding(workspaceRoot: string, id: string): void {
  const path = join(workspaceRoot, ".toporealm", "modules.yaml");
  const bindings = readBindings(path);
  if (bindings.bindings) delete bindings.bindings[id];
  writeYaml(path, bindings);
}

function unpackPackage(spec: string, options: InstallOptions): { root: string; cleanup: () => void } {
  const staging = mkdtempSync(join(tmpdir(), "toporealm-npm-"));
  const npm = options.npmCommand;
  const npmArgs = ["pack", "--ignore-scripts", spec, "--pack-destination", staging];
  try {
    if (npm) {
      execFileSync(npm, npmArgs, { cwd: options.workspaceRoot, stdio: ["ignore", "pipe", "inherit"], shell: process.platform === "win32" });
    } else {
      const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
      execFileSync(process.execPath, [npmCli, ...npmArgs], { cwd: options.workspaceRoot, stdio: ["ignore", "pipe", "inherit"] });
    }
    const tarball = readdirSync(staging).find((file) => file.endsWith(".tgz"));
    if (!tarball) throw new Error("npm pack 没有产生 tarball。");
    const unpacked = join(staging, "unpacked");
    mkdirSync(unpacked, { recursive: true });
    execFileSync("tar", ["-xzf", join(staging, tarball), "-C", unpacked], { stdio: "ignore" });
    const root = existsSync(join(unpacked, "package")) ? join(unpacked, "package") : unpacked;
    validatePackage(root);
    return { root, cleanup: () => rmSync(staging, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (error instanceof CoreError) throw error;
    throw new CoreError({ code: "MODULE_PACK_FAILED", message: `npm pack 或解包失败：${spec}`, details: { cause: error instanceof Error ? error.message : String(error) } });
  }
}

function moveManagedModule(sourceRoot: string, targetRoot: string, manifest: ModuleManifest): void {
  mkdirSync(dirname(targetRoot), { recursive: true });
  if (existsSync(targetRoot)) {
    const markerPath = join(targetRoot, ".toporealm-source.json");
    if (!existsSync(markerPath)) throw new CoreError({ code: "MODULE_TARGET_UNOWNED", message: `不会覆盖无来源标记的模块目录：${targetRoot}` });
    rmSync(targetRoot, { recursive: true, force: true });
  }
  const temporary = `${targetRoot}.tmp-${process.pid}-${Date.now()}`;
  cpSync(sourceRoot, temporary, { recursive: true });
  writeFileSync(join(temporary, ".toporealm-source.json"), JSON.stringify({ managedBy: "toporealm", id: manifest.id, version: manifest.version }, null, 2), "utf8");
  renameSync(temporary, targetRoot);
}

export function installModule(spec: string, options: InstallOptions): InstalledModule {
  const scope = options.scope ?? "workspace";
  const globalHome = resolve(options.globalHome ?? process.env.TOPOREALM_HOME ?? join(homedir(), ".toporealm"));
  const packed = unpackPackage(spec, options);
  try {
    const manifest = validatePackage(packed.root);
    const targetRoot = scope === "workspace"
      ? join(resolve(options.workspaceRoot), ".toporealm", "modules", manifest.id)
      : join(globalHome, "modules", manifest.id, manifest.version);
    moveManagedModule(packed.root, targetRoot, manifest);
    const record: SourceRecord = { managedBy: "toporealm", id: manifest.id, version: manifest.version, root: targetRoot, scope, sourceSpec: spec, installedAt: new Date().toISOString() };
    writeSourceRecord(scope === "workspace" ? join(options.workspaceRoot, ".toporealm", SOURCE_FILE) : join(globalHome, SOURCE_FILE), record);
    if (scope === "workspace") writeWorkspaceBinding(options.workspaceRoot, manifest.id);
    return record;
  } finally {
    packed.cleanup();
  }
}

export function uninstallModule(id: string, options: InstallOptions): void {
  safeModuleId(id);
  const scope = options.scope ?? "workspace";
  const globalHome = resolve(options.globalHome ?? process.env.TOPOREALM_HOME ?? join(homedir(), ".toporealm"));
  const sourceFile = scope === "workspace" ? join(options.workspaceRoot, ".toporealm", SOURCE_FILE) : join(globalHome, SOURCE_FILE);
  const records = readSourceRecords(sourceFile);
  const record = records.find((item) => item.id === id && item.scope === scope);
  if (!record) throw new CoreError({ code: "MODULE_SOURCE_NOT_FOUND", message: `没有 TopoRealm 所有权记录，拒绝卸载：${id}` });
  const marker = join(record.root, ".toporealm-source.json");
  if (!existsSync(marker)) throw new CoreError({ code: "MODULE_TARGET_UNOWNED", message: `模块目录缺少所有权标记，拒绝卸载：${record.root}` });
  rmSync(record.root, { recursive: true, force: true });
  writeYaml(sourceFile, { modules: records.filter((item) => item !== record) });
  if (scope === "workspace") removeWorkspaceBinding(options.workspaceRoot, id);
}

export function listInstalledModules(options: InstallOptions): readonly SourceRecord[] {
  const globalHome = resolve(options.globalHome ?? process.env.TOPOREALM_HOME ?? join(homedir(), ".toporealm"));
  const workspace = readSourceRecords(join(options.workspaceRoot, ".toporealm", SOURCE_FILE));
  const global = readSourceRecords(join(globalHome, SOURCE_FILE));
  return [...workspace, ...global];
}
