# Core/Server 浏览器边界（ctx_core_gateway）

负责 GraphSnapshot、GraphPatch、MutationPlan 的浏览器协议、revision 冲突、patch gap、历史和基础校验接口；不负责视觉布局或模块领域语义。

## 术语表

- **GraphSnapshot**: 某一 revision 的完整图、对象和关系快照。
- **GraphPatch**: 从一个连续 revision 到下一个 revision 的局部变化。
- **revision**: Core 接受一次原子 MutationPlan 后递增的图版本号。

> 本文由 `graph export` 从 context 顶点 ctx_core_gateway 生成（节点即文档，图是真相源）。
