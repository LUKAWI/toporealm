import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import GraphCanvas from "../GraphCanvas.svelte";
import ObjectDetail from "./ObjectDetail.svelte";
import RelationDetail from "./RelationDetail.svelte";
import { store } from "../store.svelte";
import type { GraphSnapshot } from "../protocol";

const snapshot: GraphSnapshot = {
  manifest: { format: "toporealm.graph/v1", id: "demo", label: "Demo", sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" } },
  objects: [
    { id: "q-1", kind: "research.question", label: "原问题", data: { status: "open" }, capabilities: { edit: { enabled: true } }, meta: { source: "fixture" } },
    { id: "odd-1", kind: "alien.creature", label: "未知 kind 对象", data: { raw: "保持原样" } },
  ],
  relations: [
    { id: "r-1", kind: "supports", source: "odd-1", target: "q-1", direction: "directed", label: "支持", data: { weight: 2 } },
  ],
  revision: 9,
};

async function mountChain(): Promise<{ components: Record<string, unknown>[]; target: HTMLDivElement }> {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const canvas = mount(GraphCanvas, { target });
  const objectDetail = mount(ObjectDetail, { target });
  const relationDetail = mount(RelationDetail, { target });
  await tick();
  await tick();
  return { components: [canvas, objectDetail, relationDetail] as unknown as Record<string, unknown>[], target };
}

function teardown(target: HTMLDivElement, components: Record<string, unknown>[]): void {
  for (const component of components) unmount(component as never);
  target.remove();
}

describe("选择链路与详情抽屉", () => {
  afterEach(() => {
    store.snapshot = null;
    store.selection = null;
    store.searchQuery = "";
    store.kindFilter = "";
    store.moduleStatus = null;
  });

  it("画布点击 → 选择状态 → 抽屉内容渲染全链路", async () => {
    store.snapshot = snapshot;
    const { components, target } = await mountChain();

    // 点击对象星体
    const nodeHit = target.querySelector("g.node circle.node-hit") as SVGCircleElement;
    nodeHit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
    // rAF 重播滑入后抽屉可见
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await tick();
    const drawer = target.querySelector(".drawer");
    expect(drawer).not.toBeNull();
    expect(drawer?.classList.contains("visible")).toBe(true);
    expect(drawer?.textContent).toContain("对象详情");
    expect(drawer?.textContent).toContain("q-1");
    expect(drawer?.textContent).toContain("research.question");
    expect(drawer?.textContent).toContain("原问题");
    expect(drawer?.textContent).toContain("关系");

    // 点击关系行 → 关系详情（抽屉切换无残留）
    const relationRow = [...target.querySelectorAll<HTMLButtonElement>(".relation-row")][0];
    relationRow.click();
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await tick();
    expect(target.querySelector(".drawer")?.textContent).toContain("关系详情");
    expect(target.querySelector(".drawer")?.textContent).toContain("supports");
    expect(target.querySelector(".drawer")?.textContent).toContain("odd-1");

    teardown(target, components);
  });

  it("未知 kind 显示原始 data 并标注降级", async () => {
    store.snapshot = snapshot;
    // 注册表在场时，未注册命名空间才可被判定为降级
    store.moduleStatus = { registryRevision: 1, modules: [{ id: "research", namespace: "research", status: "available" }], ui: {}, operations: [] };
    store.selection = { type: "object", id: "odd-1" };
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(ObjectDetail, { target });
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await tick();
    const drawer = target.querySelector(".drawer");
    expect(drawer?.textContent).toContain("未知 kind 对象");
    expect(drawer?.textContent).toContain("alien.creature");
    expect(drawer?.textContent).toContain("降级");
    // 原始 JSON 折叠块展开后可见原始数据
    const toggle = [...target.querySelectorAll<HTMLButtonElement>(".json-toggle")].find((button) => button.textContent?.includes("data"));
    toggle?.click();
    await tick();
    expect(target.querySelector(".json-body")?.textContent).toContain("保持原样");
    unmount(component);
    target.remove();
  });

  it("选中不存在的 ID 不崩溃且不显示脏数据", async () => {
    store.snapshot = snapshot;
    store.selection = { type: "object", id: "ghost-id" };
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(ObjectDetail, { target });
    await tick();
    expect(target.querySelector(".drawer")).toBeNull();
    store.selection = { type: "relation", id: "ghost-rel" };
    await tick();
    expect(target.querySelector(".drawer")).toBeNull();
    unmount(component);
    target.remove();
  });

  it("关系详情显示端点跳转，跳转后切换到对象详情", async () => {
    store.snapshot = snapshot;
    store.selection = { type: "relation", id: "r-1" };
    const target = document.createElement("div");
    document.body.appendChild(target);
    const objectDetail = mount(ObjectDetail, { target });
    const relationDetail = mount(RelationDetail, { target });
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await tick();
    const drawer = target.querySelector(".drawer");
    expect(drawer?.textContent).toContain("有向");
    expect(drawer?.textContent).toContain("支持");
    // data 原始块
    const toggle = [...target.querySelectorAll<HTMLButtonElement>(".json-toggle")].find((button) => button.textContent?.includes("data"));
    toggle?.click();
    await tick();
    expect(target.querySelector(".json-body")?.textContent).toContain("weight");

    // 端点跳转
    const endpoint = [...target.querySelectorAll<HTMLButtonElement>(".endpoint-link")].find((button) => button.textContent === "q-1");
    endpoint?.click();
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await tick();
    expect(store.selection).toEqual({ type: "object", id: "q-1" });
    expect(target.querySelector(".drawer")?.textContent).toContain("对象详情");
    unmount(objectDetail);
    unmount(relationDetail);
    target.remove();
  });
});
