import fsp from "node:fs/promises";
import { TopoError, isValidGraphId } from "@lukawi/toporealm-protocol";
import {
  DaemonCore,
  graphPaths,
  loadManifest,
  workspacePaths,
  writeActiveGraphId,
} from "@lukawi/toporealm-daemon-core";

// ---------- 图生命周期的工作区文件操作（blueprint §4：new/use/graphs 不进 daemon 缝） ----------
// 放 client 包（cli 的唯一依赖方向），内部实现复用 daemon-core 的布局与原子写；
// 仅触碰 graph.yaml 骨架与 active 指针，绝不写实体内容（运行期图文件唯一写者是 daemon）。

export async function provisionGraph(
  root: string,
  graphId: string,
  label?: string,
): Promise<void> {
  if (!isValidGraphId(graphId)) {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `图 id 非法："${graphId}"（将用作目录名，禁 / \\ : 空格与控制字符）`,
      details: { graphId },
    });
  }
  const ws = workspacePaths(root);
  const gp = graphPaths(root, graphId);
  let exists = false;
  try {
    await fsp.access(gp.manifest);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `图 "${graphId}" 已存在`,
      hint: "new 用于新建；切换已有图用 use",
      fix: `toporealm use ${graphId}`,
    });
  }
  await fsp.mkdir(ws.topoDir, { recursive: true });
  await DaemonCore.createGraph(root, graphId, label);
  // new 即选中
  await writeActiveGraphId(ws.activeFile, graphId);
}

export async function activateGraph(
  root: string,
  graphId: string,
): Promise<void> {
  const gp = graphPaths(root, graphId);
  try {
    await fsp.access(gp.manifest);
  } catch {
    throw new TopoError({
      code: "GRAPH_NOT_FOUND",
      message: `图 "${graphId}" 不存在于工作区`,
      fix: `toporealm new ${graphId}`,
    });
  }
  await writeActiveGraphId(workspacePaths(root).activeFile, graphId);
}

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
  const out: GraphListEntry[] = [];
  for (const id of names.sort()) {
    try {
      const m = await loadManifest(graphPaths(root, id));
      out.push({
        id,
        ...(m.label !== undefined ? { label: m.label } : {}),
        revision: m.revision,
        current: currentGraphId === id,
      });
    } catch {
      /* 非 graph 目录（无 v2 manifest）跳过 */
    }
  }
  return out;
}
