---
status: superseded # 已被 ADR-0003~0006 取代，保留作为决策历史
date: 2026-09-14
---

# ManagedGraph 统一受支持写入与完整校验

TopoRealm 0.2.0 Preview 将以 deep `ManagedGraph` module 作为 Core 的统一提交与校验 seam：对调用者提供易发现的 `read`、`validate`、`commit`、`undo`、`redo` interface，内部全部收敛到一条私有 `GraphCommand` 执行管线。选择这一 hybrid，而不是单一通用 `execute` 或公开 phased session，是为了同时获得默认调用的 locality、统一执行的 depth，并避免在没有真实需求前暴露 preview、caller policy 和提交阶段。

所有受支持写入都由 Core 自动执行基础结构、已启用模块的声明式 Schema 和确定性只读 validator；调用者不能跳过校验。error 阻止提交，warning 随成功结果返回。模块整体缺失时读取为 `complete:false`，且其私有数据不可通过受支持写入改动；模块已声明的 validator 不可用时返回 `VALIDATOR_UNAVAILABLE` error 并拒绝候选图。提交在同机本地图目录上提供多进程串行化、跨事实/revision/history/audit 的中断恢复，并在发现外部 YAML 修改时保留修改、建立新基线、终止旧 redo 路径和明确报告吸收结果。新建空图是公开五操作之外的 Core bootstrap，但同样执行基础校验并通过 journal/history/audit 持久化，不允许适配器直接落盘。

`toporealm.graph/v1`、`toporealm.module/v1` 与现有 CLI/MCP/Web 用户行为保持兼容；低层 TypeScript interface 可在兼容转发和弃用提示下重组。该重组以 `@lukawi/toporealm@0.2.0` Preview 发布，并同时让 package、MCP、宿主投影、hooks、文档和 smoke 从统一产品身份派生。

声明式字段校验采用 JSON Schema 2020-12，并保留最少的 TopoRealm 实体元数据；现有简写声明由一轮兼容 adapter 读取。模块继续使用单一 runtime entry，并从只有 `execute` 的旧形状深化为可选提供 `execute` 与只读 `validate` 的 `ModuleRuntime`。0.2 每次受支持写入校验完整候选图，不预先建设增量校验或缓存失效机制。

缺失模块时只允许修改 Core 拥有的 `label`、`meta` 和不属于该命名空间的普通图事实；缺失模块实体或关系的 kind、data、capability state、端点、方向和删除均受保护，整记录 upsert 也必须逐值保留私有区域。模块启停与绑定更换使用显式管理命令，但仍进入同一私有 `GraphCommand` 管线。外部编辑吸收开启新的 history segment，旧审计保留而 undo/redo 不跨越该基线；`ManagedGraph.read` 可以先完成恢复或吸收，并在结果中返回 notice。

`ManagedGraph` 是 0.2 唯一受支持写入 interface。旧 `GraphStore` 从根导出移除，只在 `/core/legacy` 保留一个版本用于读取和无模块 fixture，不再作为生产写入 seam。

模块校验明确分为 `snapshot` 与 `transition` 两类。前者只接收完整候选图并检查长期不变量；后者同时接收不可变的变更前图、候选图与事实变更摘要，用于判断 Workflow 状态迁移等仅凭最终快照无法识别的非法变化。`ManagedGraph.validate()` 运行 snapshot 校验；commit、undo、redo 与模块管理命令运行 snapshot 和 transition 校验。校验上下文不暴露 GraphStore、文件系统或任何写入能力。

Core 负责实体公共 envelope 的结构校验；模块 JSON Schema 只覆盖模块拥有的 kind data 与 capability state。跨实体约束、状态迁移和复杂领域规则由模块 validator 承担。执行顺序固定为 Core 基础校验、按 namespace 排序的模块、模块内按 validator ID 排序；结构化诊断再按实体 ID 与错误码稳定排序。该顺序只保证结果可复现，不允许校验器形成先后依赖。

Core 0.2.x 保留现有简写 Schema adapter，使当前 Workflow 图可以无损读取。`@lukawi/toporealm-workflow@0.1.1` 将提供正式 JSON Schema 和 snapshot/transition validators，并声明 Core `>=0.2.0 <0.3.0`；该模块升级属于独立模块开发，不纳入本次 Core 重组的源码写入范围。简写 adapter 在整个 0.2.x 保留，0.3.0 删除前必须提供迁移命令与明确诊断。
