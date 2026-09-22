# TopoRealm 协作约定（1.0 重建期）

## 当前阶段

- 1.0 底层重建进行中，**尚无实现**；实现规范唯一来源是 `docs/rebuild/blueprint.md`，开发 Spec 是 [issue #1](https://github.com/LUKAWI/toporealm/issues/1)。
- 实施顺序固定为里程碑 M1→M5（blueprint §9）：骨架 → 模块系统 → Web → 分发与迁移 → Workflow 首发移植。
- 0.x 代码与文档已归档于 `v0.1.x` 标签与 GitHub Releases，工作区中没有旧实现；不要试图引用或恢复 `src/`（已删除）。
- `web-ui/` 与 `tests/fixtures/` 是刻意保留的资产：前者按蓝图继承改造，后者是 workflow 语义与模块编写的参考。

## 架构红线（违反即返工）

- 单属主 daemon 是图文件唯一写者；CLI/WebUI 客户端绝不直接读写图。
- core 执法仅两条：所有权法（只约束 `module:*` 来源提交）+ 悬空边检查。不新增任何门禁、不做 fail-closed、领域校验只走模块 before-commit 钩子。
- core 不解释载荷（payload）；`validate` 不是 core 操作；图事实面只有 read / commit / undo / redo。
- 依赖单向：`daemon-core` 绝不 import `module-host`；模块只依赖类型（module-sdk）；契约类型集中在 protocol 包且零依赖。
- 模块是双层结构：声明层（module.yaml）只管协调，不是执法依据；行为全部在 activate 代码里注册。
- 没有 MCP。宿主适配只有 Claude Code（plugin 打包）与 Pi（extension/skills 打包），两者钩子格式不同，不得混用。
- 错误码是封闭集（blueprint §1.1 全表），只增不改义；CLI 语法是公共契约，破坏性变更必须升版本。

## 工作方式

- 需要用户审核的计划、规格、checkpoint 和报告一律使用中文；术语遵循 `CONTEXT.md`。
- 发现规范缺口：先改 `docs/rebuild/blueprint.md`（附决策记录），再写代码。蓝图与 Spec（issue #1）冲突时以蓝图为准。
- 架构级新决策走 ADR（`docs/adr/`，编号顺延）；ADR-0001/0002 已废弃仅作历史。
- `package.json`/`tsconfig`/`vitest.config` 仍指向已删除的 `src/`，构建暂不可用——这是预期中间态，M1 第一步重写为 monorepo（`packages/`）。
- 测试只打公共缝（内存客户端主缝、CLI golden 信封、fixture 模块直激活）；不测实现内部细节。
- `D:/LUKAWI/AI_project/projects/topological-tool` 是独立的 Super Plumber 工作区，除非用户明确要求，不在其中实施任何改动。
