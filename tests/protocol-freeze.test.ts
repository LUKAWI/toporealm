import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraphStore, validateGraph } from "../src/core/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store(): GraphStore {
  const root = mkdtempSync(join(tmpdir(), "toporealm-m6-"));
  roots.push(root);
  const graph = GraphStore.fromWorkspace(root, "freeze");
  graph.initialize({ format: "toporealm.graph/v1", id: "freeze", sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" } });
  return graph;
}

describe("protocol freeze hardening", () => {
  it("区分基础校验与完整校验，并报告缺失模块而不阻断读取", () => {
    const graph = store();
    graph.apply({ mutations: [{ op: "upsert_object", object: { id: "a", kind: "research.question", label: "unknown", data: { keep: true } } }] });
    const basic = validateGraph(graph.read());
    expect(basic.ok).toBe(true);
    expect(basic.complete).toBe(false);
    expect(basic.warnings[0]?.code).toBe("MODULE_REGISTRY_UNAVAILABLE");
  });

  it("拒绝共享实体 ID，并检测文件名与记录 ID 漂移", () => {
    const graph = store();
    graph.apply({ mutations: [{ op: "upsert_object", object: { id: "a", kind: "plain", label: "A" } }] });
    expect(() => graph.apply({ mutations: [{ op: "upsert_relation", relation: { id: "a", kind: "plain-link", source: "a", target: "a", direction: "directed" } }] })).toThrow(/共享 ID/);
    const wrongPath = join(graph.graphRoot, "objects", "wrong.yaml");
    mkdirSync(join(graph.graphRoot, "objects"), { recursive: true });
    writeFileSync(wrongPath, "id: actual\nkind: plain\nlabel: Actual\n", "utf8");
    expect(() => graph.read()).toThrow(/文件名/);
  });
});
