# TopoRealm 1.0 接口设计：极简方案（S1 / S2 / S3）

> Design-It-Twice 候选方案。本方案的人设约束：**每个 seam 的入口点压到最少（S1 ≤6 方法，S3 ≤8 命令），每个入口点的杠杆最大化**；任何"为方便加一个方法"的冲动先问能否并入现有入口。
> 基准：`decisions-draft.md` D1–D16、`CONTEXT-draft.md` 词汇、`design-framing.md` 全局约束。术语全部遵循 CONTEXT-draft（守护进程/客户端/载荷/提交日志/双层模块/命令/所有权法/校验钩子；kind=主类型）。

## 0. 总览：三个 seam，9 个入口点

| Seam | 位置 | 入口点 | 数量 |
|---|---|---|---|
| S1 daemon 客户端 API | 守护进程进程边界 | `read` / `commit` / `call` / `subscribe` | **4**（目标 ≤6） |
| S2 模块 runtime API | daemon ← 模块（in-process） | `activate(api)`，api 上 `read` / `commit` / `on` / `register`（+`ns`） | **4+1** |
| S3 CLI 命令语法 | 终端 | `use` / `read` / `commit` / `run` / `serve` / `module` / `migrate` | **7**（目标 ≤8） |

核心合并决策（本方案与其他方案的差异所在）：

1. **S1 undo/redo 并入 `commit`**：撤销/重做是提交日志上的游标移动，与追加提交走同一条转换管线、返回同一个结果形状。四方法语义（D4）完整保留，但入口压成一个 `commit(Transition)`。
2. **S1 read+query+自省 合一**：快照读取、过滤查询、提交日志尾读、命令目录/模块自省，全部是 `read(query)` 的一个判别联合。命令目录（D12）不是独立方法，是自省查询。
3. **S1 图生命周期不进 seam**：`init/list/switch` 是工作区文件操作，daemon 以 (workspace, graph) 二元组独占图（D5）；"换图 = 旧 daemon 空闲退出、下次触达拉起新 daemon"。图生命周期留在 CLI/文件层，S1 只说"它拥有的那张图"。
4. **S1 模块安装不进 seam**：安装是 npm 时刻的磁盘操作（D2/D8），"改模块 = 重启 daemon"（D11），而 daemon 空闲即退、几乎免费重启。S1 只暴露运行时自省（catalog），不暴露安装。
5. **S2 命令直接持有 api**：旧世界 ActionExecutor 的 MutationPlan 中转、STALE_ACTION 快照新鲜度（现状门禁 #15）整类死亡——命令 `run()` 里自己 `api.read()` / `api.commit()`，永远是新鲜状态，注册快照这个概念不存在了。
6. **S2/S3 表单免费获得**：命令的输入 schema 就是表单（WebUI/agent 共用）；不为表单单开注册通道之外的概念。
7. **S3 `use` 合并 init+switch+list**：`use <id>` = 确保存在并切到该图（幂等）；`use`（无参）= 列出图并显示当前。三个旧命令一个动词。
8. **S3 undo/redo 并入 `commit`**：`topo commit --undo|--redo`——CLI 是 S1 的投影，S1 合并了它就合并。
9. **S3 `watch` 并入 `read --follow`**：订阅流就是"不退出的 read"。
10. **S3 JSON 是默认输出**：agent 契约就是唯一契约（D13"语法即承诺"）；人类用 `--pretty`。旧世界 16 条命令 + `--json` 开关 → 7 条命令 + 恒定 JSON。

---

## 1. 共享数据信封（三个 seam 的公共词汇）

core 知道的一切领域概念（D3 最小类型信封）：

```ts
// 类型契约：三个 seam 共用，types-only，零运行时依赖
export type EntityId = string;                       // 对象与关系共享同一 id 命名空间
export type Kind = string;                           // 命名空间化主类型："workflow.task"；无 "." 前缀 = 公共/无主

/** 对象：{id, kind, payload}——payload 不透明，core 原样存取 */
export interface ObjectRecord {
  id: EntityId;
  kind: Kind;
  payload?: JsonValue;                               // 载荷：结构由拥有该 kind 的模块约定
}

/** 关系：一等实体。direction 不占 core 字段，进载荷约定（默认有向） */
export interface RelationRecord {
  id: EntityId;
  kind: Kind;
  source: EntityId;
  target: EntityId;
  payload?: JsonValue;
}

/** 变更原语：三种。upsert 吃掉 insert/update；delete 统一对象与关系（id 空间唯一） */
export type Mutation =
  | { op: "upsert_object"; object: ObjectRecord }
  | { op: "upsert_relation"; relation: RelationRecord }
  | { op: "delete"; id: EntityId };

export interface GraphPatch {                         // 与 revision 衔接的增量
  fromRevision: number;
  toRevision: number;
  objects:    { upserted: readonly ObjectRecord[]; deleted: readonly EntityId[] };
  relations:  { upserted: readonly RelationRecord[]; deleted: readonly EntityId[] };
}

export interface GraphSnapshot {
  graphId: string;
  revision: number;
  objects: readonly ObjectRecord[];
  relations: readonly RelationRecord[];
}
```

对照现实：旧 `label` 语义字段、`data`/`capabilities` 私有区（D3 砍掉）、`delete_object`/`delete_relation` 双原语、`patch_manifest` 变更原语（图清单改走文件层/初始化参数，不进变更原语）全部消失。

---

## 2. S1：daemon 客户端 API（4 个方法）

### 2.1 类型签名

```ts
/** 客户端（CLI/Web/测试）见到的守护进程完整表面。四个方法，无第五个。 */
export interface DaemonClient {
  /** 读：快照 / 提交日志尾 / 自省目录——一个入口 */
  read(query?: ReadQuery): Promise<ReadResult>;

  /** 写：提交 / 撤销 / 重做——一个入口，同一条转换管线 */
  commit(transition: Transition): Promise<TransitionResult>;

  /** 调用模块命令（人和 agent 的领域操作入口） */
  call(command: string, invocation?: { target?: EntityId; input?: Record<string, unknown> }): Promise<CallResult>;

  /** 订阅实时同步：首事件必为 sync，其后是 transition 流 */
  subscribe(listener: (event: DaemonEvent) => void): Unsubscribe;
}

// ---- read 的查询联合 ----
export type ReadQuery =
  | { snapshot?: { kinds?: readonly Kind[]; ids?: readonly EntityId[] } }  // 省略 = 全量快照
  | { history?: { limit?: number; since?: number } }                        // 提交日志尾部（游标视角）
  | { catalog: true };                                                      // 守护进程自省

export type ReadResult =
  | { query: "snapshot"; revision: number; graphId: string;
      objects: readonly ObjectRecord[]; relations: readonly RelationRecord[] }
  | { query: "history"; cursor: LogCursor; entries: readonly LogEntry[] }
  | { query: "catalog"; catalog: Catalog };

export interface LogCursor { revision: number; canUndo: boolean; canRedo: boolean; }

/** 提交日志条目 = 审计 = 近期变更源（D7：一个文件三个功能） */
export interface LogEntry {
  revision: number;
  time: string;                    // ISO 8601
  source: TransitionSource;
  label?: string;
  patch: GraphPatch;
}

// ---- commit 的转换联合：四方法语义的唯一入口 ----
export type Transition =
  | { apply: readonly Mutation[]; label?: string }   // 追加提交
  | { undo: number | true }                          // 游标后移（true = 1 步）
  | { redo: number | true };                         // 游标前移

export interface TransitionResult {
  revision: number;
  patch: GraphPatch;
  history: LogCursor;
  source: TransitionSource;
  label?: string;
}

export type TransitionSource =
  | { kind: "cli" } | { kind: "web" } | { kind: "file" }      // file = 文件监视重载吸收的外部编辑
  | { kind: "undo" } | { kind: "redo" }
  | { kind: "command"; command: string; module: string };

// ---- call ----
export interface CallResult {
  result: unknown;                 // 命令 run() 的返回值
  revision: number;                // 调用结束后的图 revision（命令内 commit 已生效）
}

// ---- subscribe ----
export type DaemonEvent =
  | { type: "sync"; snapshot: GraphSnapshot; history: LogCursor }   // 连接后第一个事件，必为此
  | { type: "transition"; patch: GraphPatch; source: TransitionSource; label?: string }
  | { type: "shutdown" };                                           // daemon 空闲退出，客户端应重连（自动拉起）

// ---- catalog（read({catalog:true}) 的自省载荷）----
export interface Catalog {
  graphId: string;
  revision: number;
  modules: readonly { id: string; version: string; namespace: string;
                      status: "available" | "unavailable" }[];
  kinds: readonly { kind: Kind; owner?: string; color?: string; icon?: string }[];
  commands: readonly CommandInfo[];
}

export interface CommandInfo {           // 命令目录：agent 与 WebUI 的公共发现源（D12）
  id: string;                            // 命名空间化全名："workflow.transition"
  module: string;
  title: string;
  appliesTo: readonly Kind[] | "*";
  input?: JsonSchema;                    // 即 agent 输入契约，即 WebUI 表单
}
```

### 2.2 不变量

- **revision 单调**：每次转换 +1；`patch.fromRevision` 恒等于前一 revision。全库不变量只有悬空边检查（内置，~5 行）+ 所有权法（对 `apply` 生效）。
- **提交日志 append-only**：`apply` 追加条目；`undo/redo` 只移动游标（存于 graph.yaml，D7），不追加。undo 后的新 apply 截断游标之后的日志段（放弃分叉语义，换取"一个文件三个功能"的简单性）。
- **外部编辑无例外**：文件监视检出的外部修改以 `source:"file"` 的自动转换进入同一日志——因此**外部编辑也可被 undo**。旧世界"吸收提交 + 丢弃候选变更 + EXTERNAL_EDIT_ABSORBED"（现状门禁 #6）整类消失。
- **无 expectedRevision**：单属主 daemon（D5）内写队列串行，跨进程 revision 冲突协议（现状门禁 #7 REVISION_CONFLICT）不存在。并发正确性下放：领域不变量由校验钩子对候选变更把关（"约束下放插件"哲学），客户端分歧由补丁流自愈（见 2.4 错误模式）。
- **订阅顺序**：连接后首事件必为 `sync`；单连接内 `transition` 按提交序送达；调用方自己的成功 commit 必然（最终）以 transition 事件回送到所有订阅者。
- **call 原子性**：一次 call 内命令产生的所有 commit 在 call 应答前已生效；历史撤销单位 = 每次 commit（D4 跨模块整体撤销语义保留在 undo 侧）。

### 2.3 顺序约束

- `subscribe` 之前不允许假设任何事件；`sync` 是唯一可信起点。
- `read` 与 `commit` 之间无跨调用事务性：读到的 revision 只作展示，不作前置条件（没有 expectedRevision 可传）。
- undo 前提：`canUndo`；redo 前提：`canRedo`。违反 → `E_HISTORY_BOUND`，不静默空转。

### 2.4 错误模式

稳定错误码全集（对照现状约 60 个码 → **8 个**）：

| 码 | 触发 | details |
|---|---|---|
| `E_OWNERSHIP` | 所有权法：变更触碰非本命名空间且非公共的 kind | `{ owner }` |
| `E_DANGLING` | 悬空边：关系端点不存在 | `{ relation, missing }` |
| `E_VETOED` | 校验钩子否决（cli/web 路径同样会被否决） | `{ vetoes: [{ module, reason?, diagnostics? }] }` |
| `E_INVALID_MUTATION` | 信封形状不合法（id 非法、op 未知、关系缺端点） | `{ path }` |
| `E_HISTORY_BOUND` | undo/redo 越过日志端点 | `{ direction, cursor }` |
| `E_UNKNOWN_COMMAND` | 命令目录中不存在该命令 | `{ command, near? }` |
| `E_NOT_APPLICABLE` | 目标不存在 / appliesTo 不匹配 / 该命令要求 target 而未给 | `{ command, target? }` |
| `E_TRANSPORT` | daemon 不可达/断连（adapter 层唯一传输错误） | `{ cause }` |

没有校验失败聚合、没有 fail-closed、没有 STALE_ACTION、没有 REVISION_CONFLICT、没有 EXTERNAL_EDIT_*。钩子否决不是 core 的错误，是模块与用户的契约（D10），`E_VETOED` 明示"被谁否决"。

### 2.5 缝后隐藏了什么（实现职责清单）

1. 内存图态与全量装载（YAML 目录 → 内存，冷启动硬约束）。
2. 提交管线：所有权法 → 悬空边检查 → before-commit 钩子（含否决收集）→ 原子落盘 + 日志追加/游标移动。
3. 统一提交日志（JSONL）+ graph.yaml 游标 + undo/redo。
4. 文件监视与外部编辑重载（重载 = `source:"file"` 转换）。
5. 双层模块装载与命令分发、目录自省（D8/D11/D12）。
6. 守护进程生命周期：自动拉起、空闲退出、(workspace, graph) 独占。
7. 传输：本机 IPC（unix socket/named pipe）与 WS 广播；序列化与补丁计算。
8. 载荷与 kind 的零解释（透传纪律）。

---

## 3. S2：模块 runtime API（`activate(api)` + 4+1 个 api 成员）

### 3.1 activate 签名

```ts
/** 双层模块的代码层唯一入口：daemon 启动时装载、activate 一次（D8/D11） */
export interface ModuleActivation {
  activate(api: ModuleApi): void | Promise<void>;
}
// runtime entry 的 default export 即 ModuleActivation
```

### 3.2 api 对象全貌

```ts
export interface ModuleApi {
  /** 模块命名空间（只读身份；commit 的所有权边界由它定义） */
  readonly ns: string;

  /** 读：与 S1 同一个 ReadQuery 形状，但同步返回（in-process 无传输） */
  read(query?: ReadQuery): SnapshotReadResult;

  // SnapshotReadResult = ReadResult 的 snapshot 变体（模块面只需要它；history/catalog 是客户端关切）

  /** 写：只此一条道。所有权法是模块唯一感到的执法（D9） */
  commit(mutations: readonly Mutation[], meta?: { label?: string }): TransitionResult;

  /** 事件与校验钩子：仅两种事件 */
  on(event: "before-commit", handler: BeforeCommitHandler): Unsubscribe;
  on(event: "after-commit", handler: AfterCommitHandler): Unsubscribe;

  /** 注册一切行为：命令 + 表单（D12）。变参：一次 activate 一口气注册完 */
  register(...contributions: readonly (CommandSpec | FormSpec)[]): void;
}

// ---- 命令：人和 agent 的同一领域操作（D12）----
export interface CommandSpec {
  id: string;                                    // 短名；目录中呈现为 "<ns>.<id>"
  title: string;                                 // 人类可读描述
  appliesTo?: readonly Kind[] | "*";             // 元数据必须可自省 → kind 串，不是谓词
  input?: JsonSchema;                            // agent 输入契约 = WebUI 表单，一物二用
  run(ctx: CommandContext): unknown | Promise<unknown>;
}

export interface CommandContext {
  api: Pick<ModuleApi, "read" | "commit">;       // ← 此处 read 即 SnapshotReadResult 签名       // 命令内直接读写；commit 自动带命令来源
  target?: { id: EntityId; kind: Kind };         // 调用方绑定的目标（存在性与 appliesTo 由 daemon 校验）
  input: Record<string, unknown>;                // 形状语义由 run 自己负责（schema 是文档，不是门禁）
}

// ---- 表单：kind 载荷的编辑投影（D12 代码注册）----
export interface FormSpec {
  kind: Kind;                                    // 必须是本 ns 或公共 kind
  fields: readonly { path: string; widget?: string; label?: string }[];
}

// ---- 校验钩子（D10）：可附诊断、可否决 ----
export interface CommitCandidate {
  mutations: readonly Mutation[];
  source: TransitionSource;                      // undo/redo/file 一视同仁——钩子同样可以否决撤销
  read(): SnapshotReadResult;                    // 只读上下文
}
export type BeforeCommitHandler =
  (candidate: CommitCandidate) => HookVerdict | Promise<HookVerdict>;
export type HookVerdict =
  | void                                          // 放行
  | { veto: true; reason?: string; diagnostics?: readonly HookDiagnostic[] };
export interface HookDiagnostic { code: string; message: string; entityId?: EntityId }

export type AfterCommitHandler =
  (applied: { patch: GraphPatch; source: TransitionSource; label?: string }) => void;
```

### 3.3 不变量

- **注册冻结**：`register` / `on` 只能在 `activate` 返回前调用；之后调用抛 `E_FROZEN`。模块集启动时冻结（D11），注册面随之冻结——命令目录因此不需要失效协议。
- **所有权法唯一执法**：`api.commit` 只允许触碰 `ns` 下或公共/无主的 kind，违反抛 `E_OWNERSHIP`。没有第二条例外。
- **before-commit 内禁止再入**：handler 内调用 `commit/register/on` 抛 `E_REENTRANT`；`read` 允许。钩子是快速纯决策（D10"不聚合、不排序"的镜像义务）。
- **来源归属免费**：命令 `run` 内 `api.commit` 的 source 恒为 `{kind:"command", command, module}`——per-invocation api 作用域使归属不需要显式传参。
- **模块无 undo/redo**：历史游标是人的特权，不进 ModuleApi。after-commit 会看到 undo/redo/file 产生的补丁（转换统一，无例外通道）。
- **命令输入不做 schema 门禁**：daemon 只查命令存在性 + appliesTo + target 存在性（可自省的廉价检查，现状门禁 #16 的 input 形状检查删除）；输入语义归 `run`。schema 是给人/agent 看的契约文档。

### 3.4 错误模式

`E_OWNERSHIP` / `E_DANGLING` / `E_VETOED`（别的模块否决了我）/ `E_INVALID_MUTATION` / `E_FROZEN` / `E_REENTRANT` / `E_NOT_APPLICABLE`。加上 `run` 抛出的自由错误统一包装为 `E_COMMAND_FAILED`（details.cause 保留原消息）。共 8 个，与 S1 共享其中 5 个——两个 seam 一套错误语言。

### 3.5 缝后隐藏了什么（实现职责清单）

1. 命令分发：目录查找、appliesTo/target 校验、per-invocation api 作用域构造、来源归属。
2. 钩子调度：before-commit 全量触发、否决收集为单个 `E_VETOED`、after-commit 广播（不排序、不聚合诊断——原样透传）。
3. 所有权法执行与"无主/公共 kind"判定（退化情形即缺模块数据冻结保护，D9 免费收益）。
4. 模块装载（import、activate 调用、激活失败 = 大声失败诊断，非运行时执法）。
5. 注册表即命令目录（无 YAML 声明与实现对不上的问题类，D12）。

---

## 4. S3：CLI 命令语法（7 条命令）

### 4.1 命令表

```text
topo use [<graph-id>] [--root <dir>] [--graph <id>]
    有参：确保图存在（不存在则创建）并设为当前图 = init+switch 合一，幂等
    无参：列出工作区图 + 当前图 = list 合一
    自动拉起 daemon（本机 IPC）；这是"daemon 模型 UX 生命线"的入口

topo read [<path>] [--kinds <a.b,c.d>] [--id <id>] [--history [n]] [--catalog]
           [--follow] [--pretty] [--graph <id>] [--root <dir>]
    默认：全量快照摘要（graphId/revision/counts）
    --kinds/--id：过滤投影（read({snapshot:{kinds,ids}})）
    --history：提交日志尾部（近期变更/入场场景，D7）
    --catalog：命令目录自省（agent 发现命令的唯一正道）
    --follow：不退出，输出 JSONL 事件流（sync 首行 + transition 流）= watch 合一
    <path>：便利点查，如 `topo read objects/t-42`

topo commit [<json> | --file <f>] [--label <s>] [--undo [n]] [--redo [n]]
            [--graph <id>] [--root <dir>]
    <json>/--file/stdin(-)：Transition JSON（apply/undo/redo 皆可）
    --undo/--redo：S1 Transition 联合的直接投影；四方法语义一条命令
    成功输出 TransitionResult JSON；失败输出错误信封 + exit 1

topo run <command-id> [<entity-id>] [--input <json> | --file <f>] [--pretty]
    S1 call 的投影；命令目录里的 id 即语法（自省 = 文档，永不过期）
    例：topo run workflow.transition t-42 --input '{"to":"passed"}'

topo serve [--port <n>] [--no-open]
    启动 WebUI（daemon 伺服构建产物）；浏览器走 WS adapter 连同一 daemon

topo module add <npm-spec|path> [--global] | topo module rm <id> | topo module ls
    安装期磁盘操作（不进 daemon seam；改模块 = daemon 空闲后自然重启，D11）

topo migrate <legacy-graph-dir>
    一次性：旧 graph v1 → 新目录式 YAML（D16），data/capabilities 机械合并进 payload
```

`help`/`version` 是全局旗标（`topo --help` / `topo --version`），不占命令名额。宿主投影（Claude Code / Pi 的 skills 与 plugin 打包，D15）不设命令——分发随打包完成；若将来需要，`host sync` 可增量加回而不破坏现有语法。

### 4.2 输出契约（语法即承诺）

- **stdout 恒为 JSON**：一次性命令 = 单个 JSON 文档；`--follow` = JSONL 事件流。`--pretty` 输出人类表格/摘要（唯一的双受众开关）。
- **stderr 恒为错误信封**：

```json
{ "error": { "code": "E_VETOED", "message": "提交被 workflow 否决。",
             "details": { "vetoes": [{ "module": "workflow", "reason": "依赖门禁",
                                       "diagnostics": [{ "code": "DEPS_NOT_PASSED",
                                                         "message": "前置任务未通过：t-41" }] }] } } }
```

- **退出码**：`0` 成功；`1` 领域错误（`E_*`，agent 可编程分流）；`2` 用法错误（未知命令/缺参数/bad JSON）。
- **稳定序**：命令动词表、旗标名、错误码、目录 JSON 形状都是公共契约；skills（D13/D15）押注其上，破坏性变更必须升版本。
- 全局环境：`TOPOREALM_ROOT` / `TOPOREALM_GRAPH` 沿用；`--root` 显式优先，向上查找 `.toporealm` 的规则不变。

### 4.3 缝后隐藏了什么（实现职责清单）

1. 参数解析与用法校验（exit 2 的全部来源）。
2. 工作区/图解析（向上查找、active 文件、`use` 的 ensure 语义）——图生命周期在这个 adapter 层，不在 S1。
3. daemon 自动拉起、IPC 连接、空闲退出后的透明重连。
4. JSON 渲染 / `--pretty` 表格、错误信封与退出码映射。
5. HELP 文本与 `--catalog` 的人类渲染。

---

## 5. 三个用法示例

### 5.1 示例一：agent 通过 CLI 完成一次任务节点状态流转

```bash
$ topo use devplan
{"graphId":"devplan","revision":41,"created":false}

# agent 自省：发现命令目录（不需要读任何文档）
$ topo read --catalog
{"query":"catalog","graphId":"devplan","revision":41,
 "modules":[{"id":"workflow","version":"1.0.0","namespace":"workflow","status":"available"}],
 "kinds":[{"kind":"workflow.task","owner":"workflow","color":"#3b82f6","icon":"task"},
          {"kind":"workflow.depends_on","owner":"workflow"}],
 "commands":[{"id":"workflow.transition","module":"workflow","title":"流转任务节点状态",
              "appliesTo":["workflow.task"],
              "input":{"type":"object","required":["to"],
                       "properties":{"to":{"enum":["pending","running","failed","passed","skipped"]}}}},
             {"id":"workflow.add_task","module":"workflow","title":"新增任务节点",
              "appliesTo":"*","input":{...}}]}

# 查看目标节点当前状态
$ topo read --id t-42
{"query":"snapshot","revision":41,"graphId":"devplan",
 "objects":[{"id":"t-42","kind":"workflow.task",
             "payload":{"title":"接口设计","state":"running"}}],"relations":[]}

# 尝试流转 → 被校验钩子否决（依赖门禁），agent 拿到结构化否决原因
$ topo run workflow.transition t-42 --input '{"to":"passed"}'
{"error":{"code":"E_VETOED","message":"提交被 workflow 否决。","details":{
  "vetoes":[{"module":"workflow","reason":"依赖门禁",
             "diagnostics":[{"code":"DEPS_NOT_PASSED","message":"前置任务未通过：t-41"}]}]}}}
$ echo $?
1

# agent 读取依赖图，转去完成 t-41，然后回来重试
$ topo read --kinds workflow.task
...
$ topo run workflow.transition t-41 --input '{"to":"passed"}'
{"revision":42,"patch":{...},"history":{"revision":42,"canUndo":true,"canRedo":false},
 "source":{"kind":"command","command":"workflow.transition","module":"workflow"},
 "label":"transition → passed"}

$ topo run workflow.transition t-42 --input '{"to":"passed"}'
{"revision":43,"patch":{...},"history":{"revision":43,"canUndo":true,"canRedo":false},
 "source":{"kind":"command","command":"workflow.transition","module":"workflow"}}

# 用户不满意，整体撤销（跨模块、含刚才的命令提交）——undo 也走同一命令
$ topo commit --undo
{"revision":42,"patch":{...},"history":{"revision":42,"canUndo":true,"canRedo":true},
 "source":{"kind":"undo"}}
```

要点：agent 的完整闭环 = `use` → `read --catalog`（发现）→ `run`（执行）→ 结构化 `E_VETOED`（自纠错）→ `commit --undo`（回退）。没有一条路径需要人类文档；错误码就是分流依据。

### 5.2 示例二：模块 activate 注册命令 + 钩子的完整代码

`module.yaml`（声明层：只管"你是谁、你有什么"，D8/D12）：

```yaml
format: toporealm.module/v2
id: workflow
namespace: workflow
version: 1.0.0
kinds: [task, depends_on]            # 词汇表：协调契约（防冲突/发现），不是执法依据
ui:
  kinds:
    workflow.task: { color: "#3b82f6", icon: "task" }
entry: runtime/index.js              # 代码层唯一入口
```

`runtime/index.js`（代码层：注册一切行为）：

```js
// 双层模块：activate 一次，注册命令 + 校验钩子（D8/D10/D12）
const STATES = ["pending", "running", "failed", "passed", "skipped"];

export default {
  activate(api) {
    // —— 命令：人和 agent 同一入口；输入 schema 即 agent 契约即 WebUI 表单 ——
    api.register({
      id: "transition",
      title: "流转任务节点状态",
      appliesTo: ["workflow.task"],
      input: { type: "object", required: ["to"], properties: { to: { enum: STATES } } },
      async run({ api, target, input }) {
        const snap = api.read({ snapshot: { ids: [target.id] } });
        const task = snap.objects[0];
        if (!task) throw new Error(`任务不存在：${target.id}`);   // → E_COMMAND_FAILED
        const updated = { ...task, payload: { ...task.payload, state: input.to } };
        const r = api.commit([{ op: "upsert_object", object: updated }],
                             { label: `transition → ${input.to}` });
        return { revision: r.revision, state: input.to };
      },
    });

    api.register({
      id: "add_task",
      title: "新增任务节点",
      appliesTo: "*",                                  // 全图命令，不绑目标
      input: { type: "object", required: ["id", "title"],
               properties: { id: { type: "string" }, title: { type: "string" } } },
      run({ api, input }) {
        return api.commit([{ op: "upsert_object",
          object: { id: input.id, kind: "workflow.task",
                    payload: { title: input.title, state: "pending" } } }]).revision;
      },
    });

    // —— 校验钩子：依赖门禁。可附诊断、可否决（D10）——
    api.on("before-commit", ({ mutations, read }) => {
      const diagnostics = [];
      for (const m of mutations) {
        if (m.op !== "upsert_object" || m.object.kind !== "workflow.task") continue;
        const next = m.object.payload?.state;
        if (next === "running" || next === "pending") continue;       // 回退不设门禁
        const { objects, relations } = read();
        const blockers = relations
          .filter((r) => r.kind === "workflow.depends_on" && r.target === m.object.id)
          .map((r) => objects.find((o) => o.id === r.source))
          .filter((dep) => dep && !["passed", "skipped"].includes(dep.payload?.state))
          .map((dep) => dep.id);
        if (blockers.length) diagnostics.push(
          { code: "DEPS_NOT_PASSED", message: `前置任务未通过：${blockers.join("、")}`,
            entityId: m.object.id });
      }
      return diagnostics.length
        ? { veto: true, reason: "依赖门禁", diagnostics }             // core 明示"被 workflow 否决"
        : undefined;                                                  // 放行
    });

    // —— after-commit：派生反应（示例：无。但通道在此）——
  },
};
```

要点：所有权法让 `workflow.*` 的提交天然合法、别的模块碰 `workflow.task` 天然 `E_OWNERSHIP`——模块代码里没有一行权限检查；校验即钩子，卸载即恢复（D10）；没有 MutationPlan 中转、没有注册快照、没有 STALE_ACTION。

### 5.3 示例三：WebUI 订阅实时同步的最小代码

```ts
// 浏览器侧：WS adapter 连接同一 daemon（D14：唯一硬需求 = 实时同步）
import { connect } from "@lukawi/toporealm/ws";     // 实现 DaemonClient 的浏览器 adapter
import { applyPatch } from "@lukawi/toporealm/patch"; // 纯函数：GraphPatch → snapshot'（与 daemon 同一份补丁语义）

const client = await connect({ graph: "devplan" }); // 首事件必为 sync——连接即全量，无需先 read
const graph = $state(null);                          // Svelte 5 runes；旧 store 层模型天然继承

client.subscribe((event) => {
  if (event.type === "sync") graph.value = event.snapshot;                  // 全量替换
  else if (event.type === "transition") graph.value = applyPatch(graph.value, event.patch); // 就地更新
  else if (event.type === "shutdown") reconnect();                          // daemon 空闲退出 → 重连自动拉起
});

// 编辑：直接提交；本客户端自己的提交会以 transition 事件回环抵达（唯一真相 = 补丁流）。
// 没有 expectedRevision：补丁 fromRevision 不衔接时 applyPatch 抛 PATCH_GAP → 全量 resync。
async function renameNode(id, title) {
  const snap = await client.read({ snapshot: { ids: [id] } });
  await client.commit({ apply: [{
    op: "upsert_object",
    object: { ...snap.objects[0], payload: { ...snap.objects[0].payload, title } },
  }] });
}
```

要点：WebUI 全部同步逻辑 = 一个 subscribe + 一个纯函数 applyPatch + 一个 resync 兜底；没有任何轮询、没有补丁序号握手、没有 REST+WS 双通道。

---

## 6. 依赖策略与 adapter 划分

### 6.1 依赖方向

```
web-ui ──WsClient────────┐
                         │
CLI ──IpcClient──────────┤            DaemonClient 契约（types-only）
                         ├──────────────────────────────────► 守护进程 host
第三方工具/脚本 ──────────┘                                        │
                                              ┌───────────────────┤
                                        core（四方法语义）    模块装载器
                                              │                   │
                                     fs(YAML 目录+提交日志)   ModuleApi 契约 ◄── 模块代码（npm 包）
                                                  （in-process，无 adapter）
```

- **契约包**：`DaemonClient` 类型、`ModuleApi` 类型、数据信封、错误码——全部 types-only，零运行时依赖。客户端与模块都只依赖契约，永不 import 守护进程内部（现状 core↔module-sdk 双向类型依赖的根治：契约独立成层，依赖单向汇聚）。
- **模块 SDK = 契约类型 + 一个 `defineModule()` 类型帮助函数**。没有第二个运行时。

### 6.2 adapter 划分（按 DEEPENING 依赖分类）

| 依赖 | 分类 | adapter |
|---|---|---|
| daemon 持久化 | local-substitutable | fs 根可注入；测试用临时目录/内存 fs |
| daemon↔CLI | 本机跨进程（自动拉起） | `IpcClient`（生产：unix socket / named pipe；测试：`MemoryClient` 内存替身） |
| daemon↔浏览器 | HTTP+WS | `WsClient`（伺服构建产物 + WS 同一 daemon） |
| daemon←模块 | in-process | 无 adapter；测试直接装载测试模块 |
| CLI 语法 | in-process 转发 | 无独立 adapter；`runCli(argv, client)` 纯函数，宿主投影（skills）是引用语法的生成文本 |

**seam 真实性自检（deletion test）**：`DaemonClient` 有三个真实实现（Memory/Ipc/Ws），删掉任意一个其余照常编译运行——S1 是真缝。CLI 只是 S1 之上的纯语法层——S3 是真薄 adapter。S2 in-process 无 transport 可删，但契约/实现分离使模块可在纯 Node 测试 harness 中激活（不给 daemon 也能跑 `activate`）——S2 以契约独立性立缝。

---

## 7. Trade-off

### 7.1 杠杆高在哪

- **四方法语义 × 一个写入口**：`commit(Transition)` 使钩子、日志、补丁、结果形状在 apply/undo/redo/file 四种转换间零分叉。钩子可以否决撤销（候选变更一视同仁）、外部编辑可以撤销（file 转换入日志）、审计天然完整（D7 一个文件三个功能）——三个"免费收益"全部来自这一个合并。
- **read 合一**：agent 只需学会一个查询动词即可发现命令、看历史、查图。`--catalog` 让命令目录成为唯一发现正道，"动作引用 + 注册快照 + STALE_ACTION"问题类连根拔除（D11 的结构收益直接兑现到接口上）。
- **错误码 60 → 8**，CLI 16 → 7：整个错误语言一张名片大小；skills 与文档押注成本同步坍缩。
- **S2 直接持有 api**：模块作者的思维模型从"返回声明式计划等待审批"退到"直接调用两个函数"——pi extension 的心智负担。来源归属、所有权、钩子执法全部在 daemon 侧静默发生（deep module：简单接口，复杂职责）。
- **生命周期出 seam**：图切换/模块安装变成文件操作，daemon 永远只面对"一张已被决定的图"——跨图事务、注册表失效协议、热装卸整类设计压力不存在。

### 7.2 哪里薄

- **read 查询表达力弱**：只有 kinds/ids 过滤和日志尾读。没有跨实体图查询（"所有 state=running 且无入边的 task"）、没有聚合、没有分页。复杂检索要么全量拉回客户端算，要么等模块把它做成命令。
- **call 结果只有 `{result, revision}`**：命令的多步提交中间态、产生的副作用清单不可见；想看细节只能 read/subscribe。
- **无 expectedRevision**：乐观并发检查从接口上消失。多写者竞态只剩钩子这道领域防线。
- **undo 粒度 = 整次提交**：不能撤销"某个模块的那部分"；undo 后新提交截断重做分支。
- **catalog/form 表达力**：appliesTo 是 kind 串非谓词，输入 schema 是静态 JSON Schema——动态适用性（"仅当状态为 running"）表达不了，只能进了 run 再拒绝。

### 7.3 什么场景会难受

1. **两个 agent 高频争写同一节点**：没有 REVISION_CONFLICT，后写覆盖前写，直到钩子（若模块写了状态机门禁）或人发现。缓解依赖 workflow 类模块认真用 before-commit 把关——纪律从 core 移到了模块作者。
2. **人想要"只撤销我刚才那步"而中途混入了 file 转换**：undo 是整体游标移动，会把外部编辑一并回退。统一性的代价。
3. **WebUI 想做服务端过滤大图**：read 联合没有投影查询语言，浏览器可能拉全量。图到几千实体前可忍（现状即全量模型），之后要么加查询语法（增量演化点）要么模块命令顶上。
4. **agent 想要"试运行"（dry-run）**：commit 没有 dry 模式；想预检只能靠模块提供 `plan` 类命令或钩子诊断。入口极简把这类便利推出了 core。
5. **习惯 `undo` 作顶级动词的人类用户**：`topo commit --undo` 需要一次学习；不提供别名（别名就是第二个入口点）。
6. **未来 MCP 回填**（D13 桥未烧）：MCP adapter 需要把 4 个方法映射成 N 个工具——映射是机械的，但工具粒度选择（合并还是拆分 read）会重新争论一次。

### 7.4 与全局约束的对账

| 约束 | 落实 |
|---|---|
| 1 四方法语义，validate 不存在 | S1 Transition 联合承载 apply/undo/redo 语义；read 承载读取；无 validate 入口，校验只有校验钩子（D10） |
| 2 最小信封 | §1：{id, kind, payload}；revision 单调（§2.2） |
| 3 目录式 YAML + 统一提交日志 | daemon 实现职责（§2.5-2/3）；cursor 存 graph.yaml |
| 4 执法仅两条 | E_DANGLING（内置）+ E_OWNERSHIP（所有权法）是仅有的两个执法错误码 |
| 5 模块集启动冻结、目录自省 | register 冻结（E_FROZEN）；`read({catalog:true})` / `topo read --catalog` |
| 6 WebUI 仅 WS 同步、无 MCP、两宿主 | `subscribe` 三事件；无 MCP 表面；宿主投影出 CLI 命令表 |
| 7 四件套说明 | 每 seam 均含：类型/清单、不变量、顺序约束、错误模式、示例、隐藏职责、依赖/adapter、trade-off |
