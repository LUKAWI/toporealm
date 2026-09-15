import { coreSurface } from "../core/index.js";
import { CoreError, GRAPH_FORMAT, validateGraph } from "../core/index.js";
import type { MutationPlan } from "../core/index.js";
import {
  discoverActions,
  type ActionExecutor,
  type ActionReference,
} from "../module-sdk/index.js";
import type { ModuleRuntime } from "../module-sdk/runtime.js";
import type { ManagedGraph } from "../core/managed.js";
import {
  createWorkspaceRuntime,
  createWorkspaceRuntimeSync,
  initializeWorkspaceGraph,
  listWorkspaceGraphs,
  selectWorkspaceGraph,
} from "../runtime/workspace.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PRODUCT_IDENTITY } from "../product-identity.js";

export const mcpSurface = {
  name: "mcp",
  coreFormat: coreSurface.graphFormat,
} as const;

/** MCP transport-neutral handlers. A real MCP adapter can expose these unchanged. */
export function createMcpHandlers(graph: ManagedGraph, actions?: ActionExecutor) {
  const handlers = {
    graph_read: () => graph.read(),
    graph_apply: (plan: MutationPlan) => graph.commit(plan),
    graph_undo: (expectedRevision?: number) => graph.undo(expectedRevision),
    graph_redo: (expectedRevision?: number) => graph.redo(expectedRevision),
  };
  if (actions) return { ...handlers, execute_action: (reference: ActionReference, input?: Record<string, unknown>) => actions.execute(reference, input) };
  return handlers;
}

export const MCP_TOOL_NAMES = [
  "graph_list",
  "graph_read",
  "graph_create",
  "graph_select",
  "graph_validate",
  "graph_apply",
  "graph_undo",
  "graph_redo",
  "module_status",
  "action_list",
  "action_execute",
] as const;

export interface ToporealmMcpOptions {
  workspaceRoot: string;
  graphId: string;
  runtimes?: Readonly<Record<string, ModuleRuntime>>;
}

function toolResult(value: unknown) {
  const structuredContent = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { result: value };
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
}

function toolError(error: unknown) {
  const code = error instanceof CoreError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  const structuredContent = { error: { code, message } };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
}

const mutationPlanSchema = z.object({
  expectedRevision: z.number().int().nonnegative().optional(),
  label: z.string().optional(),
  mutations: z.array(z.record(z.string(), z.unknown())),
});

/** Official MCP adapter; all graph writes remain delegated to ManagedGraph or ActionExecutor. */
export function createToporealmMcpServer(options: ToporealmMcpOptions): McpServer {
  let graphId = options.graphId;
  const runtimeOptions = () => ({ workspaceRoot: options.workspaceRoot, graphId, ...(options.runtimes ? { runtimes: options.runtimes } : {}) });
  let active = createWorkspaceRuntimeSync(runtimeOptions());
  const switchRuntime = async (id: string) => {
    const next = await createWorkspaceRuntime({ ...runtimeOptions(), graphId: id });
    graphId = id;
    active = next;
  };
  const server = new McpServer(
    { name: PRODUCT_IDENTITY.mcpServerName, version: PRODUCT_IDENTITY.version },
    { instructions: "先读取或发现图，再使用 expectedRevision 提交 MutationPlan。环境管理仅使用 TopoRealm CLI。" },
  );
  const register = <T extends z.ZodTypeAny>(name: string, description: string, schema: T, action: (input: z.infer<T>) => unknown | Promise<unknown>) => {
    server.registerTool(name, { description, inputSchema: schema } as never, (async (input: z.infer<T>) => {
      try { return toolResult(await action(input as z.infer<T>)); }
      catch (error) { return toolError(error); }
    }) as never);
  };

  register("graph_list", "列出工作区图与当前图。", z.object({}), () => ({ currentId: graphId, graphs: listWorkspaceGraphs(options.workspaceRoot) }));
  register("graph_read", "读取当前图快照。", z.object({}), () => {
    const result = active.graph.read();
    return { ...result.snapshot, ...result };
  });
  register("graph_create", "创建领域无关的空图。", z.object({ id: z.string().min(1), label: z.string().optional(), select: z.boolean().optional() }), async ({ id, label, select }) => {
    const manifest = { format: GRAPH_FORMAT, id, sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" }, ...(label === undefined ? {} : { label }) };
    const snapshot = initializeWorkspaceGraph(options.workspaceRoot, id, manifest);
    if (select) { selectWorkspaceGraph(options.workspaceRoot, id); await switchRuntime(id); }
    return snapshot;
  });
  register("graph_select", "选择当前图。", z.object({ id: z.string().min(1) }), async ({ id }) => {
    selectWorkspaceGraph(options.workspaceRoot, id);
    await switchRuntime(id);
    return { currentId: graphId };
  });
  register("graph_validate", "执行基础或完整校验。", z.object({ mode: z.enum(["basic", "complete"]).optional() }), ({ mode }) => {
    if (mode !== "complete") return validateGraph(active.graph.read().snapshot);
    const result = active.graph.validate();
    return { ok: !result.diagnostics.some((item) => item.severity === "error"), ...result };
  });
  register("graph_apply", "由 Core 原子提交 MutationPlan。", z.object({ plan: mutationPlanSchema }), ({ plan }) => active.graph.commit(plan as unknown as MutationPlan));
  register("graph_undo", "撤销当前图的一次提交。", z.object({ expectedRevision: z.number().int().nonnegative().optional() }), ({ expectedRevision }) => active.graph.undo(expectedRevision));
  register("graph_redo", "重做当前图的一次提交。", z.object({ expectedRevision: z.number().int().nonnegative().optional() }), ({ expectedRevision }) => active.graph.redo(expectedRevision));
  register("module_status", "读取当前图模块注册状态。", z.object({}), () => active.registry);
  register("action_list", "发现当前图模块动作引用。", z.object({ target: z.string().optional() }), ({ target }) => discoverActions(active.registry, target));
  register("action_execute", "调用模块领域操作；图变更只能由其返回 MutationPlan 后交给 Core 提交。", z.object({
    reference: z.object({ operation: z.string(), registryRevision: z.number().int().nonnegative(), target: z.string().optional(), inputSchema: z.string().optional(), inputTemplate: z.unknown().optional() }),
    input: z.record(z.string(), z.unknown()).optional(),
  }), async ({ reference, input }) => active.actions.execute(reference as ActionReference, input));
  return server;
}

export async function startToporealmMcpStdio(options: ToporealmMcpOptions): Promise<void> {
  const runtime = await createWorkspaceRuntime({ workspaceRoot: options.workspaceRoot, graphId: options.graphId, ...(options.runtimes ? { runtimes: options.runtimes } : {}) });
  const server = createToporealmMcpServer({ ...options, runtimes: runtime.runtimes });
  await server.connect(new StdioServerTransport());
}
