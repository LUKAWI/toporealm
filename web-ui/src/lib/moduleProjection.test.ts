import { describe, expect, it } from "vitest";
import { projectModuleKind } from "./moduleProjection";
import type { ModuleStatusResult } from "./protocol";

const registry: ModuleStatusResult = {
  registryRevision: 3,
  modules: [
    { id: "research", namespace: "research", status: "available", version: "0.1.0" },
    { id: "exploration", namespace: "exploration", status: "unavailable", reason: "模块目录缺失" },
  ],
  ui: { research: { presentation: { "research.question": { color: "#6d28d9", icon: "?" } }, forms: { "research.question": ["label"] } } },
  operations: [{ id: "expand-question", fullId: "research.expand-question", moduleId: "research", declaration: { applies_to: "research.question", input_schema: "research.expand-question/input-v1" } }],
};

describe("module declaration projection", () => {
  it("按模块声明投影样式、表单字段和适用动作", () => {
    expect(projectModuleKind("research.question", registry)).toMatchObject({
      available: true,
      moduleId: "research",
      presentation: { color: "#6d28d9", icon: "?" },
      fields: ["label"],
      operations: [{ operation: "research.expand-question", inputSchema: "research.expand-question/input-v1" }],
    });
  });

  it("模块不可用时只返回降级原因，不伪造专用字段或动作", () => {
    expect(projectModuleKind("exploration.unknown", registry)).toMatchObject({ available: false, reason: "模块目录缺失", fields: [], operations: [] });
  });
});
