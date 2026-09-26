import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  readEndpoint,
  waitForPidExit,
  writeEndpoint,
} from "@lukawi/toporealm-daemon-core";
import { provisionGraph } from "@lukawi/toporealm-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/index.js";

// ---------- serve 动词（blueprint §4 + D22）：自动拉起带 web 的 daemon → 开浏览器即退 ----------
// e2e 走真实 bin 拉起路径（spawnDaemonDetached → toporeald）；daemon 按 endpoint pid 显式收割。

let root: string;
let staticDir: string;
const oldEnv = process.env.TOPOREALM_WEB_STATIC;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-serve-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await provisionGraph(root, "g1"); // new = 建图 + 选中（serve 解析 active 指针）
  staticDir = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-static-"));
  await fsp.writeFile(
    path.join(staticDir, "index.html"),
    "<!doctype html><title>toporealm-serve</title>",
    "utf8",
  );
  // toporeald 子进程继承环境：静态产物指向测试目录（真实场景 = web-ui/dist）
  process.env.TOPOREALM_WEB_STATIC = staticDir;
});

afterAll(async () => {
  if (oldEnv === undefined) delete process.env.TOPOREALM_WEB_STATIC;
  else process.env.TOPOREALM_WEB_STATIC = oldEnv;
  const ep = await readEndpoint(root).catch(() => null);
  if (ep) {
    try {
      process.kill(ep.pid);
    } catch {
      /* 已退出 */
    }
    await waitForPidExit(ep.pid).catch(() => {});
  }
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(staticDir, { recursive: true, force: true }).catch(() => {});
});

describe("serve 动词", () => {
  it("拉起 daemon + endpoint.webPort 就绪 + 打开浏览器即退（--no-open 可关）", async () => {
    const opened: string[] = [];
    const code = await run(["--root", root, "serve"], {
      env: {},
      openBrowser: (url) => opened.push(url),
    });
    expect(code).toBe(0);
    const ep = await readEndpoint(root);
    expect(ep?.webPort).toBeGreaterThan(0);
    expect(opened).toEqual([`http://127.0.0.1:${ep?.webPort}`]);
    // HTTP 静态产物可访问（web-ui 构建产物伺服）
    const res = await fetch(`http://127.0.0.1:${ep?.webPort}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("toporealm-serve");
  }, 40_000);

  it("--no-open 不开浏览器；daemon 已在跑时复用同一 webPort（幂等）", async () => {
    const before = await readEndpoint(root);
    const opened: string[] = [];
    const code = await run(["--root", root, "serve", "--no-open"], {
      env: {},
      openBrowser: (url) => opened.push(url),
    });
    expect(code).toBe(0);
    expect(opened).toEqual([]);
    const after = await readEndpoint(root);
    expect(after?.webPort).toBe(before?.webPort);
    expect(after?.pid).toBe(before?.pid); // 没有第二个 daemon
  }, 20_000);

  it("--json 信封携带 url/pid/graphId", async () => {
    const lines: string[] = [];
    const code = await run(["--json", "--root", root, "serve", "--no-open"], {
      env: {},
      out: (s) => lines.push(s),
    });
    expect(code).toBe(0);
    const envelope = JSON.parse(lines.join("")) as {
      ok: boolean;
      data: { url: string; pid: number; graphId: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.graphId).toBe("g1");
    expect(envelope.data.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  }, 20_000);
});

// ---------- D34：纯 WS 模式守卫——无静态产物时 serve 拒绝开浏览器 ----------

let root2: string;

beforeAll(async () => {
  root2 = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-serve-guard-"));
  await fsp.mkdir(path.join(root2, ".toporealm", "daemon"), { recursive: true });
  await provisionGraph(root2, "g2");
});
afterAll(async () => {
  await fsp.rm(root2, { recursive: true, force: true }).catch(() => {});
});

describe("serve 静态守卫（手写 endpoint，pid=本进程=存活；不开真 daemon）", () => {
  const baseEndpoint = {
    transport: "pipe" as const,
    address: "\\\\.\\pipe\\toporealm-test-guard",
    pid: process.pid,
    instanceId: "test-instance",
    graphId: "g2",
    startedAt: new Date().toISOString(),
    webPort: 49999, // 无监听
  };

  it("webStatic=false：WEB_STATIC_MISSING，不开浏览器", async () => {
    await writeEndpoint(root2, { ...baseEndpoint, webStatic: false });
    const opened: string[] = [];
    const errs: string[] = [];
    const code = await run(["--root", root2, "serve", "--no-open"], {
      env: {},
      openBrowser: (url) => opened.push(url),
      err: (s) => errs.push(s),
    });
    expect(code).toBe(1);
    expect(opened).toEqual([]);
    expect(errs.join("")).toContain("WEB_STATIC_MISSING");
  });

  it("老 endpoint 无 webStatic 字段：HTTP 探测失败 → 同错误但提示重启 daemon", async () => {
    // webStatic: undefined 在 JSON 序列化时被丢弃——模拟 1.1.2 及以前的老 endpoint
    await writeEndpoint(root2, { ...baseEndpoint, webStatic: undefined });
    const errs: string[] = [];
    const code = await run(["--root", root2, "serve", "--no-open"], {
      env: {},
      openBrowser: () => {},
      err: (s) => errs.push(s),
    });
    expect(code).toBe(1);
    expect(errs.join("")).toContain("老 daemon");
  });

  it("webStatic=true：直接 announce（不探测）", async () => {
    await writeEndpoint(root2, { ...baseEndpoint, webStatic: true });
    const opened: string[] = [];
    const code = await run(["--root", root2, "serve"], {
      env: {},
      openBrowser: (url) => opened.push(url),
    });
    expect(code).toBe(0);
    expect(opened).toEqual(["http://127.0.0.1:49999"]);
  });
});
