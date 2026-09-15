import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedGraph } from "../src/core/managed.js";
import { GraphStore } from "../src/core/store.js";
import type { GraphRegistrySnapshot } from "../src/module-sdk/registry.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "toporealm-managed-"));
  roots.push(root);
  const store = GraphStore.fromWorkspace(root, "demo");
  store.initialize({ format: "toporealm.graph/v1", id: "demo", sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" } });
  const registry: GraphRegistrySnapshot = { registryRevision: 0, modules: [], objectKinds: [], relationKinds: [], capabilities: [], validators: [], operations: [], ui: {} };
  return { store, registry };
}

describe("ManagedGraph 统一命令管线", () => {
  it("五个公共方法共享候选图校验和 revision 结果", () => {
    const { store, registry } = fixture();
    const graph = createManagedGraph(store, { registry });
    expect(Object.keys(graph).filter((key) => typeof (graph as unknown as Record<string, unknown>)[key] === "function")).toEqual([]);
    expect(graph.read()).toMatchObject({ revision: 0, complete: true, diagnostics: [], snapshot: { revision: 0 } });
    expect(graph.validate()).toMatchObject({ revision: 0, complete: true, diagnostics: [] });
    const committed = graph.commit({ expectedRevision: 0, mutations: [{ op: "upsert_object", object: { id: "a", kind: "plain", label: "A" } }] });
    expect(committed).toMatchObject({ revision: 1, complete: true, snapshot: { revision: 1 } });
    expect(graph.undo(1)).toMatchObject({ revision: 2, snapshot: { objects: [] } });
    expect(graph.redo(2)).toMatchObject({ revision: 3, snapshot: { objects: [{ id: "a" }] } });
  });

  it("在 validator error 时不改变磁盘和 history", () => {
    const { store, registry } = fixture();
    const graph = createManagedGraph(store, {
      registry,
      validators: [{ moduleId: "workflow", namespace: "workflow", id: "deny", mode: "transition" }],
      runtimes: { workflow: { validate: () => [{ code: "DENIED", message: "拒绝", severity: "error" }] } },
    });
    expect(() => graph.commit({ mutations: [{ op: "upsert_object", object: { id: "a", kind: "plain", label: "A" } }] })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(store.read()).toMatchObject({ revision: 0, objects: [] });
    expect(store.historyStatus()).toEqual({ canUndo: false, canRedo: false });
  });

  it("undo 的候选图被拒绝时也不先写磁盘", () => {
    const { store, registry } = fixture();
    const graph = createManagedGraph(store, { registry });
    graph.commit({ mutations: [{ op: "upsert_object", object: { id: "a", kind: "plain", label: "A" } }] });
    const guarded = createManagedGraph(store, {
      registry,
      validators: [{ moduleId: "workflow", namespace: "workflow", id: "keep-a", mode: "transition" }],
      runtimes: { workflow: { validate: (_id, context) => context.candidate.objects.length ? [] : [{ code: "KEEP_A", message: "不能删除 A", severity: "error" }] } },
    });
    expect(() => guarded.undo(1)).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(store.read()).toMatchObject({ revision: 1, objects: [{ id: "a" }] });
    expect(store.historyStatus()).toEqual({ canUndo: true, canRedo: false });
  });

  it("在同一锁周期内校验并以同一 commitId 提交事实、history 与 audit", () => {
    const { store, registry } = fixture();
    let nestedWriteCode: string | undefined;
    const graph = createManagedGraph(store, {
      registry,
      validators: [{ moduleId: "workflow", namespace: "workflow", id: "locked", mode: "transition" }],
      runtimes: {
        workflow: {
          validate: () => {
            try {
              store.apply({ mutations: [] });
            } catch (error) {
              nestedWriteCode = (error as { code?: string }).code;
            }
            return [];
          },
        },
      },
    });
    graph.commit({ mutations: [{ op: "upsert_object", object: { id: "a", kind: "plain", label: "A" } }] });
    expect(nestedWriteCode).toBe("GRAPH_LOCKED");
    const revision = JSON.parse(readFileSync(join(store.graphRoot, ".revision.json"), "utf8")) as { revision: number; commitId: string };
    const audit = JSON.parse(readFileSync(join(store.graphRoot, ".audit.jsonl"), "utf8").trim()) as { commitId: string; toRevision: number };
    expect(revision).toMatchObject({ revision: 1, commitId: audit.commitId });
    expect(audit.toRevision).toBe(1);
    const historyIndex = JSON.parse(readFileSync(join(store.graphRoot, ".history/index.json"), "utf8")) as { currentSegment: string };
    expect(JSON.parse(readFileSync(join(store.graphRoot, `.history/segments/${historyIndex.currentSegment}.json`), "utf8"))).toMatchObject({ cursor: 1 });
  });
});
