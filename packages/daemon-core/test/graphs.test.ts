import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DaemonCore,
  listGraphs,
  workspacePaths,
  writeActiveGraphId,
} from "../src/index.js";

// ---------- listGraphs（1.2.0 C4 布局知识收口：cli graphs 与 web /api/graphs 单一实现） ----------

async function tmpRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-graphs-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  return root;
}

describe("listGraphs（daemon-core 文件层单一实现）", () => {
  it("无 graphs 目录 → 空列表，且绝不建目录", async () => {
    const root = await tmpRoot();
    expect(await listGraphs(root)).toEqual([]);
    await expect(fsp.stat(workspacePaths(root).graphsDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("排序 + label/revision 投影；损坏/非图目录容错跳过", async () => {
    const root = await tmpRoot();
    await DaemonCore.createGraph(root, "b", "Second");
    await DaemonCore.createGraph(root, "a");
    // 非 graph 目录（无 v3 manifest）：跳过不抛
    await fsp.mkdir(path.join(root, ".toporealm", "graphs", "junk"), {
      recursive: true,
    });
    const rows = await listGraphs(root);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]); // readdir 序无关，恒排序
    expect(rows[0]).toEqual({ id: "a", revision: 0, current: false });
    expect(rows[1]).toEqual({
      id: "b",
      label: "Second",
      revision: 0,
      current: false,
    });
  });

  it("current 缺省经 active 指针（readActiveGraphId）；显式 currentGraphId 优先（cli --graph 解析序）", async () => {
    const root = await tmpRoot();
    await DaemonCore.createGraph(root, "one");
    await DaemonCore.createGraph(root, "two");
    await writeActiveGraphId(workspacePaths(root).activeFile, "two");
    expect(await listGraphs(root)).toEqual([
      { id: "one", revision: 0, current: false },
      { id: "two", revision: 0, current: true },
    ]);
    const rows = await listGraphs(root, "one");
    expect(rows.find((r) => r.id === "one")?.current).toBe(true);
    expect(rows.find((r) => r.id === "two")?.current).toBe(false);
  });
});
