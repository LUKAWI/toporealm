import { coreSurface } from "../core/index.js";
import { CoreError, GRAPH_FORMAT, GraphStore, validateGraph } from "../core/index.js";
import type { MutationPlan } from "../core/index.js";
import { listGraphs, selectGraph } from "../cli/index.js";
import {
  ActionExecutor,
  GraphActivator,
  WorkspaceModuleResolver,
  discoverActions,
  type ActionReference,
  type ModuleActionRuntime,
} from "../module-sdk/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";

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
  runtimes?: Readonly<Record<string, ModuleActionRuntime>>;
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

/** Official MCP server adapter; all graph writes remain delegated to GraphStore or ActionExecutor. */
export function createToporealmMcpServer(options: ToporealmMcpOptions): McpServer {
  let graphId = options.graphId;
  const runtimes = options.runtimes ?? {};
  const store = () => GraphStore.fromWorkspace(options.workspaceRoot, graphId);
  const registry = () => {
    const snapshot = store().read();
    return new GraphActivator(new WorkspaceModuleResolver(options.workspaceRoot)).activate(snapshot);
  };
  const server = new McpServer(
    { name: "toporealm", version: "0.1.0" },
    { instructions: "先读取或发现图，再使用 expectedRevision 提交 MutationPlan。环境管理仅使用 TopoRealm CLI。" },
  );
  const register = <T extends z.ZodTypeAny>(name: string, description: string, schema: T, action: (input: z.infer<T>) => unknown | Promise<unknown>) => {
    server.registerTool(name, { description, inputSchema: schema } as never, (async (input: z.infer<T>) => {
      try { return toolResult(await action(input as z.infer<T>)); }
      catch (error) { return toolError(error); }
    }) as never);
  };

  register("graph_list", "列出工作区图与当前图。", z.object({}), () => ({ currentId: graphId, graphs: listGraphs(options.workspaceRoot) }));
  register("graph_read", "读取当前图快照。", z.object({}), () => store().read());
  register("graph_create", "创建领域无关的空图。", z.object({ id: z.string().min(1), label: z.string().optional(), select: z.boolean().optional() }), ({ id, label, select }) => {
    const manifest = { format: GRAPH_FORMAT, id, sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" }, ...(label === undefined ? {} : { label }) };
    const snapshot = GraphStore.fromWorkspace(options.workspaceRoot, id).initialize(manifest);
    if (select) { graphId = id; selectGraph(options.workspaceRoot, id); }
    return snapshot;
  });
  register("graph_select", "选择当前图。", z.object({ id: z.string().min(1) }), ({ id }) => {
    selectGraph(options.workspaceRoot, id);
    graphId = id;
    return { currentId: graphId };
  });
  register("graph_validate", "执行基础或完整校验。", z.object({ mode: z.enum(["basic", "complete"]).optional() }), ({ mode }) => {
    const snapshot = store().read();
    return validateGraph(snapshot, mode === "complete" ? registry() : undefined);
  });
  register("graph_apply", "由 Core 原子提交 MutationPlan。", z.object({ plan: mutationPlanSchema }), ({ plan }) => store().apply(plan as unknown as MutationPlan));
  register("graph_undo", "撤销当前图的一次提交。", z.object({ expectedRevision: z.number().int().nonnegative().optional() }), ({ expectedRevision }) => store().undo(expectedRevision));
  register("graph_redo", "重做当前图的一次提交。", z.object({ expectedRevision: z.number().int().nonnegative().optional() }), ({ expectedRevision }) => store().redo(expectedRevision));
  register("module_status", "读取当前图模块注册状态。", z.object({}), () => registry());
  register("action_list", "发现当前图模块动作引用。", z.object({ target: z.string().optional() }), ({ target }) => discoverActions(registry(), target));
  register("action_execute", "调用模块领域操作；图变更只能由其返回 MutationPlan 后交给 Core 提交。", z.object({
    reference: z.object({ operation: z.string(), registryRevision: z.number().int().nonnegative(), target: z.string().optional(), inputSchema: z.string().optional(), inputTemplate: z.unknown().optional() }),
    input: z.record(z.string(), z.unknown()).optional(),
  }), async ({ reference, input }) => new ActionExecutor(store(), registry(), runtimes).execute(reference as ActionReference, input));
  return server;
}

export async function startToporealmMcpStdio(options: ToporealmMcpOptions): Promise<void> {
  const snapshot = GraphStore.fromWorkspace(options.workspaceRoot, options.graphId).read();
  const resolver = new WorkspaceModuleResolver(options.workspaceRoot);
  const loaded: Record<string, ModuleActionRuntime> = { ...(options.runtimes ?? {}) };
  for (const ref of snapshot.manifest.modules ?? []) {
    if (loaded[ref.id]) continue;
    const module = resolver.resolve(ref.id);
    if (module.status !== "available") continue;
    const entry = module.manifest.runtime?.entry;
    if (!entry) continue;
    const imported = await import(pathToFileURL(resolve(module.root, entry)).href) as { default?: ModuleActionRuntime; runtime?: ModuleActionRuntime };
    const runtime = imported.default ?? imported.runtime;
    if (runtime && typeof runtime.execute === "function") loaded[ref.id] = runtime;
  }
  const server = createToporealmMcpServer({ ...options, runtimes: loaded });
  await server.connect(new StdioServerTransport());
}
