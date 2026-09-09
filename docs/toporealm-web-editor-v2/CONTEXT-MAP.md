# Context Map

> 本仓库有 3 个 bounded context（由 `graph export` 从图生成）。
> 术语表详情见各 context 文件；图为真相源，本文件是视图。

| Context | 边界 | 术语数 | 文档 |
|---------|------|--------|------|
| ctx_core_gateway（Core/Server 浏览器边界） | 负责 GraphSnapshot、GraphPatch、MutationPlan 的浏览器协议、revision 冲突、patch gap、历史和基础校验接口； | 3 | contexts/ctx_core_gateway.md |
| ctx_module_projection（模块 UI 投影边界） | 负责模块声明的 presentation/forms/operations 在 Web 中的安全投影，以及缺失或不兼容模块的降级显示；不负责持久化、Core s | 3 | contexts/ctx_module_projection.md |
| ctx_web_surface（Web 交互与渲染边界） | 负责浏览器端 Svelte 状态、星空画布、布局、选择、详情抽屉、编辑表单、面板和只读交互，完全沿用 Super Plumber 设计语言；不负责持久化、rev | 4 | contexts/ctx_web_surface.md |
