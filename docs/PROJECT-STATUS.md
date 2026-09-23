# TopoRealm 项目状态

状态快照：2026-09-23。

## 当前阶段：M1 骨架完成，进入 M2 模块系统

决策（D1–D17，另有 D18 实现期补遗记录于 blueprint §1）、ADR、接口设计与完整开发 Spec 已收口。M1 骨架已完成并验收（`31c98ee` monorepo 起步 → `7ab8da9`），重建为 npm workspaces monorepo，五包就位：

| 包 | 职责 |
|---|---|
| `packages/protocol` | 契约类型层（零依赖） |
| `packages/daemon-core` | 单属主图内核：提交管线、YAML 存储、提交日志、undo 游标、文件监视 |
| `packages/client` | 客户端接入面：MemoryClient + IpcClient（连接目标解析、透明自动拉起守护进程） |
| `packages/daemon` | IPC 服务器 + `toporeald` 入口（单属主互斥、空闲退出、detached 常驻） |
| `packages/cli` | 核心动词 + `--json` 信封 + 退出码 0/1/2 + did-you-mean |

验收证据（2026-09-23 于 `7ab8da9` 实测 `npm test`，vitest run）：8 个测试文件、65 个测试全绿——CLI 一条龙 e2e（真实 bin，守护进程自动拉起/复用）与 golden 信封、S1 契约在 memory/IPC 双 adapter 复跑、守护进程生命周期（单属主互斥、空闲退出）、外部编辑监视吸收。

剩余里程碑（blueprint §9）：

- **M2 模块系统**（下一步）：module-host + module-sdk + catalog/run + 所有权法 + 钩子 + form；验收为 fixture 模块（example/workflow-mini）activate→命令→钩子 veto 全链路。
- **M3 Web**：web（HTTP+WS）与 web-ui 适配（store 换 client，其余分层继承）；验收为浏览器无刷新实时同步与冲突自愈。
- **M4 分发与迁移**：安装器 + host sync（claude-code/pi）+ migrate；验收为 npm 包安装模块、旧 fixture 图迁移报告零意外。
- **M5 Workflow 首发移植**：workflow 模块移植 + 双宿主 skills + 文档；workflow 全部语义等价用例通过即发布 `1.0.0`。

| 产物 | 位置 |
|---|---|
| 设计哲学 | `Toporealm设计构想.md` |
| 重建决策档案 | `docs/rebuild/decisions-draft.md`（D1–D17；D18 见 blueprint §1） |
| 现行 ADR | `docs/adr/0003` ~ `0006`（0001/0002 为 0.x 历史，已标废弃） |
| 实现规范（唯一规范来源） | `docs/rebuild/blueprint.md` |
| 开发 Spec | [issue #1](https://github.com/LUKAWI/toporealm/issues/1)（`ready-for-agent`） |
| 统一术语 | `CONTEXT.md` |

## 0.x 归档

- `@lukawi/toporealm` 0.1.0–0.1.3 已发布并冻结：完整代码与文档保留于 `v0.1.x` 标签与 GitHub Releases；0.2.0 候选不再发布。
- [Workflow 模块](https://github.com/LUKAWI/toporealm-workflow) 0.1.0 独立演进；其 1.0 移植随 M5 进行。
- 0.x 架构文档与治理图已从工作区移除（同见 git 历史）。

## 仍然有效的边界

- Core 只执法两条：所有权法（模块来源）+ 悬空边检查；领域规则全部属于模块（ADR-0005）。
- 模块无运行时沙箱；信任在安装时刻（禁安装脚本是唯一安装期执法）。
- 不建设：MCP、远程模块市场、查询语言、分支历史、多机并发、热装卸。
- 领域模块独立开发、版本化、发布；本仓库不含任何领域模块。
