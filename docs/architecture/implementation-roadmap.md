# TopoRealm 基座实施路线图

状态：已实施并冻结 v1 协议基线。M3/M4 是非发布验证切片，不代表领域模块随 Core 产品发行。

## 交付原则

- 先贯通最薄的 Core → CLI/MCP → Server → Web UI 全链路，不先横向做完单层。
- 所有写入共用 Core，Web UI 是基座正式组成部分。
- 先以工作区本地模块验证协议，再增加 npm 获取与宿主投影。
- 早期 `v1alpha1` 在两条领域切片期间允许修正；research/exploration 与 workflow 均通过后已冻结 `v1`。
- 不在 TopoRealm 仓库外实施重构，不把旧图兼容列为 v1 门禁。

## 阶段与依赖

### M0：工程骨架与契约固化

目标：建立 TypeScript 工作区及 Core、CLI、MCP、Server、Web、Module SDK 的代码边界，固定测试与构建入口。

依赖：当前架构文档通过用户审核。

验收：

- 各包只能通过公开接口依赖 Core，不复制对象或关系类型；
- Web 使用 Svelte 与 D3 的现有成熟外壳，但不迁入旧 `NodeSchema`；
- 单一命令可完成类型检查、单元测试和构建；
- 提供一张最小 `v1` 空图 fixture。

### M1：最薄基座全链路

目标：让用户在 Web UI 中打开一张图，创建、修改、连接、删除对象，并通过 CLI/MCP 读取和执行同一套 Core 操作。

依赖：M0。

实现范围：

- YAML 图、对象和关系读写及基础校验；
- 图级写锁、revision、原子提交与稳定错误；
- 持久化线性撤销/重做，包括删除恢复；
- CLI 与固定 MCP 的最小读写入口；
- Server 全量快照和 `graph:patch`；
- Web 通用画布、属性编辑、连接、删除、撤销和重做。

验收：同一对象从 Web、CLI 或 MCP 修改后产生连续 revision 和局部 patch；重启后仍可撤销/重做；revision 冲突不覆盖数据。

### M2：模块装载与缺失模块降级

目标：实现本地模块目录、清单、注册快照与 Module SDK，使 Core 不增加领域枚举即可解释扩展。

依赖：M1。

实现范围：

- `module.yaml` 解析、贡献索引、命名空间和依赖检查；
- 工作区绑定、图级启用和不可变 `GraphRegistrySnapshot`；
- 对象、关系、capability、校验器和操作注册；
- 动作发现、`MutationPlan`、跨模块分域校验和原子提交；
- 缺失/不兼容模块的无损读取与基础/完整校验区分；
- 声明式 Web 样式和表单、固定 UI 插槽及错误边界。

验收：安装、移除和恢复 fixture 模块时，未知 `kind/data/capabilities` 往返后语义不变；故障模块不影响 Core 与其他模块。

### M3：离线 research/exploration 验收切片

目标：用固定本地资料验证两个无硬依赖模块的组合。

依赖：M2。

实现范围以 `research-vertical-slice.md` 为准：question、source、claim、supports/contradicts 关系和 `exploration.unknown` capability，不接外部 API，不设计完整研究产品。

验收：模块安装、动作发现、跨模块编辑、MCP MutationPlan、Web 增量显示、模块缺失降级和恢复全部通过。

发行边界：本阶段产物仅保留为测试 fixture；research 与 exploration 产品模块在 Core v0.1 发布后另行开发和连接验收。

### M4：workflow 代表性切片

目标：证明同一基座也能承载开发工作流，而不是只适合知识图。

依赖：M2；可与 M3 的领域实现并行，但共享 Core 写入必须串行合并。

实现范围：从 Super Plumber 选择性移植任务状态、依赖门禁、checkpoint、execution report 和下一行动；domain-modeling 与 exploration 只在切片真实需要时接入。不读取旧 `.graph/`，不追求旧命令同名兼容。

验收：一条最小任务链可通过模块操作完成状态流转和门禁，Core 仍无七态、DAG、checkpoint 或 ADR 枚举。

发行边界：本阶段产物仅保留为测试 fixture；workflow 产品模块在 Core v0.1 发布后独立开发，并与其他模块完成组合测试。

### M5：模块安装器与三宿主投影

目标：把已验证模块以统一安装生命周期交付给 Codex、Claude 和 Pi。

依赖：M3 或 M4 至少一条切片稳定；投影最终验收需两条切片均通过。

实现范围：

- `toporealm module add` 使用 `npm pack --ignore-scripts` 获取并解包自包含模块；
- 用户级/工作区安装、来源记录、更新和卸载；
- `host sync` 及所有权标记；
- Codex、Claude、Pi 三套完整插件投影和最小入场摘要钩子。

验收：同一模块可在三宿主发现对应 Skills 并连接固定 MCP；卸载只删除 TopoRealm 所有的投影，不触碰用户手写资产。

### M6：协议冻结与首个稳定基线

目标：收敛两条切片暴露的问题并冻结 `toporealm.graph/v1` 与 `toporealm.module/v1`。

依赖：M3、M4、M5。

验收：

- Core、CLI、MCP、Web UI、Module SDK 和三宿主投影使用同一稳定契约；
- 两条切片及缺失模块、撤销/重做、并发冲突场景通过；
- 文档不再引用已被 ADR 接替的设计；
- 自此以后破坏性格式变更必须升级格式版本并提供显式迁移方案。

## 建议转成 standard 实施拓扑的主干

```text
M0 工程骨架
  → M1 最薄全链路
  → M2 模块装载
     ├→ M3 research/exploration
     └→ M4 workflow
          M3 + M4 → M5 安装与宿主投影
                       → M6 协议冻结
```

M3 与 M4 可以并行设计和实现，但不得同时改写 Core 的同一接口文件；共享契约变更由主线程集中裁决。每个阶段都必须先形成可运行产物再进入下游，不把“已写测试”或“已写文档”单独当作完成。

## 明确暂不建设

- Super Plumber 旧图读取、双写和强制迁移器；
- 远程模块市场、复杂版本求解与自动 Schema 迁移；
- 第三方代码沙箱、原生二进制模块和安装脚本；
- CRDT、字段级自动合并、分支撤销历史；
- 通用外部副作用回滚；
- 完整 deep research、联网检索和自适应学习产品；
- 模块自定义宿主钩子和动态 MCP Server。

## 开工条件

以下条件满足后即可把本路线图转换为 standard 实施图并从 M0 开工：

1. 用户批准当前基座架构与路线图；
2. 当前 program 雾区按已形成的契约和切片证据毕业；
3. 新实施图写明每阶段真实文件边界、DoD 和验证命令；
4. 不把可选旧图转换器或完整 research 产品设为前置。
