import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { GraphStore, validateGraph } from "../src/core/index.js";
import { installModule, syncHosts, uninstallModule } from "../src/distribution/index.js";
import { GraphActivator, WorkspaceModuleResolver, type ModuleActionRuntime } from "../src/module-sdk/index.js";
import { listenToporealmServer } from "../src/server/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("外部 example 模块生态", () => {
  it("贯通独立安装、Web/MCP、MutationPlan、宿主投影、卸载与无损降级", async () => {
    const root = mkdtempSync(join(tmpdir(), "toporealm-ecosystem-"));
    roots.push(root);
    const packageRoot = resolve("tests/fixtures/packages/example-module");
    const store = GraphStore.fromWorkspace(root, "demo");
    store.initialize({ format: "toporealm.graph/v1", id: "demo", modules: [{ id: "example", namespace: "example", schema: 1 }], sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" } });

    const installed = installModule(packageRoot, { workspaceRoot: root });
    expect(installed.id).toBe("example");
    const resolver = new WorkspaceModuleResolver(root);
    const registry = new GraphActivator(resolver).activate(store.read());
    expect(registry.modules).toMatchObject([{ id: "example", status: "available" }]);
    expect(registry.operations.map((item) => item.fullId)).toEqual(["example.create-card"]);

    const runtimeModule = await import(pathToFileURL(join(installed.root, "runtime/index.js")).href) as { default: ModuleActionRuntime };
    const server = await listenToporealmServer(store, 0, "127.0.0.1", { runtimes: { example: runtimeModule.default } });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有地址");
    try {
      const modules = await fetch(`http://127.0.0.1:${address.port}/api/modules`).then((response) => response.json()) as { ui: Record<string, unknown>; operations: Array<{ fullId: string }> };
      expect(modules.ui).toHaveProperty("example");
      expect(modules.operations.map((item) => item.fullId)).toEqual(["example.create-card"]);
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }

    const client = new Client({ name: "ecosystem-test", version: "0.1.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("dist/cli/main.js"), "--root", root, "--graph", "demo", "mcp"], stderr: "pipe" }));
    try {
      const actions = await client.callTool({ name: "action_list", arguments: {} });
      const discovered = (actions.structuredContent as { result: Array<{ operation: string; registryRevision: number }> }).result;
      expect(discovered.map((item) => item.operation)).toEqual(["example.create-card"]);
      const executed = await client.callTool({ name: "action_execute", arguments: { reference: discovered[0], input: { id: "card-1", label: "Example card" } } });
      expect(executed.structuredContent).toMatchObject({ kind: "mutation", mutation: { snapshot: { revision: 1 } } });
    } finally {
      await client.close();
    }
    expect(store.read().objects).toMatchObject([{ id: "card-1", kind: "example.card", label: "Example card" }]);

    const hostRoots = { codex: join(root, ".codex"), claude: join(root, ".claude"), pi: join(root, ".pi") };
    syncHosts({ workspaceRoot: root, hostRoots });
    const projected = join(root, ".codex", ".toporealm", "generated", "codex", "skills", "example", "SKILL.md");
    expect(readFileSync(projected, "utf8")).toContain("example.card");

    uninstallModule("example", { workspaceRoot: root });
    expect(store.read().objects[0]?.data).toMatchObject({ source: "external-fixture" });
    const degraded = validateGraph(store.read(), new GraphActivator(new WorkspaceModuleResolver(root)).activate(store.read()));
    expect(degraded).toMatchObject({ ok: true, complete: false, warnings: [{ code: "MODULE_UNAVAILABLE" }] });
    syncHosts({ workspaceRoot: root, hostRoots });
    expect(existsSync(dirname(projected))).toBe(false);
  }, 30_000);
});
