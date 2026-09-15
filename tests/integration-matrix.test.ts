import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { executeCli, runCli } from "../src/cli/index.js";
import { createWorkspaceRuntimeSync } from "../src/runtime/index.js";
import { listenToporealmServer } from "../src/server/index.js";
import { WebGraphModel } from "../src/web/index.js";
import type { GraphSnapshot, MutationPlan } from "../src/core/index.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "toporealm-matrix-"));
  roots.push(root);
  runCli(["init", "demo"], root);
  return root;
}

const plan: MutationPlan = {
  expectedRevision: 0,
  label: "跨表面单提交",
  mutations: [
    { op: "upsert_object", object: { id: "kept", kind: "plain", label: "v1" } },
    { op: "upsert_object", object: { id: "kept", kind: "plain", label: "v2", meta: { pinned: true } } },
    { op: "upsert_object", object: { id: "temporary", kind: "plain", label: "待删除" } },
    { op: "delete_object", id: "temporary" },
  ],
};

type ResultShape = { revision: number; diagnostics: unknown[]; complete: boolean; notice: unknown };
function shape(value: Record<string, unknown>): ResultShape {
  const snapshot = value.snapshot as { revision?: number } | undefined;
  return {
    revision: typeof value.revision === "number" ? value.revision : snapshot?.revision ?? -1,
    diagnostics: Array.isArray(value.diagnostics) ? value.diagnostics : [],
    complete: value.complete === true,
    notice: value.notice ?? null,
  };
}

function auditCount(root: string): number {
  const text = readFileSync(join(root, ".toporealm", "graphs", "demo", ".audit.jsonl"), "utf8").trim();
  return text ? text.split(/\r?\n/).length : 0;
}

describe("Core/CLI/MCP/Server/Web 同场景矩阵", () => {
  it("同一 create/update/delete MutationPlan 只形成一次同构提交，并稳定拒绝旧 revision", async () => {
    const coreRoot = workspace();
    const cliRoot = workspace();
    const mcpRoot = workspace();
    const serverRoot = workspace();
    const results: Record<string, ResultShape> = {};

    const core = createWorkspaceRuntimeSync({ workspaceRoot: coreRoot, graphId: "demo" });
    results.core = shape(core.graph.commit(plan) as unknown as Record<string, unknown>);
    expect(() => core.graph.commit(plan)).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
    expect(core.graph.validate()).toMatchObject({ revision: 1, complete: true, diagnostics: [] });

    results.cli = shape(JSON.parse(runCli(["apply", JSON.stringify(plan)], cliRoot)) as Record<string, unknown>);
    expect(executeCli(["apply", JSON.stringify(plan)], { cwd: cliRoot })).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("REVISION_CONFLICT") });
    expect(JSON.parse(runCli(["validate", "--complete"], cliRoot))).toMatchObject({ ok: true, complete: true, diagnostics: [] });

    const client = new Client({ name: "integration-matrix", version: "test" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("dist/cli/main.js"), "--root", mcpRoot, "--graph", "demo", "mcp"], stderr: "pipe" }));
    try {
      const applied = await client.callTool({ name: "graph_apply", arguments: { plan } });
      results.mcp = shape(applied.structuredContent as Record<string, unknown>);
      const stale = await client.callTool({ name: "graph_apply", arguments: { plan } });
      expect(stale).toMatchObject({ isError: true, structuredContent: { error: { code: "REVISION_CONFLICT" } } });
      expect((await client.callTool({ name: "graph_validate", arguments: { mode: "complete" } })).structuredContent).toMatchObject({ ok: true, complete: true, diagnostics: [] });
    } finally {
      await client.close();
    }

    const server = await listenToporealmServer({ workspaceRoot: serverRoot, graphId: "demo" }, 0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server 未获得端口");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const initial = await fetch(`${base}/api/graph`).then((response) => response.json()) as GraphSnapshot;
      const web = new WebGraphModel(initial);
      const response = await fetch(`${base}/api/mutations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(plan) });
      const applied = await response.json() as Record<string, unknown>;
      results.server = shape(applied);
      const webSnapshot = web.applyPatch(applied.patch as never);
      results.web = { ...shape(applied), revision: webSnapshot.revision };
      const stale = await fetch(`${base}/api/mutations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(plan) });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
      expect(await fetch(`${base}/api/validate?mode=complete`).then((item) => item.json())).toMatchObject({ ok: true, complete: true, diagnostics: [] });
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }

    expect(results).toEqual(Object.fromEntries(["core", "cli", "mcp", "server", "web"].map((surface) => [surface, { revision: 1, diagnostics: [], complete: true, notice: null }])));
    for (const root of [coreRoot, cliRoot, mcpRoot, serverRoot]) {
      // 初始化自身也是一条受控 Core 提交，随后 MutationPlan 只增加一条审计。
      expect(auditCount(root)).toBe(2);
      const snapshot = createWorkspaceRuntimeSync({ workspaceRoot: root, graphId: "demo" }).graph.read().snapshot;
      expect(snapshot.objects).toEqual([{ id: "kept", kind: "plain", label: "v2", meta: { pinned: true } }]);
    }
  }, 20_000);

  it("外部 YAML 编辑经各入口形成同构 notice、新基线与单条吸收审计", async () => {
    const rootsBySurface = { core: workspace(), cli: workspace(), mcp: workspace(), server: workspace() };
    const prepareExternalEdit = (root: string) => {
      runCli(["apply", JSON.stringify({ expectedRevision: 0, mutations: [{ op: "upsert_object", object: { id: "note", kind: "plain", label: "Core 标题" } }] })], root);
      const path = join(root, ".toporealm", "graphs", "demo", "objects", "note.yaml");
      writeFileSync(path, readFileSync(path, "utf8").replace("Core 标题", "外部标题"), "utf8");
    };
    Object.values(rootsBySurface).forEach(prepareExternalEdit);
    const results: Record<string, ResultShape> = {};

    results.core = shape(createWorkspaceRuntimeSync({ workspaceRoot: rootsBySurface.core, graphId: "demo" }).graph.read() as unknown as Record<string, unknown>);
    results.cli = shape(JSON.parse(runCli(["read"], rootsBySurface.cli)) as Record<string, unknown>);

    const client = new Client({ name: "external-matrix", version: "test" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("dist/cli/main.js"), "--root", rootsBySurface.mcp, "--graph", "demo", "mcp"], stderr: "pipe" }));
    try {
      results.mcp = shape((await client.callTool({ name: "graph_read", arguments: {} })).structuredContent as Record<string, unknown>);
    } finally {
      await client.close();
    }

    const server = await listenToporealmServer({ workspaceRoot: rootsBySurface.server, graphId: "demo" }, 0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server 未获得端口");
    try {
      const read = await fetch(`http://127.0.0.1:${address.port}/api/graph`).then((item) => item.json()) as Record<string, unknown>;
      results.server = shape(read);
      results.web = shape(read);
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }

    for (const result of Object.values(results)) {
      expect(result).toMatchObject({ revision: 2, diagnostics: [], complete: true, notice: { code: "EXTERNAL_EDIT_ABSORBED", fromRevision: 1, toRevision: 2 } });
    }
    for (const root of Object.values(rootsBySurface)) {
      // 初始化 + 原始提交 + 外部吸收，各一条审计。
      expect(auditCount(root)).toBe(3);
      const audit = readFileSync(join(root, ".toporealm", "graphs", "demo", ".audit.jsonl"), "utf8");
      expect(audit.match(/"recoveryStatus":"absorbed"/g)).toHaveLength(1);
    }
  }, 20_000);
});
