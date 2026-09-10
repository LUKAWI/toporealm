import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repository = resolve(".");
const temporary = mkdtempSync(join(tmpdir(), "toporealm-registry-smoke-"));
const root = join(temporary, "consumer");
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }), "utf8");
const npmCli = [
  process.env.npm_execpath,
  join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
].find((candidate) => candidate && existsSync(candidate));
if (!npmCli) throw new Error("找不到 npm CLI。");
execFileSync(process.execPath, [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund", "@lukawi/toporealm@0.1.0"], {
  cwd: root,
  stdio: "inherit",
  timeout: 120_000,
});
const packageRoot = join(root, "node_modules", "@lukawi", "toporealm");
const cli = join(packageRoot, "dist", "cli", "main.js");
assert(existsSync(cli), `缺少安装包 CLI: ${cli}`);
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
assert.equal(manifest.name, "@lukawi/toporealm");
assert.equal(manifest.version, "0.1.0");
assert.equal(manifest.license, "MIT");
process.chdir(root);
await import("@lukawi/toporealm");
await import("@lukawi/toporealm/core");
await import("@lukawi/toporealm/module-sdk");

const help = execFileSync(process.execPath, [cli, "help"], { cwd: root, encoding: "utf8" });
assert.match(help, /TopoRealm CLI/);
execFileSync(process.execPath, [cli, "--root", root, "init", "demo"], { cwd: root, stdio: "pipe" });

let serve;
let client;
try {
  serve = spawn(process.execPath, [cli, "--root", root, "--graph", "demo", "serve", "--port", "0"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("registry 安装包 serve 未报告地址")), 10000);
    serve.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        resolve(output.slice(0, newline));
      }
    });
    serve.once("error", reject);
  });
  const started = JSON.parse(line);
  const response = await fetch(started.url);
  assert.equal(response.ok, true);
  assert.match(await response.text(), /TopoRealm/);
  const exited = new Promise((resolve) => serve.once("exit", resolve));
  serve.kill();
  await exited;
  serve = undefined;

  client = new Client({ name: "registry-smoke", version: "0.1.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [cli, "--root", root, "--graph", "demo", "mcp"],
    cwd: root,
    stderr: "pipe",
  }));
  const listed = await client.listTools();
  assert(listed.tools.some((tool) => tool.name === "graph_read"));
  await client.close();
  client = undefined;
  process.stdout.write(`${JSON.stringify({ package: manifest.name, version: manifest.version, help: true, serve: true, mcp: true })}\n`);
} finally {
  if (client) await client.close();
  if (serve && serve.exitCode === null) serve.kill();
  process.chdir(repository);
  try {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    process.stderr.write(`临时目录清理被 Windows 文件锁延迟：${temporary}\n`);
  }
}
