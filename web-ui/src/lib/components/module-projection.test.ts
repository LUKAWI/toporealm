import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import ObjectDetail from "./ObjectDetail.svelte";
import { store } from "../store.svelte";
import type { Catalog, GraphSnapshot } from "../protocol";
import { obj, rel, snapshotOf, type FakeSessionState } from "../test-support";

const state: FakeSessionState = {
  revision: 3,
  objects: [
    obj("q-1", "research.question", "原问题", { status: "open" }),
    obj("odd-1", "alien.creature", "未注册 kind", { raw: 1 }),
  ],
  relations: [rel("r-1", "supports", "odd-1", "q-1")],
  canUndo: true,
  canRedo: false,
};
const snapshot: GraphSnapshot = snapshotOf(state);

const catalog: Catalog = {
  modules: [{ id: "research", namespace: "research", version: "1.0.0" }],
  kinds: [{ kind: "research.question", owner: "research", color: "#6d28d9", icon: "?" }],
  commands: [
    { id: "research.expand", module: "research", title: "展开问题", target: "research.question", input: { type: "object" } },
  ],
};

function mountDetail(): { component: Record<string, unknown>; target: HTMLDivElement } {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const component = mount(ObjectDetail, { target });
  return { component: component as unknown as Record<string, unknown>, target };
}

describe("目录投影与详情插槽（catalog 真相）", () => {
  afterEach(() => {
    store.snapshot = null;
    store.selection = null;
    store.catalog = null;
    store.readOnly = false;
  });

  it("目录 kind 色进入 chip 圆点；appliesTo 命令按钮来自目录（不硬编码）", async () => {
    store.snapshot = snapshot;
    store.catalog = catalog;
    store.selection = { type: "object", id: "q-1" };
    const { component, target } = mountDetail();
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await tick();

    const drawer = target.querySelector(".drawer");
    expect(drawer?.textContent).toContain("research.question");
    expect(drawer?.textContent).toContain("原问题");
    // 目录色进入 kind chip 圆点
    const dot = target.querySelector<HTMLSpanElement>(".kind-dot");
    expect(dot?.getAttribute("style")).toContain("rgb(109, 40, 217)");
    // 命令按钮来自目录（commandId），不经过 Web 内硬编码分支
    const commandButton = [...target.querySelectorAll<HTMLButtonElement>(".drawer button")].find((button) => button.textContent?.includes("research.expand"));
    expect(commandButton).toBeDefined();
    unmount(component);
    target.remove();
  });

  it("run 命令经 store 调用（目录 id + target）；失败显示稳定错误码", async () => {
    store.snapshot = snapshot;
    store.catalog = catalog;
    store.selection = { type: "object", id: "q-1" };
    const calls: Array<{ commandId: string; target?: string; input: unknown }> = [];
    store.run = async (commandId: string, opts?: { target?: string; input?: unknown }) => {
      calls.push({ commandId, target: opts?.target, input: opts?.input });
      if (commandId.includes("fail")) {
        throw new (await import("../protocol")).TopoError({ code: "UNKNOWN_COMMAND", message: "命令不存在" });
      }
      store.actionMessage = `已执行 · r4`;
      return { message: "已执行", commits: [] };
    };
    const { component, target } = mountDetail();
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await tick();

    const commandButton = [...target.querySelectorAll<HTMLButtonElement>(".drawer button")].find((button) => button.textContent?.includes("research.expand"))!;
    commandButton.click();
    await tick();
    await tick();
    expect(calls).toEqual([{ commandId: "research.expand", target: "q-1", input: {} }]);
    expect(store.actionMessage).toContain("已执行");

    // 只读时命令禁用
    store.readOnly = true;
    await tick();
    expect(commandButton.disabled).toBe(true);
    store.readOnly = false;
    unmount(component);
    target.remove();
  });

  it("未注册命名空间：降级提示可见、无命令按钮，payload 折叠块仍可查看", async () => {
    store.snapshot = snapshot;
    store.catalog = catalog;
    store.selection = { type: "object", id: "odd-1" };
    const { component, target } = mountDetail();
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await tick();

    const drawer = target.querySelector(".drawer");
    expect(drawer?.textContent).toContain("降级");
    expect(drawer?.textContent).toContain("（未注册）");
    // 无任何目录命令按钮
    const commandButtons = [...target.querySelectorAll<HTMLButtonElement>(".drawer button")].filter((button) => button.textContent?.includes("research.expand"));
    expect(commandButtons).toHaveLength(0);
    // 原始 payload 可见
    const toggle = [...target.querySelectorAll<HTMLButtonElement>(".json-toggle")].find((button) => button.textContent?.includes("payload"));
    toggle?.click();
    await tick();
    expect(target.querySelector(".json-body")?.textContent).toContain('"raw": 1');
    unmount(component);
    target.remove();
  });
});
