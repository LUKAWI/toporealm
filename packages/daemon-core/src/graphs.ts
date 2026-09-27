import fsp from "node:fs/promises";
import { graphPaths, readActiveGraphId, workspacePaths } from "./paths.js";
import { loadManifest } from "./store.js";

// ---------- 工作区图集合的文件层读取（blueprint §4：creategraph/use/graphs 不进 daemon 缝） ----------
//
// 单一实现（1.2.0 C4 布局知识收口）：cli 的 graphs 动词与 web /api/graphs 共用此函数，
// 防「预览列表与 toporealm graphs 行为漂移」。语义与原 client/provision.ts 版一致：
// readdir（无 graphs 目录 = 空列表，绝不建目录）→ 排序 → 逐个 loadManifest
// （损坏/非图目录容错跳过）→ { id, label, revision, current } 投影。
//
// current 标记：显式 currentGraphId 优先（cli 的 --graph/TOPOREALM_GRAPH 解析序），
// 缺省经 .toporealm/active 指针（readActiveGraphId）——web 预览 API 即走此缺省。

export interface GraphListEntry {
  id: string;
  label?: string;
  revision: number;
  current: boolean;
}

export async function listGraphs(
  root: string,
  currentGraphId?: string,
): Promise<GraphListEntry[]> {
  const ws = workspacePaths(root);
  let names: string[];
  try {
    names = await fsp.readdir(ws.graphsDir);
  } catch {
    return [];
  }
  const current =
    currentGraphId ?? (await readActiveGraphId(ws.activeFile)) ?? null;
  const out: GraphListEntry[] = [];
  for (const id of names.sort()) {
    try {
      const m = await loadManifest(graphPaths(root, id));
      out.push({
        id,
        ...(m.label !== undefined ? { label: m.label } : {}),
        revision: m.revision,
        current: current === id,
      });
    } catch {
      /* 非 graph 目录（无 v3 manifest）跳过 */
    }
  }
  return out;
}
