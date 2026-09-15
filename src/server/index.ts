import { coreSurface } from "../core/index.js";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { CoreError, validateGraph } from "../core/index.js";
import type { ModuleRuntime } from "../module-sdk/runtime.js";
import { createWorkspaceRuntime, createWorkspaceRuntimeSync, listWorkspaceGraphs, type WorkspaceRuntime, type WorkspaceRuntimeOptions } from "../runtime/workspace.js";
import { readWebAsset, renderWebShell } from "../web/index.js";
import type { MutationPlan } from "../core/index.js";
import { WebSocketServer } from "ws";

export const serverSurface = {
  name: "server",
  coreFormat: coreSurface.graphFormat,
} as const;

export interface ToporealmServerOptions {
  runtimes?: Readonly<Record<string, ModuleRuntime>>;
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
export function createToporealmServer(runtime: WorkspaceRuntime, options: ToporealmServerOptions = {}): Server {
  let active = runtime;
  const workspaceRoot = runtime.workspaceRoot;
  const graphSummary = (candidate: WorkspaceRuntime) => {
    const snapshot = candidate.graph.read().snapshot;
    return {
      id: snapshot.manifest.id,
      label: snapshot.manifest.label,
      revision: snapshot.revision,
      objectCount: snapshot.objects.length,
      relationCount: snapshot.relations.length,
    };
  };
  const listGraphs = () => {
    return listWorkspaceGraphs(workspaceRoot).flatMap((item) => {
      try { return [graphSummary(createWorkspaceRuntimeSync({ workspaceRoot, graphId: item.id, ...(options.runtimes ? { runtimes: options.runtimes } : {}) }))]; }
      catch { return []; }
    });
  };
  const moduleAsset = (pathname: string): { body: Buffer; contentType: string } | undefined => {
    const match = /^\/api\/module-assets\/([^/]+)\/(.+)$/.exec(pathname);
    if (!match?.[1] || !match[2]) return undefined;
    const moduleRoot = active.moduleRoots[decodeURIComponent(match[1])];
    if (!moduleRoot) return undefined;
    const requested = resolve(moduleRoot, decodeURIComponent(match[2]));
    const escaped = relative(moduleRoot, requested).startsWith("..") || isAbsolute(relative(moduleRoot, requested));
    if (escaped || !existsSync(requested)) return undefined;
    const contentTypes: Record<string, string> = {
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    return { body: readFileSync(requested), contentType: contentTypes[extname(requested)] ?? "application/octet-stream" };
  };
  const webSockets = new WebSocketServer({ noServer: true });
  const broadcastMutation = (result: { revision: number; patch: unknown; diagnostics: unknown; complete: boolean; notice?: unknown }): void => {
    const message = JSON.stringify({ type: "graph:patch", graphId: active.graphId, revision: result.revision, patch: result.patch, diagnostics: result.diagnostics, complete: result.complete, ...(result.notice ? { notice: result.notice } : {}) });
    for (const client of webSockets.clients) if (client.readyState === client.OPEN) client.send(message);
  };
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://toporealm.local");
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(renderWebShell());
        return;
      }
      if (request.method === "GET" && (url.pathname === "/graph" || url.pathname === "/api/graph")) {
        const result = active.graph.read();
        sendJson(response, 200, { ...result.snapshot, diagnostics: result.diagnostics, complete: result.complete, ...(result.notice ? { notice: result.notice } : {}) });
        return;
      }
      if (request.method === "GET" && (url.pathname === "/graphs" || url.pathname === "/api/graphs")) {
        sendJson(response, 200, { currentId: active.graphId, graphs: listGraphs() });
        return;
      }
      if (request.method === "GET" && (url.pathname === "/history" || url.pathname === "/api/history")) {
        sendJson(response, 200, active.historyStatus());
        return;
      }
      if (request.method === "GET" && (url.pathname === "/validate" || url.pathname === "/api/validate")) {
        const snapshot = active.graph.read().snapshot;
        if (url.searchParams.get("mode") !== "complete") sendJson(response, 200, validateGraph(snapshot));
        else {
          const result = active.graph.validate();
          const errors = result.diagnostics.filter((item) => item.severity === "error");
          const warnings = result.diagnostics.filter((item) => item.severity === "warning");
          sendJson(response, 200, { ok: errors.length === 0, complete: result.complete, errors, warnings, diagnostics: result.diagnostics, revision: result.revision });
        }
        return;
      }
      if (request.method === "GET" && (url.pathname === "/modules" || url.pathname === "/api/modules")) {
        const registry = active.registry;
        sendJson(response, 200, { registryRevision: registry.registryRevision, modules: registry.modules, ui: registry.ui, operations: registry.operations });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/module-assets/")) {
        const asset = moduleAsset(url.pathname);
        if (!asset) {
          sendJson(response, 404, { error: { code: "MODULE_ASSET_NOT_FOUND", message: "模块 Web 资源不存在或不可用。" } });
          return;
        }
        response.statusCode = 200;
        response.setHeader("content-type", asset.contentType);
        response.setHeader("cache-control", "no-cache");
        response.end(asset.body);
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
          const next = await createWorkspaceRuntime({ workspaceRoot, graphId: body.id, ...(options.runtimes ? { runtimes: options.runtimes } : {}) });
          const read = next.graph.read();
          active = next;
          sendJson(response, 200, {
            snapshot: read.snapshot,
            history: active.historyStatus(),
            graph: graphSummary(active),
            diagnostics: read.diagnostics,
            complete: read.complete,
            ...(read.notice ? { notice: read.notice } : {}),
          });
          return;
        }
        if (url.pathname === "/actions" || url.pathname === "/api/actions") {
          const registry = active.registry;
          if (typeof body.operation !== "string") throw new CoreError({ code: "INVALID_OPERATION", message: "动作请求需要 operation。" });
          const reference: { operation: string; registryRevision: number; target?: string } = {
            operation: body.operation,
            registryRevision: typeof body.registryRevision === "number" ? body.registryRevision : registry.registryRevision,
          };
          if (typeof body.target === "string") reference.target = body.target;
          const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input as Record<string, unknown> : {};
          const result = await active.actions.execute(reference, input);
          if (result.kind === "mutation") broadcastMutation(result.mutation);
          sendJson(response, 200, result);
          return;
        }
        if (url.pathname === "/mutations" || url.pathname === "/api/mutations") {
          const result = active.graph.commit(body as unknown as MutationPlan);
          broadcastMutation(result);
          sendJson(response, 200, result);
          return;
        }
        if (url.pathname === "/undo" || url.pathname === "/api/undo") {
          const result = active.graph.undo(typeof body.expectedRevision === "number" ? body.expectedRevision : undefined);
          broadcastMutation(result);
          sendJson(response, 200, result);
          return;
        }
        if (url.pathname === "/redo" || url.pathname === "/api/redo") {
          const result = active.graph.redo(typeof body.expectedRevision === "number" ? body.expectedRevision : undefined);
          broadcastMutation(result);
          sendJson(response, 200, result);
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
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://toporealm.local");
    if (url.pathname !== "/api/events") { socket.destroy(); return; }
    webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit("connection", client, request));
  });
  server.on("close", () => webSockets.close());
  return server;
}

export async function listenToporealmServer(runtimeOptions: WorkspaceRuntimeOptions, port = 0, host = "127.0.0.1", options: ToporealmServerOptions = {}): Promise<Server> {
  const runtime = await createWorkspaceRuntime({ ...runtimeOptions, ...(options.runtimes ? { runtimes: options.runtimes } : {}) });
  const server = createToporealmServer(runtime, { ...options, runtimes: runtime.runtimes });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
