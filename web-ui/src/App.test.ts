import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App.svelte";
import { store } from "./lib/store.svelte";
import { TopoError } from "./lib/protocol";
import { makeFakeSession, obj, rel, type FakeSessionState } from "./lib/test-support";

function freshState(): FakeSessionState {
  return {
    revision: 5,
    objects: [
      obj("q-1", "research.question", "问题"),
      obj("e-1", "research.evidence", "证据"),
    ],
    relations: [rel("rel-1", "supports", "e-1", "q-1")],
    canUndo: true,
    canRedo: false,
  };
}

function mountApp(): { component: Record<string, unknown>; target: HTMLDivElement } {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const component = mount(App, { target });
  return { component: component as unknown as Record<string, unknown>, target };
}

async function mountLoadedApp(session = makeFakeSession(freshState())): Promise<ReturnType<typeof mountApp> & { session: ReturnType<typeof makeFakeSession> }> {
  store.provider = async () => session;
  const mounted = mountApp();
  await vi.waitFor(() => {
    if (!store.snapshot) throw new Error("store.load 尚未完成");
  }, { timeout: 2000 });
  await tick();
  return { ...mounted, session };
}

describe("App 外壳（1.0 Session 缝接入）", () => {
  afterEach(() => {
    store.dispose();
    store.recovery = null;
    store.snapshot = null;
    store.catalog = null;
    store.loading = true;
    store.error = "";
    store.readOnly = false;
  });

  it("经 Session 契约加载快照并渲染统计（graphId · revision · 计数）", async () => {
    const { component, target } = await mountLoadedApp();
    expect(target.querySelector(".stats")?.textContent).toContain("r5");
    expect(target.querySelectorAll(".sb-chip").length).toBe(2);
    expect(target.querySelector(".graph-label")?.textContent).toContain("demo");
    expect(target.querySelector(".graph-label")?.textContent).toContain("r5");
    // 关系渲染进画布
    expect(target.querySelectorAll("g.node").length).toBe(2);
    expect(target.querySelectorAll("g.edge-group").length).toBe(1);
    unmount(component);
    target.remove();
  });

  it("撤销遇 IF_REVISION_MISMATCH：保留本地快照并出现可点击的重载入口，重载后恢复", async () => {
    const session = makeFakeSession(freshState());
    session.undo = async () => {
      throw new TopoError({ code: "IF_REVISION_MISMATCH", message: "版本已变化" });
    };
    const { component, target } = await mountLoadedApp(session);
    const revisionBefore = store.revision;
    const objectsBefore = store.objects.length;

    const undoButton = [...target.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "撤销")!;
    expect(undoButton.disabled).toBe(false);
    undoButton.click();
    await vi.waitFor(() => {
      if (!store.recovery) throw new Error("recovery 未出现");
    }, { timeout: 2000 });
    await tick();

    // 本地快照保留
    expect(store.revision).toBe(revisionBefore);
    expect(store.objects.length).toBe(objectsBefore);
    // recovery chip + 重载入口
    const chip = target.querySelector(".action-chip.recovery");
    expect(chip?.textContent).toContain("IF_REVISION_MISMATCH");
    const reloadBtn = [...target.querySelectorAll<HTMLButtonElement>(".action-chip button")].find((b) => b.textContent?.includes("重新读取"))!;
    reloadBtn.click();
    await vi.waitFor(() => {
      if (store.recovery !== null) throw new Error("recovery 未清除");
    }, { timeout: 2000 });
    await tick();
    expect(store.snapshot).toMatchObject({ revision: 5 });
    unmount(component);
    target.remove();
  }, 20000);

  it("目录浮层渲染已装载模块与命令计数（catalog 真相）", async () => {
    const { component, target } = await mountLoadedApp();
    const modulesBtn = [...target.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "模块状态")!;
    modulesBtn.click();
    await tick();
    const flyout = target.querySelector(".modules-flyout");
    expect(flyout?.textContent).toContain("research");
    expect(flyout?.textContent).toContain("1.0.0");
    expect(flyout?.textContent).toContain("1 条命令");
    unmount(component);
    target.remove();
  });

  it("外部编辑 reset 事件 → 全量重读自愈（无刷新实时同步）", async () => {
    const session = makeFakeSession(freshState());
    const { component, target } = await mountLoadedApp(session);
    expect(store.objects.map((o) => o.id)).not.toContain("hand-1");

    // daemon 侧吸收外部编辑：state 变化 + reset 事件广播
    session.state.revision += 1;
    session.state.objects = [...session.state.objects, obj("hand-1", "hand", "人手新增")];
    session.emit({ type: "reset", reason: "external-edit" });

    await vi.waitFor(() => {
      if (!store.objects.some((o) => o.id === "hand-1")) throw Error("自愈未完成");
    }, { timeout: 2000 });
    await tick();
    expect(store.snapshot).toMatchObject({ revision: 6 });
    expect(target.querySelector(".stats")?.textContent).toContain("r6");
    expect(store.recovery).toBeNull();
    unmount(component);
    target.remove();
  }, 20000);
});
