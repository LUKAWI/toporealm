# 模块 UI 投影边界（ctx_module_projection）

负责模块声明的 presentation/forms/operations 在 Web 中的安全投影，以及缺失或不兼容模块的降级显示；不负责持久化、Core schema 或应用外壳。

## 术语表

- **presentation**: 模块为对象或关系提供的颜色、图标等呈现提示。
- **degraded**: 模块不可用时保留原始 kind/data 的可查看状态，并禁用依赖该模块的行为。
- **operation**: 模块声明且经 Server/ActionExecutor 校验后可触发的领域动作。

> 本文由 `graph export` 从 context 顶点 ctx_module_projection 生成（节点即文档，图是真相源）。
