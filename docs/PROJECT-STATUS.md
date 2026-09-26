# TopoRealm 项目状态

状态快照：2026-09-26。

## 当前阶段：1.1.0 已发布（2026-09-26，npm + GitHub Release tag 1.1.0；cli/聚合包 1.1.1 补丁）

1.1.0（blueprint §1.8 D25–D32，ADR-0007/0008）：双层工作区（~/.toporealm 全局池 + 项目 .toporealm 收编图存储）、作用域模型（装了就生效，项目遮蔽全局，manifest v3）、宿主技能池分发（claude marketplace 插件 + pi 包，删 host sync）、daemon 内存换载 + WebUI 静态预览、动词面改齐（creategraph/init/skills index/--version）。发布门（陌生环境建图全流程）验收通过；dogfood 全程由 workflow 模组管理（dev 图，P0–P3 全部 passed，证据在 .toporealm/graphs/dev）。遗留：quick 级 UX/缺陷记录在 dev 图（Argv flag 顺序纪律、wf.* 帮助键名 schema 等）。

发布前补齐：聚合包 `@lukawi/toporealm`（blueprint §2 发布物）、cli/daemon 的 tsx 运行时依赖、
README 发布形态重写（中/英）；真实浏览器人工验收已执行并通过（无刷新实时同步 / 外部编辑自愈 /
开页空闲保活 / 节点检查器，详见 `docs/releases/v1.0.0.md`）。

决策（D1–D17，另有 D18–D24 实现期补遗记录于 blueprint §1.4–§1.7）、ADR、接口设计与完整开发 Spec 已收口。重建为 npm workspaces monorepo，九个后端包 + web-ui 前端包就位：

| 包 | 职责 |
|---|---|
| `packages/protocol` | 契约类型层（零依赖；错误码封闭集、wire 信封） |
| `packages/daemon-core` | 单属主图内核：提交管线、所有权法/悬空边执法、YAML 存储、提交日志、undo 游标、文件监视 |
| `packages/module-host` | 模块发现/装载/requires 拓扑/activate 冻结/目录聚合/命令分发 |
| `packages/module-sdk` | 模块作者纯类型 + `defineModule` 帮助 |
| `packages/client` | DaemonClient port 三 adapter：MemoryClient（测试主缝）/ IpcClient（自动拉起守护）/ WsClient（浏览器同源 WS，断线重连 + I3 自愈；`./browser` 零 node 依赖出口） |
| `packages/web` | daemon 内 web 伺服：HTTP 静态产物 + `/ws` 端点（与 IPC 共用同一 wire 分发器与事件扇出，D22） |
| `packages/daemon` | IPC 服务器 + `toporeald` 入口（单属主互斥、空闲退出、detached 常驻、web 伺服常开） |
| `packages/distribution` | 模块安装器（npm pack --ignore-scripts + 本地路径 → `.toporealm/modules/<id>/` + 所有权标记）、host sync（claude-code plugin / pi extension+skills，钩子格式不混用）、0.x migrate（D23） |
| `packages/cli` | 核心动词 + `module add/rm/list` + `migrate` + `host sync` + `cmds`/`<ns.name>` 目录自省 + `serve` + `--json` 信封 + 退出码 0/1/2 + did-you-mean |
| `web-ui` | Svelte 5 + D3 浏览器编辑器（继承资产适配：store 层走 Session 契约，filter/projection/layout 分层保留） |

里程碑完成记录（blueprint §9）：

- **M1 骨架** ✅：monorepo 起步 → 核心动词 + MemoryClient/IpcClient + 守护进程生命周期（`31c98ee` → `7ab8da9`）。
- **M2 模块系统** ✅：module-host/module-sdk + 所有权法 + 钩子相位执法 + catalog/run + fixture 模块（example/workflow-mini）activate→命令→钩子 veto 全链路（`31c9630` → `837fb73`）。
- **M3 Web** ✅：web（HTTP+WS，D22）+ WsClient + web-ui 适配 + `serve` 动词；验收以 node WS 客户端 e2e 证明无刷新实时同步（双客户端 IPC+WS 互见、外部编辑 → reset → 全量重读自愈）与断线自愈（重连 + instanceId 失效 + fromRevision 补洞）；真实浏览器人工验收待 M5 期间补做（`1651ebc` → `3c7238d` 及后续修复）。
- **M4 分发与迁移** ✅：安装器（npm 包真实 `npm pack --ignore-scripts` 安装 → daemon 装载全链路；本地路径来源；所有权标记卸载）、host sync（claude-code 自包含 plugin 目录 / pi 原生项目级 `.pi` 发现位，所有权标记管理重同步）、migrate（合成 0.x fixture 图 → 迁移报告零意外：错误清单空、悬空边逐条点名、冲突/降级逐条在案，迁移后图 daemon 装载可读、undo 游标清零）；CLI 三动词接线（`deb6af9` → `cd0ac34`）。
- **M5 Workflow 首发移植** ✅（`c989d0e` → 本版）：D24 四条裁决落地（`CommitCandidate.conversion` undo/redo 豁免、Catalog forms 目录投影补课 D22④、图级档位落 `wf.settings` 单例、模块鸭子类型领域错误认领）；[workflow 模块](https://github.com/LUKAWI/toporealm-workflow) 1.0 移植（module.yaml v2 / ns `wf`、12 条 `wf.*` 命令、七态+依赖+完成+代签+checkpoint 门禁入 before-commit 钩子、自包含发布包、六 skills 适配），**发布门 = 其仓库根 `npm test`：0.x 语义测试的 1.0 形态 10 文件 / 45 用例全绿**；host sync 模块自身 skills 投影（双宿主，冲突跳过记 warning，卸载即消失）；集成验收 e2e（真实模块本地 path 安装 → daemon 装载 → cmds 可见 12 条 `wf.*` → 命令端到端 + VETOED 门禁 + undo）；根 CHANGELOG、README、发布证据材料（`docs/releases/v1.0.0.md`）；版本全对齐 `1.0.0`。

验收证据（2026-09-23 实测根目录 `npm test`，vitest 单一门禁：packages 后端缝 + web-ui jsdom 双工程）：28 个测试文件、208 个用例全绿；`npm run typecheck`（9 包 tsc --noEmit）全绿。发布动作清单与遗留事项见 `docs/releases/v1.0.0.md`（`npm publish` / `git push` 刻意未执行）。

剩余事项（非代码）：

- 属主执行发布：两侧仓库 tag + push + npm publish（依赖序与 smoke 见发布证据材料）。
- web-ui 真实浏览器人工验收（M3 起 node WS e2e 已覆盖实时同步与断线自愈语义）。

| 产物 | 位置 |
|---|---|
| 设计哲学 | `Toporealm设计构想.md` |
| 重建决策档案 | `docs/rebuild/decisions-draft.md`（D1–D17；D18–D24 见 blueprint §1.4–§1.7） |
| 现行 ADR | `docs/adr/0003` ~ `0006`（0001/0002 为 0.x 历史，已标废弃） |
| 实现规范（唯一规范来源） | `docs/rebuild/blueprint.md` |
| 开发 Spec | [issue #1](https://github.com/LUKAWI/toporealm/issues/1)（`ready-for-agent`） |
| 发布证据与清单 | `docs/releases/v1.0.0.md` |
| 统一术语 | `CONTEXT.md` |

## 0.x 归档

- `@lukawi/toporealm` 0.1.0–0.1.3 已发布并冻结：完整代码与文档保留于 `v0.1.x` 标签与 GitHub Releases；0.2.0 候选不再发布。
- [Workflow 模块](https://github.com/LUKAWI/toporealm-workflow) 0.1.0 已冻结；1.0 移植已完成（`wf.*` 命名空间，随本版同步发布）。
- 0.x 架构文档与治理图已从工作区移除（同见 git 历史）。

## 仍然有效的边界

- Core 只执法两条：所有权法（模块来源）+ 悬空边检查；领域规则全部属于模块（ADR-0005）。
- 模块无运行时沙箱；信任在安装时刻（禁安装脚本是唯一安装期执法）。
- 不建设：MCP、远程模块市场、查询语言、分支历史、多机并发、热装卸。
- 领域模块独立开发、版本化、发布；本仓库不含任何领域模块。
