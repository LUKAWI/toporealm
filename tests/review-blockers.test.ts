import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, runCliAsync } from "../src/cli/index.js";
import { createWorkspaceRuntimeSync, initializeWorkspaceGraph } from "../src/runtime/workspace.js";
import { listenToporealmServer } from "../src/server/index.js";

const roots: string[] = [];
const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("独立全图复核 blocker 回归", () => {
  it("validator 已声明时同步 seam 缺失即拒绝，生产 CLI 装载后也执行 validator", async () => {
    const root = temporaryRoot("toporealm-validator-unavailable-");
    const moduleRoot = join(root, "module");
    mkdirSync(join(moduleRoot, "validators"), { recursive: true });
    mkdirSync(join(moduleRoot, "runtime"), { recursive: true });
    writeFileSync(join(moduleRoot, "module.yaml"), [
      "format: toporealm.module/v1", "id: guarded", "namespace: guarded", "version: 0.1.0",
      "supports:", "  schemas: [1]", "contributes:", "  validators:",
      "    - id: deny", "      declaration: validators/deny.yaml", "runtime:", "  entry: runtime/index.js", "",
    ].join("\n"));
    writeFileSync(join(moduleRoot, "validators", "deny.yaml"), "mode: transition\n");
    writeFileSync(join(moduleRoot, "runtime", "index.js"), "export default { validate: () => [{ code: 'DENY', message: 'denied', severity: 'error' }] };\n");
    initializeWorkspaceGraph(root, "demo", {
      format: "toporealm.graph/v1", id: "demo",
      modules: [{ id: "guarded", namespace: "guarded", schema: 1 }],
      sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" },
    });
    mkdirSync(join(root, ".toporealm"), { recursive: true });
    writeFileSync(join(root, ".toporealm", "modules.yaml"), `bindings:\n  guarded:\n    source: path\n    path: ${JSON.stringify(moduleRoot)}\n`);
    writeFileSync(join(root, ".toporealm", "active"), "demo\n");

    expect(() => runCli(["apply", JSON.stringify({ mutations: [{ op: "upsert_object", object: { id: "x", kind: "plain", label: "X" } }] })], root))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    await expect(runCliAsync(["apply", JSON.stringify({ mutations: [{ op: "upsert_object", object: { id: "x", kind: "plain", label: "X" } }] })], root))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { diagnostics: expect.arrayContaining([expect.objectContaining({ code: "DENY" })]) } });
    expect(createWorkspaceRuntimeSync({ workspaceRoot: root, graphId: "demo" }).graph.read().snapshot)
      .toMatchObject({ revision: 0, objects: [] });
  });

  it("Workflow 0.1 relation 简写无损读取并传播兼容 notice", () => {
    const base = temporaryRoot("toporealm-workflow-compat-");
    const workspace = join(base, "workspace");
    cpSync(join(fixtures, "data", "workflow-slice"), workspace, { recursive: true });
    cpSync(join(fixtures, "data", "modules"), join(base, "modules"), { recursive: true });
    const read = createWorkspaceRuntimeSync({ workspaceRoot: workspace, graphId: "workflow-demo" }).graph.read();
    expect(read.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(read).toMatchObject({ complete: false, notice: { code: "LEGACY_SCHEMA_ADAPTED" } });
    expect(read.snapshot.relations.map((item) => item.id)).toContain("task-a-depends-task-b");
  });

  it("Server 切图按目标图装载 runtime 并返回完整性元数据", async () => {
    const base = temporaryRoot("toporealm-switch-runtime-");
    const workspace = join(base, "workspace");
    const moduleRoot = join(fixtures, "packages", "example-module");
    initializeWorkspaceGraph(workspace, "plain", { format: "toporealm.graph/v1", id: "plain", sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" } });
    initializeWorkspaceGraph(workspace, "module", { format: "toporealm.graph/v1", id: "module", modules: [{ id: "example", namespace: "example", schema: 1 }], sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" } });
    writeFileSync(join(workspace, ".toporealm", "modules.yaml"), `bindings:\n  example:\n    source: path\n    path: ${JSON.stringify(moduleRoot)}\n`);
    const server = await listenToporealmServer({ workspaceRoot: workspace, graphId: "plain" }, 0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有地址");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const switched = await fetch(`${baseUrl}/api/graph/switch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "module" }) }).then((response) => response.json()) as Record<string, unknown>;
      expect(switched).toMatchObject({ complete: false, diagnostics: expect.any(Array), snapshot: { manifest: { id: "module" } } });
      const modules = await fetch(`${baseUrl}/api/modules`).then((response) => response.json()) as { registryRevision: number };
      const actionResponse = await fetch(`${baseUrl}/api/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "example.create-card", registryRevision: modules.registryRevision, input: { title: "Card" } }) });
      expect(actionResponse.status).toBe(200);
      expect(await actionResponse.json()).toMatchObject({ kind: "mutation" });
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  it("图初始化经过 journal/history/audit 管线并留下 Core 审计", () => {
    const root = temporaryRoot("toporealm-init-pipeline-");
    runCli(["init", "demo"], root);
    const graphRoot = join(root, ".toporealm", "graphs", "demo");
    expect(existsSync(join(graphRoot, ".history", "index.json"))).toBe(true);
    expect(existsSync(join(graphRoot, ".toporealm-txn"))).toBe(false);
    const audit = readFileSync(join(graphRoot, ".audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(audit).toMatchObject([{ source: "core", fromRevision: -1, toRevision: 0, label: "初始化图", recoveryStatus: "committed" }]);
  });
});
