import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TopoError } from "@lukawi/toporealm-protocol";
import { DaemonCore, graphPaths, readLog } from "../src/index.js";

// ---------- A1 回归：convert 管线 promise 链互斥（并发提交不再双写） ----------
//
// 修复前（运行实证）：wire 层 void dispatcher.handle 完全并发——两 commit 都在
// persistAsync 的 await 让渡点上 stage 出同一 revision（revision_+1），land 才生效，
// 后 land 者整体覆盖内存 → 均返回 rev2、.log=[1,2,2]、先提交对象从内存 read 消失、
// 重启后从实体文件「复活」。修法：convert 入口把整段 stage→persist→land 串进
// 尾链（尾链吞错，单个失败不断链）；convertSync 无让渡点，不受影响。

async function tmpGraph(graphId = "g1"): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-conc-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, graphId);
  return root;
}

describe("并发提交管线（A1 convert 串行化）", () => {
  it("N 路并发 commit：revision 严格递增无重复、.log 无同 revision 两行、内存=全量合并、undo 栈完整", async () => {
    const root = await tmpGraph();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    const N = 24;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        core.commit(
          { changes: [{ op: "put", kind: "k", id: `c-${i}`, payload: { i } }] },
          "cli",
        ),
      ),
    );

    // revision 严格递增、无重复
    const revs = results.map((r) => r.revision).sort((a, b) => a - b);
    expect(revs).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    // .log 无同 revision 两行（修复前 [1,2,2]）
    const log = await readLog(graphPaths(root, "g1"));
    expect(log.map((e) => e.revision)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );

    // read 结果 = 全量合并（修复前先提交对象从内存消失）
    const got = core.read({ kinds: ["k"] });
    expect(got.revision).toBe(N);
    expect(got.entities.map((e) => e.id).sort()).toEqual(
      Array.from({ length: N }, (_, i) => `c-${i}`).sort(),
    );

    // undo 栈完整：N 步全撤 → 实体清空、日志不增（undo/redo 是游标移动，revision 仍单调递增）
    for (let i = 0; i < N; i++) await core.undo(1, "cli");
    expect(core.status()).toMatchObject({
      revision: 2 * N,
      canUndo: false,
      canRedo: true,
    });
    expect(core.read({ kinds: ["k"] }).entities).toHaveLength(0);
    expect((await readLog(graphPaths(root, "g1"))).map((e) => e.revision)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );

    // 全部重做：实体复原，日志仍只 N 行
    for (let i = 0; i < N; i++) await core.redo(1, "cli");
    expect(core.status()).toMatchObject({
      revision: 3 * N,
      canUndo: true,
      canRedo: false,
    });
    expect(core.read({ kinds: ["k"] }).entities).toHaveLength(N);
    expect((await readLog(graphPaths(root, "g1"))).map((e) => e.revision)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
    core.dispose();
  });

  it("单个失败不断链（尾链吞错）：被拒提交不占 revision，后续提交照常串行", async () => {
    const root = await tmpGraph();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    // 并发投递：坏提交（悬空边，整批拒绝零副作用）在前、好提交在后
    const bad = core.commit(
      {
        changes: [
          { op: "put", kind: "k", id: "anchor" },
          {
            op: "rel",
            kind: "r",
            id: "broken",
            source: "ghost-a",
            target: "ghost-b",
          },
        ],
      },
      "cli",
    );
    const good = core.commit(
      { changes: [{ op: "put", kind: "k", id: "after" }] },
      "cli",
    );
    await expect(bad).rejects.toBeInstanceOf(TopoError);
    await expect(bad).rejects.toMatchObject({ code: "DANGLING_RELATION" });
    const r = await good;
    expect(r.revision).toBe(1); // 失败未占号
    // 链未断：后续提交照常
    const r2 = await core.commit(
      { changes: [{ op: "put", kind: "k", id: "after2" }] },
      "cli",
    );
    expect(r2.revision).toBe(2);
    const log = await readLog(graphPaths(root, "g1"));
    expect(log.map((e) => e.revision)).toEqual([1, 2]);
    // 被拒批次零副作用：anchor 也没写进去
    expect(core.read({ ids: ["anchor"] }).entities).toHaveLength(0);
    core.dispose();
  });
});
