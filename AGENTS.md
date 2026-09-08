# TopoRealm 协作约定

- 所有需要用户审核的计划、规格、checkpoint 和报告均使用中文。
- `D:/LUKAWI/AI_project/projects/topological-tool` 是独立的 Super Plumber 工作区。除非用户明确要求，不在其中实施 TopoRealm 重构。
- 迁移旧能力时先明确基座职责与模块职责，避免把开发工作流字段重新写进通用模型。
- 优先以最低成本验证模块协议；暂不引入模块市场、代码沙箱或复杂依赖系统。
- 保留模块缺失时的无损读取能力，并明确区分基础校验与完整校验。
- Web UI 属于基座正式组成部分，架构决策必须同时考虑 Core、CLI、MCP 和 Web UI。

