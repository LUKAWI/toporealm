import type { Session, TopoEvent } from "@lukawi/toporealm-protocol";
import { graphPaths } from "@lukawi/toporealm-daemon-core";
import fsp from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// ---------- 可复用 S1 契约套件（blueprint §8：同一套用例在 memory/IPC 上复跑） ----------

export interface ContractSuiteContext {
  root: string;
  graphId: string;
  connect(): Promise<Session>;
  /** 触发外部编辑吸收：memory=确定性 reconcile；IPC=等真实 fs.watch 去抖 */
  absorbExternal(s: Session, probeId: string): Promise<void>;
}

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timeout");
    await sleep(50);
  }
}

export function runSessionContractSuite(
  getCtx: () => ContractSuiteContext,
): void {
  let ctx: ContractSuiteContext;
  let s: Session;
  let n = 0;
  const uniq = (p: string) => `${p}-${(n++).toString(36)}`;

  describe("S1 契约（blueprint §1.1；memory/IPC 两 adapter 复跑）", () => {
    beforeEach(async () => {
      ctx = getCtx();
      s = await ctx.connect();
    });

    it("status 形状 + session 指纹", async () => {
      const st = await s.status();
      expect(s.graphId).toBe(ctx.graphId);
      expect(s.instanceId).toBeTruthy();
      expect(st.graphId).toBe(ctx.graphId);
      expect(typeof st.revision).toBe("number");
      expect(st.modules).toEqual([]);
      expect(typeof st.canUndo).toBe("boolean");
      expect(typeof st.canRedo).toBe("boolean");
    });

    it("put：匿名 id 生成回显；显式 id upsert 保持 kind；投影", async () => {
      const r = await s.commit({
        changes: [
          { op: "put", kind: "ct", payload: { t: 1 } },
          { op: "put", kind: "ct", id: "ct-x", payload: { t: 2 } },
        ],
        label: "put-case",
      });
      expect(r.created).toHaveLength(1); // 只回显 daemon 分配的 id
      expect(r.created[0]).not.toBe("ct-x");
      expect(r.revision).toBeGreaterThan(0);
      // upsert：已存在对象可省 kind（保持原 kind），payload 整体替换
      const r2 = await s.commit({
        changes: [{ op: "put", id: "ct-x", payload: { t: 3 } }],
      });
      expect(r2.created).toHaveLength(0);
      const got = await s.read({ ids: ["ct-x"] });
      expect(got.entities[0]).toMatchObject({
        id: "ct-x",
        kind: "ct",
        payload: { t: 3 },
      });
      const proj = await s.read({ ids: ["ct-x"], fields: ["id", "payload.t"] });
      expect(proj.entities[0]).toEqual({ id: "ct-x", payload: { t: 3 } });
      const log = await s.log({ limit: 5 });
      expect(log.map((e) => e.label)).toContain("put-case");
    });

    it("错误封闭集：INVALID_INPUT / ID_EXISTS / UNKNOWN_ID(带 did-you-mean)", async () => {
      // 新建对象缺 kind
      await expect(
        s.commit({ changes: [{ op: "put", id: uniq("ec") }] }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      const a = uniq("ea");
      const rel = uniq("er");
      await s.commit({
        changes: [
          { op: "put", kind: "ec", id: a },
          { op: "rel", kind: "ec.rel", id: rel, source: a, target: a },
        ],
      });
      // 对象/关系 id 空间唯一，跨类型占用 = ID_EXISTS
      await expect(
        s.commit({ changes: [{ op: "put", kind: "k", id: rel }] }),
      ).rejects.toMatchObject({ code: "ID_EXISTS", details: { conflict: "relation" } });
      await expect(
        s.commit({ changes: [{ op: "rel", kind: "k.rel", source: a, target: a, id: a }] }),
      ).rejects.toMatchObject({ code: "ID_EXISTS", details: { conflict: "object" } });
      // UNKNOWN_ID + did-you-mean（typo = 真实 id + "x"）
      const typo = a + "x";
      const err = await s
        .commit({ changes: [{ op: "merge", id: typo, payload: {} }] })
        .catch((e: unknown) => e as { code: string; details?: { suggestions?: string[] } });
      expect((err as { code: string }).code).toBe("UNKNOWN_ID");
      expect(
        (err as { details?: { suggestions?: string[] } }).details?.suggestions,
      ).toContain(a);
    });

    it("rel：direction 缺省 directed；undirected 持久化；匿名关系 id 回显 created", async () => {
      const a = uniq("ra");
      const b = uniq("rb");
      const r1 = uniq("rr1");
      const r2 = uniq("rr2");
      const rc = await s.commit({
        changes: [
          { op: "put", kind: "rl", id: a },
          { op: "put", kind: "rl", id: b },
          { op: "rel", kind: "rl.rel", id: r1, source: a, target: b },
          { op: "rel", kind: "rl.rel", id: r2, source: b, target: a, direction: "undirected" },
          { op: "rel", kind: "rl.rel", source: a, target: b }, // 匿名
        ],
      });
      expect(rc.created).toHaveLength(1); // 只有 daemon 分配的匿名 id 入 created
      const got = await s.read({ ids: [r1, r2, ...(rc.created as string[])] });
      expect(got.entities).toHaveLength(3); // 匿名关系也真实入图
      const e1 = got.entities.find((e) => e.id === r1) as Record<string, unknown>;
      const e2 = got.entities.find((e) => e.id === r2) as Record<string, unknown>;
      expect(e1).toMatchObject({ source: a, target: b });
      expect("direction" in e1 ? e1.direction : "directed").toBe("directed");
      expect(e2).toMatchObject({ direction: "undirected" });
    });

    it("merge：浅合并 + null 删键；patch.updated", async () => {
      const id = uniq("mg");
      await s.commit({
        changes: [{ op: "put", kind: "mg", id, payload: { a: 1, b: 2 } }],
      });
      const r = await s.commit({
        changes: [{ op: "merge", id, payload: { b: null, c: 3 } }],
      });
      expect(r.patch.objects.updated.map((e) => e.id)).toContain(id);
      const e = (await s.read({ ids: [id] })).entities[0];
      expect(e?.payload).toEqual({ a: 1, c: 3 });
    });

    it("原子性 I2：rel 悬空整批拒绝，零副作用", async () => {
      const before = await s.status();
      const good = uniq("at");
      await expect(
        s.commit({
          changes: [
            { op: "put", kind: "at", id: good },
            { op: "rel", kind: "at.rel", source: "ghost-a", target: "ghost-b" },
          ],
        }),
      ).rejects.toMatchObject({ code: "DANGLING_RELATION" });
      const after = await s.status();
      expect(after.revision).toBe(before.revision);
      expect((await s.read({ ids: [good] })).entities).toHaveLength(0);
      // 同批创建端点 + 关系 → 合法（悬空检查针对集合整体）
      const x = uniq("ax");
      const y = uniq("ay");
      const ok = await s.commit({
        changes: [
          { op: "put", kind: "at", id: x },
          { op: "put", kind: "at", id: y },
          { op: "rel", kind: "at.rel", source: x, target: y },
        ],
      });
      expect(ok.patch.relations.added).toHaveLength(1);
    });

    it("del：悬空拦截点名边；先删关系则通过", async () => {
      const a = uniq("da");
      const b = uniq("db");
      const rel = uniq("dr");
      await s.commit({
        changes: [
          { op: "put", kind: "dl", id: a },
          { op: "put", kind: "dl", id: b },
          { op: "rel", kind: "dl.rel", id: rel, source: a, target: b },
        ],
      });
      const err = await s
        .commit({ changes: [{ op: "del", id: a }] })
        .catch((e) => e as { code: string; fix?: string; details?: { edges?: unknown[] } });
      expect((err as { code: string }).code).toBe("DANGLING_RELATION");
      expect((err as { details?: { edges?: unknown[] } }).details?.edges).toHaveLength(1);
      expect((err as { fix?: string }).fix).toContain(`rm ${rel}`);
      const r = await s.commit({
        changes: [
          { op: "del", id: rel },
          { op: "del", id: a },
        ],
      });
      expect(r.patch.relations.deleted).toEqual([rel]);
      expect(r.patch.objects.deleted).toEqual([a]);
      await expect(
        s.commit({ changes: [{ op: "del", id: uniq("nope") }] }),
      ).rejects.toMatchObject({ code: "UNKNOWN_ID" });
    });

    it("ifRevision 乐观护航", async () => {
      const st = await s.status();
      const id = uniq("ir");
      await expect(
        s.commit({
          changes: [{ op: "put", kind: "ir", id }],
          ifRevision: st.revision + 100,
        }),
      ).rejects.toMatchObject({ code: "IF_REVISION_MISMATCH" });
      const r = await s.commit({
        changes: [{ op: "put", kind: "ir", id }],
        ifRevision: st.revision,
      });
      expect(r.revision).toBe(st.revision + 1);
    });

    it("undo/redo 游标 + undo 后新提交截断 redo 段（D17）", async () => {
      const a = uniq("ua");
      const b = uniq("ub");
      const c = uniq("uc");
      await s.commit({ changes: [{ op: "put", kind: "ur", id: a }] });
      const rb = await s.commit({ changes: [{ op: "put", kind: "ur", id: b }] });
      const u = await s.undo();
      expect(u.revision).toBe(rb.revision + 1);
      expect((await s.read({ ids: [b] })).entities).toHaveLength(0);
      expect(u.canRedo).toBe(true);
      expect(u.canUndo).toBe(true);
      const r2 = await s.redo();
      expect((await s.read({ ids: [b] })).entities).toHaveLength(1);
      expect(r2.revision).toBe(u.revision + 1);
      await s.undo(2);
      expect((await s.read({ ids: [a] })).entities).toHaveLength(0);
      const rc = await s.commit({ changes: [{ op: "put", kind: "ur", id: c }] });
      expect(rc.canRedo).toBe(false); // redo 段已被截断
      // undo 到无可撤
      for (let i = 0; i < 50; i++) {
        const st = await s.status();
        if (!st.canUndo) break;
        await s.undo();
      }
      await expect(s.undo()).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    it("log：尾读 limit + LogEntry 字段", async () => {
      await s.commit({
        changes: [{ op: "put", kind: "lg", id: uniq("lg") }],
        label: "log-case",
      });
      const log = await s.log({ limit: 1 });
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ kind: "commit", label: "log-case" });
      expect(typeof log[0].time).toBe("string");
      expect(log[0].origin).toBe("cli");
    });

    it("read：ids/kinds/where 过滤与投影", async () => {
      const id1 = uniq("rf");
      const id2 = uniq("rf");
      await s.commit({
        changes: [
          { op: "put", kind: "rf.a", id: id1, payload: { st: "todo", n: 1 } },
          { op: "put", kind: "rf.b", id: id2, payload: { st: "todo" } },
        ],
      });
      let r = await s.read({ kinds: ["rf.a"] });
      expect(r.entities.map((e) => e.id)).toContain(id1);
      expect(r.entities.map((e) => e.id)).not.toContain(id2);
      r = await s.read({ where: [{ eq: { st: "todo" } }] });
      expect(r.entities.map((e) => e.id)).toEqual(
        expect.arrayContaining([id1, id2]),
      );
      r = await s.read({ where: [{ kind: "rf.a", eq: { st: "todo" } }] });
      expect(r.entities.map((e) => e.id)).toEqual([id1]);
      r = await s.read({ ids: [id1, "ghost-id"] });
      expect(r.entities.map((e) => e.id)).toEqual([id1]);
      r = await s.read({ ids: [id2], fields: ["id", "payload.st"] });
      expect(r.entities[0]).toEqual({ id: id2, payload: { st: "todo" } });
    });

    it("events：hello 首事件；commit 事件 patch 连续（I3）；退订停更", async () => {
      const seen: TopoEvent[] = [];
      const un = await s.events((e) => seen.push(e));
      expect(seen[0]?.type).toBe("hello");
      const r = await s.commit({
        changes: [{ op: "put", kind: "ev2", id: uniq("e") }],
        label: "evt-case",
      });
      await waitFor(() =>
        seen.some((e) => e.type === "commit" && e.revision === r.revision),
      );
      const ev = seen.find(
        (e) => e.type === "commit" && e.revision === r.revision,
      ) as { patch: { fromRevision: number; toRevision: number } };
      expect(ev.patch.fromRevision).toBe(r.revision - 1);
      expect(ev.patch.toRevision).toBe(r.revision);
      un();
      const count = seen.length;
      await s.commit({ changes: [{ op: "put", kind: "ev2", id: uniq("e") }] });
      await sleep(200);
      expect(seen.length).toBe(count);
    });

    it("events：fromRevision 回放免全量", async () => {
      const st = await s.status();
      const r = await s.commit({
        changes: [{ op: "put", kind: "rp", id: uniq("rp") }],
        label: "replay-case",
      });
      const seen: TopoEvent[] = [];
      const un = await s.events((e) => seen.push(e), {
        fromRevision: st.revision,
      });
      expect(seen[0]?.type).toBe("hello");
      expect(
        seen.some((e) => e.type === "commit" && e.revision === r.revision),
      ).toBe(true);
      un();
    });

    it("外部编辑吸收：external 入日志、可 undo、commit+reset 事件", async () => {
      const events: TopoEvent[] = [];
      const un = await s.events((e) => events.push(e));
      const id = uniq("hand");
      const p = graphPaths(ctx.root, ctx.graphId);
      await fsp.writeFile(
        path.join(p.objects, `${id}.yaml`),
        `id: ${id}\nkind: hand\npayload:\n  by: human\n`,
        "utf8",
      );
      await ctx.absorbExternal(s, id);
      const got = await s.read({ ids: [id] });
      expect(got.entities).toHaveLength(1);
      const log = await s.log({ limit: 3 });
      expect(log.at(-1)).toMatchObject({ kind: "external", origin: "external" });
      expect(events.map((e) => e.type)).toContain("commit");
      expect(events.map((e) => e.type)).toContain("reset");
      // undo 撤销外部编辑（story 12）
      const u = await s.undo();
      expect(u.revision).toBeGreaterThan(got.revision);
      expect((await s.read({ ids: [id] })).entities).toHaveLength(0);
      un();
    });

    it("catalog 空目录；run 未知命令 UNKNOWN_COMMAND", async () => {
      const cat = await s.catalog();
      expect(cat.commands).toEqual([]);
      await expect(s.run("nope.cmd")).rejects.toMatchObject({
        code: "UNKNOWN_COMMAND",
      });
    });
  });
}
