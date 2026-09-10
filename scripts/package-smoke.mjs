import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repository = resolve(".");
const temporary = mkdtempSync(join(tmpdir(), "toporealm-package-smoke-"));
const installRoot = join(temporary, "consumer");
mkdirSync(installRoot, { recursive: true });
writeFileSync(join(installRoot, "package.json"), JSON.stringify({ private: true, type: "module" }), "utf8");

const npmCli = [
  process.env.npm_execpath,
  join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
].find((candidate) => candidate && existsSync(candidate));
if (!npmCli) throw new Error("找不到 npm CLI。");
const npm = (...args) => execFileSync(process.execPath, [npmCli, ...args], { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
let serve;
let client;

try {
  const packed = JSON.parse(npm("pack", "--ignore-scripts", "--json", "--pack-destination", temporary))[0];
  assert.equal(packed.name, "@lukawi/toporealm");
  const paths = packed.files.map((file) => file.path);
  for (const required of ["dist/cli/main.js", "dist/web-assets/index.html", "dist/integrations/skills/toporealm/SKILL.md", "LICENSE", "README.md"]) {
    assert(paths.includes(required), `tarball 缺少 ${required}`);
  }
  assert(!paths.some((path) => /(^|\/)(src|tests|\.graph|web-ui)(\/|$)|research|exploration|workflow|example-module/.test(path)), "tarball 包含源码、运行图或领域 fixture");

  const tarball = join(temporary, packed.filename);
  execFileSync(process.execPath, [npmCli, "install", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund", tarball], {
    cwd: installRoot,
    stdio: "inherit",
    timeout: 120_000,
  });
  const packageRoot = join(installRoot, "node_modules", "@lukawi", "toporealm");
  const cli = join(packageRoot, "dist", "cli", "main.js");
  assert(existsSync(cli));
  const installedPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(installedPackage.license, "MIT");
  assert.equal(installedPackage.engines.node, ">=20");
  assert.equal(installedPackage.bin.toporealm, "dist/cli/main.js");
  assert(readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node"));
  execFileSync(process.execPath, ["--input-type=module", "--eval", "await import('@lukawi/toporealm'); await import('@lukawi/toporealm/core'); await import('@lukawi/toporealm/module-sdk')"], { cwd: installRoot, stdio: "pipe" });
  const help = execFileSync(process.execPath, [cli, "help"], { cwd: installRoot, encoding: "utf8" });
  assert.match(help, /TopoRealm CLI/);
  execFileSync(process.execPath, [cli, "--root", installRoot, "init", "demo"], { cwd: temporary, stdio: "pipe" });

  serve = spawn(process.execPath, [cli, "--root", installRoot, "--graph", "demo", "serve", "--port", "0"], { cwd: temporary, stdio: ["ignore", "pipe", "pipe"] });
  const line = await new Promise((resolveLine, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("安装包 serve 未报告地址")), 10_000);
    serve.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline >= 0) { clearTimeout(timer); resolveLine(output.slice(0, newline)); }
    });
    serve.once("error", reject);
  });
  const started = JSON.parse(line);
  const html = await fetch(started.url).then((response) => response.text());
  assert.match(html, /TopoRealm/);
  const serveExited = new Promise((resolveExit) => serve.once("exit", resolveExit));
  serve.kill();
  await serveExited;
  serve = undefined;

  client = new Client({ name: "package-smoke", version: "0.1.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "--root", installRoot, "--graph", "demo", "mcp"], cwd: temporary, stderr: "pipe" }));
  const tools = await client.listTools();
  assert(tools.tools.some((tool) => tool.name === "graph_read"));
  await client.close();
  client = undefined;

  process.stdout.write(`${JSON.stringify({ package: packed.name, version: packed.version, entries: packed.entryCount, help: true, serve: true, mcp: true })}\n`);
} finally {
  if (client) await client.close();
  if (serve && serve.exitCode === null) {
    const exited = new Promise((resolveExit) => serve.once("exit", resolveExit));
    serve.kill();
    await exited;
  }
  rmSync(temporary, { recursive: true, force: true });
}
