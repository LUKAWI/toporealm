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

// ── 1.2.0 G1-8：静态预览整链 mount 级回归（决定性盲区——纯 store 字段断言测不出
//    $state 缺失，43/43 全绿与「切图下拉永不渲染」并存的直接教训）──
describe("App 静态预览整链（1.2.0 G1 mount 级 DOM 断言）", () => {
  const graphs = [
    { id: "demo", revision: 5, current: true },
    { id: "other", revision: 2, current: false },
  ];
  const otherSnapshot = {
    graphId: "other",
    revision: 2,
    entities: [{ id: "o-1", kind: "wf.task", payload: { title: "其它图对象" } }],
  };

  /** /api/graphs 的内存假响应（store 只消费 ok/status/json） */
  function jsonRes(body: unknown, status = 200): { ok: boolean; status: number; json: () => Promise<unknown> } {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  /** 图列表 + other 图快照的 fetch 假件；snapshotStatus 非 2xx 时模拟读取失败 */
  function stubGraphsApi(snapshotStatus = 200, snapshotBody: unknown = otherSnapshot): ReturnType<typeof vi.fn> {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/graphs/other/snapshot")) return jsonRes(snapshotBody, snapshotStatus);
      if (url.includes("/api/graphs")) return jsonRes({ graphs });
      return jsonRes({ error: "unexpected request" }, 404);
    });
  }

  async function mountWithGraphs(fetchMock: ReturnType<typeof vi.fn>): Promise<ReturnType<typeof mountLoadedApp>> {
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountLoadedApp();
    await vi.waitFor(() => {
      if (!mounted.target.querySelector(".graph-select")) throw new Error("graph-select 未渲染（G1-1 响应性断裂）");
    }, { timeout: 2000 });
    await tick();
    return mounted;
  }

  function selectOther(target: HTMLDivElement): void {
    const select = target.querySelector<HTMLSelectElement>(".graph-select")!;
    select.value = "other";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  afterEach(() => {
    store.dispose();
    store.closePreview();
    store.graphsList = [];
    store.actionMessage = "";
    store.recovery = null;
    store.snapshot = null;
    store.catalog = null;
    store.loading = true;
    store.error = "";
    store.readOnly = false;
    vi.unstubAllGlobals();
  });

  it("① refreshGraphs 拉到 2 图后 .graph-select 出现且选项正确", async () => {
    const { component, target } = await mountWithGraphs(stubGraphsApi());
    const options = [...target.querySelectorAll<HTMLOptionElement>(".graph-select option")];
    expect(options.map((o) => o.value)).toEqual(["demo", "other"]);
    expect(options.map((o) => o.textContent?.trim())).toEqual(["demo（编辑中）", "other"]);
    unmount(component);
    target.remove();
  });

  it("② 选择其它图 → 只读预览覆盖层出现：内容为所选图 + toporealm use 指引", async () => {
    const { component, target } = await mountWithGraphs(stubGraphsApi());
    selectOther(target);
    await vi.waitFor(() => {
      if (!target.querySelector(".preview-pane")) throw new Error("preview-pane 未渲染（G1-1 响应性断裂）");
    }, { timeout: 2000 });
    await tick();
    const banner = target.querySelector(".preview-banner")!;
    expect(banner.textContent).toContain("只读预览");
    expect(banner.textContent).toContain("other");
    expect(banner.textContent).toContain("r2");
    expect(banner.textContent).toContain("1 实体");
    expect(banner.querySelector(".preview-hint")?.textContent).toContain("toporealm use other");
    expect(target.querySelectorAll(".preview-item").length).toBe(1);
    expect(target.querySelector(".preview-item")?.textContent).toContain("o-1");
    expect(target.querySelector(".preview-item")?.textContent).toContain("其它图对象");
    unmount(component);
    target.remove();
  });

  it("③ 返回编辑按钮关闭预览，回到编辑态画布", async () => {
    const { component, target } = await mountWithGraphs(stubGraphsApi());
    selectOther(target);
    await vi.waitFor(() => {
      if (!target.querySelector(".preview-pane")) throw new Error("preview-pane 未渲染");
    }, { timeout: 2000 });
    (target.querySelector(".preview-close") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (target.querySelector(".preview-pane")) throw new Error("preview-pane 未关闭");
    }, { timeout: 2000 });
    await tick();
    expect(store.previewGraphId).toBe("");
    expect(store.previewData).toBeNull();
    await vi.waitFor(() => {
      if (target.querySelectorAll("g.node").length !== 2) throw new Error("编辑态画布未恢复");
    }, { timeout: 2000 });
    expect(target.querySelector(".stats")?.textContent).toContain("r5");
    unmount(component);
    target.remove();
  });

  it("④ openPreview 失败 → action-chip 可见反馈且不进预览态（G1-2）", async () => {
    const { component, target } = await mountWithGraphs(stubGraphsApi(404, { error: "快照不可读" }));
    selectOther(target);
    await vi.waitFor(() => {
      const chip = target.querySelector(".action-chip");
      if (!chip || !chip.textContent?.includes("静态预览读取失败")) throw new Error("失败反馈未出现");
      if (!chip.textContent?.includes("快照不可读")) throw new Error("失败原因未透出");
    }, { timeout: 2000 });
    expect(target.querySelector(".preview-pane")).toBeNull();
    expect(store.previewGraphId).toBe("");
    unmount(component);
    target.remove();
  });

  it("⑤ 预览请求在途 → .preview-loading 指示出现，快照落地后退场（G1-5）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { component, target } = await mountWithGraphs(
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/graphs/other/snapshot")) {
          await gate;
          return jsonRes(otherSnapshot);
        }
        if (url.includes("/api/graphs")) return jsonRes({ graphs });
        return jsonRes({ error: "unexpected request" }, 404);
      }),
    );
    selectOther(target);
    await vi.waitFor(() => {
      if (!target.querySelector(".preview-loading")) throw new Error("加载指示未出现");
    }, { timeout: 2000 });
    release();
    await vi.waitFor(() => {
      if (!target.querySelector(".preview-pane")) throw new Error("preview-pane 未渲染");
    }, { timeout: 2000 });
    await tick();
    expect(target.querySelector(".preview-loading")).toBeNull();
    unmount(component);
    target.remove();
  });
});
