import fsp from "node:fs/promises";
import path from "node:path";
import { TopoError } from "@lukawi/toporealm-protocol";
import { graphPaths, workspacePaths } from "@lukawi/toporealm-daemon-core";

// ---------- 连接目标解析（root/graph 指针，全部是文件层指针读取，不触图内容） ----------

export interface ResolveOptions {
  root?: string;
  graph?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ResolvedTarget {
  root: string;
  graphId: string;
}

/**
 * root = 显式参数 > TOPOREALM_ROOT > cwd；graph = 显式参数 > TOPOREALM_GRAPH > .toporealm/active。
 * 环境类错误（NO_WORKSPACE/NO_CURRENT_GRAPH/GRAPH_NOT_FOUND）在客户端本地即判定，不空耗 daemon。
 */
export async function resolveTarget(
  opts: ResolveOptions = {},
): Promise<ResolvedTarget> {
  const env = opts.env ?? process.env;
  const root = path.resolve(
    opts.root ?? env.TOPOREALM_ROOT ?? opts.cwd ?? process.cwd(),
  );
  const ws = workspacePaths(root);
  try {
    await fsp.stat(ws.topoDir);
  } catch {
    throw new TopoError({
      code: "NO_WORKSPACE",
      message: `不是 TopoRealm 工作区（缺少 .toporealm/）：${root}`,
      hint: "任意目录一条命令即可初始化工作区并新建图",
      fix: "toporealm new <graph>",
    });
  }
  const graphId =
    opts.graph ?? env.TOPOREALM_GRAPH ?? (await readActiveFile(ws.activeFile));
  if (!graphId) {
    throw new TopoError({
      code: "NO_CURRENT_GRAPH",
      message: "工作区没有激活的图",
      hint: "new 会新建并选中；use 切换已有图",
      fix: "toporealm new <graph>",
    });
  }
  const gp = graphPaths(root, graphId);
  try {
    await fsp.access(gp.manifest);
  } catch {
    throw new TopoError({
      code: "GRAPH_NOT_FOUND",
      message: `图 "${graphId}" 不存在于工作区`,
      fix: `toporealm use <graph>`,
    });
  }
  return { root, graphId };
}

export async function readActiveFile(activeFile: string): Promise<string | null> {
  let text: string;
  try {
    text = await fsp.readFile(activeFile, "utf8");
  } catch {
    return null;
  }
  const id = text.trim();
  return id.length > 0 ? id : null;
}

export async function writeActiveFile(
  activeFile: string,
  graphId: string,
): Promise<void> {
  await fsp.mkdir(path.dirname(activeFile), { recursive: true });
  await fsp.writeFile(activeFile, graphId + "\n", "utf8");
}
