# TopoRealm 1.0 词汇表草案（重建后语言增量）

> 状态：草案——随 grilling 决议（`decisions-draft.md`）同步更新；共识确认后并入根 CONTEXT.md。
> 只收**变化的与新增的**术语；未列出的旧术语（图/对象/关系/实体ID/主类型等）继续沿用现有 CONTEXT.md。

## 新增/重定义

**守护进程（Daemon）**
独占一个图工作区、持有内存态并提供 CLI/Web 接入的常驻本地进程。所有读写的唯一执行者；图文件的唯一写者。

**客户端（Client）**
守护进程之外的薄接入面：CLI 与 Web UI。客户端不直接读写图文件。

**载荷（Payload）**
对象或关系上不透明的数据区域，core 原样存取、永不解释。旧模型的 `data` 与 `capabilities` 私有区合并于此，其内部结构由拥有该主类型的模块约定。

**提交日志（Commit Log）**
每图一个 append-only 的 JSONL 文件，记录每次提交的 patch、来源、label 与时间；兼任 undo/redo 栈、近期变更查询源与审计记录。游标（cursor）存于图清单。

**双层模块（Two-layer Module）**
模块的标准形态：声明层（module.yaml：身份、依赖、主类型词汇、静态 UI 投影、入口）负责协调——注册、发现、防冲突；代码层（runtime，in-process 加载）负责行为——注册命令、钩子、表单，拥有全权 API。声明层不是执法依据。

**命令（Command）**
模块注册的、人和 agent 都可调用的操作。元数据（适用主类型、输入 schema、描述）在代码注册时声明，由守护进程自省提供目录。取代旧模型的"动作（Action）"及其快照修订号绑定语义。

**所有权法（Ownership Rule）**
core 唯一的运行时执法规则：一个模块的提交只能触碰自己命名空间下的主类型或无主/公共主类型。它是模块间互信的协调边界（防手滑），不是安全边界（防恶意靠安装时刻的信任）。

**校验钩子（Validation Hook）**
模块订阅的 before-commit 事件：检查候选变更、附加诊断、可否决提交。core 不聚合、不 fail-closed。领域校验在新模型中的唯一标准形态。

## 死亡的术语（随 0.x 契约废弃）

动作引用（Action Reference）· 注册快照（Registry Snapshot）· 能力（Capability，作为 core 级概念）· 主类型数据/能力状态（私有区划分，并入载荷）· 完整校验/快照校验/迁移校验（校验三分法）· 可恢复提交（Recoverable Commit）· 外部编辑吸收（External Edit Adoption，改为文件监视重载）· 提交审计（并入提交日志）· 受支持写入（写入只剩一条道）· 降级编辑 · MCP 相关全部术语。
