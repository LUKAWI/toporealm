import { coreSurface } from "../core/index.js";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CoreError, GraphStore } from "../core/index.js";
import { renderWebShell } from "../web/index.js";
import type { MutationPlan } from "../core/index.js";

export const serverSurface = {
  name: "server",
  coreFormat: coreSurface.graphFormat,
} as const;

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
export function createToporealmServer(store: GraphStore): Server {
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
        sendJson(response, 200, store.read());
        return;
      }
      if (request.method === "POST") {
        const body = JSON.parse((await readBody(request)) || "{}") as Record<string, unknown>;
        if (url.pathname === "/mutations" || url.pathname === "/api/mutations") {
          sendJson(response, 200, store.apply(body as unknown as MutationPlan));
          return;
        }
        if (url.pathname === "/undo" || url.pathname === "/api/undo") {
          sendJson(response, 200, store.undo(typeof body.expectedRevision === "number" ? body.expectedRevision : undefined));
          return;
        }
        if (url.pathname === "/redo" || url.pathname === "/api/redo") {
          sendJson(response, 200, store.redo(typeof body.expectedRevision === "number" ? body.expectedRevision : undefined));
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

export function listenToporealmServer(store: GraphStore, port = 0, host = "127.0.0.1"): Promise<Server> {
  const server = createToporealmServer(store);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
