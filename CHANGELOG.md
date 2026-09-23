# Changelog

## 1.0.0 - 2026-09-23

TopoRealm 1.0 重建完成（M1–M5，blueprint §9）。本仓库不含领域模块；workflow 模块的 1.0 移植见 [toporealm-workflow](https://github.com/LUKAWI/toporealm-workflow)（同步发布 1.0.0）。

### M1 骨架

- `protocol`：全量契约类型 + 错误码封闭集（§1.1 全表，只增不改义）。
- `daemon-core`：单属主图内核——提交管线固定序（所有权法 → 悬空边 → before-commit 钩子 → 原子落盘+日志+游标 → after-commit → 广播）、YAML 存储、统一提交日志（D7）、undo 游标、文件监视外部编辑吸收。
- `client`：DaemonClient 三实现——MemoryClient（测试主缝）/ IpcClient（CLI）/ WsClient（浏览器）；自动拉起、重连、instanceId 失效检测。
- `cli`：16 核心动词 + `--json` 信封 + 退出码 0/1/2 + did-you-mean。

### M2 模块系统

- `module-host` / `module-sdk`：双层模块（module.yaml v2 协调 + activate 行为）；命令目录自省（D12 目录永远为真）；所有权法 namespace 映射（D20）；钩子相位执法（LATE_REGISTRATION / REENTRANT_COMMIT / after-commit 排队，D19/D21）；requires 拓扑排序 + MISSING_MODULE。

### M3 Web

- `web` + `web-ui`：HTTP 静态产物 + `/ws`（与 IPC 共用同一 wire 信封与事件扇出，D22）；WsClient 重连补洞与 reset 自愈；web-ui 走 Session 契约（0.x REST 面与 MutationPlan 不迁移）；`serve` 动词。

### M4 分发与迁移

- `distribution`：模块安装器（`npm pack --ignore-scripts` + 本地路径 → `.toporealm/modules/<id>/` + 所有权标记，D23①）；host sync（claude-code plugin / pi extension+skills，钩子格式不混用，D23②）；`migrate`（0.x v1 图机械映射 + 迁移报告，D23③）。

### M5 Workflow 首发移植（本版新增）

- **D24（§1.7）**：`CommitCandidate.conversion`（undo/redo 游标移动豁免领域钩子）；Catalog `forms` 目录投影（D22④ 补课）；workflow 图级档位落 `wf.settings` 单例；模块鸭子类型领域错误分发面认领重建。
- **workflow 模块 1.0**（toporealm-workflow 仓库）：module.yaml v2（ns `wf`）、12 个 `wf.*` 命令、七态/依赖/完成/代签/checkpoint 门禁入 before-commit 钩子；发布门 = 其仓库根 `npm test`（10 文件 45 用例，0.x 语义测试的 1.0 形态）。
- **host sync 模块 skills 投影**：模块包 `skills/<名>/SKILL.md` → claude-code plugin 同层 + pi 原生发现位；基座名保留、冲突记 warning、卸载后重同步即消失。
- **集成验收 e2e**：真实 workflow 模块本地 path 安装 → daemon 装载 → cmds 可见 12 条 `wf.*` → 命令端到端 + VETOED 门禁 + undo。
- 版本对齐 `1.0.0`（root + 10 包 + 跨包依赖）。

### 兼容与边界

- 0.x 图不直接可读：经 `toporealm migrate <旧图目录>` 一次性迁移（报告含冲突/降级/悬空边清单）。
- 无 MCP；宿主适配仅 Claude Code（plugin）与 Pi（extension/skills）。
- 专用 Web 领域视图、registry snapshot / STALE_ACTION / ActionExecutor 六道门禁按蓝图 §7 死亡，不迁移。
