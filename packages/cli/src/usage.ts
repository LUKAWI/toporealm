import { suggestClosest } from "@lukawi/toporealm-protocol";

// ---------- 用法错误（退出码 2：本地解析，不触 daemon） ----------

export class UsageError extends Error {
  readonly fix?: string;

  constructor(message: string, fix?: string) {
    super(message);
    this.name = "UsageError";
    if (fix !== undefined) this.fix = fix;
  }
}

export const CORE_VERBS = [
  "new",
  "use",
  "graphs",
  "status",
  "read",
  "find",
  "set",
  "add",
  "link",
  "rm",
  "log",
  "undo",
  "redo",
  "help",
  "version",
] as const;

export function helpText(): string {
  return `toporealm — 图工作空间 CLI（1.0，M1 核心动词）

全局选项：--json  --root <dir>  --graph <id>
环境变量：TOPOREALM_ROOT / TOPOREALM_GRAPH
退出码：0 成功 · 1 领域错误（agent 换方式重试）· 2 用法错误

图生命周期（工作区文件操作，不触 daemon）：
  new <graph> [--label L]       新建图并选中（自动初始化工作区）
  use <graph>                   切换当前图
  graphs                        列出工作区全部图

图事实面（经单属主 daemon）：
  status                        当前图 revision/kind 计数/undo redo 可用性
  read [id] [--kind K]... [--where k=v]... [--fields f]... [--limit N]
                                全图 / 单点邻域 / 过滤 + 投影
  find <k=v>... [--kind K]      read --where 的糖（agent 发现动词）
  add <kind> [--id X] [--payload '<json>']      新建对象，created id 回显
  set <id> [k=v]... [--payload '<json>'] [--replace]
                                改状态 = daemon 端浅合并；k=null 删键
  link <src> <tgt> [--kind ns.rel] [--id X]     建关系；仅一种关系类型时可省 --kind
  rm <id>                       删除（悬空边拦截时点名 + fix）
  undo [N] / redo [N]           撤销/重做 N 步
  log [-n N]                    提交日志尾读

help / version                 帮助与版本（模块命令 cmds、serve、module、migrate、host sync 在后续里程碑）
`;
}

// ---------- 参数解析 ----------

export class Argv {
  private readonly rest: string[];

  constructor(argv: string[]) {
    this.rest = [...argv];
  }

  flag(...names: string[]): boolean {
    for (const n of names) {
      const i = this.rest.indexOf(n);
      if (i >= 0) {
        this.rest.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  value(...names: string[]): string | undefined {
    for (const n of names) {
      const i = this.rest.indexOf(n);
      if (i >= 0 && i + 1 < this.rest.length) {
        const v = this.rest[i + 1] as string;
        this.rest.splice(i, 2);
        return v;
      }
    }
    return undefined;
  }

  values(name: string): string[] {
    // 可变长：--fields id payload.status / 重复 --kind A --kind B 两种写法都支持；
    // 遇到下一个 --flag 即停
    const out: string[] = [];
    for (;;) {
      const i = this.rest.indexOf(name);
      if (i < 0) break;
      this.rest.splice(i, 1);
      while (
        i < this.rest.length &&
        !(this.rest[i] as string).startsWith("--")
      ) {
        out.push(this.rest[i] as string);
        this.rest.splice(i, 1);
      }
    }
    return out;
  }

  numberValue(...names: string[]): number | undefined {
    const v = this.value(...names);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
      throw new UsageError(`${names[0]} 需要非负整数，得到 "${v}"`);
    }
    return n;
  }

  /** 剩余位置参数 */
  positionals(): string[] {
    return this.rest;
  }
}

// ---------- k=v → 载荷（CLI 的 k=v→Change 编译器） ----------

export function parseJsonish(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return s; // 非 JSON 一律按字符串
  }
}

export function parseKvPairs(pairs: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq <= 0) {
      throw new UsageError(`键值对格式应为 k=v，得到 "${p}"`);
    }
    out[p.slice(0, eq)] = parseJsonish(p.slice(eq + 1));
  }
  return out;
}

export function parseJsonObject(
  s: string | undefined,
  flagName: string,
): Record<string, unknown> | undefined {
  if (s === undefined) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(s) as unknown;
  } catch {
    throw new UsageError(`${flagName} 需要合法 JSON，例如 '{"status":"todo"}'`);
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new UsageError(`${flagName} 需要一个 JSON 对象`);
  }
  return v as Record<string, unknown>;
}

export function unknownVerbSuggestion(verb: string): string {
  const s = suggestClosest(verb, CORE_VERBS, 2);
  return s.length > 0 ? `；最接近的核心动词：${s.join(", ")}` : "";
}
