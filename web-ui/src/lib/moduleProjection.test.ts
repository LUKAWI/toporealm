import { describe, expect, it } from "vitest";
import { kindColorOf, projectModuleKind, representOf } from "./moduleProjection";
import type { Catalog } from "./protocol";

const catalog: Catalog = {
  modules: [{ id: "research", namespace: "research", version: "1.0.0" }],
  kinds: [{ kind: "research.question", owner: "research", color: "#6d28d9", icon: "?" }],
  commands: [
    { id: "research.expand", module: "research", title: "展开问题", target: "research.question", input: { type: "object" } },
    { id: "research.globalScan", module: "research", title: "全局扫描" },
  ],
};

// D46 语义分层：容器/标注呈现声明来自 catalog kinds（测试 mock，实现并行开发中）
const layeredCatalog: Catalog = {
  modules: [{ id: "wf", namespace: "wf", version: "1.0.0" }],
  kinds: [
    { kind: "wf.group", owner: "wf", represent: "container" },
    { kind: "wf.report", owner: "wf", represent: "annotation" },
    { kind: "wf.task", owner: "wf" },
  ],
  commands: [],
};

describe("目录投影（blueprint §1 Catalog）", () => {
  it("kinds.color/icon 投影样式，appliesTo 命令进入 kind 插槽", () => {
    expect(projectModuleKind("research.question", catalog)).toMatchObject({
      available: true,
      moduleId: "research",
      presentation: { color: "#6d28d9", icon: "?" },
      commands: [{ commandId: "research.expand", title: "展开问题", input: { type: "object" } }],
    });
  });

  it("命名空间无属主模块 = 不可用（降级呈现），目录缺失时不妄断", () => {
    const degraded = projectModuleKind("alien.creature", catalog);
    expect(degraded.available).toBe(false);
    expect(degraded.moduleId).toBeUndefined();
    expect(degraded.commands).toEqual([]);
    expect(projectModuleKind("alien.creature", null).available).toBe(true); // 目录未加载 ≠ 不可用
  });

  it("kindColorOf：目录色优先，未声明时确定性回退", () => {
    expect(kindColorOf("research.question", catalog)).toBe("#6d28d9");
    expect(kindColorOf("plain.thing", catalog)).toBe(kindColorOf("plain.thing", null));
    expect(kindColorOf("plain.thing", null)).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("represent 透传：catalog kinds 声明 container/annotation 进投影，未声明 = undefined", () => {
    expect(projectModuleKind("wf.group", layeredCatalog).represent).toBe("container");
    expect(projectModuleKind("wf.report", layeredCatalog).represent).toBe("annotation");
    expect(projectModuleKind("wf.task", layeredCatalog).represent).toBeUndefined();
    expect(representOf("wf.group", layeredCatalog)).toBe("container");
    expect(representOf("wf.group", null)).toBeUndefined(); // 目录未加载 = 普通星体
    expect(projectModuleKind("wf.task", layeredCatalog).available).toBe(true);
  });

  it("represent 是呈现声明：模块降级（无属主）时仍透传，渲染分层不随可用性失效", () => {
    expect(projectModuleKind("ghost.group", { ...layeredCatalog, modules: [] }).represent).toBeUndefined();
    const catalogWithGhostKind: Catalog = {
      ...layeredCatalog,
      kinds: [...layeredCatalog.kinds, { kind: "ghost.group", represent: "container" }],
    };
    const degraded = projectModuleKind("ghost.group", catalogWithGhostKind);
    expect(degraded.available).toBe(false);
    expect(degraded.represent).toBe("container");
  });

  it("基座批注约定（D48）：公共 kind annotation 无需目录声明即按附属标注渲染", () => {
    // 无目录、目录未加载、目录缺失该 kind 三种形态下恒为 annotation
    expect(representOf("annotation", null)).toBe("annotation");
    expect(representOf("annotation", layeredCatalog)).toBe("annotation");
    expect(projectModuleKind("annotation", null).represent).toBeUndefined(); // 投影层不受影响：基座约定只在渲染分流入口
  });
});
