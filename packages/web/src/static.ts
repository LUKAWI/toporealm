import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------- 静态产物伺服（D22 裁决②）：web-ui 构建产物 + SPA 回退 ----------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** web-ui 构建产物目录解析：TOPOREALM_WEB_STATIC > workspace 内 web-ui/dist；找不到 = null（纯 WS 模式） */
export function resolveWebUiDist(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.TOPOREALM_WEB_STATIC;
  if (fromEnv !== undefined && fromEnv !== "") {
    return path.resolve(fromEnv);
  }
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve("@toporealm/web-ui/package.json");
    const dist = path.join(path.dirname(pkgPath), "dist");
    return fs.existsSync(dist) ? dist : null;
  } catch {
    return null;
  }
}

/**
 * 返回静态文件处理器。GET/HEAD 以外的动词不处理；路径必须落在 staticDir 内
 * （拒绝 `..` 越界）；文件不存在 → SPA 回退 index.html；连 index.html 都没有 → 404。
 */
export function createStaticHandler(
  staticDir: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const root = path.resolve(staticDir);
  return async function serve(req, res): Promise<boolean> {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const url = new URL(req.url ?? "/", "http://localhost");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    const candidate = path.resolve(root, "." + pathname);
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return true;
    }
    let file = candidate;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // SPA 回退：非资源路径全部回落 index.html（前端路由/刷新不 404）
      file = path.join(root, "index.html");
      if (!fs.existsSync(file)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("web-ui build not found — run `npm run build` in web-ui/ or set TOPOREALM_WEB_STATIC");
        return true;
      }
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    if (req.method === "HEAD") {
      res.end();
    } else {
      await new Promise<void>((resolve) => {
        const stream = fs.createReadStream(file);
        stream.on("error", () => res.end());
        stream.on("close", resolve);
        stream.pipe(res);
      });
    }
    return true;
  };
}
