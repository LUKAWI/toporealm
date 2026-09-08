import { coreSurface } from "../core/index.js";
import { GraphStore } from "../core/index.js";
import type { MutationPlan } from "../core/index.js";
import type { ActionExecutor, ActionReference } from "../module-sdk/index.js";

export const mcpSurface = {
  name: "mcp",
  coreFormat: coreSurface.graphFormat,
} as const;

/** MCP transport-neutral handlers. A real MCP adapter can expose these unchanged. */
export function createMcpHandlers(store: GraphStore, actions?: ActionExecutor) {
  const handlers = {
    graph_read: () => store.read(),
    graph_apply: (plan: MutationPlan) => store.apply(plan),
    graph_undo: (expectedRevision?: number) => store.undo(expectedRevision),
    graph_redo: (expectedRevision?: number) => store.redo(expectedRevision),
  };
  if (actions) return { ...handlers, execute_action: (reference: ActionReference, input?: Record<string, unknown>) => actions.execute(reference, input) };
  return handlers;
}
