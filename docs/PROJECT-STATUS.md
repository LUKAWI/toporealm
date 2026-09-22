# TopoRealm 项目状态

状态快照：2026-09-22。

## 当前阶段：1.0 底层重建

决策（D1–D17）、ADR、接口设计与完整开发 Spec 已收口，尚未开始实现。

| 产物 | 位置 |
|---|---|
| 设计哲学 | `Toporealm设计构想.md` |
| 重建决策档案 | `docs/rebuild/decisions-draft.md`（D1–D17） |
| 现行 ADR | `docs/adr/0003` ~ `0006`（0001/0002 为 0.x 历史，已标废弃） |
| 实现规范（唯一规范来源） | `docs/rebuild/blueprint.md` |
| 开发 Spec | [issue #1](https://github.com/LUKAWI/toporealm/issues/1)（`ready-for-agent`） |
| 统一术语 | `CONTEXT.md` |

实施里程碑（blueprint §9）：M1 骨架（daemon-core + CLI）→ M2 模块系统 → M3 Web → M4 分发与迁移 → M5 Workflow 首发移植，语义等价通过即发布 `1.0.0`。

## 0.x 归档

- `@lukawi/toporealm` 0.1.0–0.1.3 已发布并冻结：完整代码与文档保留于 `v0.1.x` 标签与 GitHub Releases；0.2.0 候选不再发布。
- [Workflow 模块](https://github.com/LUKAWI/toporealm-workflow) 0.1.0 独立演进；其 1.0 移植随 M5 进行。
- 0.x 架构文档与治理图已从工作区移除（同见 git 历史）。

## 仍然有效的边界

- Core 只执法两条：所有权法（模块来源）+ 悬空边检查；领域规则全部属于模块（ADR-0005）。
- 模块无运行时沙箱；信任在安装时刻（禁安装脚本是唯一安装期执法）。
- 不建设：MCP、远程模块市场、查询语言、分支历史、多机并发、热装卸。
- 领域模块独立开发、版本化、发布；本仓库不含任何领域模块。
