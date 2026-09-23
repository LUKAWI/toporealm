import fsp from "node:fs/promises";
import path from "node:path";
import { workspacePaths } from "./paths.js";
import { atomicWriteFile } from "./store.js";

// ---------- daemon endpoint 文件（.toporealm/daemon/endpoint.json）----------
// 连接信息 + pid 互斥的共享事实：client（发现/校验）与 daemon（写入/清理）两端共用，
// 放 daemon-core 避免 client→daemon 的包依赖。

export interface DaemonEndpointInfo {
  transport: "pipe" | "socket";
  address: string;
  pid: number;
  instanceId: string;
  graphId: string;
  startedAt: string;
  /** web 伺服端口（D22：HTTP 静态 + /ws；缺省 = 老 endpoint 或未开 web） */
  webPort?: number;
}

export function endpointFile(root: string): string {
  return path.join(workspacePaths(root).daemonDir, "endpoint.json");
}

export async function readEndpoint(
  root: string,
): Promise<DaemonEndpointInfo | null> {
  try {
    return JSON.parse(
      await fsp.readFile(endpointFile(root), "utf8"),
    ) as DaemonEndpointInfo;
  } catch {
    return null;
  }
}

export async function writeEndpoint(
  root: string,
  info: DaemonEndpointInfo,
): Promise<void> {
  await atomicWriteFile(endpointFile(root), JSON.stringify(info, null, 2));
}

export async function clearEndpoint(root: string): Promise<void> {
  try {
    await fsp.unlink(endpointFile(root));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitForPidExit(
  pid: number,
  timeoutMs = 8000,
): Promise<void> {
  const t0 = Date.now();
  while (isPidAlive(pid)) {
    if (Date.now() - t0 > timeoutMs) return; // 僵而不死：交给后续互斥检查兜底
    await new Promise((r) => setTimeout(r, 50));
  }
}
