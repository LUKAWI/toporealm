import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/index.js";

const root = mkdtempSync(join(tmpdir(), "toporealm-web-product-"));
let child: ChildProcessWithoutNullStreams | undefined;

beforeAll(() => {
  runCli(["init", "demo"], root);
});

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolveExit) => child?.once("exit", () => resolveExit()));
    child.kill();
    await exited;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("打包 Web 产品运行时", () => {
  it("从 dist 自带资源启动 toporealm serve，不依赖当前目录的 web-ui", async () => {
    expect(existsSync(resolve("dist/web-assets/index.html"))).toBe(true);
    child = spawn(process.execPath, [resolve("dist/cli/main.js"), "--root", root, "--graph", "demo", "serve", "--port", "0"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const line = await new Promise<string>((resolveLine, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("serve 未报告监听地址")), 10_000);
      child?.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const newline = output.indexOf("\n");
        if (newline >= 0) {
          clearTimeout(timer);
          resolveLine(output.slice(0, newline));
        }
      });
      child?.once("error", reject);
      child?.once("exit", (code) => reject(new Error(`serve 提前退出：${code}`)));
    });
    const started = JSON.parse(line) as { url: string };
    const html = await fetch(started.url).then((response) => response.text());
    expect(html).toContain("TopoRealm");
    expect(html).toContain("--glass-strong");
    const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
    expect(asset).toBeTruthy();
    expect((await fetch(new URL(asset ?? "", started.url))).status).toBe(200);
  }, 20_000);
});
