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
  "creategraph",
  "init",
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
  "discover",
  "serve",
  "module",
  "migrate",
  "skills",
  "help",
] as const;

export function helpText(commands?: readonly CatalogEntry[]): string {
  let text = `toporealm — 图工作空间 CLI

全局选项：--json  --root <dir>  --graph <id>
环境变量：TOPOREALM_ROOT（项目根）/ TOPOREALM_GRAPH（当前图）/ TOPOREALM_HOME（全局目录，缺省 ~/.toporealm，1.1.0）
退出码：0 成功 · 1 领域错误（agent 换方式重试）· 2 用法错误

图生命周期（工作区文件操作，不触 daemon）：
  init                          初始化项目工作区（建 .toporealm + 全局目录 + AGENTS.md 提示）
  creategraph <graph> [--label L]
                                新建图并选中（自动初始化工作区）
  use <graph>                   切换当前图
  graphs                        列出工作区全部图

图事实面（经单属主 daemon）：
  status                        当前图 revision/kind 计数/undo redo 可用性
  read [id] [--kind K]... [--where k=v]... [--fields id,status] [--limit N]
                                全图 / 过滤 + 投影（裸键 = payload.<键>；逗号或重复 flag）
                                单点邻域（read <id>）不接受过滤旗标（互斥，exit 2）
  find <k=v>... [--kind K]      read --where 的糖（agent 发现动词；--kind 每次出现取一个值）
  add <kind> [--id X] [--payload '<json>']      新建对象，created id 回显
  set <id> [k=v]... [--payload '<json>'] [--replace]
                                改状态 = daemon 端浅合并；k=null 删键
  link <src> <tgt> [--kind ns.rel] [--id X]     建关系；仅一种关系类型时可省 --kind
  rm <id>                       删除（悬空边拦截时点名 + fix）
  undo [N] / redo [N]           撤销/重做 N 步（超出可撤/可重做步数时钳位并报实际步数）
  log [-n N]                    提交日志尾读（显示 undo 游标之前的已生效提交；
                                被撤销段不重复显示——undo 后 log 变短是预期语义）
  cmds [--module ns]            命令目录自省（did-you-mean 的真相源）
  discover                      agent 入场一命令：status + 命令目录 + 技能索引拼装
                                （拉 daemon，与 cmds 同语义；--json data =
                                {status, commands, skills, warnings}）
  serve [--port P] [--no-open]  WebUI：确保 daemon 在跑（自动拉起带 web 伺服）→ 开浏览器
                                （daemon detached 常驻，命令即退；D22）

模块与分发（工作区文件层冷路径，不触 daemon；改动经 daemon 模块集摘要检测在下次触达生效）：
  module add <npm|路径>         安装模块（npm 来源走 npm pack --ignore-scripts）→ 落位
                                .toporealm/modules/<id>/ 并绑定；重复安装报 ID_EXISTS
  module rm <id> [--force]      卸载（只删带安装器所有权标记的目录 + 绑定）；
                                --force 仅用于清理清单不可读的损坏模块（自愈，D42）
  module list                   分段列出 path 绑定/项目池/全局池（含遮蔽与损坏标注，D27）
  migrate <旧图目录> [--dry-run]
                                0.x v1 图 → 机械迁移 + 迁移报告；新图写入 .toporealm/graphs/ 并选中
  skills index                  模块技能索引（技能名/模块/描述/路径；纯文件层不触 daemon；
                                agent 按路径 Read 加载全文；空索引 exit 0）

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
help [cmd]                     帮助（core 静态表 + 目录动态聚合，单一真相）
  --version                    查看版本（version 子命令已废除，仅旗标）

解析路径（D26：以下两行由 help 输出按当前环境回显实际值）：
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

  /**
   * 可重复单值 flag（G2-2）：`--kind A --kind B` 与 `--fields id --fields status` 每次
   * 出现只取紧跟的一个值。旧实现「收集到下一个 --flag 才停」会把后续位置参数吞进值段
   * （`read --kind X <id>` 把 id 当 kind 静默返回整类数据；`find --kind X k=v` 报用法错误）。
   * 多值写法用逗号（--fields id,status）或重复 flag。
   */
  values(name: string): string[] {
    const out: string[] = [];
    for (;;) {
      const i = this.rest.indexOf(name);
      if (i < 0) break;
      const v = this.rest[i + 1] as string | undefined;
      // 值缺失或下一个 token 又是 flag → 此出现不消费值（不吞 flag）
      if (v === undefined || v.startsWith("--")) {
        this.rest.splice(i, 1);
        continue;
      }
      out.push(v);
      this.rest.splice(i, 2);
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

  /**
   * 剩余位置参数。
   * F1（语义收紧）：过滤未消费的 `--` 开头 token——flag 查询漏吃（未知 flag / 顺序
   * 颠倒）时不再把 flag 误当位置参数（id/kind/target）。
   * G2-2：--kind 等可重复单值 flag 不再吞后续位置参数，k=v / id 落回此处。
   */
  positionals(): string[] {
    return this.rest.filter((t) => !t.startsWith("--"));
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

/**
 * G2-10⑤：help <核心动词> 的 per-verb 用法行——从静态帮助文本提取（单一真相，
 * 不另维护动词用法表）。undo/redo 共用一行，两个词都命中；提取不到返回 undefined。
 */
export function perVerbHelp(verb: string): string | undefined {
  const lines = helpText().split("\n");
  const isEntry = (l: string): boolean => /^(?: {2})?\S/.test(l);
  const firstToken = (l: string): string => l.trim().split(/\s+/)[0] ?? "";
  const matches = (l: string): boolean => {
    const t = firstToken(l);
    if (t === verb) return true;
    // undo/redo 共行：「undo [N] / redo [N]」
    return (
      (verb === "undo" || verb === "redo") &&
      (t === "undo" || t === "redo") &&
      l.includes(verb)
    );
  };
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!isEntry(line) || !matches(line)) continue;
    out.push(line.trimEnd());
    // 续行（深缩进）归属本条目：遇到下一条目（≤2 空格缩进）/空行/节头即止
    for (let j = i + 1; j < lines.length && (lines[j] as string).startsWith("    "); j++) {
      out.push((lines[j] as string).trimEnd());
    }
  }
  if (out.length === 0) return undefined;
  return `用法：toporealm ${verb}\n` + out.join("\n");
}
