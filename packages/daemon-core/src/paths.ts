import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------- 全局目录（1.1.0 D26：~/.toporealm 或 TOPOREALM_HOME；写路径惰性确保创建） ----------

export interface GlobalPaths {
  root: string;
  /** <globalRoot>/modules：全局模块池（目录即注册） */
  modulesDir: string;
}

/**
 * 全局根：TOPOREALM_HOME 覆盖，缺省 ~/.toporealm。纯解析，不触盘；
 * 创建只能走 ensureGlobalDir（写路径），读路径（list/status）绝不建目录。
 */
export function globalPaths(env: NodeJS.ProcessEnv = process.env): GlobalPaths {
  const override = env?.["TOPOREALM_HOME"];
  const root =
    override !== undefined && override.trim().length > 0
      ? path.resolve(override.trim())
      : path.join(os.homedir(), ".toporealm");
  return { root, modulesDir: path.join(root, "modules") };
}

/** 写路径（init / module add --global / 首次触达全局池）惰性确保全局池位存在；返回全局根。 */
export async function ensureGlobalDir(env?: NodeJS.ProcessEnv): Promise<string> {
  const g = globalPaths(env);
  await fsp.mkdir(g.modulesDir, { recursive: true });
  return g.root;
}

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
    graphsDir: path.join(topoDir, "graphs"),
    daemonDir: path.join(topoDir, "daemon"),
    activeFile: path.join(topoDir, "active"),
  };
}

export interface GraphPaths {
  dir: string;
  /** graph.yaml：format toporealm.graph/v3 */
  manifest: string;
  objects: string;
  relations: string;
  /** .log：append-only JSONL 统一提交日志 */
  log: string;
}

export function graphPaths(root: string, graphId: string): GraphPaths {
  // 1.1.0 D26：图存储收编进 .toporealm/graphs/<id>
  const dir = path.join(root, ".toporealm", "graphs", graphId);
  return {
    dir,
    manifest: path.join(dir, "graph.yaml"),
    objects: path.join(dir, "objects"),
    relations: path.join(dir, "relations"),
    log: path.join(dir, ".log"),
  };
}

// ---------- active 指针（文件层操作；cli 的 new/use 写入，daemon 启动与客户端解析时读取） ----------

export async function readActiveGraphId(activeFile: string): Promise<string | null> {
  let text: string;
  try {
    text = await fsp.readFile(activeFile, "utf8");
  } catch {
    return null;
  }
  const id = text.trim();
  return id.length > 0 ? id : null;
}

export async function writeActiveGraphId(
  activeFile: string,
  graphId: string,
): Promise<void> {
  await fsp.mkdir(path.dirname(activeFile), { recursive: true });
  await fsp.writeFile(activeFile, graphId + "\n", "utf8");
}

// ---------- daemon endpoint（单属主互斥 + 客户端触达） ----------

export interface EndpointAddress {
  transport: "pipe" | "socket";
  address: string;
}

/**
 * endpoint 地址由 root 决定：同一工作区恒定位到同一 daemon（blueprint §5）。
 * D33：unix socket 落 os.tmpdir() 短路径——工作区内路径受 sun_path 限制
 * （macOS 104 字节，深路径即越限且被 libuv 静默截断），且首次 listen 前无需
 * 依赖工作区内目录存在；总长超 100 时回退 /tmp 兜底。
 */
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
  let address = path.join(os.tmpdir(), `${name}.sock`);
  if (address.length > 100) {
    address = path.join("/tmp", `${name}.sock`);
  }
  return { transport: "socket", address };
}
