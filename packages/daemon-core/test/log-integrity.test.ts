import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StoredLogEntry } from "@lukawi/toporealm-protocol";
import { DaemonCore, appendLogLine, appendLogLineSync, graphPaths, readLog } from "../src/index.js";

// ---------- G2-7：无换行残行不毒化追加的好行 ----------
// 崩溃/断电在 .log 尾部留下无换行半行后，appendFile 直接拼接 → 重载时整行 parse
// 失败被当残行跳过，新提交的好行随之被吞（实证过）。修后：追加前补 \n 让残行成独立行。

async function tmpWorkspace(label = "g1"): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-logint-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, label);
  return root;
}

function entry(revision: number): StoredLogEntry {
  return {
    revision,
    kind: "commit",
    origin: "cli",
    time: new Date().toISOString(),
    changes: [{ op: "put", kind: "k", id: `x${revision}`, payload: {} }],
    inverse: [{ op: "del", id: `x${revision}` }],
  };
}

describe("G2-7 .log 残行防护", () => {
  it("async append：无换行残行后追加 → 重载后好行存活（修复前被拼接吞掉）", async () => {
    const root = await tmpWorkspace();
    const p = graphPaths(root, "g1");
    // 模拟崩溃残行：无换行结尾
    await fsp.writeFile(p.log, '{"revision":99,"kind":"commit","trun', "utf8");
    await appendLogLine(p, entry(1));
    const log = await readLog(p);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ revision: 1, kind: "commit" });
    // 残行仍在文件里（成独立行，不静默改写历史），但不拖累后续行
    const text = await fsp.readFile(p.log, "utf8");
    expect(text.startsWith('{"revision":99')).toBe(true);
  });

  it("sync append：同一防护（模块 api.commit 的 in-process 路径）", async () => {
    const root = await tmpWorkspace();
    const p = graphPaths(root, "g1");
    await fsp.writeFile(p.log, "partial-line-no-newline", "utf8");
    appendLogLineSync(p, entry(1));
    appendLogLineSync(p, entry(2));
    const log = await readLog(p);
    expect(log.map((e) => e.revision)).toEqual([1, 2]);
  });

  it("正常文件（换行结尾/空文件/不存在）追加零回归", async () => {
    const root = await tmpWorkspace();
    const p = graphPaths(root, "g1");
    // 不存在 → 首次追加
    await appendLogLine(p, entry(1));
    // 空文件
    await fsp.writeFile(p.log, "", "utf8");
    await appendLogLine(p, entry(1));
    // 换行结尾
    await appendLogLine(p, entry(2));
    expect((await readLog(p)).map((e) => e.revision)).toEqual([1, 2]);
  });

  it("集成：残行 → daemon 装载 → 提交 → 重启后提交可 undo（审计不断档）", async () => {
    const root = await tmpWorkspace();
    const p = graphPaths(root, "g1");
    await fsp.writeFile(p.log, '{"revision":7,"kind":"com', "utf8");
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    await core.commit({ changes: [{ op: "put", kind: "k", id: "a", payload: {} }], label: "seed" }, "cli");
    expect(core.revision).toBe(1);
    core.dispose();
    const again = await DaemonCore.open({ root, graphId: "g1", watch: false });
    expect(again.revision).toBe(1);
    expect(again.status().canUndo).toBe(true);
    const undone = await again.undo(1, "cli");
    expect(undone.canRedo).toBe(true);
    again.dispose();
  });
});
