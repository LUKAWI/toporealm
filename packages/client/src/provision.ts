import fsp from "node:fs/promises";
import { TopoError, isValidGraphId } from "@lukawi/toporealm-protocol";
import {
  DaemonCore,
  graphPaths,
  workspacePaths,
  writeActiveGraphId,
} from "@lukawi/toporealm-daemon-core";

// ---------- 图生命周期的工作区文件操作（blueprint §4：creategraph/use/graphs 不进 daemon 缝） ----------
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
      hint: "creategraph 用于新建；切换已有图用 use",
      fix: `toporealm use ${graphId}`,
    });
  }
  await fsp.mkdir(ws.topoDir, { recursive: true });
  await DaemonCore.createGraph(root, graphId, label);
  // creategraph 即选中
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
      fix: `toporealm creategraph ${graphId}`,
    });
  }
  await writeActiveGraphId(workspacePaths(root).activeFile, graphId);
}

// 图列表单一实现在 daemon-core（C4 布局知识收口，cli 的 graphs 动词与 web /api/graphs
// 同口径）；client 是 cli 的转出口（cli 依赖方向不含 daemon-core）。
export {
  listGraphs,
  type GraphListEntry,
} from "@lukawi/toporealm-daemon-core";
