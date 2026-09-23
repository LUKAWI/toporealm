import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TopoError } from "@lukawi/toporealm-protocol";
import { DaemonCore, graphPaths } from "../src/index.js";

async function tmpWorkspace(label = "g1"): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-core-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, label);
  return root;
}

async function expectTopo(fn: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    expect.fail(`expected TopoError ${code}`);
  } catch (e) {
    if (e instanceof TopoError) expect(e.code).toBe(code);
    else throw e;
  }
}

describe("daemon-core 冷启动", () => {
  it("空图装载 <100ms（blueprint §9 硬约束）", async () => {
    const root = await tmpWorkspace();
    // 预热一次（首跑含 FS 缓存抖动），约束针对稳定态
    const warm = await DaemonCore.open({ root, graphId: "g1", watch: false });
    warm.dispose();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    expect(core.revision).toBe(0);
    expect(core.loadMs).toBeLessThan(100);
    core.dispose();
  });
});

describe("提交管线（read/commit/undo/redo 统一转换）", () => {
  it("put 匿名 id 生成回显、read、status 计数", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    const r = await core.commit(
      {
        changes: [
          { op: "put", kind: "wf.task", payload: { title: "A" } },
          { op: "put", kind: "wf.task", id: "t-2", payload: { title: "B" } },
        ],
        label: "seed",
      },
      "cli",
    );
    expect(r.created).toHaveLength(1);
    expect(r.created[0]).toBeTruthy();
    expect(r.revision).toBe(1);
    const got = core.read({ ids: ["t-2"] });
    expect(got.entities[0]).toMatchObject({ id: "t-2", kind: "wf.task" });
    const s = core.status();
    expect(s.counts["wf.task"]).toBe(2);
    expect(s.canUndo).toBe(true);
    expect(s.canRedo).toBe(false);
    core.dispose();
  });

  it("put kind 一致性：已存在 id 同给不同 kind → UNKNOWN_KIND（D18③）；一致 → 正常 upsert", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    await core.commit({ changes: [{ op: "put", kind: "a", id: "x" }] }, "cli");
    try {
      await core.commit(
        { changes: [{ op: "put", kind: "b", id: "x", payload: { n: 1 } }] },
        "cli",
      );
      expect.fail("should throw");
    } catch (e) {
      expect(TopoError.is(e)).toBe(true);
      const err = e as TopoError;
      expect(err.code).toBe("UNKNOWN_KIND");
      expect(err.message).toContain('"a"'); // 点名存量
      expect(err.message).toContain('"b"'); // 点名提交值
      expect(err.details).toMatchObject({ id: "x", existing: "a", submitted: "b" });
    }
    // 拒绝整批零副作用（原子性）
    expect(core.read({ ids: ["x"] }).entities[0]).toMatchObject({ kind: "a", payload: {} });
    // id 与 kind 同给且一致 → 正常 upsert
    await core.commit(
      { changes: [{ op: "put", kind: "a", id: "x", payload: { n: 2 } }] },
      "cli",
    );
    expect(core.read({ ids: ["x"] }).entities[0]).toMatchObject({ kind: "a", payload: { n: 2 } });
    core.dispose();
  });

  it("merge 浅合并 + null 删键；put 整体替换", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    await core.commit(
      { changes: [{ op: "put", kind: "k", id: "x", payload: { a: 1, b: 2 } }] },
      "cli",
    );
    await core.commit(
      { changes: [{ op: "merge", id: "x", payload: { b: null, c: 3 } }] },
      "cli",
    );
    expect(core.read({ ids: ["x"] }).entities[0]?.payload).toEqual({ a: 1, c: 3 });
    await core.commit(
      { changes: [{ op: "put", id: "x", payload: { z: true } }] },
      "cli",
    );
    expect(core.read({ ids: ["x"] }).entities[0]?.payload).toEqual({ z: true });
    core.dispose();
  });

  it("悬空边：rel 端点必须存在；同批创建合法（I2 集合整体）", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    await expectTopo(
      () =>
        core.commit(
          {
            changes: [{ op: "rel", kind: "r", source: "nope", target: "nada" }],
          },
          "cli",
        ),
      "DANGLING_RELATION",
    );
    // 原子性：失败的提交不得留下痕迹
    expect(core.revision).toBe(0);
    expect(core.read().entities).toHaveLength(0);
    // 同一提交内创建端点 + 关系 → 通过
    const r = await core.commit(
      {
        changes: [
          { op: "put", kind: "k", id: "a" },
          { op: "put", kind: "k", id: "b" },
          { op: "rel", kind: "r", id: "rab", source: "a", target: "b" },
        ],
      },
      "cli",
    );
    expect(r.revision).toBe(1);
    core.dispose();
  });

  it("del 被关系引用的对象被拦截并点名边；先删关系则通过", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    await core.commit(
      {
        changes: [
          { op: "put", kind: "k", id: "a" },
          { op: "put", kind: "k", id: "b" },
          { op: "rel", kind: "r", id: "rab", source: "a", target: "b" },
        ],
      },
      "cli",
    );
    try {
      await core.commit({ changes: [{ op: "del", id: "a" }] }, "cli");
      expect.fail("should throw");
    } catch (e) {
      expect(TopoError.is(e) && e.code).toBe("DANGLING_RELATION");
      expect(TopoError.is(e) && e.details?.edges).toEqual([
        { id: "rab", kind: "r", source: "a", target: "b" },
      ]);
      expect(TopoError.is(e) && e.fix).toContain("rm rab");
    }
    await core.commit(
      { changes: [{ op: "del", id: "rab" }, { op: "del", id: "a" }] },
      "cli",
    );
    expect(core.read({ ids: ["a"] }).entities).toHaveLength(0);
    core.dispose();
  });

  it("所有权法：仅约束 module:* 来源；公共/无主与自命名空间放行", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    // 越界
    await expectTopo(
      () => core.commit({ changes: [{ op: "put", kind: "wf.task", id: "t" }] }, "module:foo"),
      "OWNERSHIP_VIOLATION",
    );
    // merge/del 按目标实体 kind 判定
    await core.commit({ changes: [{ op: "put", kind: "wf.task", id: "t", payload: { x: 1 } }] }, "cli");
    await expectTopo(
      () => core.commit({ changes: [{ op: "merge", id: "t", payload: { x: 2 } }] }, "module:foo"),
      "OWNERSHIP_VIOLATION",
    );
    // 自命名空间 + 公共/无主
    await core.commit({ changes: [{ op: "put", kind: "foo.thing", id: "f1" }] }, "module:foo");
    await core.commit({ changes: [{ op: "put", kind: "note", id: "n1" }] }, "module:foo");
    // 人类来源豁免
    await core.commit({ changes: [{ op: "put", kind: "wf.task", id: "t2" }] }, "cli");
    core.dispose();
  });

  it("ifRevision 护航", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    await expectTopo(
      () => core.commit({ changes: [{ op: "put", kind: "k" }], ifRevision: 5 }, "cli"),
      "IF_REVISION_MISMATCH",
    );
    await core.commit({ changes: [{ op: "put", kind: "k" }], ifRevision: 0 }, "cli");
    core.dispose();
  });

  it("undo/redo 游标语义 + undo 后新提交截断 redo 段（D17）", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    await core.commit({ changes: [{ op: "put", kind: "k", id: "e1" }] }, "cli");
    await core.commit({ changes: [{ op: "put", kind: "k", id: "e2" }] }, "cli");
    await core.commit({ changes: [{ op: "put", kind: "k", id: "e3" }] }, "cli");
    // undo 单步
    const u1 = await core.undo(1, "cli");
    expect(u1.revision).toBe(4);
    expect(core.read({ ids: ["e3"] }).entities).toHaveLength(0);
    expect(core.status()).toMatchObject({ canUndo: true, canRedo: true });
    // undo 不追加日志；日志视图只显示已应用段（被撤销的 revision 3 不再出现）
    expect(core.tailLog().map((e) => e.revision)).toEqual([1, 2]);
    // redo
    const r1 = await core.redo(1, "cli");
    expect(r1.revision).toBe(5);
    expect(core.read({ ids: ["e3"] }).entities).toHaveLength(1);
    // undo 三步回起点
    await core.undo(3, "cli");
    expect(core.read().entities).toHaveLength(0);
    expect(core.status()).toMatchObject({ canUndo: false, canRedo: true });
    // 新提交截断 redo 段
    const c = await core.commit({ changes: [{ op: "put", kind: "k", id: "e4" }] }, "cli");
    expect(c.revision).toBe(9);
    expect(c.canRedo).toBe(false);
    expect(core.tailLog().map((e) => e.revision)).toEqual([9]);
    // redo 无可重做
    await expectTopo(() => core.redo(1, "cli"), "INVALID_INPUT");
    core.dispose();
  });

  it("merge 的逆变更恢复旧键值（而非删除）", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    await core.commit({ changes: [{ op: "put", kind: "k", id: "x", payload: { s: "old" } }] }, "cli");
    await core.commit({ changes: [{ op: "merge", id: "x", payload: { s: "new", t: 1 } }] }, "cli");
    await core.undo(1, "cli");
    expect(core.read({ ids: ["x"] }).entities[0]?.payload).toEqual({ s: "old" });
    core.dispose();
  });

  it("持久化往返：revision/游标/日志跨重启保持", async () => {
    const root = await tmpWorkspace();
    const a = await DaemonCore.open({ root, graphId: "g1", watch: false });
    await a.commit({ changes: [{ op: "put", kind: "k", id: "p1" }], label: "first" }, "cli");
    await a.commit({ changes: [{ op: "put", kind: "k", id: "p2" }] }, "cli");
    await a.undo(1, "cli");
    a.dispose();
    const b = await DaemonCore.open({ root, graphId: "g1", watch: false });
    expect(b.revision).toBe(3);
    expect(b.status()).toMatchObject({ canUndo: true, canRedo: true });
    expect(b.tailLog().map((e) => e.revision)).toEqual([1]);
    expect(b.read({ ids: ["p1"] }).entities).toHaveLength(1);
    expect(b.read({ ids: ["p2"] }).entities).toHaveLength(0);
    b.dispose();
  });
});

describe("before/after-commit 钩子（M1 管线就位，注册面空置到 M2）", () => {
  it("veto 短路：先于应用，双快照可见，拒绝后零副作用", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    let seenOrigin = "";
    core.registerBeforeCommitHook((c) => {
      seenOrigin = c.origin;
      if (c.after.objects.some((o) => o.payload?.forbidden === true)) {
        return { veto: "禁止字段", details: { hook: "test" } };
      }
    });
    let afterFired = 0;
    core.registerAfterCommitHook(() => {
      afterFired++;
    });
    try {
      await core.commit(
        { changes: [{ op: "put", kind: "k", id: "bad", payload: { forbidden: true } }] },
        "cli",
      );
      expect.fail("should veto");
    } catch (e) {
      expect(TopoError.is(e) && e.code).toBe("VETOED");
      expect(seenOrigin).toBe("cli");
      expect(TopoError.is(e) && e.details?.vetoes).toEqual([
        { reason: "禁止字段", details: { hook: "test" } },
      ]);
    }
    expect(core.revision).toBe(0);
    expect(core.read().entities).toHaveLength(0);
    const ok = await core.commit({ changes: [{ op: "put", kind: "k", id: "ok" }] }, "cli");
    expect(ok.revision).toBe(1);
    expect(afterFired).toBe(1);
    core.dispose();
  });
});

describe("外部编辑吸收（文件监视 → external 走同一管线）", () => {
  it("reconcileExternal 吸收手改：入日志、可 undo、undo 回写磁盘", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    await core.commit({ changes: [{ op: "put", kind: "k", id: "t1", payload: { v: 1 } }] }, "cli");
    // 人手改：新建对象文件 + 改 t1 的 payload
    const p = graphPaths(root, "g1");
    await fsp.writeFile(
      path.join(p.objects, "hand-made.yaml"),
      "id: hand-made\nkind: k\npayload:\n  by: human\n",
      "utf8",
    );
    await fsp.writeFile(
      path.join(p.objects, "t1.yaml"),
      "id: t1\nkind: k\npayload:\n  v: 2\n",
      "utf8",
    );
    const events: string[] = [];
    core.events((e) => events.push(e.type));
    const absorbed = await core.reconcileExternal();
    expect(absorbed).toBe(true);
    expect(core.read({ ids: ["hand-made"] }).entities).toHaveLength(1);
    expect(core.read({ ids: ["t1"] }).entities[0]?.payload).toEqual({ v: 2 });
    const log = core.tailLog();
    expect(log.at(-1)).toMatchObject({ kind: "external", origin: "external" });
    expect(events).toEqual(["hello", "commit", "reset"]);
    await core.undo(1, "cli");
    expect(core.read({ ids: ["hand-made"] }).entities).toHaveLength(0);
    await expect(fsp.access(path.join(p.objects, "hand-made.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(core.read({ ids: ["t1"] }).entities[0]?.payload).toEqual({ v: 1 });
    core.dispose();
  });

  it("fs.watch 自动吸收（真实文件事件，去抖后生效）", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1" }); // watch: true
    const p = graphPaths(root, "g1");
    await fsp.writeFile(
      path.join(p.objects, "watched.yaml"),
      "id: watched\nkind: k\npayload: {}\n",
      "utf8",
    );
    for (let i = 0; i < 40; i++) {
      if (core.read({ ids: ["watched"] }).entities.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(core.read({ ids: ["watched"] }).entities).toHaveLength(1);
    expect(core.tailLog().at(-1)).toMatchObject({ kind: "external" });
    core.dispose();
  });

  it("执法拒绝悬空手改：保持内存态，不回写不循环", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    await core.commit({ changes: [{ op: "put", kind: "k", id: "keep" }] }, "cli");
    const p = graphPaths(root, "g1");
    // 手删对象但留下指向它的关系 → 悬空 → 吸收被拒
    await fsp.writeFile(
      path.join(p.relations, "r-bad.yaml"),
      "id: r-bad\nkind: r\nsource: keep\ntarget: gone\npayload: {}\n",
      "utf8",
    );
    await fsp.rm(path.join(p.objects, "keep.yaml"));
    const absorbed = await core.reconcileExternal();
    // 手改产生了悬空关系（target "gone" 不存在）→ 吸收整体被拒（原子性），
    // 内存态保持不变，不回写、不循环；用户修好文件后由下一次监视事件吸收
    expect(absorbed).toBe(false);
    expect(core.read({ ids: ["keep"] }).entities).toHaveLength(1);
    expect(core.read({ ids: ["r-bad"] }).entities).toHaveLength(0);
    core.dispose();
  });
});

describe("磁盘卫生（Windows 原子写）", () => {
  it("多次提交后无临时文件残留", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    for (let i = 0; i < 20; i++) {
      await core.commit({ changes: [{ op: "put", kind: "k", id: `f${i}` }] }, "cli");
    }
    await core.undo(2, "cli");
    await core.redo(1, "cli");
    const p = graphPaths(root, "g1");
    for (const dir of [p.objects, p.relations, path.dirname(p.manifest)]) {
      const names = await fsp.readdir(dir);
      expect(names.filter((n) => n.includes(".tmp-"))).toEqual([]);
    }
    expect(fs.existsSync(p.manifest)).toBe(true);
    core.dispose();
  });
});

describe("M2 管线扩展：所有权 namespace 映射 / commitSync / 钩子相位（D19–D21）", () => {
  it("CommitCandidate.conversion 如实标注转换类别（D24①）：commit/undo/redo 各归其位", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    const seen: string[] = [];
    core.registerBeforeCommitHook((c) => {
      seen.push(c.conversion ?? "(missing)");
    });
    await core.commit({ changes: [{ op: "put", kind: "k", id: "e1" }] }, "cli");
    await core.undo(1, "cli");
    await core.redo(1, "cli");
    expect(seen).toEqual(["commit", "undo", "redo"]);
    core.dispose();
  });

  it("所有权法按注册的 namespace 判定（D20）：id=workflow + ns=wf 可写 wf.*", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    core.registerModuleOwner("workflow", "wf");
    // 声明 namespace 与 id 不同：以声明为准
    await core.commit(
      { changes: [{ op: "put", kind: "wf.task", id: "t1" }] },
      "module:workflow",
    );
    expect(core.read({ ids: ["t1"] }).entities).toHaveLength(1);
    // 他人命名空间仍然拒绝
    await expectTopo(
      () =>
        core.commit(
          { changes: [{ op: "put", kind: "other.task", id: "x" }] },
          "module:workflow",
        ),
      "OWNERSHIP_VIOLATION",
    );
    // 未注册 id 回退：namespace = id 自身（S1 直注语义不变）
    await core.commit(
      { changes: [{ op: "put", kind: "lonely.thing", id: "l1" }] },
      "module:lonely",
    );
    expect(core.read({ ids: ["l1"] }).entities).toHaveLength(1);
    core.dispose();
  });

  it("commitSync 同步落盘：返回即持久化，重开可读", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    const r = core.commitSync(
      { changes: [{ op: "put", kind: "k", id: "sync-1", payload: { n: 1 } }], label: "sync" },
      "cli",
    );
    expect(r.revision).toBe(1);
    expect(r.created).toEqual([]);
    core.dispose();
    const again = await DaemonCore.open({ root, graphId: "g1", watch: false });
    expect(again.read({ ids: ["sync-1"] }).entities[0]).toMatchObject({
      id: "sync-1",
      kind: "k",
      payload: { n: 1 },
    });
    expect(again.revision).toBe(1);
    expect(again.tailLog().map((e) => e.label)).toContain("sync");
    again.dispose();
  });

  it("before-commit 钩子内提交 → REENTRANT_COMMIT，外层提交整体拒绝零副作用", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    core.registerBeforeCommitHook(() => {
      core.commitSync({ changes: [{ op: "put", kind: "k", id: "reentrant" }] }, "cli");
    });
    await expectTopo(
      () =>
        core.commit({ changes: [{ op: "put", kind: "k", id: "outer" }] }, "cli"),
      "REENTRANT_COMMIT",
    );
    expect(core.revision).toBe(0);
    expect(core.read().entities).toHaveLength(0);
    core.dispose();
  });

  it("after-commit 钩子提交排队追加（不嵌套）：事件按 revision 连续，undo 整段可撤", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    const seen: number[] = [];
    core.registerAfterCommitHook((e) => {
      seen.push(e.revision);
      if (e.revision === 1) {
        // 钩子内 api.commit：排队追加，不嵌套进当前转换
        const receipt = core.commitSync(
          {
            changes: [{ op: "put", kind: "k", id: "queued", payload: { by: "after-hook" } }],
            label: "queued-by-after-hook",
          },
          "module:m",
        );
        // D21：受理回执是排队时图态快照（revision 为当前顶、空 patch）
        expect(receipt.revision).toBe(1);
        expect(receipt.patch.objects.added).toHaveLength(0);
      }
    });
    core.events((e) => {
      if (e.type === "commit") seen.push(`evt:${e.revision}`);
    });
    const outer = await core.commit(
      { changes: [{ op: "put", kind: "k", id: "outer" }] },
      "cli",
    );
    expect(outer.revision).toBe(1);
    // 排队提交真实落图：revision 2
    expect(core.read({ ids: ["queued"] }).entities).toHaveLength(1);
    expect(core.revision).toBe(2);
    // 事件顺序：外层 1 先广播，排队 2 后广播（不嵌套 → 事件连续）
    expect(seen).toEqual([1, "evt:1", 2, "evt:2"]);
    // 排队提交入日志、可独立 undo
    expect(core.tailLog().map((e) => e.label)).toContain("queued-by-after-hook");
    expect(core.tailLog().at(-1)?.origin).toBe("module:m");
    await core.undo(2, "cli");
    expect(core.read().entities).toHaveLength(0);
    core.dispose();
  });

  it("after-commit 排队提交被钩子 veto → 记 warning，外层提交不受影响（D21）", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    core.registerBeforeCommitHook((c) => {
      if (c.origin === "module:poison") return { veto: "毒提交", details: { why: 1 } };
    });
    core.registerAfterCommitHook(() => {
      core.commitSync(
        { changes: [{ op: "put", kind: "k", id: "poisoned" }] },
        "module:poison",
      );
    });
    const outer = await core.commit(
      { changes: [{ op: "put", kind: "k", id: "fine" }] },
      "cli",
    );
    expect(outer.revision).toBe(1);
    expect(core.read({ ids: ["fine"] }).entities).toHaveLength(1);
    expect(core.read({ ids: ["poisoned"] }).entities).toHaveLength(0);
    expect(core.revision).toBe(1); // 排队提交被拒，revision 不再前进
    expect(core.warnings.some((w) => w.includes("VETOED") || w.includes("否决"))).toBe(true);
    core.dispose();
  });

  it("registerModuleOwner + setLoadedModules：status/catalog 反映运行时模块集", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    expect(core.status().modules).toEqual([]);
    core.registerModuleOwner("workflow", "wf");
    core.setLoadedModules(["workflow"]);
    expect(core.status().modules).toEqual(["workflow"]);
    expect(core.catalog().modules).toEqual([
      { id: "workflow", version: "0.0.0", namespace: "wf" },
    ]);
    core.dispose();
  });
});
