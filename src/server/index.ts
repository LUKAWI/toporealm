import { coreSurface } from "../core/index.js";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CoreError, GraphStore, validateGraph } from "../core/index.js";
import { ActionExecutor, GraphActivator, WorkspaceModuleResolver } from "../module-sdk/index.js";
import type { ModuleActionRuntime } from "../module-sdk/index.js";
import { readWebAsset, renderWebShell } from "../web/index.js";
import type { MutationPlan } from "../core/index.js";

export const serverSurface = {
  name: "server",
  coreFormat: coreSurface.graphFormat,
} as const;

export interface ToporealmServerOptions {
  runtimes?: Readonly<Record<string, ModuleActionRuntime>>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(body);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("请求体过大"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

/** A small HTTP adapter for the same Core store used by CLI and MCP. */
export function createToporealmServer(store: GraphStore, options: ToporealmServerOptions = {}): Server {
  let activeStore = store;
  const workspaceRoot = dirname(dirname(dirname(store.graphRoot)));
  const graphSummary = (candidate: GraphStore) => {
    const snapshot = candidate.read();
    return {
      id: snapshot.manifest.id,
      label: snapshot.manifest.label,
      revision: snapshot.revision,
      objectCount: snapshot.objects.length,
      relationCount: snapshot.relations.length,
    };
  };
  const listGraphs = () => {
    const graphsRoot = join(workspaceRoot, ".toporealm", "graphs");
    try {
      return readdirSync(graphsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          try { return [graphSummary(GraphStore.fromWorkspace(workspaceRoot, entry.name))]; }
          catch { return []; }
        })
        .sort((left, right) => left.id.localeCompare(right.id));
    } catch {
      return [];
    }
  };
  const activeRegistry = () => new GraphActivator(new WorkspaceModuleResolver(workspaceRoot)).activate(activeStore.read());
  const runtimes = options.runtimes ?? {};
  return createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://toporealm.local");
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(renderWebShell());
        return;
      }
      if (request.method === "GET" && (url.pathname === "/graph" || url.pathname === "/api/graph")) {
        sendJson(response, 200, activeStore.read());
        return;
      }
      if (request.method === "GET" && (url.pathname === "/graphs" || url.pathname === "/api/graphs")) {
        sendJson(response, 200, { currentId: activeStore.read().manifest.id, graphs: listGraphs() });
        return;
      }
      if (request.method === "GET" && (url.pathname === "/history" || url.pathname === "/api/history")) {
        sendJson(response, 200, activeStore.historyStatus());
        return;
      }
      if (request.method === "GET" && (url.pathname === "/validate" || url.pathname === "/api/validate")) {
        const snapshot = activeStore.read();
        sendJson(response, 200, url.searchParams.get("mode") === "complete" ? validateGraph(snapshot, activeRegistry()) : validateGraph(snapshot));
        return;
      }
      if (request.method === "GET" && (url.pathname === "/modules" || url.pathname === "/api/modules")) {
        const registry = activeRegistry();
        sendJson(response, 200, { registryRevision: registry.registryRevision, modules: registry.modules, ui: registry.ui, operations: registry.operations });
        return;
      }
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        const asset = readWebAsset(url.pathname);
        if (asset) {
          response.statusCode = 200;
          response.setHeader("content-type", asset.contentType);
          response.end(asset.body);
          return;
        }
      }
      if (request.method === "POST") {
        const body = JSON.parse((await readBody(request)) || "{}") as Record<string, unknown>;
        if (url.pathname === "/graph/switch" || url.pathname === "/api/graph/switch") {
          if (typeof body.id !== "string") throw new CoreError({ code: "INVALID_GRAPH_ID", message: "图切换需要字符串 graph ID。" });
          const next = GraphStore.fromWorkspace(workspaceRoot, body.id);
          const snapshot = next.read();
          activeStore = next;
          sendJson(response, 200, { snapshot, history: activeStore.historyStatus(), graph: graphSummary(activeStore) });
          return;
        }
        if (url.pathname === "/actions" || url.pathname === "/api/actions") {
          const registry = activeRegistry();
          if (typeof body.operation !== "string") throw new CoreError({ code: "INVALID_OPERATION", message: "动作请求需要 operation。" });
          const reference: { operation: string; registryRevision: number; target?: string } = {
            operation: body.operation,
            registryRevision: typeof body.registryRevision === "number" ? body.registryRevision : registry.registryRevision,
          };
          if (typeof body.target === "string") reference.target = body.target;
          const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input as Record<string, unknown> : {};
          const result = await new ActionExecutor(activeStore, registry, runtimes).execute(reference, input);
          sendJson(response, 200, result);
          return;
        }
        if (url.pathname === "/mutations" || url.pathname === "/api/mutations") {
          sendJson(response, 200, activeStore.apply(body as unknown as MutationPlan));
          return;
        }
        if (url.pathname === "/undo" || url.pathname === "/api/undo") {
          sendJson(response, 200, activeStore.undo(typeof body.expectedRevision === "number" ? body.expectedRevision : undefined));
          return;
        }
        if (url.pathname === "/redo" || url.pathname === "/api/redo") {
          sendJson(response, 200, activeStore.redo(typeof body.expectedRevision === "number" ? body.expectedRevision : undefined));
          return;
        }
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "没有这个 TopoRealm 接口。" } });
    } catch (error) {
      if (error instanceof CoreError) {
        sendJson(response, error.code === "REVISION_CONFLICT" ? 409 : 400, {
          error: { code: error.code, message: error.message, details: error.details },
        });
        return;
      }
      sendJson(response, 400, { error: { code: "BAD_REQUEST", message: error instanceof Error ? error.message : String(error) } });
    }
  });
}

export function listenToporealmServer(store: GraphStore, port = 0, host = "127.0.0.1", options: ToporealmServerOptions = {}): Promise<Server> {
  const server = createToporealmServer(store, options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
