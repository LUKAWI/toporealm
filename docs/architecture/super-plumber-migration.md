# Super Plumber 能力迁移边界

状态：已确认。TopoRealm 是独立新项目，v1 不承诺旧图兼容。

## 总体策略

TopoRealm 不依赖 `topological-tool` 包，不在旧仓库中实施重构，也不把旧 `.graph/` 读取列为 v1 门禁。迁移采用“保留已验证行为与实现经验，围绕新接口选择性移植”的方式，不整仓复制旧 Core。

若后续证明成本足够低，可以单独提供一次性转换器，把旧 Super Plumber 图复制为启用 `workflow`、`domain-modeling` 与 `exploration` 模块的新图。转换器不覆盖旧图、不反向写回，也不为无法映射的字段污染 TopoRealm Core；未映射内容进入迁移报告。

## 能力归属

| 旧能力 | TopoRealm 归属 | 处理方式 |
| --- | --- | --- |
| 目录式 YAML、稳定 ID、图 I/O、引用完整性 | Core | 按新对象/关系格式重建，可借鉴原子写入经验 |
| 图锁、索引、事件、快照 | Core | 选择性移植机制，改为图级 revision 与可逆编辑历史 |
| CLI、MCP、Web Server、D3/Svelte 画布 | 宿主适配层与 Web UI | 复用成熟外壳，改接统一 Core 接口 |
| 七态、依赖门禁、认领、重试、checkpoint、execution report | `workflow` 模块 | 从旧 Core 抽离为模块 Schema、操作和 Skills |
| context、ADR、术语与跨上下文契约 | `domain-modeling` 模块 | 作为模块对象、关系和操作实现 |
| fog、未知区与渐进探索 | `exploration` 模块 | 不进入最小 Core |
| 固定节点/边枚举、DAG 假设、entry/exit、开发专用审核规则 | 不进入 Core | 由对应模块声明；无通用价值的旧约束直接淘汰 |

## v1 兼容范围

- 不直接读取、修改或保存旧 `.graph/`。
- 不维持新旧格式双写或双向同步。
- 不要求旧插件、Skills 或命令在 TopoRealm 中保持原名。
- Super Plumber 继续作为独立产品和历史图运行环境。
- 可选转换器延后评估，不阻塞 TopoRealm v1。

## 边界结论

TopoRealm 的完成标准是新基座和模块组合可独立工作，不是旧图迁移率。旧项目只作为只读参考源；任何选择性移植都在本仓库按新职责重新验收。
