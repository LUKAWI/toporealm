import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WorkspaceModuleResolver, type ResolvedModule } from "../module-sdk/index.js";
import { CoreError } from "../core/index.js";

export type HostId = "codex" | "claude" | "pi";

export interface HostSyncOptions {
  workspaceRoot: string;
  hostRoots: Record<HostId, string>;
}

export interface HostSyncResult {
  host: HostId;
  projectionRoot: string;
  modules: readonly string[];
}

interface OwnerMarker {
  managedBy: "toporealm";
  generator: "toporealm-host-sync";
  moduleId?: string;
  version?: string;
}

const BASE_SKILLS: Record<string, string> = {
  toporealm: "读取当前图和模块状态，把通用请求路由到 Core 或已启用模块。\n",
  "toporealm-design": "指导通用对象、关系、布局和图级审核，不添加领域字段。\n",
  "toporealm-join": "只读读取图范围、模块和近期变化，再路由后续工作。\n",
};

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function readOwner(path: string): OwnerMarker | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as OwnerMarker;
  } catch {
    return undefined;
  }
}

function ensureOwnedOrEmpty(path: string, expectedModule?: string): void {
  if (!existsSync(path)) return;
  const owner = readOwner(join(path, ".toporealm-owner.json"));
  if (!owner || owner.managedBy !== "toporealm" || owner.generator !== "toporealm-host-sync" || (expectedModule && owner.moduleId !== expectedModule)) {
    throw new CoreError({ code: "HOST_TARGET_UNOWNED", message: `不会覆盖无 TopoRealm 所有权标记的宿主资产：${path}` });
  }
}

function projectionManifest(host: HostId, modules: readonly string[]): Record<string, unknown> {
  const base = { name: "toporealm", version: "0.1.0-alpha.1", host, skills: modules.map((id) => `skills/${id}`), mcp: "mcp/toporealm.json", hooks: ["hooks/session-brief.mjs"] };
  if (host === "pi") return { ...base, entry: "index.js" };
  return base;
}

function writeBaseProjection(root: string, host: HostId, modules: readonly string[]): void {
  writeJson(join(root, ".toporealm-owner.json"), { managedBy: "toporealm", generator: "toporealm-host-sync" } satisfies OwnerMarker);
  if (host === "codex") writeJson(join(root, ".codex-plugin", "plugin.json"), projectionManifest(host, modules));
  if (host === "claude") writeJson(join(root, ".claude-plugin", "plugin.json"), projectionManifest(host, modules));
  if (host === "pi") writeFileSync(join(root, "index.js"), `export default ${JSON.stringify(projectionManifest(host, modules))};\n`, "utf8");
  writeJson(join(root, "mcp", "toporealm.json"), { command: "npx", args: ["toporealm", "mcp"] });
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, "hooks", "session-brief.mjs"), "// TopoRealm 只读入场摘要钩子；宿主在启动/恢复时调用 toporealm join。\n", "utf8");
}

function copySkills(root: string, module: ResolvedModule): void {
  if (module.status !== "available") return;
  const skills = module.manifest.skills?.directory;
  if (!skills) return;
  const source = resolve(module.root, skills);
  if (!existsSync(source)) return;
  const target = join(root, "skills", module.id);
  ensureOwnedOrEmpty(target, module.id);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  writeJson(join(target, ".toporealm-owner.json"), { managedBy: "toporealm", generator: "toporealm-host-sync", moduleId: module.id, version: module.manifest.version } satisfies OwnerMarker);
}

function removeStaleSkills(root: string, active: ReadonlySet<string>): void {
  const skillsRoot = join(root, "skills");
  if (!existsSync(skillsRoot)) return;
  for (const id of readdirSync(skillsRoot)) {
    const target = join(skillsRoot, id);
    const owner = readOwner(join(target, ".toporealm-owner.json"));
    if (owner?.managedBy === "toporealm" && owner.generator === "toporealm-host-sync" && owner.moduleId && !active.has(owner.moduleId)) rmSync(target, { recursive: true, force: true });
  }
}

export function syncHosts(options: HostSyncOptions): readonly HostSyncResult[] {
  const resolver = new WorkspaceModuleResolver(options.workspaceRoot);
  const bindings = resolver.readBindings().bindings ?? {};
  const resolved = Object.keys(bindings).map((id) => resolver.resolve(id));
  const available = resolved.filter((item): item is Extract<ResolvedModule, { status: "available" }> => item.status === "available");
  const modules = available.map((item) => item.id);
  return (["codex", "claude", "pi"] as const).map((host) => {
    const root = join(resolve(options.hostRoots[host]), ".toporealm", "generated", host);
    ensureOwnedOrEmpty(root);
    mkdirSync(root, { recursive: true });
    for (const [name, content] of Object.entries(BASE_SKILLS)) {
      const path = join(root, "skills", name);
      ensureOwnedOrEmpty(path, "core");
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "SKILL.md"), content, "utf8");
      writeJson(join(path, ".toporealm-owner.json"), { managedBy: "toporealm", generator: "toporealm-host-sync", moduleId: "core" } satisfies OwnerMarker);
    }
    for (const module of available) copySkills(root, module);
    removeStaleSkills(root, new Set(["core", ...modules]));
    writeBaseProjection(root, host, ["toporealm", "toporealm-design", "toporealm-join", ...modules]);
    return { host, projectionRoot: root, modules };
  });
}
