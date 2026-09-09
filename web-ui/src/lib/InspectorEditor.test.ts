import { mount, tick, unmount } from "svelte";
import { describe, expect, it } from "vitest";
import InspectorEditor from "./InspectorEditor.svelte";
import type { ActionResult, CanvasSelection, GraphSnapshot, ModuleStatusResult, MutationPlan } from "./protocol";

const baseSnapshot: GraphSnapshot = {
  manifest: { format: "toporealm.graph/v1", id: "demo", sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" } },
  objects: [{ id: "q-1", kind: "research.question", label: "原问题", data: { unknown: true }, capabilities: { edit: { enabled: true } }, meta: { source: "fixture" } }],
  relations: [],
  revision: 4,
};

const moduleRegistry: ModuleStatusResult = {
  registryRevision: 4,
  modules: [{ id: "research", namespace: "research", status: "available", version: "0.1.0" }],
  ui: { research: { presentation: { "research.question": { color: "#6d28d9", icon: "?" } }, forms: { "research.question": ["label"] } } },
  operations: [{ id: "expand-question", fullId: "research.expand-question", moduleId: "research", declaration: { applies_to: "research.question", input_template: { depth: 1 } } }],
};

describe("InspectorEditor", () => {
  it("检视未知 kind 的完整原始记录，并保存修改 MutationPlan", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const commits: MutationPlan[] = [];
    const component = mount(InspectorEditor, {
      target,
      props: {
        snapshot: baseSnapshot,
        selection: { type: "object", id: "q-1" } satisfies CanvasSelection,
        onCommit: async (plan: MutationPlan) => { commits.push(plan); },
      },
    });
    await tick();
    expect(target.textContent).toContain("research.question");
    expect(target.textContent).toContain("unknown");
    [...target.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("编辑对象"))?.click();
    await tick();
    const label = [...target.querySelectorAll<HTMLInputElement>("input")].find((input) => input.value === "原问题");
    if (!label) throw new Error("没有找到 label 输入框");
    label.value = "修改后的问题";
    label.dispatchEvent(new Event("input", { bubbles: true }));
    target.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(commits[0]?.mutations[0]).toMatchObject({ op: "upsert_object", object: { id: "q-1", label: "修改后的问题", data: { unknown: true } } });
    unmount(component);
    target.remove();
  });

  it("从选中对象预填 source，并允许提交关系连接计划", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const commits: MutationPlan[] = [];
    const component = mount(InspectorEditor, {
      target,
      props: {
        snapshot: { ...baseSnapshot, objects: [...baseSnapshot.objects, { id: "c-1", kind: "plain", label: "Claim" }] },
        selection: { type: "object", id: "q-1" } satisfies CanvasSelection,
        onCommit: async (plan: MutationPlan) => { commits.push(plan); },
      },
    });
    await tick();
    const connect = [...target.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("以此为起点"));
    connect?.click();
    await tick();
    const inputs = [...target.querySelectorAll<HTMLInputElement>("input")];
    const source = inputs.find((input) => input.value === "q-1");
    const targetInput = inputs.find((input) => input.placeholder === "对象 ID" && input !== source);
    if (!targetInput) throw new Error("没有找到关系 target 输入框");
    targetInput.value = "c-1";
    targetInput.dispatchEvent(new Event("input", { bubbles: true }));
    const idInput = inputs.find((input) => input.placeholder?.includes("relates"));
    if (!idInput) throw new Error("没有找到关系 ID 输入框");
    idInput.value = "rel-1";
    idInput.dispatchEvent(new Event("input", { bubbles: true }));
    target.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(commits[0]?.mutations[0]).toMatchObject({ op: "upsert_relation", relation: { id: "rel-1", source: "q-1", target: "c-1" } });
    unmount(component);
    target.remove();
  });

  it("删除当前记录通过统一 MutationPlan 上报，并清除选择", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const commits: MutationPlan[] = [];
    const selections: (CanvasSelection | null)[] = [];
    const component = mount(InspectorEditor, {
      target,
      props: {
        snapshot: { ...baseSnapshot, relations: [{ id: "rel-1", kind: "supports", source: "q-1", target: "q-1", direction: "directed" }] },
        selection: { type: "relation", id: "rel-1" } satisfies CanvasSelection,
        onCommit: async (plan: MutationPlan) => { commits.push(plan); },
        onSelect: (next: CanvasSelection | null) => { selections.push(next); },
      },
    });
    await tick();
    [...target.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "删除")?.click();
    await tick();
    expect(commits[0]?.mutations[0]).toEqual({ op: "delete_relation", id: "rel-1" });
    expect(selections).toEqual([null]);
    unmount(component);
    target.remove();
  });

  it("使用模块声明显示样式、字段和动作，并把动作交给宿主", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const actions: Array<{ operation: string; target?: string; input: Record<string, unknown>; registryRevision?: number }> = [];
    const component = mount(InspectorEditor, {
      target,
      props: {
        snapshot: baseSnapshot,
        selection: { type: "object", id: "q-1" } satisfies CanvasSelection,
        moduleRegistry,
        onAction: async (operation: string, targetId: string | undefined, input: Record<string, unknown>, registryRevision?: number): Promise<ActionResult | void> => { actions.push({ operation, target: targetId, input, registryRevision }); },
      },
    });
    await tick();
    expect(target.textContent).toContain("声明式投影");
    expect(target.textContent).toContain("label");
    const actionButton = [...target.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("expand-question"));
    actionButton?.click();
    await tick();
    expect(actions).toEqual([{ operation: "research.expand-question", target: "q-1", input: { depth: 1 }, registryRevision: 4 }]);
    unmount(component);
    target.remove();
  });

  it("只读模式保留查看/复制能力并禁用所有写入口", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(InspectorEditor, {
      target,
      props: { snapshot: baseSnapshot, selection: { type: "object", id: "q-1" } satisfies CanvasSelection, readOnly: true },
    });
    await tick();
    const buttons = [...target.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.find((button) => button.textContent?.includes("编辑对象"))?.disabled).toBe(true);
    expect(buttons.find((button) => button.textContent?.includes("以此为起点"))?.disabled).toBe(true);
    expect(buttons.find((button) => button.textContent?.trim() === "删除")?.disabled).toBe(true);
    expect(target.textContent).toContain("只读模式");
    unmount(component);
    target.remove();
  });
});
