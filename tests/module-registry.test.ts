import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraphStore } from "../src/core/index.js";
import {
  GraphActivator,
  WorkspaceModuleResolver,
  applyRegisteredPlan,
  discoverActions,
  validateMutationPlan,
} from "../src/module-sdk/index.js";
import { CoreError } from "../src/core/index.js";
import { withUiErrorBoundary } from "../src/web/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function moduleWorkspace(): { root: string; store: GraphStore } {
  const root = mkdtempSync(join(tmpdir(), "toporealm-m2-"));
  roots.push(root);
  const moduleRoot = join(root, ".toporealm", "modules", "research");
  mkdirSync(join(moduleRoot, "schemas"), { recursive: true });
  mkdirSync(join(moduleRoot, "operations"), { recursive: true });
  writeFileSync(join(root, ".toporealm", "modules.yaml"), `bindings:\n  research:\n    source: workspace\n    path: modules/research\n`, "utf8");
  writeFileSync(join(moduleRoot, "module.yaml"), `format: toporealm.module/v1alpha1\nid: research\nnamespace: research\nversion: 0.1.0\nsupports:\n  schemas: [1]\ncontributes:\n  object_kinds:\n    - id: question\n      declaration: schemas/question.yaml\n  operations:\n    - id: expand-question\n      declaration: operations/expand-question.yaml\n`, "utf8");
  writeFileSync(join(moduleRoot, "schemas", "question.yaml"), "label: Research question\n", "utf8");
  writeFileSync(join(moduleRoot, "operations", "expand-question.yaml"), "input_schema: research.expand-question/input-v1\ninput_template:\n  depth: 2\n", "utf8");
  const store = GraphStore.fromWorkspace(root, "research-notes");
  store.initialize({
    format: "toporealm.graph/v1alpha1",
    id: "research-notes",
    sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" },
    modules: [{ id: "research", namespace: "research", schema: 1 }],
  });
  return { root, store };
}

describe("module registry", () => {
  it("解析显式工作区绑定并生成不可变贡献注册快照", () => {
    const { root, store } = moduleWorkspace();
    const registry = new GraphActivator(new WorkspaceModuleResolver(root)).activate(store.read());
    expect(registry.modules[0]?.status).toBe("available");
    expect(registry.objectKinds[0]?.fullId).toBe("research.question");
    expect(discoverActions(registry, "q-1")[0]).toMatchObject({
      operation: "research.expand-question",
      target: "q-1",
      inputSchema: "research.expand-question/input-v1",
    });
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it("模块缺失时只禁用命名空间编辑，基础读取仍然无损", () => {
    const { store } = moduleWorkspace();
    const registry = new GraphActivator(new WorkspaceModuleResolver(store.graphRoot)).activate(store.read());
    expect(registry.modules[0]?.status).toBe("unavailable");
    expect(() => validateMutationPlan(registry, { mutations: [{ op: "upsert_object", object: { id: "q-1", kind: "research.question", label: "Q" } }] })).toThrow(CoreError);
    const plain = store.apply({ mutations: [{ op: "upsert_object", object: { id: "raw", kind: "research.question", label: "保留原始数据", data: { unknown: true } } }] });
    expect(plain.snapshot.objects[0]?.data).toEqual({ unknown: true });
  });

  it("校验通过后让跨模块 MutationPlan 仍由 Core 原子提交", () => {
    const { root, store } = moduleWorkspace();
    const registry = new GraphActivator(new WorkspaceModuleResolver(root)).activate(store.read());
    const result = applyRegisteredPlan(store, registry, {
      mutations: [{ op: "upsert_object", object: { id: "q-1", kind: "research.question", label: "Q" } }],
    });
    expect(result.snapshot.objects[0]?.id).toBe("q-1");
  });

  it("UI 扩展失败时回退到通用界面", () => {
    const result = withUiErrorBoundary(() => { throw new Error("extension failed"); }, () => "generic");
    expect(result).toMatchObject({ enabled: false, value: "generic", error: "extension failed" });
  });
});
