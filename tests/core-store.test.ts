import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraphStore, RevisionConflictError } from "../src/core/index.js";
import { runCli } from "../src/cli/index.js";
import { createMcpHandlers } from "../src/mcp/index.js";
import { listenToporealmServer } from "../src/server/index.js";
import { WebGraphModel } from "../src/web/index.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureStore(): GraphStore {
  const root = mkdtempSync(join(tmpdir(), "toporealm-m1-"));
  temporaryRoots.push(root);
  const store = GraphStore.fromWorkspace(root, "demo");
  store.initialize({
    format: "toporealm.graph/v1",
    id: "demo",
    label: "M1 demo",
    sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" },
  });
  return store;
}

const person = (id: string, label: string) => ({ id, kind: "person", label });

describe("GraphStore", () => {
  it("以一个 MutationPlan 原子写入对象和关系，并生成 revision patch", () => {
    const store = fixtureStore();
    const result = store.apply({
      label: "创建关系",
      expectedRevision: 0,
      mutations: [
        { op: "upsert_object", object: person("alice", "Alice") },
        { op: "upsert_object", object: person("bob", "Bob") },
        { op: "upsert_relation", relation: { id: "knows-1", kind: "knows", source: "alice", target: "bob", direction: "directed" } },
      ],
    });
    expect(result.snapshot.revision).toBe(1);
    expect(result.patch.objects.added.map((object) => object.id)).toEqual(["alice", "bob"]);
    expect(result.patch.relations.added.map((relation) => relation.id)).toEqual(["knows-1"]);
    expect(store.read().relations).toHaveLength(1);
  });

  it("持久化线性 undo/redo，并拒绝旧 revision 覆盖", () => {
    const store = fixtureStore();
    store.apply({ mutations: [{ op: "upsert_object", object: person("alice", "Alice") }] });
    store.apply({ mutations: [{ op: "upsert_object", object: person("alice", "Alice 2") }] });
    const undone = store.undo(2);
    expect(undone.snapshot.objects[0]?.label).toBe("Alice");
    const restarted = new GraphStore(store.graphRoot);
    const redone = restarted.redo(3);
    expect(redone.snapshot.objects[0]?.label).toBe("Alice 2");
    expect(redone.snapshot.revision).toBe(4);
    expect(() => restarted.apply({ expectedRevision: 3, mutations: [{ op: "upsert_object", object: person("alice", "stale") }] })).toThrow(RevisionConflictError);
  });

  it("让 CLI、MCP 和 Web patch 共用同一 Core 事实", () => {
    const store = fixtureStore();
    const workspace = dirname(dirname(dirname(store.graphRoot)));
    const web = new WebGraphModel(store.read());
    const handlers = createMcpHandlers(store);
    const mcpResult = handlers.graph_apply({ mutations: [{ op: "upsert_object", object: person("alice", "Alice") }] });
    const cliRead = JSON.parse(runCli(["read", "demo"], workspace));
    web.applyPatch(mcpResult.patch);
    expect(web.snapshot.revision).toBe(mcpResult.snapshot.revision);
    expect(cliRead.revision).toBe(mcpResult.snapshot.revision);
    expect(web.snapshot.objects.map((object) => object.id)).toEqual(["alice"]);
  });

  it("通过 Server HTTP 适配器读取并撤销同一事务", async () => {
    const store = fixtureStore();
    store.apply({ mutations: [{ op: "upsert_object", object: person("alice", "Alice") }] });
    const server = await listenToporealmServer(store);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有地址");
    try {
      const graph = await fetch(`http://127.0.0.1:${address.port}/graph`).then((response) => response.json()) as { revision: number };
      expect(graph.revision).toBe(1);
      const undone = await fetch(`http://127.0.0.1:${address.port}/undo`, { method: "POST", body: "{}" }).then((response) => response.json()) as { snapshot: { revision: number; objects: unknown[] } };
      expect(undone.snapshot.revision).toBe(2);
      expect(undone.snapshot.objects).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("通过浏览器协议暴露历史、基础校验并拒绝过期 revision", async () => {
    const store = fixtureStore();
    const server = await listenToporealmServer(store);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有地址");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const initialHistory = await fetch(`${base}/api/history`).then((response) => response.json()) as { canUndo: boolean; canRedo: boolean };
      expect(initialHistory).toEqual({ canUndo: false, canRedo: false });
      const validation = await fetch(`${base}/api/validate`).then((response) => response.json()) as { ok: boolean; complete: boolean };
      expect(validation).toMatchObject({ ok: true, complete: false });

      const appliedResponse = await fetch(`${base}/api/mutations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 0, mutations: [{ op: "upsert_object", object: person("alice", "Alice") }] }),
      });
      expect(appliedResponse.status).toBe(200);
      const applied = await appliedResponse.json() as { snapshot: { revision: number }; patch: { fromRevision: number; toRevision: number } };
      expect(applied.patch).toEqual(expect.objectContaining({ fromRevision: 0, toRevision: 1 }));
      expect(applied.snapshot.revision).toBe(1);

      const conflictResponse = await fetch(`${base}/api/mutations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 0, mutations: [{ op: "upsert_object", object: person("bob", "Bob") }] }),
      });
      expect(conflictResponse.status).toBe(409);
      expect(await conflictResponse.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
      expect(store.read().objects.map((object) => object.id)).toEqual(["alice"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("通过 Server 删除对象时沿用 Core 的关联关系清理语义", async () => {
    const store = fixtureStore();
    store.apply({ mutations: [
      { op: "upsert_object", object: person("alice", "Alice") },
      { op: "upsert_object", object: person("bob", "Bob") },
      { op: "upsert_relation", relation: { id: "knows-1", kind: "knows", source: "alice", target: "bob", direction: "directed" } },
    ] });
    const server = await listenToporealmServer(store);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有地址");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/mutations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1, mutations: [{ op: "delete_object", id: "alice" }] }),
      });
      expect(response.status).toBe(200);
      const result = await response.json() as { snapshot: { objects: unknown[]; relations: unknown[] } };
      expect(result.snapshot.objects).toHaveLength(1);
      expect(result.snapshot.relations).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("通过显式 graph ID 列表和切换入口保持快照、历史与校验一致", async () => {
    const store = fixtureStore();
    const workspaceRoot = dirname(dirname(dirname(store.graphRoot)));
    const other = GraphStore.fromWorkspace(workspaceRoot, "other");
    other.initialize({ format: "toporealm.graph/v1", id: "other", label: "Other graph", sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" } });
    const server = await listenToporealmServer(store);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有地址");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const listed = await fetch(`${base}/api/graphs`).then((response) => response.json()) as { currentId: string; graphs: Array<{ id: string }> };
      expect(listed.currentId).toBe("demo");
      expect(listed.graphs.map((graph) => graph.id)).toEqual(["demo", "other"]);
      const switchedResponse = await fetch(`${base}/api/graph/switch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "other" }) });
      expect(switchedResponse.status).toBe(200);
      const switched = await switchedResponse.json() as { snapshot: { manifest: { id: string }; revision: number }; history: { canUndo: boolean; canRedo: boolean } };
      expect(switched.snapshot).toMatchObject({ manifest: { id: "other" }, revision: 0 });
      expect(switched.history).toEqual({ canUndo: false, canRedo: false });
      const complete = await fetch(`${base}/api/validate?mode=complete`).then((response) => response.json()) as { ok: boolean; complete: boolean };
      expect(complete).toMatchObject({ ok: true, complete: true });
      const modules = await fetch(`${base}/api/modules`).then((response) => response.json()) as { registryRevision: number; modules: unknown[] };
      expect(modules).toMatchObject({ registryRevision: 0, modules: [] });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
