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
});
