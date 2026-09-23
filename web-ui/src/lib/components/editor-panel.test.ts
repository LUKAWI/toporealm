import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import EditorPanel from "./EditorPanel.svelte";
import { store } from "../store.svelte";
import { TopoError, type Change, type CommitResult, type GraphSnapshot } from "../protocol";
import { obj, snapshotOf, type FakeSessionState } from "../test-support";

const state: FakeSessionState = {
  revision: 4,
  objects: [obj("q-1", "research.question", "原问题", { status: "open" })],
  relations: [],
  canUndo: true,
  canRedo: false,
};
const snapshot: GraphSnapshot = snapshotOf(state);

function fakeResult(revision: number): CommitResult {
  return {
    revision,
    created: [],
    patch: { fromRevision: revision - 1, toRevision: revision, objects: { added: [], updated: [], deleted: [] }, relations: { added: [], updated: [], deleted: [] } },
    canUndo: true,
    canRedo: false,
  };
}

function mountPanel(): { component: Record<string, unknown>; target: HTMLDivElement } {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const component = mount(EditorPanel, { target });
  return { component: component as unknown as Record<string, unknown>, target };
}

describe("EditorPanel 通用编辑流（Change[] 提交）", () => {
  afterEach(() => {
    store.snapshot = null;
    store.editor = null;
    store.readOnly = false;
  });

  it("新增对象：提交 Change[]（put + payload.title）且成功后关闭", async () => {
    store.snapshot = snapshot;
    const commits: Array<{ changes: readonly Change[]; label?: string }> = [];
    store.commit = async (input) => {
      commits.push(input);
      store.actionMessage = `已保存 r5`;
      return fakeResult(5);
    };
    store.openEditor("create-object");
    const { component, target } = mountPanel();
    await tick();

    const inputs = [...target.querySelectorAll<HTMLInputElement>(".field-input")];
    const idInput = inputs.find((input) => input.placeholder?.includes("note-9"))!;
    idInput.value = "note-9";
    idInput.dispatchEvent(new Event("input", { bubbles: true }));
    const kindInput = inputs.find((input) => input.getAttribute("list") === "known-kinds")!;
    kindInput.value = "plain";
    kindInput.dispatchEvent(new Event("input", { bubbles: true }));
    const titleInput = inputs.find((input) => input.placeholder?.includes("人类可读"))!;
    titleInput.value = "新对象";
    titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    const payloadInput = target.querySelector("textarea")!;
    payloadInput.value = '{"k": 1}';
    payloadInput.dispatchEvent(new Event("input", { bubbles: true }));

    target.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    await tick();
    expect(commits).toHaveLength(1);
    expect(commits[0].label).toBe("create-object");
    expect(commits[0].changes[0]).toMatchObject({
      op: "put",
      kind: "plain",
      id: "note-9",
      payload: { k: 1, title: "新对象" },
    });
    expect(store.editor).toBeNull();
    unmount(component);
    target.remove();
  });

  it("编辑对象预填 payload；保存走 put 整体替换语义", async () => {
    store.snapshot = snapshot;
    const commits: Array<{ changes: readonly Change[] }> = [];
    store.commit = async (input) => {
      commits.push(input);
      return fakeResult(5);
    };
    store.openEditor("edit-object", { targetId: "q-1" });
    const { component, target } = mountPanel();
    await tick();
    await tick();

    // 预填：kind/标题/payload
    const kindInput = [...target.querySelectorAll<HTMLInputElement>(".field-input")].find((input) => input.getAttribute("list") === "known-kinds")!;
    expect(kindInput.value).toBe("research.question");
    const titleInput = [...target.querySelectorAll<HTMLInputElement>(".field-input")].find((input) => input.placeholder?.includes("人类可读"))!;
    expect(titleInput.value).toBe("原问题");
    const textarea = target.querySelector("textarea")!;
    expect(JSON.parse(textarea.value)).toMatchObject({ status: "open", title: "原问题" });

    // 修改 payload：status 删除（put 整体替换）
    textarea.value = '{"title": "原问题", "status": "done"}';
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    target.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(commits).toHaveLength(1);
    expect(commits[0].changes[0]).toMatchObject({ op: "put", id: "q-1", kind: "research.question" });
    expect((commits[0].changes[0] as { payload: Record<string, unknown> }).payload).toEqual({ status: "done", title: "原问题" });
    unmount(component);
    target.remove();
  });

  it("连接流：从选中对象预填 source；payload 非法 JSON 保留输入并显示错误", async () => {
    store.snapshot = snapshot;
    store.openEditor("create-relation", { sourceId: "q-1" });
    const { component, target } = mountPanel();
    await tick();

    const inputs = [...target.querySelectorAll<HTMLInputElement>(".field-input")];
    const sourceInput = inputs.find((input) => input.placeholder === "起点对象 ID")!;
    expect(sourceInput.value).toBe("q-1");

    const textarea = target.querySelector("textarea")!;
    textarea.value = "{broken";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    target.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    await tick();
    expect(target.querySelector(".form-error")?.textContent).toContain("INVALID_JSON");
    // 输入保留
    expect(sourceInput.value).toBe("q-1");
    expect(store.editor).not.toBeNull();
    unmount(component);
    target.remove();
  });

  it("提交冲突：保留输入、显示稳定错误码并提供重新读取", async () => {
    store.snapshot = snapshot;
    store.commit = async () => {
      throw new TopoError({ code: "IF_REVISION_MISMATCH", message: "版本已变化" });
    };
    store.openEditor("edit-object", { targetId: "q-1" });
    const { component, target } = mountPanel();
    await tick();
    await tick();

    const titleInput = [...target.querySelectorAll<HTMLInputElement>(".field-input")].find((input) => input.placeholder?.includes("人类可读"))!;
    titleInput.value = "用户正在修改的标题";
    titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    target.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      if (!target.querySelector(".form-error")) throw new Error("错误提示未出现");
    }, { timeout: 2000 });
    await tick();

    const errorBox = target.querySelector(".form-error");
    expect(errorBox?.textContent).toContain("IF_REVISION_MISMATCH");
    expect(errorBox?.querySelector(".mini-btn")?.textContent).toContain("重新读取");
    // 输入保留，编辑器未关闭
    expect((titleInput as HTMLInputElement).value).toBe("用户正在修改的标题");
    expect(store.editor).not.toBeNull();

    const reload = vi.spyOn(store, "reload").mockResolvedValue();
    (errorBox?.querySelector(".mini-btn") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (reload.mock.calls.length === 0) throw new Error("重新读取未触发");
    }, { timeout: 2000 });
    expect(reload).toHaveBeenCalledOnce();
    expect((titleInput as HTMLInputElement).value).toBe("用户正在修改的标题");
    reload.mockRestore();
    unmount(component);
    target.remove();
  });

  it("只读模式：写入口禁用且无法打开编辑器", async () => {
    store.snapshot = snapshot;
    store.readOnly = true;
    store.openEditor("create-object");
    expect(store.editor).toBeNull();
    store.editor = { mode: "create-object" };
    const { component, target } = mountPanel();
    await tick();
    expect(target.querySelector(".readonly-note")).not.toBeNull();
    const submit = target.querySelector<HTMLButtonElement>("button[type=submit]");
    expect(submit?.disabled).toBe(true);
    unmount(component);
    target.remove();
  });
});
