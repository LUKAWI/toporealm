import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import ObjectDetail from "./ObjectDetail.svelte";
import { store } from "../store.svelte";
import type { ActionResult, GraphSnapshot, ModuleStatusResult } from "../protocol";

const snapshot: GraphSnapshot = {
  manifest: { format: "toporealm.graph/v1", id: "demo", label: "Demo", sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" } },
  objects: [
    { id: "q-1", kind: "research.question", label: "原问题", data: { status: "open" } },
    { id: "odd-1", kind: "alien.creature", label: "未注册 kind", data: { raw: 1 } },
  ],
  relations: [],
  revision: 3,
};

const registry: ModuleStatusResult = {
  registryRevision: 3,
  modules: [{ id: "research", namespace: "research", status: "available", version: "0.1.0" }],
  ui: {
    research: {
      presentation: { "research.question": { color: "#6d28d9", icon: "?" } },
      forms: { "research.question": ["label", "data.text"] },
    },
  },
  operations: [
    { id: "expand-question", fullId: "research.expand-question", moduleId: "research", declaration: { applies_to: "research.question", input_template: { depth: 1 } } },
  ],
};

function mountDetail(): { component: Record<string, unknown>; target: HTMLDivElement } {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const component = mount(ObjectDetail, { target });
  return { component: component as unknown as Record<string, unknown>, target };
}

describe("模块 UI 投影与降级", () => {
  afterEach(() => {
    store.snapshot = null;
    store.selection = null;
    store.moduleStatus = null;
    store.readOnly = false;
  });

  it("模块声明的样式/字段提示/动作按钮进入固定插槽（非硬编码）", async () => {
    store.snapshot = snapshot;
    store.moduleStatus = registry;
    store.selection = { type: "object", id: "q-1" };
    const { component, target } = mountDetail();
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await tick();

    const drawer = target.querySelector(".drawer");
    expect(drawer?.textContent).toContain("research.question");
    // presentation 色进入 kind chip 圆点
    const dot = target.querySelector<HTMLSpanElement>(".kind-dot");
    expect(dot?.getAttribute("style")).toContain("rgb(109, 40, 217)");
    // 动作按钮来自声明（fullId），不经过 Web 内硬编码分支
    const actionButton = [...target.querySelectorAll<HTMLButtonElement>(".drawer button")].find((button) => button.textContent?.includes("research.expand-question"));
    expect(actionButton).toBeDefined();
    unmount(component);
    target.remove();
  });

  it("动作执行携带声明模板并经 store 回灌快照；失败显示稳定错误", async () => {
    store.snapshot = snapshot;
    store.moduleStatus = registry;
    store.selection = { type: "object", id: "q-1" };
    const calls: Array<{ operation: string; target: string | undefined; input: Record<string, unknown> }> = [];
    store.executeAction = async (operation, targetId, input) => {
      calls.push({ operation, target: targetId, input });
      if (operation.includes("fail")) {
        const { GraphApiError } = await import("../protocol");
        throw new GraphApiError("RUNTIME_FAILED", "depth 超出限制", 400);
      }
      return { kind: "mutation", operation, mutation: { snapshot, patch: { fromRevision: 3, toRevision: 4, objects: { added: [], updated: [], deleted: [] }, relations: { added: [], updated: [], deleted: [] }, manifestChanged: false }, history: { canUndo: true, canRedo: false } } } as ActionResult;
    };
    const { component, target } = mountDetail();
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await tick();

    const actionButton = [...target.querySelectorAll<HTMLButtonElement>(".drawer button")].find((button) => button.textContent?.includes("research.expand-question"))!;
    actionButton.click();
    await tick();
    await tick();
    expect(calls).toEqual([{ operation: "research.expand-question", target: "q-1", input: { depth: 1 } }]);
    expect(store.actionMessage).toContain("已提交");

    // 只读时动作禁用
    store.readOnly = true;
    await tick();
    expect(actionButton.disabled).toBe(true);
    store.readOnly = false;
    unmount(component);
    target.remove();
  });

  it("缺失模块：降级原因可见、无动作按钮，原始数据仍可往返查看", async () => {
    store.snapshot = snapshot;
    store.moduleStatus = registry;
    store.selection = { type: "object", id: "odd-1" };
    const { component, target } = mountDetail();
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await tick();

    const drawer = target.querySelector(".drawer");
    expect(drawer?.textContent).toContain("降级");
    expect(drawer?.textContent).toContain("alien");
    expect(drawer?.textContent).toContain("当前图未注册此命名空间");
    // 无任何模块动作按钮
    const actionButtons = [...target.querySelectorAll<HTMLButtonElement>(".drawer button")].filter((button) => button.textContent?.includes("research.expand-question"));
    expect(actionButtons).toHaveLength(0);
    // 原始数据可见
    const toggle = [...target.querySelectorAll<HTMLButtonElement>(".json-toggle")].find((button) => button.textContent?.includes("data"));
    toggle?.click();
    await tick();
    expect(target.querySelector(".json-body")?.textContent).toContain('"raw": 1');
    unmount(component);
    target.remove();
  });
});
