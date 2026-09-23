import crypto from "node:crypto";
import path from "node:path";

// ---------- 工作区与图目录布局（blueprint §3） ----------

export interface WorkspacePaths {
  root: string;
  /** <root>/.toporealm */
  topoDir: string;
  graphsDir: string;
  /** <root>/.toporealm/daemon（运行时：endpoint、pid；空闲退出后清理） */
  daemonDir: string;
  /** 当前图 id 指针（use 写入；文件层操作） */
  activeFile: string;
}

export function workspacePaths(root: string): WorkspacePaths {
  const topoDir = path.join(root, ".toporealm");
  return {
    root,
    topoDir,
    graphsDir: path.join(root, "graphs"),
    daemonDir: path.join(topoDir, "daemon"),
    activeFile: path.join(topoDir, "active"),
  };
}

export interface GraphPaths {
  dir: string;
  /** graph.yaml：format toporealm.graph/v2 */
  manifest: string;
  objects: string;
  relations: string;
  /** .log：append-only JSONL 统一提交日志 */
  log: string;
}

export function graphPaths(root: string, graphId: string): GraphPaths {
  const dir = path.join(root, "graphs", graphId);
  return {
    dir,
    manifest: path.join(dir, "graph.yaml"),
    objects: path.join(dir, "objects"),
    relations: path.join(dir, "relations"),
    log: path.join(dir, ".log"),
  };
}

// ---------- daemon endpoint（单属主互斥 + 客户端触达） ----------

export interface EndpointAddress {
  transport: "pipe" | "socket";
  address: string;
}

/** endpoint 地址由 root 决定：同一工作区恒定位到同一 daemon。 */
export function endpointAddress(root: string): EndpointAddress {
  const name = `toporealm-${crypto
    .createHash("sha256")
    .update(path.resolve(root))
    .digest("hex")
    .slice(0, 16)}`;
  if (process.platform === "win32") {
    // Windows 命名管道：net 模块原生支持；名字哈希化避免超长与非法字符
    return { transport: "pipe", address: `\\\\.\\pipe\\${name}` };
  }
  return {
    transport: "socket",
    address: path.join(workspacePaths(root).daemonDir, `${name}.sock`),
  };
}
