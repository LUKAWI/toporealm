# 最小 Research 纵向验收切片

状态：范围已确认。它只验证基座协议，不定义完整研究产品。

## 验收目的

使用一个完全离线、结果可重复的样例，证明 TopoRealm 能在不修改 Core 类型枚举的情况下组合两个模块，并贯通文件、注册、Core、MCP 与 Web UI。

## 固定场景

仓库提供一个研究问题和两份固定本地资料。样例只使用三种 research 对象：

- `research.question`：待回答的研究问题；
- `research.source`：本地资料及其出处；
- `research.claim`：从资料中形成的可核对论点。

证据不是额外对象，而是拥有稳定 ID 的一等关系：

- `research.supports`：来源支持论点；
- `research.contradicts`：来源反驳论点。

关系数据可以保存原文定位、证据摘要、可信度和支持强度。只有未来出现需要脱离来源独立组合的证据实体时，才重新评估 `research.evidence` 对象。

## 模块组合

`exploration` 不依赖 `research`，`research` 也不依赖 `exploration`。图显式启用两者后，可以把 `exploration.unknown` 能力附加到 question 或 claim，用于记录置信度和未解决说明。移除 exploration 后，research 仍可工作，未知能力数据由 Core 无损保留。

## 最小操作链

1. 装载 research 与 exploration 模块；
2. 创建 question、两份 source 和若干 claim；
3. 通过模块动作建立 supports 或 contradicts 关系；
4. 给一个对象附加 `exploration.unknown`；
5. MCP 返回动作摘要并执行至少一次图内 `MutationPlan`；
6. Web UI 通过增量 patch 更新对象和关系，不重置视口；
7. 临时移除一个模块，确认通用界面仍无损读取；
8. 恢复模块，确认完整表单、样式、校验和动作重新出现。

## 明确不做

- 不调用搜索引擎、论文库或其他外部 API；
- 不设计完整研究方法、自动综合结论或方向推荐；
- 不为样例增加自定义 Web UI 代码，除非声明式样式和表单无法完成验收；
- 不把样例类型写入 Core。

## 通过读数

- 两个模块可独立安装、无硬依赖并可在同一图组合；
- 未修改 Core 的对象、关系或能力枚举；
- 图内动作原子写入并进入撤销历史；
- 模块缺失时基础校验可用、完整校验明确不可用；
- Web UI 正常修改只收到连续 revision 的局部 patch。
