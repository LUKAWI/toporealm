export {
  endpointFile,
  readEndpoint,
  writeEndpoint,
  clearEndpoint,
  isPidAlive,
  waitForPidExit,
  type DaemonEndpointInfo,
} from "@lukawi/toporealm-daemon-core";

import crypto from "node:crypto";
import fsp from "node:fs/promises";

import {
  DaemonCore,
  readActiveGraphId,
  workspacePaths,
} from "@lukawi/toporealm-daemon-core";
import { ModuleHost } from "@lukawi/toporealm-module-host";

// ---------- GraphRuntime（1.1.0 D30）：单属主 daemon 的当前图状态 + 内存换载 ----------
//
// 换载语义（blueprint §1.8 D30 / 评审 R1 R2 Y2 Y3）：
// - 跟随：每个请求入口检查 active 指针（mtime+size 缓存）；显式目标（hello 带 graph）优先。
// - 独占：换载等待在途请求清零后进行；请求经 beginOp/endOp 门与换载互斥。
// - 失败：新图装载失败 → 错误如实上抛，旧图继续服务（禁止 SESSION_STALE——客户端会等
//   一个永不退出的 pid）；跟随路径吞错（下一次 active 变更前不重试）。
// - re-binding：host.attach(newCore)（R1）——模块已 activate 恰好一次，注册面向新 core 重放。
// - 订阅：换载成功后通知所有连接（重订阅 + 推送 reset/graph-switched）。

export interface RuntimePair {
  core: DaemonCore;
  host: ModuleHost;
}

/** web 分发器的 runtime 结构面（daemon 实现；web 侧仅依赖此形状） */
export interface WireRuntimeLike {
  current(): RuntimePair;
  maybeSwap(): Promise<void>;
  ensureGraph(graphId: string): Promise<void>;
  beginOp(): Promise<void>;
  endOp(): void;
  onSwap(cb: (pair: RuntimePair) => void): () => void;
}

export class GraphRuntime implements WireRuntimeLike {
  private readonly instanceId_ = crypto.randomUUID();

  /** 实例身份：runtime 级稳定（换载延续实例，非重启——D30；wire 层恒用此 id） */
  instanceId(): string {
    return this.instanceId_;
  }
  private pair: RuntimePair;
  /** 在途请求计数（换载独占等待其清零） */
  private inflight = 0;
  private drainWaiters: (() => void)[] = [];
  /** 进行中的换载（所有请求入口在此排队） */
  private swapPromise: Promise<void> | null = null;
  /** active 指针缓存戳（mtime:size） */
  private activeStampCache: string | null = null;
  private readonly swapListeners = new Set<(pair: RuntimePair) => void>();

  private constructor(pair: RuntimePair) {
    this.pair = pair;
  }

  static async open(root: string, graphId: string): Promise<GraphRuntime> {
    const core = await DaemonCore.open({ root, graphId, watch: true });
    const host = await ModuleHost.load(core, { root });
    return new GraphRuntime({ core, host });
  }

  current(): RuntimePair {
    return this.pair;
  }

  onSwap(cb: (pair: RuntimePair) => void): () => void {
    this.swapListeners.add(cb);
    return () => {
      this.swapListeners.delete(cb);
    };
  }

  /** 请求入口：active 指针变化 → 换载（mtime 缓存，未变化零成本）。失败吞掉（跟随语义）。 */
  async maybeSwap(): Promise<void> {
    if (this.swapPromise) {
      await this.swapPromise.catch(() => {});
      return;
    }
    const stamp = await this.readActiveStamp();
    if (stamp === null || stamp === this.activeStampCache) return;
    this.activeStampCache = stamp;
    const target = await readActiveGraphId(
      workspacePaths(this.pair.core.root).activeFile,
    );
    if (!target || target === this.pair.core.graphId) return;
    this.swapPromise = this.doSwap(target).finally(() => {
      this.swapPromise = null;
    });
    await this.swapPromise.catch(() => {});
  }

  /** 显式目标图（hello 带 graph）：必要时换载；失败如实上抛，旧图继续服务（R2）。 */
  async ensureGraph(graphId: string): Promise<void> {
    if (graphId === this.pair.core.graphId) return;
    if (this.swapPromise) await this.swapPromise;
    if (graphId === this.pair.core.graphId) return;
    await this.doSwap(graphId);
  }

  /** 请求门：与换载互斥（Y2）。op 全程持门；beginOp 等待进行中的换载完成。 */
  async beginOp(): Promise<void> {
    for (;;) {
      if (!this.swapPromise) break;
      await this.swapPromise.catch(() => {});
    }
    this.inflight++;
  }

  endOp(): void {
    this.inflight--;
    if (this.inflight <= 0) {
      for (const w of this.drainWaiters.splice(0)) w();
    }
  }

  private async doSwap(target: string): Promise<void> {
    // 独占：等在途请求清零（Y2：排空 after-commit 队列——commit 返回即已排空）
    while (this.inflight > 0) {
      await new Promise<void>((r) => this.drainWaiters.push(r));
    }
    const newCore = await DaemonCore.open({
      root: this.pair.core.root,
      graphId: target,
      watch: true,
    });
    await this.pair.host.attach(newCore);
    const old = this.pair.core;
    this.pair = { core: newCore, host: this.pair.host };
    old.dispose();
    for (const cb of [...this.swapListeners]) cb(this.pair);
  }

  private async readActiveStamp(): Promise<string | null> {
    try {
      const st = await fsp.stat(workspacePaths(this.pair.core.root).activeFile);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }
}
