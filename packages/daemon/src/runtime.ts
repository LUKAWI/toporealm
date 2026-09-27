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

  /**
   * 释放当前图内核与换载监听（A4：dispose 责任归 runtime）。
   * 修复前 serveDaemon.stop() dispose 的是启动时捕获的 core 引用——任意一次换载后，
   * 当前图内核的 fs.watch 与 reconcile 定时器永不清理（库用法/测试泄漏，detached
   * 进程靠 process.exit 兜底）。stop 是唯一释放口，必须经此方法收口。
   */
  dispose(): void {
    this.swapListeners.clear();
    this.pair.core.dispose();
  }

  /** 请求入口：active 指针变化 → 换载（mtime 缓存，未变化零成本）。失败吞掉（跟随语义）。 */
  async maybeSwap(): Promise<void> {
    if (this.swapPromise) {
      await this.swapPromise.catch(() => {});
      return;
    }
    const stamp = await this.readActiveStamp();
    if (stamp === null || stamp === this.activeStampCache) return;
    const target = await readActiveGraphId(
      workspacePaths(this.pair.core.root).activeFile,
    );
    if (!target || target === this.pair.core.graphId) {
      this.activeStampCache = stamp;
      return;
    }
    // A3：等待窗口内可能已有显式换载（ensureGraph）入场——让位且不消费 stamp，
    // 下一请求重查。修复前此处无条件赋值会覆写进行中的 swapPromise → 双换载竞态
    //（双开内核/泄漏/dispose 落错对象）。
    if (this.swapPromise) return;
    this.activeStampCache = stamp;
    await this.startSwap(target).catch(() => {});
  }

  /** 显式目标图（hello 带 graph）：必要时换载；失败如实上抛，旧图继续服务（R2）。 */
  async ensureGraph(graphId: string): Promise<void> {
    if (graphId === this.pair.core.graphId) return;
    if (this.swapPromise) await this.swapPromise;
    if (graphId === this.pair.core.graphId) return;
    // A3：与 maybeSwap 同构走 startSwap——换载全程持 swapPromise 门，
    // 并发双开/绕过独占（Y2）不再可能。
    await this.startSwap(graphId);
  }

  /**
   * 换载入口（A3 收口）：swapPromise 的赋值先于 doSwap 任何 body 执行。
   * 修复前 `this.swapPromise = this.doSwap(target)` 的 RHS 先同步执行 doSwap 体
   * 到首个 await，期间 beginOp 的门检查已通过——op 的 inflight 落在正被换载的
   * 旧内核上；ensureGraph 直呼 doSwap 则完全不设门。现在 beginOp 在换载全程
   * 看到非空 swapPromise，单线程下 break→inflight++ 无让渡点，门语义完整。
   */
  private startSwap(target: string): Promise<void> {
    const p = (async () => {
      await null; // 先让渡：保证下面的赋值先于 doSwap 体（drain 检查 / open）执行
      await this.doSwap(target);
    })().finally(() => {
      this.swapPromise = null;
    });
    this.swapPromise = p;
    return p;
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
