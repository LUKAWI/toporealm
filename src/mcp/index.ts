import { coreSurface } from "../core/index.js";
import { GraphStore } from "../core/index.js";
import type { MutationPlan } from "../core/index.js";

export const mcpSurface = {
  name: "mcp",
  coreFormat: coreSurface.graphFormat,
} as const;

/** MCP transport-neutral handlers. A real MCP adapter can expose these unchanged. */
export function createMcpHandlers(store: GraphStore) {
  return {
    graph_read: () => store.read(),
    graph_apply: (plan: MutationPlan) => store.apply(plan),
    graph_undo: (expectedRevision?: number) => store.undo(expectedRevision),
    graph_redo: (expectedRevision?: number) => store.redo(expectedRevision),
  };
}
