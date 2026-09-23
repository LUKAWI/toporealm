import { suggestClosest, type CatalogEntry } from "@lukawi/toporealm-protocol";

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
  "cmds",
  "serve",
  "module",
  "migrate",
  "host",
  "help",
  "version",
] as const;

export function helpText(commands?: readonly CatalogEntry[]): string {
  let text = `toporealm — 图工作空间 CLI（1.0）

全局选项：--json  --root <dir>  --graph <id>
环境变量：TOPOREALM_ROOT / TOPOREALM_GRAPH
退出码：0 成功 · 1 领域错误（agent 换方式重试）· 2 用法错误

图生命周期（工作区文件操作，不触 daemon）：
  new <graph> [--label L]       新建图并选中（自动初始化工作区）
  use <graph>                   切换当前图
  graphs                        列出工作区全部图

图事实面（经单属主 daemon）：
  status                        当前图 revision/kind 计数/undo redo 可用性
  read [id] [--kind K]... [--where k=v]... [--fields id,status] [--limit N]
                                全图 / 单点邻域 / 过滤 + 投影（裸键 = payload.<键>；逗号或重复 flag）
  find <k=v>... [--kind K]      read --where 的糖（agent 发现动词）
  add <kind> [--id X] [--payload '<json>']      新建对象，created id 回显
  set <id> [k=v]... [--payload '<json>'] [--replace]
                                改状态 = daemon 端浅合并；k=null 删键
  link <src> <tgt> [--kind ns.rel] [--id X]     建关系；仅一种关系类型时可省 --kind
  rm <id>                       删除（悬空边拦截时点名 + fix）
  undo [N] / redo [N]           撤销/重做 N 步
  log [-n N]                    提交日志尾读
  cmds [--module ns]            命令目录自省（did-you-mean 的真相源）
  serve [--port P] [--no-open]  WebUI：确保 daemon 在跑（自动拉起带 web 伺服）→ 开浏览器
                                （daemon detached 常驻，命令即退；D22）

模块与分发（工作区文件层冷路径，不触 daemon；改动经 daemon 模块集摘要检测在下次触达生效）：
  module add <npm|路径>         安装模块（npm 来源走 npm pack --ignore-scripts）→ 落位
                                .toporealm/modules/<id>/ 并绑定；重复安装报 ID_EXISTS
  module rm <id>                卸载（只删带安装器所有权标记的目录 + 绑定）
  module list                   列出绑定模块（workspace/path/global 与安装来源）
  migrate <旧图目录> [--dry-run]
                                0.x v1 图 → 1.0 机械迁移 + 迁移报告；新图写入 graphs/ 并选中
  host sync [--host claude-code|pi|all]
                                宿主投影：claude-code plugin 打包 / pi extension+skills 打包

模块命令（<ns.name> [target] [--input '<json>']，即顶层子命令）：
`;
  if (commands && commands.length > 0) {
    for (const c of commands) {
      text += `  ${c.id}${c.target ? " <target>" : ""} [--input '<json>']    ${c.title}\n`;
    }
  } else {
    text += `  （本图未装载模块；toporealm cmds 自省目录）\n`;
  }
  text += `
help [cmd] / version           帮助（core 静态表 + 目录动态聚合，单一真相）与版本
`;
  return text;
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

// ---------- --fields 投影解析（blueprint §4：--fields id,status 逗号写法是契约拼写） ----------

/** 结构字段（protocol ReadQuery.fields）；其余裸键一律作 payload.<键> 简写（§4 示例 status = §7 约定的 payload.status） */
const STRUCTURAL_FIELDS = new Set(["id", "kind", "source", "target"]);

/**
 * --fields 解析：`--fields id,status`（逗号）与 `--fields id --fields status`（重复 flag）两种写法等价；
 * 裸键解析为 payload.<键>（蓝图 §4 示例即此语义），也可显式写 payload.<键>。
 * 非法值（空字段/空段）在本地即报用法错误（exit 2），不把坏值静默投进 core 得到空投影。
 */
export function parseFields(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    for (const piece of v.split(",")) {
      const f = piece.trim();
      if (f === "") {
        throw new UsageError(
          `--fields 字段不能为空（合法：id/kind/source/target/<payload键>/payload.<键>，得到 "${v}"）`,
        );
      }
      if (STRUCTURAL_FIELDS.has(f)) {
        out.push(f);
      } else if (f.startsWith("payload.")) {
        if (f === "payload.") {
          throw new UsageError(`--fields "payload." 缺键名（例如 payload.status）`);
        }
        out.push(f);
      } else {
        out.push(`payload.${f}`); // 裸键 = payload 键简写
      }
    }
  }
  return out;
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
