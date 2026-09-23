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

预估移植量：runtime ~150 行 + module.yaml ~20 行 + 钩子 ~60 行（fixture 89 行运行时的量级，语义零损失）。

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
