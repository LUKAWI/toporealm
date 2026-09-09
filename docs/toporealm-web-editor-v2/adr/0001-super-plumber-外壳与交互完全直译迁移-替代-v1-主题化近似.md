# 0001 — Super Plumber 外壳与交互完全直译迁移，替代 v1 主题化近似

Web 编辑器 v2 直接整段复用 topological-tool/web-ui 的应用外壳（单排顶栏/左缘工具轨/右缘玻璃抽屉）、设计令牌与画布交互契约（滚轮缩放、中键平移+pointer capture、节点拖拽、空白点击清除、双击重置、声呐 hover/selected/focus 反馈），在其下接 TopoRealm 的 GraphSnapshot/GraphPatch/MutationPlan 与模块投影；TopoRealm 无工作流状态语义，星体色彩改为表达对象 kind/模块，关系方向用不对称渐隐与方向指示表达。不复制旧 NodeSchema，不修改 topological-tool 仓库。

**Status：** proposed（待裁决）

**Context：** v1 人工审核不通过，三大阻塞：点击节点无法显示详情、前端只做了主题化近似而未完全沿用 Super Plumber 设计语言、鼠标与画布交互不流畅编辑不可用。v1 的 ADR（复用成熟 Svelte/D3 外壳）方向正确但执行时降级为自创蓝色三栏壳体。

**Considered Options：** A：继续自创壳体只借配色（v1 实际路线）→ 已被人审否决，视觉与操作习惯都不一致；B：原生 DOM/SVG 重写全部交互 → 重担画布风险，违背复用成熟交互的初衷；C：完全直译迁移参考外壳与交互契约，仅替换数据契约与领域视觉语义（选中）。

**Why：** 用户明确要求完全沿用同一设计语言与操作习惯；直接复用经过真人审核的参考实现是达成该要求风险最低、速度最快的路径；适配层让 Core 与模块协议保持唯一真相。

**Consequences：** TopoRealm web-ui 需要与参考实现保持结构同构，后续参考演进时可对照同步；旧仓库保持只读；工作流专用面板（map 透镜/分期/对比/雾区）不迁移，TopoRealm 以同主题新增通用面板替代。

> 本文由 `graph export` 从图顶点 adr_0001 生成；改图不改文，重新导出即覆盖。
