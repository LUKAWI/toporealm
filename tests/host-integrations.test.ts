import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/index.js";
import { BASE_SKILL_NAMES, syncHosts } from "../src/distribution/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex、Claude、Pi 原生投影", () => {
  it("生成彼此独立的原生 manifest、MCP 配置、Skills 与只读入场 hook", async () => {
    const root = mkdtempSync(join(tmpdir(), "toporealm-hosts-"));
    roots.push(root);
    runCli(["init", "demo"], root);
    const hostRoots = { codex: join(root, "codex"), claude: join(root, "claude"), pi: join(root, "pi") };
    const first = syncHosts({ workspaceRoot: root, hostRoots });
    const second = syncHosts({ workspaceRoot: root, hostRoots });
    expect(second).toEqual(first);

    const byHost = Object.fromEntries(first.map((item) => [item.host, item.projectionRoot])) as Record<string, string>;
    const codex = JSON.parse(readFileSync(join(byHost.codex, ".codex-plugin", "plugin.json"), "utf8"));
    expect(codex).toMatchObject({ name: "toporealm", skills: "./skills/", mcpServers: "./.mcp.json", interface: { displayName: "TopoRealm" } });
    const claude = JSON.parse(readFileSync(join(byHost.claude, ".claude-plugin", "plugin.json"), "utf8"));
    expect(claude).toMatchObject({ name: "toporealm", displayName: "TopoRealm", version: "0.1.0" });
    expect(JSON.parse(readFileSync(join(byHost.claude, "hooks", "hooks.json"), "utf8"))).toHaveProperty("hooks.SessionStart");
    const pi = JSON.parse(readFileSync(join(byHost.pi, "package.json"), "utf8"));
    expect(pi).toMatchObject({ name: "@lukawi/toporealm-pi", pi: { extensions: ["./index.js"], skills: ["./skills"] } });

    for (const projection of first) {
      const mcp = JSON.parse(readFileSync(join(projection.projectionRoot, ".mcp.json"), "utf8"));
      expect(mcp).toMatchObject({ mcpServers: { toporealm: { type: "stdio", command: "npx", args: ["-y", "@lukawi/toporealm@0.1.0", "mcp"] } } });
      for (const skill of BASE_SKILL_NAMES) expect(readFileSync(join(projection.projectionRoot, "skills", skill, "SKILL.md"), "utf8")).toContain(`name: ${skill}`);

      const client = new Client({ name: `${projection.host}-smoke`, version: "0.1.0" });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("dist/cli/main.js"), "--root", root, "--graph", "demo", "mcp"], cwd: projection.projectionRoot, stderr: "pipe" }));
      expect((await client.callTool({ name: "graph_list", arguments: {} })).structuredContent).toMatchObject({ currentId: "demo" });
      await client.close();
    }

    const userSkill = join(byHost.codex, "skills", "user-owned");
    mkdirSync(userSkill, { recursive: true });
    writeFileSync(join(userSkill, "SKILL.md"), "user owned", "utf8");
    syncHosts({ workspaceRoot: root, hostRoots });
    expect(readFileSync(join(userSkill, "SKILL.md"), "utf8")).toBe("user owned");
  }, 20_000);
});
