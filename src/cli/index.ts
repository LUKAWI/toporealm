import { coreSurface } from "../core/index.js";
import { GraphStore } from "../core/index.js";
import type { GraphManifest, MutationPlan } from "../core/index.js";

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

/** Minimal JSON CLI used by the vertical slice; all writes still go through GraphStore. */
export function runCli(argv: readonly string[], workspaceRoot = process.cwd()): string {
  const [command, graphId, payload] = argv;
  if (!command || !graphId) throw new Error("用法：toporealm <read|apply|undo|redo> <graph-id> [JSON]");
  const store = openGraph(workspaceRoot, graphId);
  if (command === "read") return JSON.stringify(store.read());
  if (command === "apply") return JSON.stringify(store.apply(JSON.parse(payload ?? "{}") as MutationPlan));
  if (command === "undo") return JSON.stringify(store.undo());
  if (command === "redo") return JSON.stringify(store.redo());
  throw new Error(`未知命令：${command}`);
}
