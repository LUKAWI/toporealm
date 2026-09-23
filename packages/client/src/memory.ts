import type {
  Catalog,
  CommandRunResult,
  CommitInput,
  CommitResult,
  DaemonClient,
  GraphSummary,
  LogEntry,
  Origin,
  ReadQuery,
  ReadResult,
  Session,
  TopoEvent,
  Unsubscribe,
} from "@lukawi/toporealm-protocol";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
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
    return new MemorySession(core, this.opts.origin ?? "cli");
  }
}

export class MemorySession implements Session {
  constructor(
    private readonly core: DaemonCore,
    private readonly origin: Origin,
  ) {}

  get graphId(): string {
    return this.core.graphId;
  }

  get instanceId(): string {
    return this.core.instanceId;
  }

  async status(): Promise<GraphSummary> {
    return this.core.status();
  }

  async read(query?: ReadQuery): Promise<ReadResult> {
    return this.core.read(query);
  }

  async log(opts?: { limit?: number }): Promise<readonly LogEntry[]> {
    return this.core.tailLog(opts?.limit ?? 50);
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    return this.core.commit(input, this.origin);
  }

  async undo(steps?: number): Promise<CommitResult> {
    return this.core.undo(steps ?? 1, this.origin);
  }

  async redo(steps?: number): Promise<CommitResult> {
    return this.core.redo(steps ?? 1, this.origin);
  }

  async catalog(): Promise<Catalog> {
    return this.core.catalog();
  }

  async run(commandId: string): Promise<CommandRunResult> {
    return this.core.run(commandId);
  }

  async events(
    listener: (e: TopoEvent) => void,
    opts?: { fromRevision?: number },
  ): Promise<Unsubscribe> {
    return this.core.events(listener, opts);
  }

  async close(): Promise<void> {
    this.core.dispose();
  }

  /** 测试辅助：确定性触发外部编辑吸收（IPC adapter 用真实 fs.watch） */
  reconcileNow(): Promise<boolean> {
    return this.core.reconcileExternal();
  }
}
