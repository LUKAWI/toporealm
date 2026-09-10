import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WorkspaceModuleResolver, type ResolvedModule } from "../module-sdk/index.js";
import { CoreError } from "../core/index.js";
import { BASE_SKILL_NAMES, baseSkillsRoot } from "./skills.js";

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

function writeBaseProjection(root: string, host: HostId, modules: readonly string[]): void {
  writeJson(join(root, ".toporealm-owner.json"), { managedBy: "toporealm", generator: "toporealm-host-sync" } satisfies OwnerMarker);
  const mcpServer = { type: "stdio", command: "npx", args: ["-y", "@lukawi/toporealm@0.1.0", "mcp"], enabled: true };
  writeJson(join(root, ".mcp.json"), { mcpServers: { toporealm: mcpServer } });
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, "hooks", "session-brief.mjs"), `import { spawnSync } from "node:child_process";
const result = spawnSync("npx", ["-y", "@lukawi/toporealm@0.1.0", "status"], { encoding: "utf8", shell: process.platform === "win32" });
const summary = result.status === 0 ? result.stdout.trim() : "TopoRealm 工作区尚不可用。";
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: summary } }));
`, "utf8");
  if (host === "codex") {
    writeJson(join(root, ".codex-plugin", "plugin.json"), {
      name: "toporealm", version: "0.1.0", description: "Domain-neutral graph foundation for Codex.",
      author: { name: "lukawi", url: "https://github.com/LUKAWI/toporealm" }, homepage: "https://github.com/LUKAWI/toporealm",
      repository: "https://github.com/LUKAWI/toporealm", license: "MIT", keywords: ["graph", "mcp", "skills"],
      skills: "./skills/", mcpServers: "./.mcp.json",
      interface: { displayName: "TopoRealm", shortDescription: "Domain-neutral graphs, modules, and visual editing", longDescription: "Read, evolve, validate, and visualize extensible TopoRealm graphs through Core, CLI, MCP, Web UI, and separately installed modules.", developerName: "lukawi", category: "Developer Tools", capabilities: ["Read", "Write"], websiteURL: "https://github.com/LUKAWI/toporealm", defaultPrompt: ["Read the current TopoRealm graph and help me continue", "Design a domain-neutral graph change for this request"] },
    });
  }
  if (host === "claude") {
    writeJson(join(root, ".claude-plugin", "plugin.json"), {
      $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json", name: "toporealm", displayName: "TopoRealm",
      description: "Domain-neutral graph foundation for Claude Code.", version: "0.1.0", author: { name: "lukawi" },
      homepage: "https://github.com/LUKAWI/toporealm", repository: "https://github.com/LUKAWI/toporealm", license: "MIT", keywords: ["graph", "mcp", "skills"],
    });
    writeJson(join(root, "hooks", "hooks.json"), { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/session-brief.mjs\"" }] }] } });
  }
  if (host === "pi") {
    writeJson(join(root, "package.json"), {
      name: "@lukawi/toporealm-pi", version: "0.1.0", private: true, type: "module", keywords: ["pi-package", "graph", "mcp"],
      pi: { extensions: ["./index.js"], skills: ["./skills"] }, mcpServers: { toporealm: mcpServer },
    });
    writeFileSync(join(root, "index.js"), `import { spawnSync } from "node:child_process";
export default function toporealmPi(pi) {
  pi.on("before_agent_start", async () => {
    const result = spawnSync("npx", ["-y", "@lukawi/toporealm@0.1.0", "status"], { encoding: "utf8", shell: process.platform === "win32" });
    return { message: { customType: "toporealm-status", content: result.status === 0 ? result.stdout.trim() : "TopoRealm 工作区尚不可用。", display: false } };
  });
}
`, "utf8");
  }
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
    for (const name of BASE_SKILL_NAMES) {
      const path = join(root, "skills", name);
      ensureOwnedOrEmpty(path, "core");
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      cpSync(join(baseSkillsRoot(), name), path, { recursive: true });
      writeJson(join(path, ".toporealm-owner.json"), { managedBy: "toporealm", generator: "toporealm-host-sync", moduleId: "core" } satisfies OwnerMarker);
    }
    for (const module of available) copySkills(root, module);
    removeStaleSkills(root, new Set(["core", ...modules]));
    writeBaseProjection(root, host, [...BASE_SKILL_NAMES, ...modules]);
    return { host, projectionRoot: root, modules };
  });
}
