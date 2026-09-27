import {
  TopoError,
  type DaemonClient,
  type IpcRequest,
  type IpcResultMap,
  type Origin,
  type Session,
  type TopoEvent,
  type Unsubscribe,
} from "@lukawi/toporealm-protocol";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { ModuleHost } from "@lukawi/toporealm-module-host";
import { SessionTransport, type SessionOp } from "./transport.js";
import { resolveTarget, type ResolveOptions } from "./workspace.js";

// ---------- MemoryClient：进程内完整 daemon 语义（测试主缝 / 嵌入式集成，blueprint §8） ----------

export interface MemoryClientOptions {
  /** 提交来源（默认 "cli"；测试注入 module:* 验所有权法） */
  origin?: Origin;
  /** 默认 true：文件监视吸收外部编辑 */
  watch?: boolean;
}

export class MemoryClient implements DaemonClient {
  constructor(private readonly opts: MemoryClientOptions = {}) {}

  async connect(connectOpts?: ResolveOptions): Promise<Session> {
    const target = await resolveTarget(connectOpts);
    const core = await DaemonCore.open({
      root: target.root,
      graphId: target.graphId,
      watch: this.opts.watch,
    });
    // 模块装载与 daemon 同构（模块集启动冻结；requires 缺失 → 大声失败）
    const host = await ModuleHost.load(core, { root: target.root });
    return new MemorySession(core, host, this.opts.origin ?? "cli");
  }
}

/**
 * memory 会话 = 共享传输基座（transport.ts）+ 进程内直连策略（D40）：
 * 10 个 Session 方法骨架在基座，这里的传输策略是把 op 直呼到 DaemonCore/ModuleHost
 * （不走 wire 管道：无 pending/超时/重连；TopoError 原生抛出，无 fromJSON 重建）。
 * 返回类型仍被 IpcResultMap 脊柱钉住——与 daemon wire 结果形状漂移即编译失败。
 */
export class MemorySession extends SessionTransport implements Session {
  constructor(
    private readonly core: DaemonCore,
    private readonly host: ModuleHost,
    private readonly origin: Origin,
  ) {
    super();
  }

  get graphId(): string {
    return this.core.graphId;
  }

  get instanceId(): string {
    return this.core.instanceId;
  }

  /** 传输策略：op → 进程内直调（core/host 同步入口经 Promise.resolve 对齐骨架的异步缝）。
   *  参数缺省（log limit 50 / undo·redo steps 1）是 memory 语义，保留。 */
  protected override dispatch<O extends SessionOp>(
    req: IpcRequest & { op: O },
  ): Promise<IpcResultMap[O]> {
    const wire = req as IpcRequest; // 全 union 视图：switch 按 op 字面量收窄取载荷
    switch (wire.op) {
      case "status":
        return Promise.resolve(this.core.status()) as Promise<IpcResultMap[O]>;
      case "read":
        return Promise.resolve(this.core.read(wire.query)) as Promise<IpcResultMap[O]>;
      case "log":
        // readonly LogEntry[]（wire 脊柱）← LogEntry[]（core.tailLog）：经 unknown 对齐只读性
        return Promise.resolve(
          this.core.tailLog(wire.limit ?? 50),
        ) as unknown as Promise<IpcResultMap[O]>;
      case "commit":
        return this.core.commit(wire.input, this.origin) as Promise<IpcResultMap[O]>;
      case "undo":
        return this.core.undo(wire.steps ?? 1, this.origin) as Promise<IpcResultMap[O]>;
      case "redo":
        return this.core.redo(wire.steps ?? 1, this.origin) as Promise<IpcResultMap[O]>;
      case "catalog":
        return Promise.resolve(this.host.catalog(wire.module)) as Promise<IpcResultMap[O]>;
      case "run":
        return this.host.run(wire.commandId, wire.opts) as Promise<IpcResultMap[O]>;
      default:
        // hello/events/unlisten 等握手与订阅 op 不经 dispatch（events 已整法覆写）
        throw new TopoError({
          code: "INVALID_INPUT",
          message: `MemorySession 直连不支持 wire op：${String(wire.op)}`,
        });
    }
  }

  /** 事件策略：订阅面整体委托 DaemonCore（core.events 自带扇出与退订；同步返回退订函数） */
  override async events(
    listener: (e: TopoEvent) => void,
    opts?: { fromRevision?: number },
  ): Promise<Unsubscribe> {
    return this.core.events(listener, opts);
  }

  override async close(): Promise<void> {
    this.core.dispose();
  }

  /** 字节策略不适用：直连无 wire；防御性抛错（dispatch 已覆写，永不触达） */
  protected override sendRequest(_req: IpcRequest): never {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: "MemorySession 直连不经过 wire 管道",
    });
  }

  /** 测试辅助：确定性触发外部编辑吸收（IPC adapter 用真实 fs.watch） */
  reconcileNow(): Promise<boolean> {
    return this.core.reconcileExternal();
  }

  /** 测试/S2 缝：模块运行时访问（目录 warning、form 投影等） */
  get moduleRuntime(): ModuleHost {
    return this.host;
  }
}
