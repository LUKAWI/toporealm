# TopoRealm 1.0 重建蓝图

> 状态：设计基准（D1–D17 + ADR-0003~0006 + interface-comparison.md 裁决的落地文档）。
> 本文是实现阶段的唯一规范来源；与三份候选设计冲突处，以本文为准。

---

## 0. 总览

```
Claude Code (plugin+skills)      Pi (extension+skills)       浏览器 (WebUI)
        │  shell: toporealm …          │ shell                  │ HTTP + WS
        └──────────────┬───────────────┴──────────┬─────────────┘
                       ▼   DaemonClient port      ▼
        ┌─────────────────────────────────────────────────────┐
        │                Daemon（单属主进程）                    │
        │  内存图态 · 统一提交管线 · WS 广播 · 文件监视 · 自动拉起   │
        │  接口：status/read/log/commit/undo/redo/catalog/run/  │
        │        events/close（+instanceId）                    │
        │  执法仅两条：所有权法(module来源) + 悬空边                │
        └───────────────┬─────────────────────────────────────┘
                        │ 原子落盘（临时文件+rename）
     graph.yaml(revision+undo游标) · objects/ · relations/ · .log(提交日志)
                        │
        module-host：装载双层模块（module.yaml 协调 + runtime 代码）
                     命令/表单/钩子注册，目录自省
```

一句话：**人经 CLI、agent 经 CLI+skills、浏览器经 WS，全部打到一个单属主 daemon；模块是装载进 daemon 的双层扩展；core 只执法两条。**

---

## 1. Protocol 层（全量类型，`packages/protocol`，零依赖）

```ts
// ---------- 基础词汇 ----------
export type EntityId = string;          // 磁盘文件名安全：禁 / \ : 与控制字符
export type Kind = string;              // 命名空间化："wf.task"；无点号 = 公共/无主
export type Payload = Record<string, unknown>;
export type Origin = "cli" | "web" | `module:${string}` | "external" | "migrate";

/** 最小信封（D3）：core 知道的一切 */
export interface Entity {
  id: EntityId;
  kind: Kind;
  payload: Payload;                     // 不透明；显示名走约定 payload.title（module.yaml titleKey 投影）
}
export interface RelationEntity extends Entity {
  source: EntityId;                     // 结构字段：悬空边检查的唯一依据
  target: EntityId;
  direction?: "directed" | "undirected"; // 可选，缺省 "directed"（D17 默认值；不占执法）
}
export type EntityRecord = Entity | RelationEntity;   // 判别："source" in r

export interface GraphSnapshot {
  graphId: string;
  revision: number;                     // 单调，每次转换 +1
  objects: readonly Entity[];
  relations: readonly RelationEntity[];
}
export interface GraphSummary {
  graphId: string;
  revision: number;
  counts: Readonly<Record<Kind, number>>;
  modules: readonly string[];           // 已装载模块 id
  canUndo: boolean;
  canRedo: boolean;
}

// ---------- 变更词汇（三条缝共用，学一次用三处） ----------
export type Change =
  | { op: "put";   kind?: Kind; id?: EntityId; payload?: Payload }           // upsert 对象；匿名 id 由 daemon 生成；kind 规则见下方 D18
  | { op: "rel";   kind: Kind; id?: EntityId; source: EntityId; target: EntityId; payload?: Payload; direction?: "directed" | "undirected" }
  | { op: "merge"; id: EntityId; payload: Payload }                            // 浅合并顶层键；值 null = 删键 ★主路径
  | { op: "del";   id: EntityId };                                             // 统一删除对象与关系（id 空间唯一）

/**
 * D18（实现期补遗，记录于 §1）：put.kind 可选（upsert 保型）。
 * 动机：改对象不必重述 kind——caller 拿到 id 就能改载荷，不应被迫先 read 回 kind 再原样带回。
 * 语义：① 新建对象（id 不存在）仍必须提供 kind；
 *      ② id 已存在时 kind 可省，以存量 kind 为准；
 *      ③ id 与 kind 同给时必须一致，否则 UNKNOWN_KIND。
 */

export interface CommitInput {
  changes: readonly Change[];           // 原子单位；一次 undo 整体撤销
  label?: string;                       // 入提交日志的一句话
  ifRevision?: number;                  // 可选乐观护航；缺省 = 无条件（单属主队列天然串行）
}
export interface CommitResult {
  revision: number;
  created: readonly EntityId[];         // daemon 分配的 id 按序回显（免二次 read）
  patch: GraphPatch;
  canUndo: boolean;
  canRedo: boolean;
}
/** 集合分桶 patch（B）：未来新资源种类 = 增量桶，契约不破 */
export interface GraphPatch {
  fromRevision: number;                 // 恒等于前一 revision（缺口只可能因客户端丢事件）
  toRevision: number;
  objects:   { added: readonly Entity[]; updated: readonly Entity[]; deleted: readonly EntityId[] };
  relations: { added: readonly RelationEntity[]; updated: readonly RelationEntity[]; deleted: readonly EntityId[] };
}

// ---------- 读查询（C-lite） ----------
export interface ReadQuery {
  ids?: readonly EntityId[];            // 各条件取交集
  kinds?: readonly Kind[];
  where?: readonly { kind?: Kind; eq?: Record<string, unknown> }[];  // payload 顶层浅等值
  fields?: readonly ("id" | "kind" | "source" | "target" | `payload.${string}`)[]; // 投影，省 token
}
export interface ReadResult { revision: number; entities: readonly EntityRecord[]; }

// ---------- 提交日志（D7：undo 栈 + 近期变更 + 审计三合一） ----------
export interface LogEntry {
  revision: number;
  kind: "commit" | "undo" | "redo" | "external";   // external = 文件监视重载吸收的人手改
  origin: Origin;
  label?: string;
  time: string;                         // ISO 8601
}
// 游标存 graph.yaml；undo/redo 移动游标，不追加日志（D17 裁决②）
// undo 后的新提交截断游标之后的日志段

// ---------- 命令目录（D12：daemon 自省，永远等于注册事实） ----------
export interface CatalogEntry {
  id: string;                           // 全名恒含点号："wf.start"
  module: string;
  title: string;                        // agent 的唯一必读文档
  target?: Kind;                        // appliesTo；缺省 = 全局命令
  input?: object;                       // JSON Schema——说明书，不是门禁（执法仅两条）
}
export interface Catalog {
  modules: readonly { id: string; version: string; namespace: string }[];
  kinds: readonly { kind: Kind; owner?: string; color?: string; icon?: string }[];
  commands: readonly CatalogEntry[];
  forms?: readonly { kind: Kind; form: FormSpec }[];   // D24②：api.form 注册面的目录投影（仅非空时携带）
}

// ---------- 事件 ----------
export type TopoEvent =
  | { type: "hello"; graphId: string; revision: number }                       // 连接/订阅后首事件，必为此
  | { type: "commit"; revision: number; patch: GraphPatch; origin: Origin; label?: string }  // commit/undo/redo/external 全走此事件
  | { type: "reset"; reason: "external-edit" | "daemon-restarted" };           // 客户端应全量重读
```

### 1.1 S1：DaemonClient port

```ts
export interface DaemonClient {
  connect(opts?: { root?: string; graph?: string }): Promise<Session>;
}
export interface Session {
  readonly graphId: string;
  readonly instanceId: string;          // daemon 会话指纹：变化 ⇒ 模块集/目录可能全变，须重拉
  status(): Promise<GraphSummary>;
  read(query?: ReadQuery): Promise<ReadResult>;
  log(opts?: { limit?: number }): Promise<readonly LogEntry[]>;
  commit(input: CommitInput): Promise<CommitResult>;
  undo(steps?: number): Promise<CommitResult>;
  redo(steps?: number): Promise<CommitResult>;
  catalog(module?: string): Promise<Catalog>;
  run(commandId: string, opts?: { target?: EntityId; input?: unknown }): Promise<CommandRunResult>;
  events(listener: (e: TopoEvent) => void, opts?: { fromRevision?: number }): Promise<Unsubscribe>; // fromRevision 回放免全量
  close(): Promise<void>;
}
export interface CommandRunResult { message?: string; data?: unknown; commits?: readonly CommitResult[]; }
```

**不变量（S1）**
- I1 revision 单调：commit/undo/redo/external 每次恰好 +1；read 永不改状态。
- I2 一次 commit 原子：changes 全成或全不成；`rel` 两端可在同一提交内创建（悬空检查针对集合整体）。
- I3 事件补丁连续：`commit` 事件 `patch.fromRevision` ≠ 客户端当前 revision ⇒ 客户端全量重读（自愈）。
- I4 所有权法只约束 `module:*` 来源；cli/web/external 豁免（人是图最终属主）。
- I5 客户端永不写图文件；磁盘唯一写者是 daemon。

**错误码全表（~17，封闭集只增不改义，全部带 hint + fix）**
| 码 | 层 | hint/fix 示例 |
|---|---|---|
| NO_WORKSPACE / NO_CURRENT_GRAPH / GRAPH_NOT_FOUND | 环境 | fix: `toporealm new` / `toporealm use` |
| UNKNOWN_ID / UNKNOWN_KIND / ID_EXISTS | 实体 | did-you-mean 来自活图/词汇表 |
| DANGLING_RELATION | 执法一 | 点名悬空边 + fix 建/删 |
| OWNERSHIP_VIOLATION | 执法二 | 点名模块与越界 kind |
| VETOED | 钩子 | 点名否决模块 + 理由（details.vetoes[]） |
| LATE_REGISTRATION | 模块 | activate 返回后注册；fix: 移回 activate 内 |
| REENTRANT_COMMIT | 钩子 | before-commit 钩子内再入提交；fix: 改到 after-commit（自动排队） |
| MISSING_MODULE | 模块依赖 | requires.modules 未装载；fix: `toporealm module add <id>` |
| UNKNOWN_COMMAND / INVALID_INPUT | 命令 | did-you-mean 来自目录 |
| IF_REVISION_MISMATCH | 并发 | fix: `read <id>` 后重试 |
| DAEMON_UNREACHABLE / SESSION_STALE | 传输 | fix: 重试（自动拉起）/ 重连 |

### 1.2 S2：模块 runtime API

```ts
// 模块入口：ESM default export；daemon 启动时装载、activate 恰好一次
export default { activate(api: ModuleApi): void | Promise<void> };

export interface ModuleApi {
  readonly self: Readonly<{ id: string; namespace: string; version: string }>;
  read(query?: ReadQuery): ReadResult;                 // 同步（in-process 内存态）
  get(id: EntityId): EntityRecord | undefined;          // 便捷直取，免全量
  byKind(kind: Kind): EntityRecord[];
  /** 所有权法执法点：以 module:<id> 身份提交；只能触碰 self.namespace.* 或公共/无主 kind */
  commit(input: CommitInput): CommitResult;             // 同步；返回即已原子落盘
  command(spec: CommandSpec, handler: CommandHandler): void;   // 仅 activate 返回前合法
  hook(name: "before-commit", fn: BeforeCommitHook): void;
  hook(name: "after-commit", fn: AfterCommitHook): void;       // 可 api.commit——排队追加，不嵌套
  form(kind: Kind, form: FormSpec): void;               // WebUI inspector 载荷表单
}

export interface CommandSpec {
  name: string;                         // 本名；目录 id = `${namespace}.${name}`
  title: string;                        // 必填：agent 的唯一文档
  target?: Kind;                        // 绑定目标主类型；缺省 = 全局命令
  input?: object;                       // JSON Schema 说明书（强烈建议写）
}
export interface CommandContext { target?: EntityRecord; input: Record<string, unknown>; }
export interface CommandOutput { message?: string; data?: unknown; }
export type CommandHandler = (ctx: CommandContext) => CommandOutput | Promise<CommandOutput>;
// handler 自由调用 api.commit（D17 裁决①）；多次 commit = 多个 undo 单位（模块自律或拆分命令）

/** before-commit：双快照——钩子直接对候选图做领域判断（B） */
export interface CommitCandidate {
  revision: number;                     // 将成为的 revision
  before: GraphSnapshot;                // 不可变
  after: GraphSnapshot;                 // 候选图（不可变）
  changes: readonly Change[];
  origin: Origin;                       // 钩子对一切来源生效（含 undo/external/人）
  conversion?: "commit" | "undo" | "redo" | "external";  // D24①：转换类别——领域钩子据此豁免 undo/redo 游标移动
}
export type BeforeCommitHook = (c: CommitCandidate) => void | { veto: string; details?: Record<string, unknown> };
// v1 钩子必须同步（D17 默认值）；core 不聚合不排序；first-veto 短路；钩子内 commit → REENTRANT_COMMIT
export interface AfterCommitEvent { revision: number; patch: GraphPatch; origin: Origin; label?: string; }
export type AfterCommitHook = (e: AfterCommitEvent) => void;

export interface FormSpec {
  fields: readonly { name: string; title?: string; type: "string" | "number" | "boolean" | "enum" | "text";
                     options?: readonly string[]; required?: boolean }[];
}
```

**模块侧不变量**
- M1 模块集 daemon 启动时冻结；注册面 activate 返回后冻结（违者 `LATE_REGISTRATION`）；命令目录因此永远为真。
- M2 模块无 undo/redo（撤销是用户的手）。
- M3 所有权法看 kind 的 namespace；关系端点跨 namespace 不违法（数据面互操作正道，D11）。
- M4 before-commit 同步、first-veto 短路、禁再入；after-commit 的提交排队追加。
- M5 声明层声明的 kinds 词汇 vs 实际写入的 kind：目录级一致性（M5 违反 = 目录外行为，记 warning，不执法——D8 声明层不是执法依据）。
- M6 `requires.modules` 不满足 → daemon 拒绝启动，点名缺失（fix: `toporealm module add`）。

### 1.3 module.yaml v2（声明层）

```yaml
format: toporealm.module/v2
id: workflow                      # 全局唯一；npm 包名可不同
namespace: wf                     # 所有权边界 + kind/命令前缀
version: "1.0.0"
requires: { modules: [] }         # 可选；缺失 = daemon 拒绝启动
kinds:
  objects: [task, checkpoint]     # 实际 kind = wf.task …
  relations: [blocks]
ui:                               # 静态投影（core 不解释，WebUI 读）
  color: "#3b82f6"
  icon: "checkbox"
  titleKey: title                 # payload 中作显示名的键
entry: ./index.js                 # 代码层入口
```

### 1.4 实现期补遗（M2：D19–D21）

**D19（实现期补遗）：错误码封闭集增补三码。**
动机：§1.2 点名的 LATE_REGISTRATION / REENTRANT_COMMIT 与不变量 M6 的 requires
缺失失败都需要稳定码进客户端错误语言；封闭集只增不改义，随本条一次入 §1.1 全表。
- `LATE_REGISTRATION`：注册面（command/hook/form）在 activate 返回后再调用即抛。
- `REENTRANT_COMMIT`：before-commit 钩子内调用 api.commit 即抛（管辖区内再入）。
- `MISSING_MODULE`：`requires.modules` 未满足，daemon 拒绝启动并点名缺失。

**D20（实现期补遗）：所有权法的 namespace 映射。**
动机：§1.2 说所有权"看 kind 的 namespace"（M3），而提交身份是 `module:<id>`——
id ≠ namespace（如 id=workflow、namespace=wf），core 需要映射。裁决：
- module-host 装载模块时向 core 注册 `id → namespace`（core 不 import module-host，
  注册面单向，与钩子注册同性质）；
- 所有权检查 = kind 命名空间 ∈ { 公共/无主, 该模块声明的 namespace }；
- 未注册的 `module:<id>` 来源回退为 namespace = id（S1 测试直注 origin 的既有语义不变）。

**D21（实现期补遗）：after-commit 排队提交的回执与失败语义。**
- after-commit 钩子内 api.commit 排队追加（不嵌套）；受理即返回排队时图态的快照回执
  （revision 为当前顶、空 patch）——真实结果以随后广播的 commit 事件为准；
- 排队提交在外层提交广播后按序排空；排空中被钩子 veto 只记 warning，不回滚外层提交；
- 排空深度上限 100（防模块自激死循环），超限记 warning 停止排空。

### 1.5 实现期补遗（M3：D22）

**D22（实现期补遗）：Web 传输缝裁决。**
动机：§2 的 web 包与 §5 多客户端条目落到代码前钉死四件事，避免 client/daemon/web 三包各自发明语义。

1. **WS 复用 IPC wire 信封**：WS 文本帧 = `IpcRequest` / `IpcResponse` / `IpcPush`
   （protocol/wire.ts 同一套类型与编解码），事件扇出与 IPC 同源（core.events 单一订阅面）。
   为此 `hello.root` 改为可选——浏览器不知道工作区路径：web 端 hello 可省 root/graph
   （省略 = 即服务 daemon 自身的 root/graph，不做比对；提供了仍比对）。
2. **web 伺服随 daemon 常开**：toporeald 启动即挂 HTTP（静态产物，目录
   `TOPOREALM_WEB_STATIC` > web-ui 包内 dist）+ WS（`/ws` 路径）。端口解析序
   `--web-port > TOPOREALM_WEB_PORT > 0（临时口）`；实际端口写入
   `.toporealm/daemon/endpoint.json` 的 `webPort` 字段——这是 web 客户端与
   `toporealm serve` 的发现面。端口被占回退临时口并如实记录。
3. **WsClient 重连语义**：异常断线自动重连（指数退避，次数可配）；重连成功后带
   `fromRevision = 本地最后 revision` 重新订阅——daemon 按事件回放语义补洞，无法回放时发
   reset，客户端据此全量重读（不变量 I3 自愈）。重连握手发现 `instanceId` 变化 =
   SESSION_STALE：在途请求失败 + 向监听者广播 `reset(daemon-restarted)`（目录缓存作废重拉，
   §5）；会话对象透明续用于新 daemon（浏览器不刷新页面）。
4. **web-ui 的 0.x REST 面（/api/*）与 MutationPlan 不迁移**（replace, don't layer）：
   web-ui 一律走 Session 契约（status/read/commit/undo/redo/catalog/run/events）。
   多图切换与 validate 面板随 REST 面死亡（daemon 单图服务；validate 不是 core 操作）；
   form/ui 投影按 §1 catalog（kinds.color/icon、commands.input）先行，复杂视图按 §7 预留 v1.1。
   空闲退出判定补充：打开中的 WS/IPC 连接视作活动（空闲 = 无连接且无请求）。

### 1.6 实现期补遗（M4：D23）

**D23（实现期补遗）：分发与迁移的落点裁决。**
动机：§2 的 distribution 包落到代码前钉死四件事，避免安装器/host sync/migrate 各自发明落点与语义。

1. **模块安装器只交付 workspace 安装**：npm 来源走 `npm pack <spec> --ignore-scripts`
   （禁安装脚本 = 安装期唯一执法点，D2 默认值）；本地路径来源直接复制。两种来源统一
   落位 `.toporealm/modules/<id>/` 并写 `.toporealm-source.json` 所有权标记（记录来源、
   版本、安装时间），绑定写 `modules.yaml: { <id>: { source: workspace } }`；卸载只删
   带标记的模块目录 + 对应绑定，无标记目录拒绝删除。`--global` 延后：CLI 显式报用法
   错误，module-host 对 global 绑定维持跳过 + warning（§3 的 global 绑定形态保留）。
2. **host sync 两宿主投影落点与格式**：claude-code = 自包含 plugin 目录
   `.toporealm/hosts/claude-code/`（`.claude-plugin/plugin.json` + `skills/toporealm/SKILL.md`
   + `hooks/hooks.json`，钩子用 Claude Code 格式：`hooks.SessionStart[].hooks[].{type:command}`）；
   pi = 原生项目级发现位（`.pi/skills/toporealm/SKILL.md` + `.pi/extensions/toporealm/index.js`，
   扩展用 pi 格式：`export default (pi) => pi.on("session_start", …)` 只读入场摘要）。
   两宿主钩子格式不得混用；基座 skill 正文同源（Agent Skills 标准 frontmatter），宿主
   差异只在包装与钩子。每个受管目录写 `.toporealm-sync.json` 所有权标记（生成器、模块
   集、文件清单）；重同步只替换标记清单内的文件，用户手写文件永不触碰。模块自身
   skills 的投影随 M5 交付（v2 声明层无 skills 字段，D12）。
3. **migrate 冲突语义细化**（§6 键冲突条款的从句展开）：`data` 先落 payload；
   `capabilities` 键与已落键冲突时更名 `cap_<键>` 落位并入冲突清单（不冲突保持原键，
   含点号的能力 id 在 payload 中合法）；`label→title`、`meta→meta` 与已有 payload 键
   冲突时 data/payload 优先、被放弃值记入冲突清单。0.x 实体文件顶层清单外字段与
   graph.yaml v1 顶层 `meta` 丢弃并计入降级清单（旧图可由 0.x 随时回看）。迁移输入的
   `.revision.json` 取 `revision` 计数（缺失按 0 并计入降级清单）。输出：新图写入
   `<root>/graphs/<图id>/`（v2 清单最后写 = 迁移完成标记；同 `new` 选中新图），迁移
   报告经 CLI 输出交付（--json 信封含全量报告），不向图目录写报告文件（§3 布局不变）；
   实体文件名 ≠ id、id 非法、缺 kind、重复 id 的实体跳过并计入错误清单；悬空关系照迁
   并单列清单（迁移是文件层机械映射，不走 commit 管线）。模块引用升级 = 报告内附每
   模块的 v2 声明投影（id/namespace/kinds 从迁移后数据观测；version/entry 为占位，由
   模块本体仓库回填）。
4. **npm pack 的 Windows tar 规避**：npm 在 Windows 下可能解析到 Git Bash 的 GNU tar
   而失败；distribution 拉起 npm 子进程时（win32）把 `C:\Windows\System32` 前置到子进程
   PATH（系统自带 bsdtar 优先）。测试同样在用例内前置，不依赖外部 shell 环境。

### 1.7 实现期补遗（M5：D24）

**D24（实现期补遗）：Workflow 首发移植的四条落点裁决。**
动机：§7 的移植面落到代码前钉死四件事——领域钩子如何区分 undo/redo 与前向转换、
FormSpec 如何过缝到达 WebUI、0.x `manifest.meta` 死亡后图级档位放哪里、自包含模块的
领域错误如何进入客户端错误语言。

1. **CommitCandidate 增补 `conversion`；undo/redo 豁免领域门禁**：CommitCandidate 增补
   可选字段 `conversion?: "commit" | "undo" | "redo" | "external"`（core.stage 如实填写；
   纯增补，既有字段语义不变）。领域钩子对一切**前向**转换（commit/external，含人与外部
   手改）执法；undo/redo 是已过管线的提交的游标移动（M2：撤销是用户的手），领域钩子不得
   拦截——否则 undo「passed → running」这类合法逆转会被七态门禁否决，撤销永久失灵
   （workflow-mini fixture 在 M2 即以「只把守形状」绕开此缺口，完整执法以本字段为前提）。
   钩子仍被 undo/redo 调用（§1.2「对一切来源生效」不变），豁免是 workflow 模块的执法策略。
2. **FormSpec 目录投影通道（D22④ 补课）**：Catalog 增补可选
   `forms?: readonly { kind: Kind; form: FormSpec }[]`——module-host 的 catalog() 把
   `api.form` 注册面投影进目录（仅非空时携带），wire 透传。WebUI inspector 表单从目录
   读取，不另开查询面：「目录永远等于注册事实」（D12）在 form 上同样成立。
3. **workflow 图级档位落 `wf.settings` 单例**：0.x `set-class` 无 target 时写
   `manifest.meta.workflow.class`；1.0 manifest 没有 meta。裁决：图级档位是模块领域
   数据，落为模块自己的 kind——`wf.settings` 单例对象（id 固定 `workflow`，
   `payload.class` = quick|standard|program），随声明词汇进目录；所有权归模块，
   人可经 `set` 直改（所有权法豁免，前向转换仍过领域钩子）。
4. **模块领域错误的鸭子类型认领**：模块发布包自包含、零运行时依赖（0.x 契约延续：
   依赖打入 bundle、不保留 dependencies），持不到 protocol `TopoError` 的类身份——
   module-host 命令分发面对 handler 抛出的「`code` ∈ §1.1 封闭集 + `message` 字符串」
   形状的错误如实认领重建为真 TopoError（hint/fix/details 一并透传）；形状不符的原样
   上抛，归 wire 层 `DAEMON_UNREACHABLE`（真 daemon 内部错误）。模块作者的错误语言
   因此仍是封闭集（§1.1 只增不改义），无需为此引入运行时依赖。

### 1.8 规划期补遗（1.1.0：D25–D32）

> 1.1.0 规划裁决（grilling 会话 2026-09-26，经对抗性架构评审后全量采纳）。
> 完整论证与源码证据见 `docs/rebuild/decisions-110.md`；ADR-0007（作用域模型）、
> ADR-0008（宿主技能分发）为其中两条架构级决策的正式化。本文以下正文（§2–§9）
> 仍描述 1.0 形态，1.1.0 以本节为准。

**D25（兼容性立场）：1.1.0 直接破坏。** 动词改名不留旧名、布局变更不做迁移工具、
CHANGELOG 声明 breaking；semver 严格性（破坏应升 2.0）明确放弃——真实用户基数≈0。
红线「CLI 语法破坏性变更必须升版本」以 1.1.0 满足。`@lukawi/toporealm-client` 的
`^1.0.0` 依赖会随升级 break，README 声明。

**D26（双层工作区）：全局目录 + 项目目录 + 显式 init。**

- 全局目录 `~/.toporealm/`（`TOPOREALM_HOME` 可覆盖，测试注入）：**CLI 惰性确保创建**
  （`init` / `module add --global` / 首次触达全局池时），**不用 npm postinstall**
  （`--ignore-scripts`/pnpm/CI 下不保证执行，且无增量价值——评审 Y6）。
  内容 = 全局模块池 `modules/<id>/`，目录即注册，来源记录沿用 `.toporealm-source.json`。
- 项目目录 `<root>/.toporealm/`：图存储收编为 `.toporealm/graphs/<图名>/`
  （多图结构与 `active` 指针照旧，纯挪位）；`daemon/` 照旧。
- 显式 `toporealm init`：建项目工作区；`AGENTS.md` 不存在则生成、已存在则打印建议
  片段**不自动改**（用户文件永不触碰），内容为提示 agent 读 toporealm 技能。
- **`modules.yaml` 收缩（评审 R3）**：项目池/全局池 = 目录即注册；`source: path`
  绑定是 `modules.yaml` 的**唯一剩余职责**（模块作者开发期工作流 + 测试 fixture
  接缝，三套测试依赖此机制）。语义三分：`workspace`（池内安装）→ 由目录存在性
  表达；`global` → 由全局池目录表达；`path` → 仍写绑定文件。
- `help` 与 `module list` 输出回显解析后的全局根与项目根实际路径（TOPOREALM_HOME
  与 TOPOREALM_ROOT 正交但易混）。

**D27（作用域模型）：装了就生效，项目遮蔽全局。**（ADR-0007）

- 模块集 = 全局池 ∪ 项目池 ∪ path 绑定，**无第三步启用动作**；1.0「图级启用」废除
  （实现本就是 root 级全量装载，graph.yaml `modules` 列表仅记录）。
- 项目装同 id 模块**遮蔽**全局；不做项目级排除；命名空间冲突靠现有执法大声报错。
- graph.yaml 删除 `modules` 字段，清单格式升 **`toporealm.graph/v3`**；1.0 v2 图
  无自动迁移路径（仅 dogfood 自举的一次性手工路径，见 D31）。
- **模块集 digest（评审 Y1）**：哈希**遮蔽解析后的有效集**——sha256(排序的
  `pool:id@version`，pool ∈ global|project|path，version 取 module.yaml)。禁止
  哈希 id 并集（遮蔽换血不触发过期）或文件原文（目录即注册后无原文）。
- **requires.modules 跨池联合解析**；依赖被遮蔽时发装载 warning（requires 无版本
  约束，静默换版风险要点名）。
- **global 池坏模块（清单损坏）= 跳过 + warning**，不毒死所有工作区的 daemon
  （1.0 对 global 来源已有先例）；项目池坏模块仍大声失败。warning 必须上浮到
  `status`/`module list`。

**D28（宿主技能分发）：池即唯一存储 + 原生通道读取。**（ADR-0008）

- 模块技能文件只存在于池中（零拷贝、零投影再生）；toporealm 不写任何宿主自有目录
  （`~/.claude`、`.pi`、`.agents`）。**`host sync` 动词与整套投影机器删除**。模块
  作者义务收缩为：按 Agent Skills 标准带 `skills/` 目录。
- **claude code**：基座 marketplace 插件（仓库根声明，一次性 `claude plugin
  marketplace add LUKAWI/toporealm` + install）。插件纯静态：基座 CLI 技能 +
  SessionStart 钩子。钩子运行 `toporealm skills index`（stdout 注入会话上下文）：
  扫描两池各模块 `skills/`，读 SKILL.md frontmatter，逐行输出
  「技能名 · 所属模块 · 一句话描述 · 绝对路径」；agent 按需 Read 全文（渐进披露
  两阶段复刻）。索引按当前工作区解析链生成 → 项目模块技能只在本项目会话出现。
- **pi**：主聚合包加 `pi` 字段（`pi.extensions` 指向内置扩展），`pi install
  npm:@lukawi/toporealm` 一次性全局生效；扩展订阅 `resources_discover` 返回池内
  skills 目录 + 基座技能目录作为 `skillPaths`——pi 原生发现注册，文件仍只在池中。
- **skills index 硬约束（评审 Y4）**：① 纯文件层，**绝不拉起 daemon**；无工作区 =
  空输出 exit 0。② 坏 frontmatter / 缺 SKILL.md / 超大（>256KB）→ 跳过该技能
  （索引不是注册面，容错优先）。③ 跨模块重名技能**并列输出**靠模块列消歧，不静默
  去重。④ 无技能时输出空；CLI 不在 PATH 时钩子命令兜底静默（跨平台 shell 语义
  在 hooks.json 里写死），不产生会话启动噪音。⑤ cwd 在子目录 = 索引为空（与 CLI
  root 语义一致），init 生成的提示写明「会话须在仓库根启动」。
- 实测依据：claude/ZCode skills 扫描严格一层（`.agents`/`.claude` 同规则，池内
  深层与 skills 内嵌套均不可见，2026-09-26 真实目录试验）；pi `resources_discover`
  可贡献 skillPaths（扩展 API 实证）。pi 侧多 skillPaths 重名技能的原生行为未验证
  （P2 实测，必要时扩展侧消歧）。

**D29（CLI 动词面）：破坏性改齐，无别名。**

- 改名：`new` → **`creategraph`**；`version` 子命令删除，新增 **`--version`** 旗标。
- 新增：`init`；`module add/rm` 的 **`--global`**；**`skills index`**。
- 删除：`host sync`。
- 不变：`use`/`graphs`/`status`/`read`/`find`/`add`/`set`/`link`/`rm`/`undo`/`redo`/
  `log`/`cmds`/`serve`/`migrate`（migrate 输出落 `.toporealm/graphs/`，1.1 起产 v3）。
- `module list` 分全局/项目两段 + 标注遮蔽与损坏；重复 add 语义同 1.0
  （`ID_EXISTS`，更新 = rm + add）。
- P1 全量扫描改名波及面：错误 fix/hint 文案中的 `toporealm new`（workspace.ts 等）、
  usage.ts、golden 信封测试。

**D30（多图专注）：工作区单数 + daemon 内存换载 + WebUI 静态预览。**

- 一次一图不变。切图 = **内存换载**，语义（评审 R2 钉死）：
  - **跟随机制（评审 Y3，简化定案）**：daemon 在**每个请求入口**检查 active 指针
    （mtime 缓存）——显式 `req.graph` 优先，省略则跟随 active。CLI 与 WebUI 统一
    跟随，无握手特判、无触发盲区。
  - 换载在请求处理内**串行**完成（受客户端 connect deadline 约束）；成功返回新
    graphId/revision；失败（图不存在/损坏）返回 `GRAPH_NOT_FOUND`/`INVALID_INPUT`
    且**旧图继续服务**——禁止 SESSION_STALE（客户端会等一个永不退出的 pid 然后
    重拉第二个 daemon 互踩）。
  - **SESSION_STALE 保留给模块集 digest 变化**（daemon 自旋退出的现有路径不动）。
  - **换载互斥（评审 Y2）**：swap 与 commit/undo/redo 异步互斥；等待 after-commit
    队列排空；取消外部编辑 reconcile 计时器后再切。
  - **re-binding seam（评审 R1）**：ModuleHost 的命令/钩子闭包硬绑定构造时的
    DaemonCore（host.ts:67,296-315）——换载禁止新建 core 后直接复用模块（会向旧图
    落盘）；ModuleHost 改持 core 引用（间接层），换载时向新 core 重挂
    钩子/词汇观察者并 `setLoadedModules`；**activate 恰好一次的冻结语义不变**。
  - **订阅迁移**：事件订阅随 re-binding 迁移并向所有连接广播 reset；reset 事件
    增补可选 `graphId`/`instanceId` 载荷（protocol 增量扩展）。
- **专注的唯一改变者 = `use`**：解析链 `--graph` > `TOPOREALM_GRAPH` > active 不变；
  输出回显「选定图： X（之前 Y）」+ `export TOPOREALM_GRAPH=X` 提示行；所有写命令
  人类输出回显当前图名。多终端 `TOPOREALM_GRAPH` 指向不同图 = 每命令换载（换载已
  便宜，不做滞回）。
- **WebUI**：专注图 = 实时编辑器（自动跟随）；其它图 = **静态预览**（新只读端点：
  图枚举——扫 `.toporealm/graphs/`；图快照——直接读该图 graph.yaml/objects/
  relations 渲染，不载入 core；快照读撞上非原子写 = 明确报错，不重试不缓存）。
  预览页标注「只读预览 · 当前编辑图是 X · 切换执行 `toporealm use <id>`」。
  **1.1.0 不提供 UI 切换按钮**（专注切换保持 CLI 唯一入口）。
- **并编两张图明确不支持**；将来确有需求演进 per-graph daemon（endpoint 按
  (root, graph) 定址，已论证可行）。范围澄清（评审 B7）：「core 零改动」仅指提交
  管线与执法面；v3 manifest 触及 store/core 的 manifest 读写，re-binding 触及
  module-host。

**D31（dogfood）：仓库根 init + 单图 dev + 1.0.0 语法起步。**

- P0 用 1.0.0 全局 CLI + npm 安装的 workflow 模组建图录任务（`new` + `module add`）；
  daemon 运行时文件 gitignore，图文件与 `.log` 入库（`daemon/`、`modules/`、
  `active` 不入库，clone 后 init/use 引导补齐——评审 B5）。
- **P1 首步 = dogfood 自举迁移（评审 Y5）**：杀 1.0 daemon →
  `git mv graphs/dev .toporealm/graphs/dev` → 手改 graph.yaml（format→v3、删
  modules 行）→ dev 版 CLI 验证。1.0 v2 图仅此一条手工路径，CHANGELOG 注明。

**D32（评审采纳杂项）**：host sync 删除后 1.0 投影残留（`.pi/skills/`、
`.toporealm/hosts/`、`.toporealm-sync.json`）在 P2 文档给手工清理说明；静态预览
读端点在 daemon 进程内，不违反单属主红线。

**1.1.0 阶段划分**（P0–P3，取代 §9 对 1.1.0 的适用性）：

- **P0 dogfood 起步**（1.0.0 语法）：仓库根建图装模组录任务（含 D31 自举迁移条目）。
- **P1 地基**：全局目录/布局挪位/manifest v3/双池装载与 digest/内存换载全套/
  use 增强与写命令回显/web 图枚举+快照端点与静态预览 UI/动词面改造/测试全量更新。
- **P2 分发**：skills index → claude marketplace 插件 → 主包 pi 化 → init 提示
  → workflow 仓库 skills/ 对齐核查 → 1.0 投影残留清理说明。
- **P3 文档与发布**：blueprint 正文各节按 1.1.0 收敛（本补遗并入正文）/ CONTEXT.md
  术语 / CHANGELOG（breaking）/ README → 版本对齐 1.1.0 → 发布（npm + marketplace
  验证）。

---

## 2. 包结构（monorepo，npm workspaces）

```
packages/
  protocol/      §1 全部类型 + 错误码表。零 import、零依赖。版本 = 契约版本。
  client/        DaemonClient port 实现：IpcClient(node) / WsClient(browser) / MemoryClient(测试)。
                 自动拉起 daemon、重连、instanceId 失效检测都住这里。
  daemon-core/   提交管线（所有权法→悬空边→钩子→原子落盘+日志→after-commit→广播）、
                 内存图态、YAML 目录读写、提交日志、undo 游标、文件监视。
                 ★ 绝不 import module-host（结构性修复 0.x 双向依赖）。
  module-host/   模块发现/装载/依赖拓扑排序/activate 调度/注册面冻结/目录聚合/命令分发。
                 → 只依赖 daemon-core 暴露的内部管线入口 + protocol。
  module-sdk/    模块作者的类型 + defineModule() 类型帮助。纯类型，零运行时。
  cli/           动词表、k=v→Change 编译器、--json 信封、退出码、HELP（core 静态 + 目录动态聚合）。
  web/           daemon 内 HTTP 伺服构建产物 + WS 事件端点。
  web-ui/        Svelte 5 + D3（继承现有 store/protocol/filter/projection 分层，组件逐个审）。
  distribution/  模块安装器（npm pack --ignore-scripts + 本地路径；禁 install 脚本；
                 所有权标记）、host sync（仅 claude-code plugin + pi extension/skills，
                 注意两者钩子格式不同）、migrate。
  daemon/        可执行入口（bin: toporeald）+ 生命周期（自动拉起/空闲退出/instanceId）。
```

**依赖方向（全部单向）**：protocol ← client ← cli/web-ui；protocol ← daemon-core ← module-host ← 模块；模块 → module-sdk（纯类型）。distribution 只被 cli 冷路径调用。

**发布物**：`@lukawi/toporealm`（bin: `toporealm`，聚合 cli+daemon+client+distribution）、`@lukawi/toporealm-client`（第三方集成）、`@lukawi/toporealm/module-sdk` 子路径。可选后置：`@lukawi/toporealm-mcp`（桥未烧）。

---

## 3. 磁盘与工作区布局

```
<workspace>/
├── .toporealm/
│   ├── active                      # 当前图 id（use 写入；cli/web 共享指针）
│   ├── modules.yaml                # 绑定：{ [id]: { source: "workspace"|"global"|"path", path? } }
│   ├── modules/<id>/               # 工作区安装的模块（带 .toporealm-source.json 所有权标记）
│   └── daemon/                     # 运行时：socket、pid、instance-id（空闲退出后清理）
└── graphs/<graphId>/
    ├── graph.yaml                  # format: toporealm.graph/v2; id; label?; revision; undoCursor; modules[]
    ├── objects/<id>.yaml           # { id, kind, payload }
    ├── relations/<id>.yaml         # { id, kind, source, target, direction?, payload }
    └── .log                        # JSONL 统一提交日志（D7）
```

- daemon 启动：读 graph.yaml → 全量装载 objects/relations（冷启动硬约束：空图 <100ms）→ 装载模块 → 开 socket。
- 原子写：临时文件 + rename；Windows 上 rename 前不 unlink（修 0.x 双实现不一致）。
- 文件监视：objects/relations/graph.yaml 变更 → 与内存态 digest 比对 → 差异作为 `origin:"external"` 转换吸收（走同一管线，入日志，可 undo）→ 广播 commit 事件 + reset 事件（提示全量重读，简化客户端）。

---

## 4. CLI 语法（`toporealm`，~16 动词）

```text
全局：--json（机器输出信封）  --root <dir>  --graph <id>   环境变量 TOPOREALM_ROOT/GRAPH
信封：--json 成功 {ok:true, data, revision, instanceId}；失败 stderr {ok:false, error:{code,message,hint?,fix?,details?}}
退出码：0 成功；1 领域错误（agent 换方式重试）；2 用法错误（本地解析，不触 daemon）

  status                              工作区+当前图+revision+kind 计数+undo/redo 可用性
  read [id] [--kind K]… [--where k=v]… [--fields id,status] [--limit N]
                                      全图/单点邻域/过滤+投影
  find <k=v>… [--kind K] [--fields …] read --where 的糖（agent 发现动词）
  set <id> [k=v]… [--payload '<json>'] [--replace]
                                      ★改状态 = daemon 端浅合并；k=null 删键
  add <kind> [--id X] [--payload '<json>']                新建对象，created id 回显
  link <src> <tgt> [--kind ns.rel] [--id X]               建关系；仅一种关系 kind 时可省 --kind
  rm <id>                             删除（悬空边拦截时点名 + fix）
  undo [N] / redo [N]                 撤销/重做 N 步
  log [-n N]                          提交日志尾读（近期变更/入场）
  use <graph> / graphs / new <graph>  切换/列出/新建（new 即选中）——文件层操作，不进 daemon 缝
  cmds [--module ns]                  命令目录自省
  <ns.name> [target] [--input '<json>']                   ★模块命令即顶层子命令（点号与核心动词零冲突）
  serve [--port P] [--no-open]        WebUI（daemon + 静态产物 + WS）
  module add <npm|path> [--global] | module rm <id> | module list
  migrate <旧图目录>                  0.x → 1.0 一次性迁移
  host sync [--host claude-code|pi|all]                   宿主投影（仅两宿主）
  help [cmd] / version                HELP = core 静态表 + 目录动态聚合（单一真相）
```

**Agent 主干路径预算**（沿用 C 实测形状）：`status → find → set → link → set → log` ≈ 6 命令 ≈750 token；错误自恢复 1–2 命令（hint/fix 直接可复制执行）。

---

## 5. Daemon 运行时规格

- **生命周期**：client.connect / CLI 首命令触达 → socket 不存在则 spawn `toporeald`（握手含 instanceId）；空闲超时（默认 30s，可配）自动退出；每次转换刷新空闲计时。
- **模块集失效检测（实现期补遗，复用 D5）**：daemon 启动记录 `.toporealm/modules.yaml` 内容摘要；hello 时复验，摘要变化 = 模块集过期 → 如实 SESSION_STALE + 旧 daemon 自旋退出，客户端下次触达自动拉起装载新模块集的 daemon。模块集启动冻结，运行期不热装载。
- **提交管线（固定序，模块作者唯一需要背的顺序）**：
  ```
  id/kind 解析 → 所有权法（仅 module 来源）→ 悬空边检查（集合整体）
  → before-commit 钩子（同步，first-veto 短路，禁再入）
  → 原子应用 + .log 追加 + 游标维护（undo/redo 移游标；undo 后新提交截断 redo 段）
  → after-commit 钩子（其 commit 排队追加）→ 事件广播（commit 事件，origin 如实）
  ```
- **多客户端**：IPC（CLI）与 WS（Web）共用同一事件扇出；instanceId 在 daemon 重启后变化，client 检测到即作废目录缓存并重拉。web 伺服（HTTP 静态产物 + `/ws`）随 daemon 常开，端口/重连/发现语义见 D22；`toporealm serve [--port P] [--no-open]` = 确保 daemon 在跑（自动拉起带 `--web-port`）→ 打开浏览器即退（daemon detached 常驻）。

## 6. 迁移 CLI（`toporealm migrate`）

- 输入：0.x 图目录（graph.yaml v1 + objects/ + relations/ + .revision.json）。
- 映射（机械，无判断）：
  - `data` 与 `capabilities` **浅合并**进 `payload`（键冲突：`data.` 优先、`capabilities.` 加 `cap_` 前缀，报告冲突清单）；
  - `label` → `payload.title`；`meta` → `payload.meta`（嵌套降级）；
  - `kind` 原样（命名空间化已合规）；`direction` 原样；id 原样；
  - revision 保留计数；undo 游标清零；**历史/审计不迁移**（.log 从空开始，旧图可由 0.x 随时回看）；
  - modules 引用升级为 v2 声明（requires/kinds 投影，模块本体由各自仓库迁移）。
- 输出：新目录 + 迁移报告（冲突/降级明细）；`--dry-run` 支持。

## 7. Workflow 模块移植面（首发 dogfood）

| 0.x 概念 | 1.0 去处 |
|---|---|
| 七态生命周期 | payload 约定 `status` + before-commit 钩子把关非法流转（现状 validator 逻辑原样搬进钩子，before/after 双快照让依赖门禁直接读候选图） |
| 12 个领域操作 | 12 个 CommandSpec（`wf.*` 顶层子命令）；输入 schema 从 operations/*.yaml 移到注册代码 |
| MutationPlan | Change[]（put/merge/del 覆盖全部用例） |
| ActionExecutor 六道门禁 | 死亡；只剩 target 存在性 + appliesTo 兑现 |
| registry snapshot / STALE_ACTION | 死亡（D9/D11） |
| 专用 Web 视图 | form + ui 投影先行；复杂视图走 v1.1 预留 |
| 依赖门禁（depends_on） | 钩子读 after 快照（≈20 行，现状测试用例可直接改造） |

预估移植量：runtime ~150 行 + module.yaml ~20 行 + 钩子 ~60 行（fixture 89 行运行时的量级，语义零损失）。移植落点裁决见 §1.7 D24（undo/redo 钩子豁免、forms 目录投影、图级档位落 `wf.settings` 单例）。

## 8. 测试策略（replace, don't layer）

- **契约测试在 S1**：全量 DaemonClient 用例跑 **MemoryClient**；IpcClient/WsClient 只补传输一致性用例（同一套用例三 adapter 复跑）。
- **S2**：fixture 模块直 activate 进 MemoryDaemon——所有权法、钩子 veto、目录自省、注册冻结全部在真缝上测。
- **S3**：golden JSON 信封录制（MemoryClient 后端）；exit code 表驱动。
- **daemon 生命周期专项**：自动拉起、空闲退出、崩溃后重连、instanceId 失效、外部编辑监视（注入 fs 事件）、双客户端并发（CLI+WS 同图）。
- **死亡测试随之删除**：锁/journal/恢复矩阵/外部编辑吸收/fail-closed 校验/STALE_ACTION 的 0.x 用例不迁移（replace 不 layer）。
- 迁移 CLI：0.x fixture 图 → 迁移 → 断言 payload 合并与冲突报告。

## 9. 实施顺序（里程碑）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 骨架 | protocol + daemon-core（无模块）+ MemoryClient + cli 核心动词（status/read/commit/undo/redo/log/new/use/graphs/set/add/link/rm/find） | CLI 全流程走通；外部编辑监视生效；契约测试绿 |
| M2 模块系统 | module-host + module-sdk + catalog/run + 所有权法 + 钩子 + form | fixture 模块（example/workflow-mini）activate→命令→钩子 veto 全链路 |
| M3 Web | web（HTTP+WS）+ web-ui 适配（store 换 client，其余分层继承） | 浏览器无刷新实时同步；冲突自愈 |
| M4 分发 | 安装器 + host sync（claude-code/pi）+ migrate | npm 包安装模块；旧 fixture 图迁移报告零意外 |
| M5 首发 | workflow 模块移植 + skills（双宿主）+ 文档 + `1.0.0` 发布 | workflow 全部语义等价用例通过 = 发布门 |

---
*本文由 D1–D17 + ADR-0003~0006 + interface-comparison.md 推导；实现期发现规范缺口时，先改本文（带决策记录），再写代码。*
