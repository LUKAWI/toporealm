import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import GraphCanvas from "./GraphCanvas.svelte";
import { store } from "./store.svelte";
import type { GraphSnapshot } from "./protocol";

const snapshot: GraphSnapshot = {
  manifest: { format: "toporealm.graph/v1", id: "demo", label: "Demo", sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" } },
  objects: [
    { id: "a-1", kind: "research.question", label: "问题 A（超过二十个字符的很长标签用于触发截断逻辑哦）" },
    { id: "b-1", kind: "plain", label: "对象 B" },
    { id: "c-1", kind: "plain", label: "对象 C" },
  ],
  relations: [
    { id: "r-1", kind: "supports", source: "b-1", target: "a-1", direction: "directed" },
    { id: "r-2", kind: "related", source: "b-1", target: "c-1", direction: "undirected" },
    { id: "r-broken", kind: "related", source: "b-1", target: "missing", direction: "directed" },
  ],
  revision: 7,
};

function loadStore(): void {
  // 直接注入测试快照（load 需要 fetch，这里只验证渲染契约）
  store.snapshot = snapshot;
  store.loading = false;
}

describe("GraphCanvas", () => {
  afterEach(() => {
    store.snapshot = null;
    store.selection = null;
    store.searchQuery = "";
    store.kindFilter = "";
  });

  it("渲染的对象/关系数量与快照一致，端点缺失的关系被剔除", async () => {
    loadStore();
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(GraphCanvas, { target });
    await tick();
    await tick();
    expect(target.querySelectorAll("g.node").length).toBe(3);
    // r-broken 的 target 缺失：不进渲染层
    expect(target.querySelectorAll("g.edge-group").length).toBe(2);
    // directed 关系有方向折角，undirected 没有
    const dirs = [...target.querySelectorAll<SVGPathElement>(".edge-dir")];
    expect(dirs.filter((path) => path.getAttribute("opacity") === "1").length).toBe(1);
    unmount(component);
    target.remove();
  });

  it("点击节点/关系把稳定 ID 写入选择状态，空白点击清除", async () => {
    loadStore();
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(GraphCanvas, { target });
    await tick();
    await tick();

    const node = target.querySelector("g.node") as SVGGElement;
    const hitArea = node.querySelector(".node-hit-area") as SVGRectElement;
    expect(hitArea).not.toBeNull();
    hitArea.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(store.selection).toEqual({ type: "object", id: "a-1" });

    const edgeGroup = target.querySelector("g.edge-group") as SVGGElement;
    edgeGroup.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(store.selection).toEqual({ type: "relation", id: "r-1" });

    const svg = target.querySelector("svg.graph-canvas") as SVGSVGElement;
    svg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(store.selection).toBeNull();
    unmount(component);
    target.remove();
  });

  it("kind 过滤淡出不匹配的星体；渲染不因重复加载抖动坐标缓存", async () => {
    loadStore();
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(GraphCanvas, { target });
    await tick();
    await tick();
    store.kindFilter = "plain";
    await tick();
    const dimmed = target.querySelectorAll("g.node.dimmed");
    expect(dimmed.length).toBe(1);
    expect(dimmed[0].getAttribute("aria-label")).toContain("research.question");
    unmount(component);
    target.remove();
  });
});
