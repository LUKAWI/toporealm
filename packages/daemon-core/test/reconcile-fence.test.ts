import { describe, expect, it, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonCore, graphPaths } from "../src/index.js";

// store.js 部分替身：仅拦 loadEntities，其余导出原样透传。intercept 为空时行为
// 与真模块完全一致（DaemonCore.open 走真实装载）。用闸门把「读盘横跨提交」的
// 竞态确定性摆出来——真实触发需要 watch 事件与提交时序巧合，无法稳定复现。
type LoadEntitiesFn = typeof import("../src/store.js").loadEntities;
type LoadEntitiesParam = Parameters<LoadEntitiesFn>[0];
type DiskEntities = Awaited<ReturnType<LoadEntitiesFn>>;

const fence = vi.hoisted(() => ({
  intercept: null as null | ((p: LoadEntitiesParam) => Promise<DiskEntities>),
  realLoad: null as LoadEntitiesFn | null,
}));

vi.mock("../src/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store.js")>();
  fence.realLoad = actual.loadEntities;
  return {
    ...actual,
    loadEntities: (p: LoadEntitiesParam): Promise<DiskEntities> =>
      fence.intercept ? fence.intercept(p) : actual.loadEntities(p),
  };
});

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function tmpWorkspace(label = "g1"): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-fence-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, label);
  return root;
}

/** 把 loadEntities 换成「真实读盘后停在闸门前、放行后返回过期快照」的版本。 */
function parkLoadDuring(parked: { resolve: () => void }, gate: { promise: Promise<void> }): void {
  fence.intercept = async (p) => {
    const snap = await fence.realLoad!(p);
    parked.resolve();
    await gate.promise;
    return snap;
  };
}

describe("外部吸收快照新鲜度栅栏（dev 图 rev 433 误删 domain-beta 竞态回归）", () => {
  it("读盘横跨已落地的提交：丢弃过期快照，不把刚提交的实体误判为外部删除", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    await core.commit(
      { changes: [{ op: "put", kind: "wf.domain", id: "domain-alpha", payload: { title: "A" } }] },
      "cli",
    );
    const parked = defer();
    const gate = defer();
    parkLoadDuring(parked, gate);
    const reconciling = core.reconcileExternal();
    await parked.promise;
    // 提交在读盘窗口内入队并落地（对应真实竞态中的 rev 432）；external 转换
    // 排在其后执行——没有栅栏时会把过期快照判出的 del 应用到落地后的图上
    await core.commit(
      { changes: [{ op: "put", kind: "wf.domain", id: "domain-beta", payload: { title: "B" } }] },
      "cli",
    );
    gate.resolve();
    const absorbed = await reconciling;
    fence.intercept = null;
    expect(absorbed).toBe(false);
    // domain-beta 存活：内存、提交日志无 external、磁盘文件仍在
    expect(core.read({ ids: ["domain-beta"] }).entities).toHaveLength(1);
    expect(core.tailLog().some((e) => e.kind === "external")).toBe(false);
    await expect(
      fsp.access(path.join(graphPaths(root, "g1").objects, "domain-beta.yaml")),
    ).resolves.toBeUndefined();
    core.dispose();
  });

  it("已入队未落地的提交同样触发栅栏：仅 revision 比对拦不住的排序竞态", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    await core.commit(
      { changes: [{ op: "put", kind: "wf.domain", id: "domain-alpha", payload: { title: "A" } }] },
      "cli",
    );
    const parked = defer();
    const gate = defer();
    parkLoadDuring(parked, gate);
    const reconciling = core.reconcileExternal();
    await parked.promise;
    // 只入队不等待：convert 同步入队（管线忙碌计数 >0），落盘尚未完成、revision 未动。
    // 若栅栏只看 revision，external 会排在该提交之后执行，同样的误删照旧发生。
    const committing = core.commit(
      { changes: [{ op: "put", kind: "wf.domain", id: "domain-beta", payload: { title: "B" } }] },
      "cli",
    );
    gate.resolve();
    const absorbed = await reconciling;
    fence.intercept = null;
    await committing;
    expect(absorbed).toBe(false);
    expect(core.read({ ids: ["domain-beta"] }).entities).toHaveLength(1);
    expect(core.tailLog().some((e) => e.kind === "external")).toBe(false);
    core.dispose();
  });

  it("读盘横跨 update 提交：栅栏阻止用旧 payload 回滚刚提交的更新", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    await core.commit({ changes: [{ op: "put", kind: "k", id: "x", payload: { v: 1 } }] }, "cli");
    const parked = defer();
    const gate = defer();
    parkLoadDuring(parked, gate);
    const reconciling = core.reconcileExternal();
    await parked.promise;
    await core.commit({ changes: [{ op: "put", id: "x", payload: { v: 2 } }] }, "cli");
    gate.resolve();
    const absorbed = await reconciling;
    fence.intercept = null;
    expect(absorbed).toBe(false);
    // 未被过期快照回滚：内存与磁盘都是新值
    expect(core.read({ ids: ["x"] }).entities[0]?.payload).toEqual({ v: 2 });
    const text = await fsp.readFile(
      path.join(graphPaths(root, "g1").objects, "x.yaml"),
      "utf8",
    );
    expect(text).toContain("v: 2");
    core.dispose();
  });
});
