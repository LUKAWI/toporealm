import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWebServer, type WebServerOptions } from "../src/server.js";

// ---------- D34：纯 WS 模式守卫——无静态产物时 GET / 明确 503 说明，不再空体 404 白屏 ----------

let tmp: string;
const servers: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-web-srv-"));
});
afterAll(async () => {
  for (const s of servers) await s.close().catch(() => {});
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/** GET / 不触 runtime（只静态层）；stub 满足类型即可 */
function fakeRuntime(): WebServerOptions["runtime"] {
  return { current: () => ({ core: null }) } as unknown as WebServerOptions["runtime"];
}

describe("startWebServer 静态守卫", () => {
  it("无 staticDir：GET / 返回 503 + 说明文本（含 TOPOREALM_WEB_STATIC 提示）", async () => {
    const srv = await startWebServer({
      runtime: fakeRuntime(),
      port: 0,
      onStop: () => {},
    });
    servers.push(srv);
    const res = await fetch(`http://127.0.0.1:${srv.port}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("TOPOREALM_WEB_STATIC");
  });

  it("有 staticDir：GET / 伺服 index.html（200）", async () => {
    const dir = path.join(tmp, "dist");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "index.html"), "<!doctype html><title>ok</title>");
    const srv = await startWebServer({
      runtime: fakeRuntime(),
      port: 0,
      staticDir: dir,
      onStop: () => {},
    });
    servers.push(srv);
    const res = await fetch(`http://127.0.0.1:${srv.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>ok</title>");
  });
});
