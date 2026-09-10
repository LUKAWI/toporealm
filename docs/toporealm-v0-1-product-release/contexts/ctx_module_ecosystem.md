# 模块生态（ctx_module_ecosystem）

负责模块安装生命周期、可信运行边界和非发布 fixture 的生态验证；不负责 research、exploration、workflow 等领域模块产品。

## 术语表

- **生态验证模块**: 仅用于验证安装、激活、动作、宿主投影和卸载协议的外部 fixture；不进入产品安装包。 Avoid: 内置模块, 官方业务模块
- **领域操作实现**: 模块提供且由 Core 调用的领域行为实现；没有图存储写权限，图变更只能以 MutationPlan 交给 Core 提交。

> 本文由 `graph export` 从 context 顶点 ctx_module_ecosystem 生成（节点即文档，图是真相源）。
