# Context Map

> 本仓库有 4 个 bounded context（由 `graph export` 从图生成）。
> 术语表详情见各 context 文件；图为真相源，本文件是视图。

| Context | 边界 | 术语数 | 文档 |
|---------|------|--------|------|
| ctx_distribution（公开发行） | 负责 @lukawi/toporealm 的 npm 包边界、跨平台 CI、MIT 许可、GitHub 仓库、版本发布与发布后证据；不改变 Core 或模块机器 | 1 | contexts/ctx_distribution.md |
| ctx_host_integration（Agent 与宿主集成） | 负责 toporealm、toporealm-design、toporealm-join、toporealm-grilling 四个基础 Skills 及 Co | 1 | contexts/ctx_host_integration.md |
| ctx_module_ecosystem（模块生态） | 负责模块安装生命周期、可信运行边界和非发布 fixture 的生态验证；不负责 research、exploration、workflow 等领域模块产品。 | 2 | contexts/ctx_module_ecosystem.md |
| ctx_runtime（基座运行时） | 负责领域无关的图存储、工作区与图解析、CLI、stdio MCP、Server 和 Web UI 运行时；不负责领域模块实现与发布平台运维。 | 1 | contexts/ctx_runtime.md |
