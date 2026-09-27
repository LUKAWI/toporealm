import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import process from "node:process";
import {
  createLineDecoder,
  encodeLine,
  TopoError,
  type Catalog,
  type CommandRunResult,
  type CommitInput,
  type CommitResult,
  type DaemonClient,
  type GraphSummary,
  type IpcMessage,
  type IpcRequest,
  type LogEntry,
  type ReadQuery,
  type ReadResult,
  type Session,
  type TopoEvent,
  type Unsubscribe,
} from "@lukawi/toporealm-protocol";
import {
  clearEndpoint,
  isPidAlive,
  readEndpoint,
  waitForPidExit,
} from "@lukawi/toporealm-daemon-core";
import { resolveTarget, type ResolveOptions, type ResolvedTarget } from "./workspace.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ---------- IpcClient：自动拉起单属主 daemon 的传输实现（blueprint §5 生命周期） ----------

export interface IpcClientOptions {
  /** 覆盖 daemon 启动命令（测试注入）；默认解析 @lukawi/toporealm-daemon 的 toporeald bin */
  daemonCommand?: { cmd: string; args: string[] };
  connectTimeoutMs?: number;
}

/** daemon 正服务别的图/root（hello 被拒）→ 等其自旋退出后自动重拉（D5） */
class DaemonStaleError extends Error {}

function defaultDaemonCommand(): { cmd: string; args: string[] } {
  const req = createRequire(import.meta.url);
  const pkgPath = req.resolve("@lukawi/toporealm-daemon/package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    bin?: Record<string, string> | string;
  };
  const binRel =
    typeof pkg.bin === "string"
      ? pkg.bin
      : (pkg.bin?.["toporeald"] ?? "bin/toporeald.mjs");
  return {
    cmd: process.execPath,
    args: [path.join(path.dirname(pkgPath), binRel)],
  };
}

/**
 * 拉起单属主 daemon（detached 常驻，blueprint §5）：脱离拉起者独立存活，
 * 退出由空闲超时/清理路径负责。toporealm serve 复用（可附 --web-port 等参数）。
 *
 * G2-1：daemon 的 stderr 不再丢弃——落 os.tmpdir() 下按 root 哈希定址的见证文件。
 * 不用 pipe：detached daemon 比 CLI 长寿，CLI 退出即关闭 pipe 读端，daemon 之后的
 * stderr 写（启动横幅/警告）会 EPIPE 波及常驻进程；落盘文件则与拉起者生命周期无关，
 * 连接超时时客户端可读尾部把 toporeald 真实死因附进错误（坏模块/坏 YAML/坏 manifest）。
 */
export function daemonStderrLogPath(root: string): string {
  const name = `toporealm-${crypto
    .createHash("sha256")
    .update(path.resolve(root))
    .digest("hex")
    .slice(0, 16)}`;
  return path.join(os.tmpdir(), `${name}.toporeald-stderr.log`);
}

/** 读 daemon stderr 见证文件尾部（无文件/读失败 → 空串；上限 ~800 字符） */
export async function daemonStderrTail(root: string): Promise<string> {
  try {
    const text = await fsp.readFile(daemonStderrLogPath(root), "utf8");
    const trimmed = text.trim();
    return trimmed.length > 800 ? trimmed.slice(-800) : trimmed;
  } catch {
    return "";
  }
}

export function spawnDaemonDetached(
  target: { root: string; graphId: string },
  extraArgs: string[] = [],
  cmd: { cmd: string; args: string[] } | undefined = undefined,
): void {
  const c = cmd ?? defaultDaemonCommand();
  // 见证文件按次截断重写：只关心最近一次拉起的输出
  let stderrFd: number | undefined;
  try {
    stderrFd = fs.openSync(daemonStderrLogPath(target.root), "w");
  } catch {
    /* 见证文件打不开不阻断拉起（可观测性增强，非执法） */
  }
  try {
    const child = spawn(
      c.cmd,
      [...c.args, "--root", target.root, "--graph", target.graphId, ...extraArgs],
      {
        // detached：daemon 必须脱离拉起者独立常驻（blueprint §5）——拉起它的
        // CLI/中间进程退出时不得连带被杀（POSIX 入新进程组，Windows 独立作业）。
        detached: true,
        stdio: ["ignore", "ignore", stderrFd !== undefined ? stderrFd : "ignore"], // stderr 落见证文件（G2-1）
        windowsHide: true,
      },
    );
    child.unref(); // 父进程事件循环不为它保持存活
  } catch (err) {
    throw new TopoError({
      code: "DAEMON_UNREACHABLE",
      message: `无法拉起 daemon：${String(err)}`,
    });
  } finally {
    // fd 已随 spawn 继承给子进程；父侧副本立即关闭（见证文件由子进程独占续写）
    if (stderrFd !== undefined) fs.closeSync(stderrFd);
  }
}

function connectSocket(address: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect(address);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("connect timeout"));
    }, timeoutMs);
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

export class IpcClient implements DaemonClient {
  constructor(private readonly opts: IpcClientOptions = {}) {}

  async connect(connectOpts?: ResolveOptions): Promise<Session> {
    const target = await resolveTarget(connectOpts);
    const deadline = Date.now() + (this.opts.connectTimeoutMs ?? 10_000);
    let spawnCount = 0;
    let staleCount = 0;
    let lastSpawnAt = 0;
    for (;;) {
      if (Date.now() > deadline) {
        // G2-1：把 toporeald 的真实死因（坏模块/坏 modules.yaml/坏 graph.yaml →
        // 其启动即退，死因已在 stderr 见证文件）附进超时错误——不再只给一句
        // 「等待就绪超时」让用户手动复现。封闭码不变（DAEMON_UNREACHABLE）。
        const tail = await daemonStderrTail(target.root);
        throw new TopoError({
          code: "DAEMON_UNREACHABLE",
          message:
            tail !== ""
              ? `等待 daemon 就绪超时；toporeald 退出原因：${tail}`
              : "等待 daemon 就绪超时",
          ...(tail !== ""
            ? {}
            : { hint: "手动运行 toporeald --root <dir> --graph <id> 观察输出" }),
        });
      }
      const ep = await readEndpoint(target.root);
      if (ep && isPidAlive(ep.pid)) {
        try {
          return await this.attach(target, ep.address);
        } catch (err) {
          if (err instanceof DaemonStaleError) {
            if (++staleCount > 3) {
              throw new TopoError({
                code: "SESSION_STALE",
                message: "daemon 反复与目标图不符，放弃重试",
              });
            }
            await waitForPidExit(ep.pid);
            lastSpawnAt = 0; // 旧 daemon 已退，下一轮允许立即重拉
            continue;
          }
          // socket 连不上（僵死 endpoint）→ 清掉重拉
          await clearEndpoint(target.root).catch(() => {});
          continue;
        }
      }
      if (ep) {
        // pid 已死：陈旧 endpoint
        await clearEndpoint(target.root).catch(() => {});
        continue;
      }
      // 无 endpoint：拉起（上限 2 次）；已拉起则耐心等冷启动（tsx 装载 ~1-2s），
      // 超过 4s 仍无 endpoint 才允许第二次拉起（防崩溃循环但不误判慢启动）
      const now = Date.now();
      if (spawnCount === 0 || (spawnCount < 2 && now - lastSpawnAt > 4000)) {
        this.spawnDaemon(target);
        spawnCount++;
        lastSpawnAt = now;
      }
      await sleep(120);
    }
  }

  private async attach(
    target: ResolvedTarget,
    address: string,
  ): Promise<Session> {
    let socket: net.Socket;
    try {
      socket = await connectSocket(address, 1500);
    } catch {
      throw new Error("endpoint not accepting connections");
    }
    const session = new IpcSession(socket);
    try {
      await session.handshake(target);
    } catch (err) {
      socket.destroy();
      if (err instanceof TopoError && err.code === "SESSION_STALE") {
        throw new DaemonStaleError(err.message);
      }
      throw err;
    }
    return session;
  }

  private spawnDaemon(target: ResolvedTarget): void {
    spawnDaemonDetached(target, [], this.opts.daemonCommand);
  }
}

class IpcSession implements Session {
  graphId = "";
  instanceId = "";
  private next = 1;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private readonly listeners = new Set<(e: TopoEvent) => void>();
  private subToken: string | null = null;
  private dead = false;

  constructor(private readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    const decode = createLineDecoder((m: IpcMessage) => this.onMessage(m));
    socket.on("data", (chunk: string) => decode.push(chunk));
    const drop = (): void => {
      this.dead = true;
      this.failAll(
        new TopoError({
          code: "DAEMON_UNREACHABLE",
          message: "与 daemon 的连接已断开",
          fix: "重新连接（自动拉起）",
        }),
      );
    };
    socket.on("close", drop);
    socket.on("error", drop);
  }

  private onMessage(m: IpcMessage): void {
    if ("event" in m) {
      for (const l of [...this.listeners]) {
        try {
          l(m.event);
        } catch {
          /* 监听器异常不阻断广播 */
        }
      }
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (this.instanceId === "") {
      this.instanceId = m.instanceId;
    } else if (m.instanceId !== this.instanceId) {
      // 会话指纹变化：daemon 重启 → 作废目录缓存、全量重拉（blueprint §5）
      this.dead = true;
      this.failAll(
        new TopoError({
          code: "SESSION_STALE",
          message: "daemon 已重启（instanceId 变化），会话作废",
          fix: "重新 connect",
        }),
      );
      for (const l of this.listeners) {
        try {
          l({ type: "reset", reason: "daemon-restarted" });
        } catch {
          /* 忽略 */
        }
      }
      p.reject(
        new TopoError({ code: "SESSION_STALE", message: "daemon 已重启（instanceId 变化）" }),
      );
      return;
    }
    if (m.ok) p.resolve(m.result);
    else p.reject(TopoError.fromJSON(m.error));
  }

  private failAll(err: TopoError): void {
    for (const [, p] of [...this.pending]) p.reject(err);
    this.pending.clear();
  }

  private nextId(): string {
    return String(this.next++);
  }

  private request(req: IpcRequest): Promise<unknown> {
    if (this.dead) {
      return Promise.reject(
        new TopoError({ code: "SESSION_STALE", message: "会话已失效", fix: "重新 connect" }),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(req.id)) {
          reject(
            new TopoError({ code: "DAEMON_UNREACHABLE", message: "daemon 响应超时" }),
          );
        }
      }, 30_000);
      this.pending.set(req.id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.socket.write(encodeLine(req));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(req.id);
        reject(err);
      }
    });
  }

  async handshake(target: ResolvedTarget): Promise<void> {
    const res = (await this.request({
      id: this.nextId(),
      op: "hello",
      root: target.root,
      graph: target.graphId,
    })) as { graphId: string; revision: number };
    this.graphId = res.graphId;
  }

  async status(): Promise<GraphSummary> {
    return (await this.request({ id: this.nextId(), op: "status" })) as GraphSummary;
  }

  async read(query?: ReadQuery): Promise<ReadResult> {
    return (await this.request({
      id: this.nextId(),
      op: "read",
      ...(query !== undefined ? { query } : {}),
    })) as ReadResult;
  }

  async log(opts?: { limit?: number }): Promise<readonly LogEntry[]> {
    return (await this.request({
      id: this.nextId(),
      op: "log",
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    })) as readonly LogEntry[];
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    return (await this.request({
      id: this.nextId(),
      op: "commit",
      input,
    })) as CommitResult;
  }

  async undo(steps?: number): Promise<CommitResult> {
    return (await this.request({
      id: this.nextId(),
      op: "undo",
      ...(steps !== undefined ? { steps } : {}),
    })) as CommitResult;
  }

  async redo(steps?: number): Promise<CommitResult> {
    return (await this.request({
      id: this.nextId(),
      op: "redo",
      ...(steps !== undefined ? { steps } : {}),
    })) as CommitResult;
  }

  async catalog(module?: string): Promise<Catalog> {
    return (await this.request({
      id: this.nextId(),
      op: "catalog",
      ...(module !== undefined ? { module } : {}),
    })) as Catalog;
  }

  async run(
    commandId: string,
    opts?: { target?: string; input?: unknown },
  ): Promise<CommandRunResult> {
    return (await this.request({
      id: this.nextId(),
      op: "run",
      commandId,
      ...(opts !== undefined ? { opts } : {}),
    })) as CommandRunResult;
  }

  async events(
    listener: (e: TopoEvent) => void,
    opts?: { fromRevision?: number },
  ): Promise<Unsubscribe> {
    this.listeners.add(listener);
    if (this.subToken === null) {
      const res = (await this.request({
        id: this.nextId(),
        op: "events",
        ...(opts?.fromRevision !== undefined
          ? { fromRevision: opts.fromRevision }
          : {}),
      })) as { token: string };
      this.subToken = res.token;
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.subToken !== null) {
        const token = this.subToken;
        this.subToken = null;
        void this.request({ id: this.nextId(), op: "unlisten", token }).catch(
          () => {},
        );
      }
    };
  }

  async close(): Promise<void> {
    if (this.subToken !== null) {
      const token = this.subToken;
      this.subToken = null;
      void this.request({ id: this.nextId(), op: "unlisten", token }).catch(
        () => {},
      );
    }
    this.socket.end();
  }
}
