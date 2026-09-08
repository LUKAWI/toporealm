import { coreSurface } from "../core/index.js";
import { GraphStore } from "../core/index.js";
import type { GraphManifest, MutationPlan } from "../core/index.js";
import { join } from "node:path";
import { installModule, syncHosts, type InstallOptions, type HostSyncOptions } from "../distribution/index.js";

export const cliSurface = {
  name: "cli",
  coreFormat: coreSurface.graphFormat,
} as const;

export function openGraph(workspaceRoot: string, graphId: string): GraphStore {
  return GraphStore.fromWorkspace(workspaceRoot, graphId);
}

export function readGraph(workspaceRoot: string, graphId: string) {
  return openGraph(workspaceRoot, graphId).read();
}

export function applyGraphPlan(workspaceRoot: string, graphId: string, plan: MutationPlan) {
  return openGraph(workspaceRoot, graphId).apply(plan);
}

export function undoGraph(workspaceRoot: string, graphId: string, expectedRevision?: number) {
  return openGraph(workspaceRoot, graphId).undo(expectedRevision);
}

export function redoGraph(workspaceRoot: string, graphId: string, expectedRevision?: number) {
  return openGraph(workspaceRoot, graphId).redo(expectedRevision);
}

export function initGraph(workspaceRoot: string, graphId: string, manifest: GraphManifest) {
  return openGraph(workspaceRoot, graphId).initialize(manifest);
}

export function addModule(spec: string, options: InstallOptions) {
  return installModule(spec, options);
}

export function syncHostProjections(options: HostSyncOptions) {
  return syncHosts(options);
}

/** Minimal JSON CLI used by the vertical slice; all writes still go through GraphStore. */
export function runCli(argv: readonly string[], workspaceRoot = process.cwd()): string {
  const [command, graphId, payload] = argv;
  if (!command || !graphId) throw new Error("用法：toporealm <read|apply|undo|redo> <graph-id> [JSON]，或 toporealm module add <spec>");
  if (command === "module" && graphId === "add") {
    if (!payload) throw new Error("用法：toporealm module add <npm-spec>");
    const scope = argv.includes("--global") ? "global" : "workspace";
    return JSON.stringify(addModule(payload, { workspaceRoot, scope }));
  }
  if (command === "host" && graphId === "sync") {
    const roots = { codex: join(workspaceRoot, ".codex"), claude: join(workspaceRoot, ".claude"), pi: join(workspaceRoot, ".pi") };
    return JSON.stringify(syncHostProjections({ workspaceRoot, hostRoots: roots }));
  }
  const store = openGraph(workspaceRoot, graphId);
  if (command === "read") return JSON.stringify(store.read());
  if (command === "apply") return JSON.stringify(store.apply(JSON.parse(payload ?? "{}") as MutationPlan));
  if (command === "undo") return JSON.stringify(store.undo());
  if (command === "redo") return JSON.stringify(store.redo());
  throw new Error(`未知命令：${command}`);
}
