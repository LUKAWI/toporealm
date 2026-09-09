import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App.svelte";
import { store } from "./lib/store.svelte";

const snapshot = {
  manifest: { format: "toporealm.graph/v1" as const, id: "demo", label: "Demo", sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" } },
  objects: [
    { id: "q-1", kind: "research.question", label: "问题" },
    { id: "e-1", kind: "research.evidence", label: "证据" },
  ],
  relations: [{ id: "rel-1", kind: "supports", source: "e-1", target: "q-1", direction: "directed" as const }],
  revision: 5,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFetch(options: { undoStatus?: number; validateErrors?: number } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/graph")) return jsonResponse(snapshot);
    if (url.endsWith("/api/history")) return jsonResponse({ canUndo: true, canRedo: false });
    if (url.endsWith("/api/graphs")) return jsonResponse({ currentId: "demo", graphs: [{ id: "demo", label: "Demo", revision: 5, objectCount: 2, relationCount: 1 }] });
    if (url.endsWith("/api/modules")) return jsonResponse({ registryRevision: 1, modules: [], ui: {}, operations: [] });
    if (url.endsWith("/api/validate")) {
      const issues = Array.from({ length: options.validateErrors ?? 0 }, (_value, index) => ({ code: `E${index}`, message: `结构错误 ${index}`, severity: "error" }));
      return jsonResponse({ ok: issues.length === 0, complete: false, errors: issues, warnings: [] });
    }
    if (url.endsWith("/api/undo")) {
      if (options.undoStatus === 409) return jsonResponse({ error: { code: "REVISION_CONFLICT", message: "版本已变化" } }, 409);
      return jsonResponse({ ...snapshot, revision: 6, patch: { fromRevision: 5, toRevision: 6, objects: { added: [], updated: [], deleted: [] }, relations: { added: [], updated: [], deleted: [] }, manifestChanged: false } });
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mountApp(): { component: Record<string, unknown>; target: HTMLDivElement } {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const component = mount(App, { target });
  return { component: component as unknown as Record<string, unknown>, target };
}

async function mountLoadedApp(): Promise<{ component: Record<string, unknown>; target: HTMLDivElement }> {
  const mounted = mountApp();
  await vi.waitFor(() => {
    if (!store.snapshot) throw new Error("store.load 尚未完成");
  }, { timeout: 2000 });
  await tick();
  return mounted;
}

describe("App 外壳协议接入", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    store.recovery = null;
    store.snapshot = null;
    store.loading = true;
  });

  it("从真实协议形状加载快照并渲染统计", async () => {
    installFetch();
    const { component, target } = await mountLoadedApp();
    expect(target.querySelector(".stats")?.textContent).toContain("r5");
    expect(target.querySelectorAll(".sb-chip").length).toBe(2);
    unmount(component);
    target.remove();
  });

  it("撤销遇 409：保留本地快照并出现可点击的重载入口，重载后恢复", async () => {
    const fetchMock = installFetch({ undoStatus: 409 });
    const { component, target } = await mountLoadedApp();
    const revisionBefore = store.revision;
    const objectsBefore = store.objects.length;

    const undoButton = [...target.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "撤销");
    if (!undoButton) throw new Error("没有找到撤销按钮");
    undoButton.click();
    await vi.waitFor(() => {
      if (!target.querySelector(".action-chip.recovery")) throw new Error("recovery chip 未出现");
    }, { timeout: 2000 });
    await tick();

    const chip = target.querySelector(".action-chip.recovery");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("REVISION_CONFLICT");
    const reloadButton = chip?.querySelector<HTMLButtonElement>("button");
    expect(reloadButton?.textContent).toContain("重新读取");
    expect(store.snapshot).toMatchObject({ revision: revisionBefore });
    expect(store.objects.length).toBe(objectsBefore);

    fetchMock.mockClear();
    reloadButton?.click();
    await tick();
    await tick();
    const graphCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/graph"));
    expect(graphCalls.length).toBeGreaterThanOrEqual(1);
    expect(target.querySelector(".action-chip.recovery")).toBeNull();
    unmount(component);
    target.remove();
  });

  it("校验浮层区分显示错误与警告清单", async () => {
    installFetch({ validateErrors: 2 });
    const { component, target } = await mountLoadedApp();
    const validateButton = [...target.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "校验");
    validateButton?.click();
    await tick();
    const basicButton = [...target.querySelectorAll<HTMLButtonElement>(".flyout-btn")].find((button) => button.textContent?.includes("基础校验"));
    basicButton?.click();
    await vi.waitFor(() => {
      if (!target.querySelector(".validation-summary")) throw new Error("校验结果未出现");
    }, { timeout: 2000 });
    const summary = target.querySelector(".validation-summary")?.textContent ?? "";
    expect(summary).toContain("2 个错误");
    expect(summary).toContain("仅结构校验");
    expect(summary).toContain("结构错误 0");
    unmount(component);
    target.remove();
  });

  it("只读开关同步到 store，写操作入口禁用", async () => {
    installFetch();
    const { component, target } = await mountLoadedApp();
    const readonlyButton = [...target.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "只读模式");
    readonlyButton?.click();
    await tick();
    expect(store.readOnly).toBe(true);
    const undoButton = [...target.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "撤销");
    expect(undoButton?.disabled).toBe(true);
    unmount(component);
    target.remove();
  });
});
