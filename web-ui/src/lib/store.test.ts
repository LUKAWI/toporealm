import { afterEach, describe, expect, it, vi } from "vitest";
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

// ── 1.2.0 G1：静态预览路径 + 会话生命周期（此前纯 store 字段断言测不出 $state 缺失，
//    mount 级 DOM 断言在 App.test.ts；这里是 store 公共缝的行为面）──
describe("静态预览与会话生命周期（1.2.0 G1）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** /api/graphs 的内存假响应（store 只消费 ok/status/json） */
  function jsonRes(body: unknown, status = 200): { ok: boolean; status: number; json: () => Promise<unknown> } {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  it("openPreview：拉取快照进 previewData，closePreview 清场", async () => {
    const { store } = await loadedStore();
    const fetchMock = vi.fn(async () =>
      jsonRes({ graphId: "b", revision: 2, entities: [{ id: "b-1", kind: "plain", payload: { title: "B" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await store.openPreview("b");
    expect(fetchMock).toHaveBeenCalledWith("/api/graphs/b/snapshot");
    expect(store.previewGraphId).toBe("b");
    expect(store.previewData).toMatchObject({ graphId: "b", revision: 2 });
    expect(store.previewLoading).toBe(false);
    store.closePreview();
    expect(store.previewGraphId).toBe("");
    expect(store.previewData).toBeNull();
    expect(store.previewLoading).toBe(false);
  });

  it("openPreview 失败：进 actionMessage 可见反馈而非黑洞 error（G1-2）", async () => {
    const { store } = await loadedStore();
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ error: "图不可读" }, 404)));
    await store.openPreview("b");
    expect(store.previewGraphId).toBe("");
    expect(store.previewData).toBeNull();
    expect(store.actionMessage).toContain("静态预览读取失败");
    expect(store.actionMessage).toContain("图不可读");
    // error 保持「无快照」全屏错误态语义：不残留预览失败（否则压住 reloadFromEvent 的状态提示）
    expect(store.error).toBe("");
  });

  it("预览 in-flight 守卫：后发请求胜出，先发响应作废不落地（G1-5）", async () => {
    const { store } = await loadedStore();
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/a/snapshot")) {
          await gateA;
          return jsonRes({ graphId: "a", revision: 1, entities: [] });
        }
        return jsonRes({ graphId: "b", revision: 2, entities: [] });
      }),
    );
    const first = store.openPreview("a");
    const second = store.openPreview("b");
    releaseA();
    await Promise.all([first, second]);
    expect(store.previewGraphId).toBe("b");
    expect(store.previewData).toMatchObject({ graphId: "b" });
    expect(store.previewLoading).toBe(false);
  });

  it("closePreview 作废在途预览响应（G1-5）", async () => {
    const { store } = await loadedStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return jsonRes({ graphId: "a", revision: 1, entities: [] });
      }),
    );
    const pending = store.openPreview("a");
    store.closePreview();
    release();
    await pending;
    expect(store.previewGraphId).toBe("");
    expect(store.previewData).toBeNull();
    expect(store.previewLoading).toBe(false);
  });

  it("load 重读前先关闭旧会话：reset 自愈不泄漏 WS 连接（G1-3）", async () => {
    const state = initialState();
    const sessions: ReturnType<typeof makeFakeSession>[] = [];
    const store = new WebGraphStore(async () => {
      const session = makeFakeSession(state);
      sessions.push(session);
      return session;
    });
    await store.load();
    expect(sessions).toHaveLength(1);

    // daemon 侧外部编辑 → reset 事件 → reloadFromEvent → load：旧会话必须被关闭
    state.revision += 1;
    state.objects = [...state.objects, obj("hand-1", "hand", "人手改")];
    sessions[0].emit({ type: "reset", reason: "external-edit" });
    await vi.waitFor(() => expect(sessions.length).toBe(2));
    await vi.waitFor(() => expect(sessions[0].calls.close).toBe(1));
    expect(sessions[1].calls.read).toBe(1);

    // 旧会话已退订：旧会话再广播事件不触发新的重读
    const readsAfterReload = sessions[1].calls.read;
    sessions[0].emit({ type: "reset", reason: "daemon-restarted" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessions[1].calls.read).toBe(readsAfterReload);

    // dispose 收口最后一个会话
    store.dispose();
    expect(sessions[1].calls.close).toBe(1);
  });

  it("graph-switched reset：全量重读 + 提示切换后的目标图（G1-4）", async () => {
    const state = initialState();
    const session = makeFakeSession(state);
    const store = new WebGraphStore(async () => session);
    await store.load();
    session.emit({ type: "reset", reason: "graph-switched", graphId: "g-next" });
    await vi.waitFor(() => expect(session.calls.read).toBe(2));
    expect(store.actionMessage).toContain("已切换到图");
    expect(store.actionMessage).toContain("g-next");
    expect(store.actionMessage).not.toContain("daemon 已重启");
  });
});
