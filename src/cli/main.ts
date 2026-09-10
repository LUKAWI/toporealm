#!/usr/bin/env node
import { executeCli, runActionCli, runCli } from "./index.js";
import { startToporealmMcpStdio } from "../mcp/index.js";
import { GraphStore } from "../core/index.js";
import { listenToporealmServer } from "../server/index.js";
import { spawn } from "node:child_process";

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

const argv = process.argv.slice(2);
if (argv.includes("action")) {
  try {
    process.stdout.write(`${await runActionCli(argv)}\n`);
  } catch (error) {
    const value = error && typeof error === "object" && "code" in error
      ? { code: String(error.code), message: error instanceof Error ? error.message : String(error) }
      : { code: "CLI_ERROR", message: error instanceof Error ? error.message : String(error) };
    process.stderr.write(`${JSON.stringify({ error: value })}\n`);
    process.exitCode = 1;
  }
} else if (argv.includes("mcp")) {
  try {
    const target = JSON.parse(runCli(argv)) as { workspaceRoot: string; graphId: string };
    await startToporealmMcpStdio(target);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else if (argv.includes("serve")) {
  try {
    const target = JSON.parse(runCli(argv)) as { workspaceRoot: string; graphId: string; host: string; port: number; open: boolean };
    const server = await listenToporealmServer(GraphStore.fromWorkspace(target.workspaceRoot, target.graphId), target.port, target.host);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Web Server 未获得 TCP 地址。");
    const url = `http://${target.host}:${address.port}/`;
    process.stdout.write(`${JSON.stringify({ url, graphId: target.graphId })}\n`);
    if (target.open) openBrowser(url);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  const result = executeCli(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
