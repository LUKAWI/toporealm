import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import EditorPanel from "./EditorPanel.svelte";
import { store } from "../store.svelte";
import { GraphApiError, type GraphSnapshot, type MutationPlan } from "../protocol";

const snapshot: GraphSnapshot = {
  manifest: { format: "toporealm.graph/v1", id: "demo", label: "Demo", sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" } },
  objects: [{ id: "q-1", kind: "research.question", label: "原问题", data: { status: "open" } }],
  relations: [],
  revision: 4,
};

function mountPanel(): { component: Record<string, unknown>; target: HTMLDivElement } {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const component = mount(EditorPanel, { target });
  return { component: component as unknown as Record<string, unknown>, target };
}

describe("EditorPanel 通用编辑流", () => {
  afterEach(() => {
    store.snapshot = null;
    store.editor = null;
    store.readOnly = false;
  });

  it("新增对象：提交统一 MutationPlan 且成功后关闭", async () => {
    store.snapshot = snapshot;
    const plans: MutationPlan[] = [];
    store.commit = async (plan: MutationPlan) => {
      plans.push(plan);
      store.actionMessage = `已保存 r${5}`;
      return {
        snapshot: { ...snapshot, revision: 5 },
        patch: { fromRevision: 4, toRevision: 5, objects: { added: [], updated: [], deleted: [] }, relations: { added: [], updated: [], deleted: [] }, manifestChanged: false },
        history: { canUndo: true, canRedo: false },
      };
    };
    store.openEditor("create-object");
    const { component, target } = mountPanel();
    await tick();

    const inputs = [...target.querySelectorAll<HTMLInputElement>(".field-input")];
    inputs.find((input) => input.placeholder?.includes("note-9"))!.value = "note-9";
    inputs.find((input) => input.placeholder?.includes("note-9"))!.dispatchEvent(new Event("input", { bubbles: true }));
    const kindInput = inputs.find((input) => input.getAttribute("list") === "known-kinds")!;
    kindInput.value = "plain";
    kindInput.dispatchEvent(new Event("input", { bubbles: true }));
    const labelInput = inputs.find((input) => input.placeholder?.includes("人类可读"))!;
    labelInput.value = "新对象";
    labelInput.dispatchEvent(new Event("input", { bubbles: true }));
    const dataInput = target.querySelector("textarea")!;
    dataInput.value = '{"k": 1}';
    dataInput.dispatchEvent(new Event("input", { bubbles: true }));

    target.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    await tick();
    expect(plans).toHaveLength(1);
    expect(plans[0].mutations[0]).toMatchObject({ op: "upsert_object", object: { id: "note-9", kind: "plain", label: "新对象", data: { k: 1 } } });
    expect(store.editor).toBeNull();
    unmount(component);
    target.remove();
  });

  it("连接流：从选中对象预填 source；data 非法 JSON 保留输入并显示错误", async () => {
    store.snapshot = snapshot;
    store.openEditor("create-relation", { sourceId: "q-1" });
    const { component, target } = mountPanel();
    await tick();

    const inputs = [...target.querySelectorAll<HTMLInputElement>(".field-input")];
    const sourceInput = inputs.find((input) => input.placeholder === "起点对象 ID")!;
    expect(sourceInput.value).toBe("q-1");

    // data 非法 JSON
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
      throw new GraphApiError("REVISION_CONFLICT", "版本已变化", 409);
    };
    store.openEditor("edit-object", { targetId: "q-1" });
    const { component, target } = mountPanel();
    await tick();
    await tick();

    const labelInput = [...target.querySelectorAll<HTMLInputElement>(".field-input")].find((input) => input.placeholder?.includes("人类可读"))!;
    labelInput.value = "用户正在修改的标签";
    labelInput.dispatchEvent(new Event("input", { bubbles: true }));
    target.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      if (!target.querySelector(".form-error")) throw new Error("错误提示未出现");
    }, { timeout: 2000 });
    await tick();

    const errorBox = target.querySelector(".form-error");
    expect(errorBox?.textContent).toContain("REVISION_CONFLICT");
    expect(errorBox?.querySelector(".mini-btn")?.textContent).toContain("重新读取");
    // 输入保留，编辑器未关闭
    expect((labelInput as HTMLInputElement).value).toBe("用户正在修改的标签");
    expect(store.editor).not.toBeNull();

    const reload = vi.spyOn(store, "reload").mockResolvedValue();
    (errorBox?.querySelector(".mini-btn") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (target.querySelector(".form-error")) throw new Error("重新读取后旧冲突仍然可见");
    }, { timeout: 2000 });
    expect(reload).toHaveBeenCalledOnce();
    expect((labelInput as HTMLInputElement).value).toBe("用户正在修改的标签");
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
