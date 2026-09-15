# TopoRealm 项目状态与资料导航

状态快照：2026-09-15（Asia/Shanghai）。版本、CI、registry 与远端提交属于易变事实；下列公开状态在 0.2 发布操作前还会再次实时核对。

## 当前结论

`@lukawi/toporealm@0.2.0` 已在本工作区完成 Core 与全产品表面重组，并通过独立全图双轴复核，目前是**尚未发布的候选**：冻结精确提交与 tarball 后，需用户针对该候选明确授权，才执行 npm/GitHub 发布及干净 registry 安装核验。当前公开 Preview 仍为 0.1.3。

TopoRealm 已完成两个可独立安装的公开 Preview 产品：

| 产品 | 当前 Preview | GitHub Release | 状态 |
|---|---:|---|---|
| 领域无关基座 `@lukawi/toporealm` | `0.1.3` | [TopoRealm 0.1.3](https://github.com/LUKAWI/toporealm/releases/tag/v0.1.3) | 已发布；Core、CLI、MCP、Web、Module SDK、模块生命周期和三宿主投影可用 |
| 工作流模块 `@lukawi/toporealm-workflow` | `0.1.0` | [Workflow 0.1.0 Preview](https://github.com/LUKAWI/toporealm-workflow/releases/tag/v0.1.0) | 已发布；达到既定 Super Plumber v1.0.0 行为等价门禁 |

推荐按 Preview 标签安装：

```bash
npm install @lukawi/toporealm@preview @lukawi/toporealm-workflow@preview
```

注意：Core 的 npm `latest` 仍为 `0.1.0`，`preview` 为 `0.1.3`；Workflow 的 `latest` 与 `preview` 当前都为 `0.1.0`。产品文档和测试基线应使用 Preview 标签，不要用无标签安装推断当前 Core 版本。

## 已交付能力

### TopoRealm Core

- `ManagedGraph` 五方法公共契约，统一基础/完整校验、revision 与可恢复 `MutationPlan` 提交；
- 同机多进程锁、journal 中断恢复、segment 化 undo/redo、最小 audit 与外部编辑吸收；
- Workspace Runtime 统一装配 CLI、MCP、Server、Web、模块 registry/validator/action；
- 增量 patch、多图工作区与模块缺失时的无损读取和私有区域保护；
- CLI、固定强类型 MCP、本地 Server、Svelte 5 + D3 Web UI；
- Module SDK、安装/绑定/激活/卸载、Action Reference 与 Web contribution；
- Codex、Claude、Pi 独立宿主投影和基础 Skills。

Core 继续独占图存储写权限。模块可以提供由 Core 调用的领域操作实现，但所有图变更只能以 `MutationPlan` 交给 Core 校验、加锁并提交。

### Workflow 模块

- `pending / ready / running / passed / failed / blocked / cancelled` 七态；
- `depends_on / fallback / iterates`、并行、汇合、claim、retry、stale 与 iteration；
- 一等 checkpoint、execution report 和验证来源；
- quick、standard、program 三档工作流；
- 12 个领域操作、专用 Web 视图、六个 Workflow Skills；
- 建议性的 `workflow-adjudicator`，允许 self pass，human checkpoint 仍需用户确认；
- Codex、Claude、Pi 直接发现和调用；安装、卸载、恢复及多模块组合验证。

## 发布与验证证据

| 范围 | 发布提交 | 最终 CI | 发布验证 |
|---|---|---|---|
| Core 0.1.3 | `33698e3ed6cbd81a15e5e75d5acb65d305a12587` | [run 34595319043](https://github.com/LUKAWI/toporealm/actions/runs/34595319043) | 根测试 38、Web 测试 44、package smoke 通过 |
| Workflow 0.1.0 | `e510b3883a526a7a1a5b4fe6511c61e4255c41df` | [run 34599715730](https://github.com/LUKAWI/toporealm-workflow/actions/runs/34599715730) | 17 个测试文件、55 项测试；registry 空目录 CLI/MCP/Web/三宿主 smoke 通过 |

Workflow 的完整验收资料位于独立仓库：

- `docs/parity-matrix.md`
- `docs/acceptance/parity-evidence.md`
- `docs/acceptance/platform-matrix.md`
- `docs/acceptance/dogfood-scenario.md`
- `docs/acceptance/human-acceptance.md`
- `docs/releases/v0.1.0-preview.md`

## 当前阶段

Core 0.2.0 的开发、本地矩阵和独立全图复核已经收口，正在冻结精确候选并等待人工发布门。Workflow 0.1.0 保持独立发布和独立升级，本轮没有修改其源码。

已登记的候选领域模块为：

1. `domain-modeling`：context、ADR、术语、上下文契约与过期传播；
2. `exploration`：unknown/fog、拆分、解决、重开与毕业证据；
3. `research`：question/source/claim/evidence 与研究工作流；
4. `learning`：知识点、前置关系、掌握、练习与复习。

这些仍是 0.2 发布后的候选路线，不代表已经决定开发顺序。

## 仍然有效的边界

- Core 不内置任何领域模块；领域模块独立开发、版本化和发布。
- 新模块必须先完成单模块连接测试，再做与 Workflow 及其他模块的组合测试。
- 不在 Core 中重新引入 Workflow、Research、ADR 或 fog 等领域枚举。
- 首版不建设远程模块市场、第三方代码沙箱或复杂依赖求解。
- `D:/LUKAWI/AI_project/projects/topological-tool` 是独立 Super Plumber 工作区，只作行为与视觉参考。

## 资料阅读顺序

1. `README.md`：公开产品定位和安装入口；
2. 本文件：当前阶段、版本和资料导航；
3. `CONTEXT.md`：统一语言；
4. `docs/architecture/`：Core 冻结协议与设计边界；
5. `docs/adr/0001-workflow-module-successor-strategy.md`：Workflow 后继主线决策；
6. `docs/releases/`：Core 各版本发布记录；
7. `docs/handoff/toporealm-project-handoff/`：完整交接背景，具体版本事实以本文件和实时查询为准；
8. `D:/LUKAWI/AI_project/projects/toporealm-workflow/docs/`：Workflow 产品规范与验收证据。

`.graph/` 保存历史设计和实施治理证据，但不替代源码、测试、ADR 和 Release。读取图状态时要区分 task、context 与 ADR 的不同生命周期。
