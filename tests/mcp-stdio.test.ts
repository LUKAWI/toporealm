import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/index.js";

const root = mkdtempSync(join(tmpdir(), "toporealm-mcp-"));
let client: Client;

beforeAll(async () => {
  runCli(["init", "demo"], root);
  runCli(["init", "module"], root);
  runCli(["--graph", "module", "apply", JSON.stringify({ mutations: [{ op: "patch_manifest", patch: { modules: [{ id: "example", namespace: "example", schema: 1 }] } }] })], root);
  mkdirSync(join(root, ".toporealm"), { recursive: true });
  writeFileSync(join(root, ".toporealm", "modules.yaml"), `bindings:\n  example:\n    source: path\n    path: ${JSON.stringify(resolve("tests/fixtures/packages/example-module"))}\n`);
  client = new Client({ name: "toporealm-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli/main.js"), "--root", root, "--graph", "demo", "mcp"],
    stderr: "pipe",
  });
  await client.connect(transport);
}, 20_000);

afterAll(async () => {
  await client?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("TopoRealm stdio MCP", () => {
  it("通过官方 StdioClientTransport 握手、列举并调用结构化工具", async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "graph_list", "graph_read", "graph_create", "graph_select", "graph_validate",
      "graph_apply", "graph_undo", "graph_redo", "module_status", "action_list", "action_execute",
    ]));
    expect(names).not.toEqual(expect.arrayContaining(["module_add", "module_remove", "host_sync"]));

    const read = await client.callTool({ name: "graph_read", arguments: {} });
    expect(read.structuredContent).toMatchObject({ manifest: { id: "demo" }, revision: 0 });
  });

  it("把 MutationPlan 交给 Core，并以稳定结构返回旧 revision 冲突", async () => {
    const applied = await client.callTool({
      name: "graph_apply",
      arguments: { plan: { expectedRevision: 0, mutations: [{ op: "upsert_object", object: { id: "note-1", kind: "note", label: "Note" } }] } },
    });
    expect(applied.structuredContent).toMatchObject({ snapshot: { revision: 1 } });

    const stale = await client.callTool({
      name: "graph_apply",
      arguments: { plan: { expectedRevision: 0, mutations: [{ op: "delete_object", id: "note-1" }] } },
    });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
  });

  it("切图后按目标图重装 ModuleRuntime 并可执行动作", async () => {
    const selected = await client.callTool({ name: "graph_select", arguments: { id: "module" } });
    expect(selected.structuredContent).toMatchObject({ currentId: "module" });
    const modules = await client.callTool({ name: "module_status", arguments: {} });
    const registryRevision = (modules.structuredContent as { registryRevision: number }).registryRevision;
    const action = await client.callTool({
      name: "action_execute",
      arguments: { reference: { operation: "example.create-card", registryRevision }, input: { id: "mcp-card", label: "MCP Card" } },
    });
    expect(action.isError).not.toBe(true);
    expect(action.structuredContent).toMatchObject({ kind: "mutation", mutation: { snapshot: { objects: [{ id: "mcp-card" }] } } });
  });
});
