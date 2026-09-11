import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CoreError,
  GRAPH_FORMAT,
  GraphStore,
  coreSurface,
  validateGraph,
  type GraphManifest,
  type MutationPlan,
} from "../core/index.js";
import {
  installModule,
  listInstalledModules,
  syncHosts,
  uninstallModule,
  type HostSyncOptions,
  type InstallOptions,
} from "../distribution/index.js";
import {
  ActionExecutor,
  GraphActivator,
  WorkspaceModuleResolver,
  discoverActions,
  type ActionReference,
  type ModuleActionRuntime,
} from "../module-sdk/index.js";

export const cliSurface = { name: "cli", coreFormat: coreSurface.graphFormat } as const;

export interface ResolverEnvironment {
  TOPOREALM_ROOT?: string;
  TOPOREALM_GRAPH?: string;
  TOPOREALM_HOME?: string;
}

export interface CliExecutionResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

class CliUsageError extends Error {
  readonly code = "CLI_USAGE";
}

const HELP = `TopoRealm CLI

用法：toporealm [--root <目录>] [--graph <图 ID>] <命令>

命令：
  init <图 ID>              初始化工作区和图
  list                      列出工作区中的图
  switch <图 ID>            设置当前图
  status                    查看当前图状态
  read                      读取图快照
  apply <MutationPlan JSON> 提交图变更
  undo [revision]           撤销
  redo [revision]           重做
  validate [--complete]     基础或完整校验
  serve                     启动 Web Server
  mcp                       启动 stdio MCP Server
  module add|remove|list    管理模块
  action list|execute       发现或执行模块领域操作
  host sync                 同步 Codex、Claude、Pi 宿主资产
  help                      显示帮助

环境变量：TOPOREALM_ROOT、TOPOREALM_GRAPH、TOPOREALM_HOME`;

function workspaceMarker(root: string): string {
  return join(root, ".toporealm");
}

function isWorkspace(root: string): boolean {
  return existsSync(workspaceMarker(root));
}

export function resolveWorkspaceRoot(options: {
  cwd?: string | undefined;
  explicitRoot?: string | undefined;
  env?: ResolverEnvironment | undefined;
  allowCreate?: boolean;
} = {}): string {
  const cwd = resolve(options.cwd ?? process.cwd());
  const explicit = options.explicitRoot ?? options.env?.TOPOREALM_ROOT;
  if (explicit) {
    const root = resolve(cwd, explicit);
    if (!options.allowCreate && !isWorkspace(root)) {
      throw new CoreError({ code: "WORKSPACE_NOT_FOUND", message: `指定目录不是 TopoRealm 工作区：${root}` });
    }
    return root;
  }
  let candidate = cwd;
  while (true) {
    if (isWorkspace(candidate)) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  if (options.allowCreate) return cwd;
  throw new CoreError({ code: "WORKSPACE_NOT_FOUND", message: `从 ${cwd} 向上找不到 .toporealm 工作区。` });
}

export function listGraphs(workspaceRoot: string): Array<{ id: string; label?: string }> {
  const graphsRoot = join(workspaceRoot, ".toporealm", "graphs");
  if (!existsSync(graphsRoot)) return [];
  return readdirSync(graphsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(graphsRoot, entry.name, "graph.yaml")))
    .map((entry) => {
      const snapshot = GraphStore.fromWorkspace(workspaceRoot, entry.name).read();
      const item: { id: string; label?: string } = { id: entry.name };
      if (snapshot.manifest.label !== undefined) item.label = snapshot.manifest.label;
      return item;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function assertGraphExists(workspaceRoot: string, graphId: string, source: string): string {
  if (!existsSync(join(workspaceRoot, ".toporealm", "graphs", graphId, "graph.yaml"))) {
    throw new CoreError({ code: "GRAPH_NOT_FOUND", message: `${source}指定的图不存在：${graphId}` });
  }
  return graphId;
}

export function resolveGraphTarget(workspaceRoot: string, options: {
  explicitGraph?: string | undefined;
  env?: ResolverEnvironment | undefined;
} = {}): string {
  if (options.explicitGraph) return assertGraphExists(workspaceRoot, options.explicitGraph, "--graph ");
  if (options.env?.TOPOREALM_GRAPH) return assertGraphExists(workspaceRoot, options.env.TOPOREALM_GRAPH, "TOPOREALM_GRAPH ");
  const activePath = join(workspaceRoot, ".toporealm", "active");
  if (existsSync(activePath)) {
    const active = readFileSync(activePath, "utf8").trim();
    if (active) return assertGraphExists(workspaceRoot, active, "当前图 ");
  }
  const graphs = listGraphs(workspaceRoot);
  if (graphs.some((graph) => graph.id === "default")) return "default";
  if (graphs.length === 1 && graphs[0]) return graphs[0].id;
  throw new CoreError({ code: "GRAPH_REQUIRED", message: "无法唯一确定目标图；请使用 --graph、TOPOREALM_GRAPH 或 switch。" });
}

export function selectGraph(workspaceRoot: string, graphId: string): void {
  assertGraphExists(workspaceRoot, graphId, "");
  writeFileSync(join(workspaceRoot, ".toporealm", "active"), `${graphId}\n`, "utf8");
}

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

interface ParsedCli {
  args: string[];
  root?: string;
  graph?: string;
  complete: boolean;
  global: boolean;
  host?: string;
  port?: number;
  open: boolean;
}

function parseCli(argv: readonly string[]): ParsedCli {
  const parsed: ParsedCli = { args: [], complete: false, global: false, open: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root" || value === "--graph" || value === "--host" || value === "--port") {
      const option = argv[index + 1];
      if (!option) throw new CliUsageError(`${value} 需要一个值。`);
      if (value === "--root") parsed.root = option;
      else if (value === "--graph") parsed.graph = option;
      else if (value === "--host") parsed.host = option;
      else {
        const port = Number(option);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliUsageError(`--port 无效：${option}`);
        parsed.port = port;
      }
      index += 1;
    } else if (value === "--complete") parsed.complete = true;
    else if (value === "--global") parsed.global = true;
    else if (value === "--open") parsed.open = true;
    else if (value !== undefined) parsed.args.push(value);
  }
  return parsed;
}

function required(value: string | undefined, usage: string): string {
  if (!value) throw new CliUsageError(`用法：${usage}`);
  return value;
}

function parseRevision(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) throw new CliUsageError(`revision 必须是非负整数：${value}`);
  return revision;
}

/** Synchronous command seam. Long-running serve/mcp processes are wired by the executable entrypoint. */
export function runCli(argv: readonly string[], cwd = process.cwd(), env: ResolverEnvironment = process.env): string {
  const parsed = parseCli(argv);
  const [command, first, second] = parsed.args;
  if (!command || command === "help" || command === "--help" || command === "-h") return HELP;
  const commands = new Set(["init", "list", "switch", "status", "read", "apply", "undo", "redo", "validate", "serve", "mcp", "module", "host", "action"]);
  if (!commands.has(command)) throw new CliUsageError(`未知命令：${command}`);

  if (command === "init") {
    const graphId = parsed.graph ?? required(first, "toporealm init <图 ID>");
    const root = resolveWorkspaceRoot({ cwd, explicitRoot: parsed.root, env, allowCreate: true });
    mkdirSync(join(root, ".toporealm", "graphs"), { recursive: true });
    const snapshot = initGraph(root, graphId, {
      format: GRAPH_FORMAT,
      id: graphId,
      sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" },
    });
    if (!existsSync(join(root, ".toporealm", "active"))) selectGraph(root, graphId);
    return JSON.stringify(snapshot);
  }

  const root = resolveWorkspaceRoot({ cwd, explicitRoot: parsed.root, env });
  if (command === "list") {
    let currentId: string | undefined;
    try { currentId = resolveGraphTarget(root, { explicitGraph: parsed.graph, env }); } catch { currentId = undefined; }
    return JSON.stringify({ currentId, graphs: listGraphs(root) });
  }
  if (command === "switch") {
    const graphId = parsed.graph ?? required(first, "toporealm switch <图 ID>");
    selectGraph(root, graphId);
    return JSON.stringify({ currentId: graphId });
  }
  if (command === "module") {
    const action = required(first, "toporealm module add|remove|list");
    const options: InstallOptions = { workspaceRoot: root, scope: parsed.global ? "global" : "workspace" };
    if (env.TOPOREALM_HOME) options.globalHome = env.TOPOREALM_HOME;
    if (action === "list") return JSON.stringify({ modules: listInstalledModules(options) });
    if (action === "add") return JSON.stringify(addModule(required(second, "toporealm module add <npm-spec>"), options));
    if (action === "remove") {
      const id = required(second, "toporealm module remove <module-id>");
      uninstallModule(id, options);
      return JSON.stringify({ removed: id, scope: options.scope });
    }
    throw new CliUsageError(`未知 module 子命令：${action}`);
  }
  if (command === "host") {
    if (first !== "sync") throw new CliUsageError("用法：toporealm host sync");
    return JSON.stringify(syncHostProjections({
      workspaceRoot: root,
      hostRoots: { codex: join(root, ".codex"), claude: join(root, ".claude"), pi: join(root, ".pi") },
    }));
  }
  if (command === "action") {
    const action = required(first, "toporealm action list|execute");
    if (action !== "list" && action !== "execute") throw new CliUsageError(`未知 action 子命令：${action}`);
    return JSON.stringify({ command: "action", action, workspaceRoot: root, graphId: resolveGraphTarget(root, { explicitGraph: parsed.graph, env }), payload: second });
  }
  if (command === "serve" || command === "mcp") {
    return JSON.stringify({ command, workspaceRoot: root, graphId: resolveGraphTarget(root, { explicitGraph: parsed.graph, env }), host: parsed.host ?? "127.0.0.1", port: parsed.port ?? 0, open: parsed.open });
  }

  let legacyGraph: string | undefined;
  let payload = first;
  if (!parsed.graph && ["read", "apply"].includes(command) && first && !first.startsWith("{")) {
    legacyGraph = first;
    payload = second;
  }
  const graphId = resolveGraphTarget(root, { explicitGraph: parsed.graph ?? legacyGraph, env });
  const store = openGraph(root, graphId);
  if (command === "read") return JSON.stringify(store.read());
  if (command === "status") {
    const snapshot = store.read();
    return JSON.stringify({ graphId, revision: snapshot.revision, objects: snapshot.objects.length, relations: snapshot.relations.length, history: store.historyStatus() });
  }
  if (command === "apply") return JSON.stringify(store.apply(JSON.parse(required(payload, "toporealm apply <MutationPlan JSON>")) as MutationPlan));
  if (command === "undo") return JSON.stringify(store.undo(parseRevision(first)));
  if (command === "redo") return JSON.stringify(store.redo(parseRevision(first)));
  if (command === "validate") {
    const snapshot = store.read();
    const registry = parsed.complete ? new GraphActivator(new WorkspaceModuleResolver(root)).activate(snapshot) : undefined;
    return JSON.stringify(validateGraph(snapshot, registry));
  }
  throw new CliUsageError(`未知命令：${command}`);
}

async function loadActionRuntimes(workspaceRoot: string, graphId: string): Promise<Record<string, ModuleActionRuntime>> {
  const snapshot = GraphStore.fromWorkspace(workspaceRoot, graphId).read();
  const resolver = new WorkspaceModuleResolver(workspaceRoot);
  const loaded: Record<string, ModuleActionRuntime> = {};
  for (const ref of snapshot.manifest.modules ?? []) {
    const module = resolver.resolve(ref.id);
    if (module.status !== "available" || !module.manifest.runtime?.entry) continue;
    const imported = await import(pathToFileURL(resolve(module.root, module.manifest.runtime.entry)).href) as {
      default?: ModuleActionRuntime;
      runtime?: ModuleActionRuntime;
    };
    const runtime = imported.default ?? imported.runtime;
    if (runtime && typeof runtime.execute === "function") loaded[ref.id] = runtime;
  }
  return loaded;
}

/** Async CLI seam for the same ActionReference protocol exposed by MCP. */
export async function runActionCli(
  argv: readonly string[],
  cwd = process.cwd(),
  env: ResolverEnvironment = process.env,
): Promise<string> {
  const descriptor = JSON.parse(runCli(argv, cwd, env)) as {
    command: string;
    action: "list" | "execute";
    workspaceRoot: string;
    graphId: string;
    payload?: string;
  };
  if (descriptor.command !== "action") throw new CliUsageError("runActionCli 只接受 action 命令。");
  const store = GraphStore.fromWorkspace(descriptor.workspaceRoot, descriptor.graphId);
  const registry = new GraphActivator(new WorkspaceModuleResolver(descriptor.workspaceRoot)).activate(store.read());
  if (descriptor.action === "list") return JSON.stringify(discoverActions(registry));
  const rawPayload = required(descriptor.payload, "toporealm action execute '<JSON>'");
  const decodedPayload = rawPayload.startsWith("base64:")
    ? Buffer.from(rawPayload.slice("base64:".length), "base64url").toString("utf8")
    : rawPayload;
  const payload = JSON.parse(decodedPayload) as {
    reference?: ActionReference;
    input?: Record<string, unknown>;
  };
  if (!payload.reference) throw new CliUsageError("action execute 缺少 reference。");
  const executor = new ActionExecutor(store, registry, await loadActionRuntimes(descriptor.workspaceRoot, descriptor.graphId));
  return JSON.stringify(await executor.execute(payload.reference, payload.input));
}

export function executeCli(argv: readonly string[], options: { cwd?: string; env?: ResolverEnvironment } = {}): CliExecutionResult {
  try {
    return { exitCode: 0, stdout: `${runCli(argv, options.cwd, options.env)}\n`, stderr: "" };
  } catch (error) {
    const usage = error instanceof CliUsageError;
    const code = error instanceof CoreError ? error.code : usage ? error.code : "CLI_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: usage ? 2 : 1, stdout: "", stderr: `${JSON.stringify({ error: { code, message } })}\n` };
  }
}
