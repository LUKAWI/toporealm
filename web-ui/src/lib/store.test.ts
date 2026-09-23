import { describe, expect, it, vi } from "vitest";
import { TopoError, type Change, type TopoEvent } from "./protocol";
import { WebGraphStore } from "./store.svelte";
import { makeFakeSession, obj, rel, type FakeSessionState } from "./test-support";

function initialState(): FakeSessionState {
  return {
    revision: 5,
    objects: [obj("q-1", "research.question", "问题")],
    relations: [],
    canUndo: true,
    canRedo: false,
  };
}

async function loadedStore(overrides: {
  state?: FakeSessionState;
  onCommit?: (changes: readonly Change[]) => Promise<void> | void;
  failUndoWith?: TopoError;
} = {}) {
  const session = makeFakeSession(overrides.state ?? initialState(), {
    ...(overrides.onCommit !== undefined ? { onCommit: overrides.onCommit } : {}),
    ...(overrides.failUndoWith !== undefined ? { failUndoWith: overrides.failUndoWith } : {}),
  });
  const store = new WebGraphStore(async () => session);
  await store.load();
  return { store, session };
}

describe("WebGraphStore（1.0 Session 契约）", () => {
  it("load：read 拆桶为快照、status 供 undo/redo 可用性、catalog 进目录", async () => {
    const { store, session } = await loadedStore();
    expect(store.snapshot).toMatchObject({ graphId: "demo", revision: 5, objects: [{ id: "q-1" }], relations: [] });
    expect(store.history).toEqual({ canUndo: true, canRedo: false });
    expect(store.catalog?.commands).toHaveLength(1);
    expect(store.error).toBe("");
    expect(session.calls.catalog).toBe(1);
  });

  it("commit：Change[] + ifRevision 乐观护航；回执 patch 应用本地视图", async () => {
    const { store, session } = await loadedStore();
    const result = await store.commit({
      changes: [{ op: "put", kind: "plain", id: "n-1", payload: { title: "新对象" } }],
      label: "add",
    });
    expect(result.revision).toBe(6);
    expect(store.revision).toBe(6);
    expect(store.objects.map((o) => o.id)).toContain("n-1");
    expect(store.history.canUndo).toBe(true);
    expect(session.calls.commit).toBe(1);
    // 读回假件状态：payload 整体替换 + title 约定键
    expect(session.state.objects.find((o) => o.id === "n-1")?.payload).toMatchObject({ title: "新对象" });
  });

  it("IF_REVISION_MISMATCH 进 recovery：本地快照不变，reload 恢复并清除", async () => {
    const conflict = new TopoError({ code: "IF_REVISION_MISMATCH", message: "版本已变化" });
    const { store } = await loadedStore({ onCommit: () => { throw conflict; } });
    const before = store.snapshot;
    await expect(store.commit({ changes: [{ op: "del", id: "q-1" }] })).rejects.toMatchObject({ code: "IF_REVISION_MISMATCH" });
    expect(store.recovery).toMatchObject({ code: "IF_REVISION_MISMATCH" });
    expect(store.snapshot).toEqual(before);
    await store.reload();
    expect(store.recovery).toBeNull();
    expect(store.snapshot).toMatchObject({ revision: 5 });
  });

  it("实时 commit 事件应用本地视图；缺口触发全量重读自愈（I3）", async () => {
    const state = initialState();
    const session = makeFakeSession(state);
    const store = new WebGraphStore(async () => session);
    await store.load();

    // 连续事件：正常推进
    const before = JSON.parse(JSON.stringify(session.state)) as FakeSessionState;
    state.revision += 1;
    state.objects = [...state.objects, obj("live-1", "plain", "实时")];
    session.emit({
      type: "commit",
      revision: state.revision,
      patch: {
        fromRevision: before.revision,
        toRevision: state.revision,
        objects: { added: [obj("live-1", "plain", "实时")], updated: [], deleted: [] },
        relations: { added: [], updated: [], deleted: [] },
      },
      origin: "cli",
    });
    await vi.waitFor(() => expect(store.revision).toBe(6));
    expect(store.objects.map((o) => o.id)).toContain("live-1");

    // 缺口事件（fromRevision 跳号）→ recovery + 全量重读自愈
    state.revision += 2; // 本地 6 → 服务器顶 8
    state.objects = [obj("fresh", "plain", "服务器快照")];
    const readCount = session.calls.read;
    session.emit({
      type: "commit",
      revision: state.revision,
      patch: { fromRevision: 7, toRevision: state.revision, objects: { added: [], updated: [], deleted: [] }, relations: { added: [], updated: [], deleted: [] } },
      origin: "cli",
    });
    await vi.waitFor(() => expect(store.revision).toBe(8));
    expect(store.objects.map((o) => o.id)).toEqual(["fresh"]);
    expect(session.calls.read).toBeGreaterThan(readCount);
    // 自愈完成：recovery 清除，留下一句可见的状态说明
    expect(store.recovery).toBeNull();
    expect(store.actionMessage).toContain("完整快照");
  });

  it("reset 事件（外部编辑/daemon 重启）→ 全量重读 + 目录缓存作废重拉", async () => {
    const state = initialState();
    const session = makeFakeSession(state);
    const store = new WebGraphStore(async () => session);
    await store.load();
    expect(session.calls.catalog).toBe(1);

    state.revision += 1;
    state.objects = [obj("hand-1", "hand", "人手改"), rel("r-1", "supports", "hand-1", "q-1")];
    session.emit({ type: "reset", reason: "external-edit" });
    await vi.waitFor(() => expect(session.calls.read).toBe(2));
    expect(store.objects.map((o) => o.id)).toContain("hand-1");
    expect(store.relations).toHaveLength(1);
    expect(session.calls.catalog).toBe(2); // 目录缓存作废重拉（blueprint §5）
    expect(store.recovery).toBeNull();
  });

  it("undo 冲突进 recovery；只读模式不发请求", async () => {
    const { store, session } = await loadedStore({
      failUndoWith: new TopoError({ code: "IF_REVISION_MISMATCH", message: "版本已变化" }),
    });
    await store.undo();
    expect(store.recovery).toMatchObject({ code: "IF_REVISION_MISMATCH" });
    expect(store.snapshot).toMatchObject({ revision: 5 });

    const roSession = makeFakeSession(initialState());
    const roStore = new WebGraphStore(async () => roSession);
    await roStore.load();
    roStore.readOnly = true;
    await roStore.undo();
    expect(roStore.actionMessage).toContain("只读");
    expect(roSession.calls.undo).toBeUndefined();
  });

  it("run：目录命令的 commits 按序回灌本地视图", async () => {
    const state = initialState();
    const session = makeFakeSession(state);
    const store = new WebGraphStore(async () => session);
    await store.load();
    // 直接构造带 commits 的 run 结果：命令内两次提交
    const s = session as unknown as { run: (id: string, opts?: object) => Promise<{ message?: string; commits?: unknown[] }> };
    s.run = async () => {
      const c1 = session.commit({ changes: [{ op: "put", kind: "wf.task", id: "t-1" }] });
      const c2 = session.commit({ changes: [{ op: "merge", id: "t-1", payload: { status: "ready" } }] });
      return { message: "done", commits: [await c1, await c2] };
    };
    const result = await store.run("research.expand", { target: "q-1", input: {} });
    expect(result.message).toBe("done");
    expect(store.revision).toBe(7);
    expect(store.objects.map((o) => o.id)).toContain("t-1");
  });

  it("非恢复错误不进 recovery，原样上抛", async () => {
    const veto = new TopoError({ code: "VETOED", message: "模块否决" });
    const { store } = await loadedStore({ onCommit: () => { throw veto; } });
    await expect(store.commit({ changes: [{ op: "put", kind: "x", id: "y" }] })).rejects.toMatchObject({ code: "VETOED" });
    expect(store.recovery).toBeNull();
  });

  it("写请求在途时拒绝第二次写入", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const state = initialState();
    const session = makeFakeSession(state, {
      onCommit: async () => {
        await gate;
      },
    });
    const store = new WebGraphStore(async () => session);
    await store.load();
    const first = store.commit({ changes: [{ op: "put", kind: "x", id: "a" }] });
    await expect(store.commit({ changes: [{ op: "put", kind: "x", id: "b" }] })).rejects.toMatchObject({ code: "WRITE_IN_PROGRESS" });
    release();
    await first;
    expect(store.writing).toBe(false);
  });
});
