# TopoRealm 项目状态

状态快照：2026-09-23。

## 当前阶段：M1–M3 完成（骨架 / 模块系统 / Web），进入 M4 分发与迁移

决策（D1–D17，另有 D18–D22 实现期补遗记录于 blueprint §1.4/§1.5）、ADR、接口设计与完整开发 Spec 已收口。重建为 npm workspaces monorepo，八个后端包 + web-ui 前端包就位：

| 包 | 职责 |
|---|---|
| `packages/protocol` | 契约类型层（零依赖；错误码封闭集、wire 信封） |
| `packages/daemon-core` | 单属主图内核：提交管线、所有权法/悬空边执法、YAML 存储、提交日志、undo 游标、文件监视 |
| `packages/module-host` | 模块发现/装载/requires 拓扑/activate 冻结/目录聚合/命令分发 |
| `packages/module-sdk` | 模块作者纯类型 + `defineModule` 帮助 |
| `packages/client` | DaemonClient port 三 adapter：MemoryClient（测试主缝）/ IpcClient（自动拉起守护）/ WsClient（浏览器同源 WS，断线重连 + I3 自愈；`./browser` 零 node 依赖出口） |
| `packages/web` | daemon 内 web 伺服：HTTP 静态产物 + `/ws` 端点（与 IPC 共用同一 wire 分发器与事件扇出，D22） |
| `packages/daemon` | IPC 服务器 + `toporeald` 入口（单属主互斥、空闲退出、detached 常驻、web 伺服常开） |
| `packages/cli` | 核心动词 + `cmds`/`<ns.name>` 目录自省 + `serve` + `--json` 信封 + 退出码 0/1/2 + did-you-mean |
| `web-ui` | Svelte 5 + D3 浏览器编辑器（继承资产适配：store 层走 Session 契约，filter/projection/layout 分层保留） |

里程碑完成记录（blueprint §9）：

- **M1 骨架** ✅：monorepo 起步 → 核心动词 + MemoryClient/IpcClient + 守护进程生命周期（`31c98ee` → `7ab8da9`）。
- **M2 模块系统** ✅：module-host/module-sdk + 所有权法 + 钩子相位执法 + catalog/run + fixture 模块（example/workflow-mini）activate→命令→钩子 veto 全链路（`31c9630` → `837fb73`）。
- **M3 Web** ✅：web（HTTP+WS，D22）+ WsClient + web-ui 适配 + `serve` 动词；验收以 node WS 客户端 e2e 证明无刷新实时同步（双客户端 IPC+WS 互见、外部编辑 → reset → 全量重读自愈）与断线自愈（重连 + instanceId 失效 + fromRevision 补洞）；真实浏览器人工验收待 M4 期间补做（`1651ebc` → `3c7238d` 及后续修复）。

验收证据（2026-09-23 实测根目录 `npm test`，vitest 单一门禁：packages 后端缝 + web-ui jsdom 双工程）：23 个测试文件、178 个用例全绿；`npm run typecheck`（8 包 tsc --noEmit）全绿。

剩余里程碑：

- **M4 分发与迁移**（下一步）：安装器 + host sync（claude-code/pi，钩子格式不得混用）+ migrate；验收为 npm 包安装模块、旧 fixture 图迁移报告零意外。
- **M5 Workflow 首发移植**：workflow 模块移植 + 双宿主 skills + 文档；workflow 全部语义等价用例通过即发布 `1.0.0`（含 FormSpec 目录投影通道的补课，见 D22④）。

| 产物 | 位置 |
|---|---|
| 设计哲学 | `Toporealm设计构想.md` |
| 重建决策档案 | `docs/rebuild/decisions-draft.md`（D1–D17；D18–D22 见 blueprint §1.4/§1.5） |
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
