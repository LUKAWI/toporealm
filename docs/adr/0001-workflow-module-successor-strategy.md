---
status: accepted
date: 2026-09-10
---

# Workflow 模块作为 Super Plumber 后继主线

TopoRealm 在 v0.1 基座发布后首先开发独立的 `workflow` 模块，以 Super Plumber `v1.0.0` 加明确登记的后续关键修复为不可变行为基线。目标是达到或超过其工作流使用效果，但不直接兼容旧 `.graph`、旧 `NodeSchema` 或旧 Skill 名称；Super Plumber 1.x 转入维护模式，新功能只进入 Workflow 模块。

## 已确认决策

- GitHub 仓库使用 `LUKAWI/toporealm-workflow`，npm 包使用 `@lukawi/toporealm-workflow`；模块独立维护源码、版本、CI、Skills、Web 贡献、测试和 Release，TopoRealm 主仓只保留跨包契约测试。
- 开发期间可以发布 `0.1.0-alpha.N` 做安装与连接验证；首个正式 `0.1.0` Preview 必须整体通过 Workflow 行为等价门禁，届时才将其宣布为推荐主线。
- `workflow` 只拥有工作流语义；领域建模、ADR/context 与 fog/unknown 分别留给 `domain-modeling` 和 `exploration` 等模块，Super Plumber 的跨领域总体验由模块组合提供。
- `quick`、`standard`、`program` 三档分类、选择规则和执行强度由 `workflow` 拥有。`program` 不硬依赖 `exploration`；没有该模块时使用普通研究任务和 checkpoint 消除关键未知，安装后则可引用 `exploration.unknown` 并获得 fog、毕业证据和相应可视化，`workflow` 不复制其领域模型。
- Workflow v1 固定使用 `pending`、`ready`、`running`、`passed`、`failed`、`blocked`、`cancelled` 七态，不允许项目自定义状态。
- Workflow 关系首版只公开 `workflow.depends_on`、`workflow.fallback` 和 `workflow.iterates`；不延续与 `depends_on` 机器行为重复的历史边类型。
- Workflow Skills 使用 `workflow`、`workflow-design`、`workflow-join`、`workflow-execute`、`workflow-review` 和 `workflow-tdd`，不增加 `toporealm-` 前缀，也不注册 `plumber-*` Skill 别名；需求与意图对齐继续使用基座的 `toporealm-grilling`。
- 不提供专用 designer 角色；提供 `workflow-adjudicator` 作为建议使用的独立裁决者。执行者允许自标 `passed`，独立裁决不构成硬门禁；系统记录 `self`、`independent` 或 `human` 验证来源并展示建议复核提示。human checkpoint 仍只能由用户确认。
- `workflow.checkpoint` 与 `workflow.execution_report` 是归属于任务的一等对象，默认在 Web UI 中作为折叠子记录呈现，而不是铺在任务主画布上。
- `workflow@0.1.0` 必须提供接入基座 Web 外壳的专用 Workflow 视图，覆盖七态与依赖、ready/frontier、blocked/stale、三档分类、claim/retry/fallback/iterates、checkpoint、execution report、验证来源、建议复核和 human 等待状态；与 `domain-modeling` 或 `exploration` 组合时再显示 context/ADR 与 fog 增强层。视觉和动效沿用 TopoRealm/Super Plumber 设计语言，不复制独立 Web 应用。
- 必要的旧 MCP 工具名只能作为调用同一 Workflow operation 的薄适配器，并且只有真实 agent 迁移测试证明需要时才增加。旧图转换器若开发，必须是独立的单向复制工具。
- `workflow@0.1.0` 的发布门禁包括：Super Plumber `v1.0.0` parity matrix 中全部“必须等价”项目通过；Core、CLI、MCP、专用 Web、六个 Skills 与 `workflow-adjudicator` 全链路通过；Codex、Claude、Pi 从真实安装包直接发现并使用模块；Windows、macOS、Linux CI 通过；至少一个真实 standard/program 工作流覆盖并行、汇合、失败重试、fallback、iteration、human checkpoint、自验和建议独立裁决；与至少一个独立测试模块完成组合、缺失降级、恢复和卸载；用户完成真实 Web UI 人工验收；registry 干净安装与发布后 smoke 通过。旧图迁移不属于本版本门禁。

## 后果

Workflow 必须以 TopoRealm Module API 为唯一运行边界，不能依赖或内嵌 Super Plumber 包。行为等价通过显式 parity matrix 验收；被模块边界取代或明确排除的旧能力必须逐项说明，不能以实现不同为由静默遗漏。
