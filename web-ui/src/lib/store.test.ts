import { describe, expect, it } from "vitest";
import { GraphApiError, type GraphSnapshot, type HistoryStatus, type MutationPlan, type MutationResult } from "./protocol";
import { WebGraphStore } from "./store.svelte";

function snapshot(revision = 5, objects = [{ id: "q-1", kind: "research.question", label: "问题" }]): GraphSnapshot {
  return {
    manifest: { format: "toporealm.graph/v1", id: "demo", label: "Demo", sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" } },
    objects,
    relations: [],
    revision,
  };
}

function history(canUndo = true, canRedo = false): HistoryStatus {
  return { canUndo, canRedo };
}

function resultFor(next: GraphSnapshot): MutationResult {
  return {
    snapshot: next,
    patch: {
      fromRevision: next.revision - 1,
      toRevision: next.revision,
      objects: { added: next.objects, updated: [], deleted: [] },
      relations: { added: [], updated: [], deleted: [] },
      manifestChanged: false,
    },
    history: history(next.revision > 0, true),
  };
}

function fakeApi(overrides: Partial<Parameters<typeof Object.assign>[1]> = {}) {
  const calls: Record<string, number> = {};
  const base = {
    calls,
    async readGraph() {
      calls.readGraph = (calls.readGraph ?? 0) + 1;
      return snapshot();
    },
    async apply(plan: MutationPlan) {
      calls.apply = (calls.apply ?? 0) + 1;
      const nextRevision = (plan.expectedRevision ?? 0) + 1;
      const added = plan.mutations.flatMap((mutation) => (mutation.op === "upsert_object" ? [mutation.object] : []));
      return resultFor(snapshot(nextRevision, [...snapshot().objects, ...added]));
    },
    async undo() {
      calls.undo = (calls.undo ?? 0) + 1;
      return resultFor(snapshot(6));
    },
    async redo() {
      calls.redo = (calls.redo ?? 0) + 1;
      return resultFor(snapshot(6));
    },
    async history() {
      return history();
    },
    async listGraphs() {
      return { currentId: "demo", graphs: [{ id: "demo", label: "Demo", revision: 5, objectCount: 1, relationCount: 0 }] };
    },
    async switchGraph(id: string) {
      calls.switchGraph = (calls.switchGraph ?? 0) + 1;
      return { snapshot: snapshot(), history: history(), graph: { id, label: "Demo", revision: 5, objectCount: 1, relationCount: 0 } };
    },
    async modules() {
      return { registryRevision: 1, modules: [], ui: {}, operations: [] };
    },
    async executeAction() {
      throw new Error("not expected in this test");
    },
    async validate() {
      return { ok: true, complete: false, errors: [], warnings: [] };
    },
    async validateComplete() {
      return { ok: true, complete: true, errors: [], warnings: [] };
    },
  };
  return Object.assign(base, overrides);
}

describe("WebGraphStore", () => {
  it("load 接入真实协议形状：快照、历史、图列表与模块状态", async () => {
    const store = new WebGraphStore(fakeApi());
    await store.load();
    expect(store.snapshot).toMatchObject({ revision: 5, objects: [{ id: "q-1" }] });
    expect(store.history).toEqual({ canUndo: true, canRedo: false });
    expect(store.graphs).toHaveLength(1);
    expect(store.error).toBe("");
  });

  it("commit 连续推进 revision 并把 patch 写入本地视图", async () => {
    const api = fakeApi();
    const store = new WebGraphStore(api);
    await store.load();
    const result = await store.commit({ mutations: [{ op: "upsert_object", object: { id: "n-1", kind: "plain", label: "新对象" } }] });
    expect(result.snapshot.revision).toBe(6);
    expect(store.revision).toBe(6);
    expect(store.objects.map((object) => object.id)).toContain("n-1");
    expect(api.calls.apply).toBe(1);
  });

  it("409 冲突进入 recovery 态：本地快照不变，reload 恢复并清除", async () => {
    const conflict = new GraphApiError("REVISION_CONFLICT", "版本已变化", 409);
    const store = new WebGraphStore(fakeApi({
      async apply() {
        throw conflict;
      },
    }));
    await store.load();
    const before = store.snapshot;
    await expect(store.commit({ mutations: [{ op: "delete_object", id: "q-1" }] })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(store.recovery).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(store.snapshot).toEqual(before);
    await store.reload();
    expect(store.recovery).toBeNull();
    expect(store.snapshot).toMatchObject({ revision: 5 });
  });

  it("patch gap（本地 revision 不连续）同样进入 recovery 态且不改写本地快照", async () => {
    const store = new WebGraphStore(fakeApi({
      async apply() {
        return {
          snapshot: snapshot(9),
          patch: {
            fromRevision: 8,
            toRevision: 9,
            objects: { added: [], updated: [], deleted: [] },
            relations: { added: [], updated: [], deleted: [] },
            manifestChanged: false,
          },
          history: history(),
        };
      },
    }));
    await store.load();
    await expect(store.commit({ mutations: [{ op: "upsert_object", object: { id: "x", kind: "plain", label: "x" } }] })).rejects.toMatchObject({ code: "PATCH_GAP" });
    expect(store.recovery).toMatchObject({ code: "PATCH_GAP" });
    expect(store.snapshot).toMatchObject({ revision: 5 });
    expect(store.objects.map((object) => object.id)).toEqual(["q-1"]);
  });

  it("undo 409 进入 recovery；只读模式不发请求", async () => {
    const store = new WebGraphStore(fakeApi({
      async undo() {
        throw new GraphApiError("REVISION_CONFLICT", "版本已变化", 409);
      },
    }));
    await store.load();
    await store.undo();
    expect(store.recovery).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(store.snapshot).toMatchObject({ revision: 5 });

    const roApi = fakeApi();
    const roStore = new WebGraphStore(roApi);
    await roStore.load();
    roStore.readOnly = true;
    await roStore.undo();
    expect(roStore.actionMessage).toContain("只读");
    expect(roApi.calls.undo).toBeUndefined();
  });

  it("switchGraph 清空选择、过滤与校验状态", async () => {
    let releaseSwitch!: () => void;
    const switchGate = new Promise<void>((resolve) => {
      releaseSwitch = resolve;
    });
    const api = fakeApi({
      async switchGraph(id: string) {
        await switchGate;
        return { snapshot: snapshot(), history: history(), graph: { id, label: "Demo", revision: 5, objectCount: 1, relationCount: 0 } };
      },
    });
    const store = new WebGraphStore(api);
    await store.load();
    store.selection = { type: "object", id: "q-1" };
    store.searchQuery = "问题";
    store.kindFilter = "research.question";
    store.openEditor("edit-object", { targetId: "q-1" });
    const switching = store.switchGraph("other");
    expect(store.switching).toBe(true);
    expect(store.editor).toBeNull();
    expect(store.selection).toBeNull();
    store.openEditor("edit-object", { targetId: "q-1" });
    expect(store.editor).toBeNull();
    await expect(store.commit({ mutations: [{ op: "upsert_object", object: { id: "q-1", kind: "plain", label: "旧图修改" } }] })).rejects.toMatchObject({ code: "GRAPH_SWITCHING" });
    expect(api.calls.apply).toBeUndefined();
    await store.undo();
    expect(api.calls.undo).toBeUndefined();
    await expect(store.executeAction("research.expand-question", "q-1", {})).rejects.toMatchObject({ code: "GRAPH_SWITCHING" });
    releaseSwitch();
    await switching;
    expect(store.snapshot?.manifest.id).toBe("demo");
    expect(store.selection).toBeNull();
    expect(store.searchQuery).toBe("");
    expect(store.kindFilter).toBe("");
    expect(store.validation).toBeNull();
    expect(store.editor).toBeNull();
  });

  it("写请求在途时拒绝切图，避免旧写入落到新 activeStore", async () => {
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const api = fakeApi({
      async apply() {
        await applyGate;
        return resultFor(snapshot(6));
      },
    });
    const store = new WebGraphStore(api);
    await store.load();
    const committing = store.commit({ mutations: [{ op: "upsert_object", object: { id: "q-1", kind: "plain", label: "旧图修改" } }] });
    expect(store.writing).toBe(true);
    await store.switchGraph("other");
    expect(store.switching).toBe(false);
    expect(api.calls.switchGraph).toBeUndefined();
    releaseApply();
    await committing;
    expect(store.writing).toBe(false);
  });

  it("模块 action 请求在途时拒绝切图与第二次写入", async () => {
    let releaseAction!: () => void;
    const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
    const api = fakeApi({
      async executeAction() {
        await actionGate;
        return { kind: "result", operation: "workflow.next-actions", result: {}, effects: "none" as const };
      },
    });
    const store = new WebGraphStore(api);
    await store.load();
    const executing = store.executeAction("workflow.next-actions", undefined, {});
    expect(store.writing).toBe(true);
    await store.switchGraph("other");
    expect(api.calls.switchGraph).toBeUndefined();
    await expect(store.executeAction("workflow.transition-task", "task-a", { status: "ready" })).rejects.toMatchObject({ code: "WRITE_IN_PROGRESS" });
    releaseAction();
    await executing;
    expect(store.writing).toBe(false);
  });

  it("模块缺失与恢复只刷新 registry，不重载或改写当前图数据", async () => {
    let available = false;
    const api = fakeApi({
      async modules() {
        return {
          registryRevision: 5,
          modules: [{ id: "workflow", namespace: "workflow", status: available ? "available" as const : "unavailable" as const, ...(available ? {} : { reason: "模块目录缺失" }) }],
          ui: available ? { workflow: { entry: "./web/index.js", tag: "toporealm-workflow-view" } } : {},
          operations: [],
        };
      },
    });
    const store = new WebGraphStore(api);
    await store.load();
    const before = JSON.parse(JSON.stringify(store.snapshot));
    expect(store.moduleStatus?.modules[0]).toMatchObject({ status: "unavailable" });
    available = true;
    await store.refreshModules();
    expect(store.moduleStatus?.modules[0]).toMatchObject({ status: "available" });
    expect(store.moduleStatus?.ui).toHaveProperty("workflow");
    expect(store.snapshot).toEqual(before);
    expect(api.calls.readGraph).toBe(1);
  });
});
