import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GraphStore } from "../src/core/index.js";
import { listenToporealmServer } from "../src/server/index.js";
import { createMcpHandlers } from "../src/mcp/index.js";
import { createExplorationRuntime, createResearchRuntime } from "../src/modules/index.js";
import { ActionExecutor, GraphActivator, WorkspaceModuleResolver, applyRegisteredPlan, discoverActions } from "../src/module-sdk/index.js";
import { WebGraphModel } from "../src/web/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copiedFixture(): { root: string; store: GraphStore } {
  const base = mkdtempSync(join(tmpdir(), "toporealm-m3-"));
  roots.push(base);
  const root = join(base, "workspace");
  mkdirSync(root, { recursive: true });
  const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/research-vertical");
  cpSync(fixture, root, { recursive: true });
  cpSync(resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/modules"), join(base, "modules"), { recursive: true });
  return { root, store: GraphStore.fromWorkspace(root, "research-demo") };
}

describe("offline research/exploration vertical slice", () => {
  it("在同一图中独立装载两个模块，并用离线动作生成可追溯关系", async () => {
    const { root, store } = copiedFixture();
    const registry = new GraphActivator(new WorkspaceModuleResolver(root)).activate(store.read());
    expect(registry.modules.map((module) => module.status)).toEqual(["available", "available"]);
    const actions = new ActionExecutor(store, registry, {
      research: createResearchRuntime(),
      exploration: createExplorationRuntime(),
    });
    const reference = discoverActions(registry, "question-1").find((action) => action.operation === "research.expand-question");
    if (!reference) throw new Error("缺少 research.expand-question 动作");
    const initial = store.read();
    const web = new WebGraphModel(initial);
    const crossModule = applyRegisteredPlan(store, registry, {
      mutations: [
        { op: "upsert_object", object: { id: "unknown-1", kind: "exploration.unknown", label: "待核对", data: { status: "open" } } },
        { op: "upsert_object", object: { id: "question-1", kind: "research.question", label: "增量图更新如何保持可追溯？", data: { status: "active" } } },
      ],
    });
    web.applyPatch(crossModule.patch);
    const result = await actions.execute(reference, { depth: 1 });
    expect(result.kind).toBe("mutation");
    if (result.kind !== "mutation") return;
    expect(result.mutation.snapshot.objects.map((object) => object.kind)).toEqual(["research.question", "research.claim", "research.source", "exploration.unknown"]);
    expect(result.mutation.snapshot.relations).toHaveLength(2);
    web.applyPatch(result.mutation.patch);
    expect(web.snapshot.revision).toBe(result.mutation.snapshot.revision);
    expect(web.snapshot.relations).toHaveLength(2);
  });

  it("MCP execute_action 与普通 graph_apply 使用同一 MutationPlan 入口", async () => {
    const { root, store } = copiedFixture();
    const registry = new GraphActivator(new WorkspaceModuleResolver(root)).activate(store.read());
    const actions = new ActionExecutor(store, registry, { exploration: createExplorationRuntime(), research: createResearchRuntime() });
    const handlers = createMcpHandlers(store, actions);
    const reference = discoverActions(registry).find((action) => action.operation === "exploration.open-unknown");
    if (!reference) throw new Error("缺少 exploration.open-unknown 动作");
    const result = await handlers.execute_action(reference, { label: "需要进一步确认" });
    expect(result.kind).toBe("mutation");
    expect(store.read().objects.some((object) => object.kind === "exploration.unknown")).toBe(true);
  });

  it("移除模块时无损读取仍可用，恢复模块后注册快照重新可用", () => {
    const { root, store } = copiedFixture();
    const explorationPath = join(dirname(root), "modules", "exploration");
    // path 绑定指向 fixtures/modules；只删除图声明的绑定目标来模拟缺失模块。
    rmSync(explorationPath, { recursive: true, force: true });
    const degraded = new GraphActivator(new WorkspaceModuleResolver(root)).activate(store.read());
    expect(degraded.modules.find((module) => module.id === "research")?.status).toBe("available");
    expect(degraded.modules.find((module) => module.id === "exploration")?.status).toBe("unavailable");
    expect(store.read().objects[0]?.data).toEqual({ status: "open" });
    cpSync(resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/modules/exploration"), explorationPath, { recursive: true });
    expect(new GraphActivator(new WorkspaceModuleResolver(root)).activate(store.read()).modules.find((module) => module.id === "exploration")?.status).toBe("available");
  });

  it("Server 从模块声明发现动作，并在运行时失败时返回稳定错误边界", async () => {
    const { store } = copiedFixture();
    const server = await listenToporealmServer(store);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有地址");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const modules = await fetch(`${base}/api/modules`).then((response) => response.json()) as { operations: Array<{ fullId: string }>; ui: Record<string, unknown> };
      expect(modules.operations.map((operation) => operation.fullId)).toContain("research.expand-question");
      expect(modules.ui).toHaveProperty("research");
      const action = await fetch(`${base}/api/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "research.expand-question", target: "question-1", input: { depth: 1 } }),
      }).then((response) => response.json()) as { kind: string; mutation?: { snapshot: { revision: number } } };
      expect(action.kind).toBe("mutation");
      expect(action.mutation?.snapshot.revision).toBe(1);

      const failedResponse = await fetch(`${base}/api/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "research.expand-question", target: "question-1", input: { depth: 9 } }),
      });
      expect(failedResponse.status).toBe(400);
      expect(await failedResponse.json()).toMatchObject({ error: { code: "RUNTIME_FAILED" } });
      expect(store.read().revision).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
