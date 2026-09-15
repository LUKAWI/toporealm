import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedGraph } from "../src/core/managed.js";
import { GraphStore } from "../src/core/store.js";
import type { GraphRegistrySnapshot } from "../src/module-sdk/registry.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "toporealm-guard-"));
  roots.push(root);
  const store = GraphStore.fromWorkspace(root, "demo");
  store.initialize({
    format: "toporealm.graph/v1",
    id: "demo",
    modules: [{ id: "workflow", namespace: "workflow", schema: 1 }],
    sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" },
  });
  store.apply({ mutations: [
    { op: "upsert_object", object: { id: "a", kind: "workflow.task", label: "A", data: { state: "todo" }, capabilities: { "workflow.guard": { owner: "human" } } } },
    { op: "upsert_object", object: { id: "b", kind: "plain", label: "B" } },
    { op: "upsert_relation", relation: { id: "r", kind: "workflow.depends", source: "a", target: "b", direction: "directed", data: { hard: true } } },
  ] });
  const registry: GraphRegistrySnapshot = {
    registryRevision: 1,
    modules: [{ id: "workflow", namespace: "workflow", status: "unavailable", reason: "not installed" }],
    objectKinds: [], relationKinds: [], capabilities: [], validators: [], operations: [], ui: {},
  };
  return { store, graph: createManagedGraph(store, { registry }) };
}

describe("缺失模块私有区域保护", () => {
  it("允许 Core label/meta 编辑且逐值保留缺失模块私有区域", () => {
    const { graph } = fixture();
    const current = graph.read().snapshot.objects.find((item) => item.id === "a")!;
    const result = graph.commit({ expectedRevision: 1, mutations: [{ op: "upsert_object", object: { ...current, label: "A2", meta: { pinned: true } } }] });
    expect(result.snapshot.objects.find((item) => item.id === "a")).toMatchObject({ label: "A2", data: { state: "todo" }, meta: { pinned: true } });
    expect(result.complete).toBe(false);
  });

  it("允许新增和修改不属于缺失模块的普通事实", () => {
    const { graph } = fixture();
    const result = graph.commit({ expectedRevision: 1, mutations: [
      { op: "upsert_object", object: { id: "b", kind: "plain", label: "B2", data: { note: "公开事实" }, meta: { pinned: true } } },
      { op: "upsert_object", object: { id: "c", kind: "plain", label: "C", data: { note: "新事实" } } },
    ] });
    expect(result.snapshot.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "b", label: "B2", data: { note: "公开事实" }, meta: { pinned: true } }),
      expect.objectContaining({ id: "c", kind: "plain" }),
    ]));
  });

  it.each([
    ["新增私有实体", { op: "upsert_object", object: { id: "new-task", kind: "workflow.task", label: "新任务", data: { state: "todo" } } }],
    ["新增私有关系", { op: "upsert_relation", relation: { id: "new-dep", kind: "workflow.depends", source: "a", target: "b", direction: "directed", data: { hard: true } } }],
    ["实体 kind", { op: "upsert_object", object: { id: "a", kind: "plain", label: "A", data: { state: "todo" }, capabilities: { "workflow.guard": { owner: "human" } } } }],
    ["实体 data", { op: "upsert_object", object: { id: "a", kind: "workflow.task", label: "A", data: { state: "done" }, capabilities: { "workflow.guard": { owner: "human" } } } }],
    ["capability state", { op: "upsert_object", object: { id: "a", kind: "workflow.task", label: "A", data: { state: "todo" }, capabilities: { "workflow.guard": { owner: "agent" } } } }],
    ["实体删除", { op: "delete_object", id: "a" }],
    ["关系 kind", { op: "upsert_relation", relation: { id: "r", kind: "plain", source: "a", target: "b", direction: "directed", data: { hard: true } } }],
    ["关系 data", { op: "upsert_relation", relation: { id: "r", kind: "workflow.depends", source: "a", target: "b", direction: "directed", data: { hard: false } } }],
    ["关系 capability", { op: "upsert_relation", relation: { id: "r", kind: "workflow.depends", source: "a", target: "b", direction: "directed", data: { hard: true }, capabilities: { "workflow.guard": { owner: "human" } } } }],
    ["关系端点", { op: "upsert_relation", relation: { id: "r", kind: "workflow.depends", source: "b", target: "a", direction: "directed", data: { hard: true } } }],
    ["关系方向", { op: "upsert_relation", relation: { id: "r", kind: "workflow.depends", source: "a", target: "b", direction: "undirected", data: { hard: true } } }],
    ["关系删除", { op: "delete_relation", id: "r" }],
  ] as const)("缺失模块时拒绝%s", (_label, mutation) => {
    const { graph } = fixture();
    expect(() => graph.commit({ expectedRevision: 1, mutations: [mutation] })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(graph.read().revision).toBe(1);
  });

  it("audit 仅追加固定索引字段且不复制模块私有内容", () => {
    const { store, graph } = fixture();
    const current = graph.read().snapshot.objects.find((item) => item.id === "a")!;
    graph.commit({ label: "更新标题", mutations: [{ op: "upsert_object", object: { ...current, label: "A2" } }] });
    const lines = readFileSync(join(store.graphRoot, ".audit.jsonl"), "utf8").trim().split("\n");
    const audit = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(Object.keys(audit).sort()).toEqual(["checksumSummary", "commitId", "fromRevision", "label", "recoveryStatus", "source", "timestamp", "toRevision"]);
    expect(Object.keys(audit.checksumSummary as object).sort()).toEqual(["after", "algorithm", "before", "fileCount"]);
    expect(JSON.stringify(audit)).not.toContain("human");
    expect(lines).toHaveLength(2);
  });

  it("read 吸收外部 YAML 为新 revision/segment，保留 audit 并清除跨基线 undo", () => {
    const { store, graph } = fixture();
    const objectPath = join(store.graphRoot, "objects/a.yaml");
    writeFileSync(objectPath, readFileSync(objectPath, "utf8").replace("label: A", "label: 外部标题"), "utf8");
    const result = graph.read();
    expect(result).toMatchObject({
      revision: 2,
      snapshot: { revision: 2, objects: expect.arrayContaining([expect.objectContaining({ id: "a", label: "外部标题" })]) },
      notice: {
        code: "EXTERNAL_EDIT_ABSORBED", fromRevision: 1, toRevision: 2, segmentId: "seg_0002",
        redoCleared: true, auditPreserved: true, preserved: true, complete: false, missingModules: ["workflow"],
      },
    });
    const index = JSON.parse(readFileSync(join(store.graphRoot, ".history/index.json"), "utf8")) as { currentSegment: string; sealedSegments: string[] };
    expect(index).toEqual({ currentSegment: "seg_0002", sealedSegments: ["seg_0001"] });
    expect(JSON.parse(readFileSync(join(store.graphRoot, ".history/segments/seg_0001.json"), "utf8"))).toMatchObject({ sealed: true });
    expect(JSON.parse(readFileSync(join(store.graphRoot, ".history/segments/seg_0002.json"), "utf8"))).toMatchObject({ cursor: 0, entries: [] });
    const audit = readFileSync(join(store.graphRoot, ".audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(audit).toHaveLength(2);
    expect(audit.at(-1)).toMatchObject({ source: "external", recoveryStatus: "absorbed", fromRevision: 1, toRevision: 2 });
    expect(() => graph.undo(2)).toThrowError(expect.objectContaining({ code: "NO_UNDO" }));
  });

  it("commit 遇到外部编辑时先吸收且不覆盖外部事实或执行原计划", () => {
    const { store, graph } = fixture();
    const objectPath = join(store.graphRoot, "objects/a.yaml");
    writeFileSync(objectPath, readFileSync(objectPath, "utf8").replace("label: A", "label: 外部标题"), "utf8");
    const result = graph.commit({ expectedRevision: 1, mutations: [{ op: "upsert_object", object: { id: "c", kind: "plain", label: "C" } }] });
    expect(result).toMatchObject({ revision: 2, notice: { code: "EXTERNAL_EDIT_ABSORBED" } });
    expect(result.snapshot.objects).toEqual(expect.arrayContaining([expect.objectContaining({ id: "a", label: "外部标题" })]));
    expect(result.snapshot.objects.some((item) => item.id === "c")).toBe(false);
  });

  it("undo/redo 保持同一 segment 与单调审计，撤销后新提交截断 redo", () => {
    const { store, graph } = fixture();
    const current = graph.read().snapshot.objects.find((item) => item.id === "a")!;
    graph.commit({ expectedRevision: 1, label: "标题 A2", mutations: [{ op: "upsert_object", object: { ...current, label: "A2" } }] });
    graph.undo(2);
    graph.redo(3);
    graph.undo(4);
    const afterUndo = graph.read().snapshot.objects.find((item) => item.id === "a")!;
    graph.commit({ expectedRevision: 5, label: "标题 A3", mutations: [{ op: "upsert_object", object: { ...afterUndo, label: "A3" } }] });
    expect(store.historyStatus()).toEqual({ canUndo: true, canRedo: false });
    expect(() => graph.redo(6)).toThrowError(expect.objectContaining({ code: "NO_REDO" }));
    const index = JSON.parse(readFileSync(join(store.graphRoot, ".history/index.json"), "utf8")) as { currentSegment: string; sealedSegments: string[] };
    expect(index).toEqual({ currentSegment: "seg_0001", sealedSegments: [] });
    const auditText = readFileSync(join(store.graphRoot, ".audit.jsonl"), "utf8");
    const audit = auditText.trim().split("\n").map((line) => JSON.parse(line) as { fromRevision: number; toRevision: number; label: string });
    expect(audit.map((item) => item.toRevision)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(audit.slice(2, 5).map((item) => item.label)).toEqual(["[undo] 撤销", "[redo] 重做", "[undo] 撤销"]);
    expect(auditText).not.toContain("human");
  });

});
