import { describe, expect, it } from "vitest";
import { kindColorOf, projectModuleKind } from "./moduleProjection";
import type { Catalog } from "./protocol";

const catalog: Catalog = {
  modules: [{ id: "research", namespace: "research", version: "1.0.0" }],
  kinds: [{ kind: "research.question", owner: "research", color: "#6d28d9", icon: "?" }],
  commands: [
    { id: "research.expand", module: "research", title: "展开问题", target: "research.question", input: { type: "object" } },
    { id: "research.globalScan", module: "research", title: "全局扫描" },
  ],
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
});
