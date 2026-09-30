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
    obj("t-1", "wf.task", "带检查点的任务", {
      checkpoints: [
        { id: "cp-1", status: "pending", verifier: "human", label: "人工验收" },
        { id: "cp-2", status: "passed", verifier: "self", label: "自检", by: "main-session", at: "2026-09-30T01:00:00Z" },
      ],
    }),
    obj("a-1", "annotation", "这个任务超范围了", {
      body: "这个任务超范围了",
      motivation: "assessing",
      target: { scope: "node", ref: "t-1" },
      resolved: false,
      author: "user",
      created: "2026-09-30T02:00:00Z",
    }),
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
    { id: "wf.record-checkpoint", module: "workflow", title: "上报检查点", target: "wf.task", input: { type: "object" } },
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
    store.composer = null;
    store.actionMessage = "";
  });

  it("目录 kind 色进入 chip 圆点；D47 写面 = 写批注按钮（通用编辑/命令区已退场）", async () => {
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
    // 审阅写面按钮在场；模块命令按钮不存在
    const labels = [...target.querySelectorAll<HTMLButtonElement>(".drawer button")].map((b) => b.textContent?.trim());
    expect(labels).toContain("写批注");
    expect(labels).toContain("为此类写批注");
    expect(labels.some((t) => t?.includes("research.expand"))).toBe(false);
    unmount(component);
    target.remove();
  });

  it("写批注入口打开 composer（对象/类两种目标）", async () => {
    store.snapshot = snapshot;
    store.catalog = catalog;
    store.selection = { type: "object", id: "q-1" };
    const { component, target } = mountDetail();
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await tick();

    const buttons = [...target.querySelectorAll<HTMLButtonElement>(".drawer button")];
    buttons.find((b) => b.textContent?.trim() === "写批注")!.click();
    await tick();
    expect(store.composer).toEqual({ scope: "node", nodeId: "q-1" });

    buttons.find((b) => b.textContent?.trim() === "为此类写批注")!.click();
    await tick();
    expect(store.composer).toEqual({ scope: "kind", kind: "research.question" });
    unmount(component);
    target.remove();
  });

  it("checkpoint √/×（D49）：无决策条目出按钮，提交带 actor/by=user；已决策条目只读展示", async () => {
    store.snapshot = snapshot;
    store.catalog = catalog;
    store.selection = { type: "object", id: "t-1" };
    const calls: Array<{ commandId: string; target?: string; input?: unknown }> = [];
    store.run = async (commandId: string, opts?: { target?: string; input?: unknown }) => {
      calls.push({ commandId, target: opts?.target, input: opts?.input });
      return { message: "ok", commits: [] };
    };
    const { component, target } = mountDetail();
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await tick();

    const rows = [...target.querySelectorAll<HTMLElement>(".checkpoint-row")];
    expect(rows).toHaveLength(2);
    // pending 条目：√/× 按钮在场
    const passBtn = rows[0].querySelector<HTMLButtonElement>(".cp-btn.pass")!;
    const failBtn = rows[0].querySelector<HTMLButtonElement>(".cp-btn.fail")!;
    expect(passBtn).toBeTruthy();
    expect(failBtn).toBeTruthy();
    // passed 条目：无按钮，只读展示决策人与时间
    expect(rows[1].querySelector(".cp-btn")).toBeNull();
    expect(rows[1].querySelector(".checkpoint-who")?.textContent).toContain("main-session");

    passBtn.click();
    await tick();
    await tick();
    expect(calls).toEqual([
      { commandId: "wf.record-checkpoint", target: "t-1", input: { id: "cp-1", status: "passed", actor: "user", by: "user" } },
    ]);
    failBtn.click();
    await tick();
    await tick();
    expect(calls[1]?.input).toMatchObject({ id: "cp-1", status: "failed" });
    unmount(component);
    target.remove();
  });

  it("checkpoint 命令缺席（workflow 未装载）→ 只读降级提示", async () => {
    store.snapshot = snapshot;
    store.catalog = { modules: [], kinds: [], commands: [] };
    store.selection = { type: "object", id: "t-1" };
    const { component, target } = mountDetail();
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await tick();

    expect(target.querySelector(".drawer")?.textContent).toContain("workflow 模块未装载");
    expect(target.querySelector(".checkpoint-row .cp-btn")).toBeNull();
    unmount(component);
    target.remove();
  });

  it("批注对象（D48）专属呈现：内容/意图/目标跳转/收口操作，无写批注按钮", async () => {
    store.snapshot = snapshot;
    store.catalog = catalog;
    store.selection = { type: "object", id: "a-1" };
    const resolved: Array<[string, boolean]> = [];
    store.setAnnotationResolved = async (id: string, value: boolean) => {
      resolved.push([id, value]);
      return { revision: 4, created: [], patch: {
        fromRevision: 3, toRevision: 4,
        objects: { added: [], updated: [], deleted: [] },
        relations: { added: [], updated: [], deleted: [] },
      }, canUndo: true, canRedo: false };
    };
    const { component, target } = mountDetail();
    await tick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await tick();

    const drawer = target.querySelector(".drawer")!;
    expect(drawer.textContent).toContain("这个任务超范围了");
    expect(drawer.textContent).toContain("评审意见");
    expect(drawer.textContent).toContain("未解决");
    expect(drawer.textContent).toContain("user");
    // 收口操作（在跳转前做——跳转会把抽屉切到宿主对象）
    const resolveBtn = [...target.querySelectorAll<HTMLButtonElement>(".drawer button")].find((b) => b.textContent?.includes("标记已解决"))!;
    resolveBtn.click();
    await tick();
    await tick();
    expect(resolved).toEqual([["a-1", true]]);
    // 批注对象不再提供写批注入口
    expect([...target.querySelectorAll<HTMLButtonElement>(".drawer button")].some((b) => b.textContent?.trim() === "写批注")).toBe(false);
    // 目标跳转（node 锚定 → 可跳到宿主）
    const jump = [...target.querySelectorAll<HTMLButtonElement>(".drawer .endpoint-link")].find((b) => b.textContent?.trim() === "t-1");
    expect(jump).toBeTruthy();
    jump!.click();
    await tick();
    expect(store.selection).toEqual({ type: "object", id: "t-1" });
    unmount(component);
    target.remove();
  });

  it("未注册命名空间：降级提示可见、payload 折叠块仍可查看", async () => {
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
    // 原始 payload 可见
    const toggle = [...target.querySelectorAll<HTMLButtonElement>(".json-toggle")].find((button) => button.textContent?.includes("payload"));
    toggle?.click();
    await tick();
    expect(target.querySelector(".json-body")?.textContent).toContain('"raw": 1');
    unmount(component);
    target.remove();
  });
});
