# TopoRealm｜拓境

**以拓扑关系为核心的 agent 效率与流程管理工具：极简核心（daemon + CLI + WebUI）+ 高度自定义的双层模块系统。**

设计灵感是 [pi](https://github.com/badlogic/pi-mono)：最小的核心、体系化的扩展、以及一份人与 agent 共享的本地图数据。

> ✅ **当前状态：1.0.0 代码就绪（M1–M5 全部完成），待发布。**
>
> - 五个里程碑（骨架 → 模块系统 → Web → 分发与迁移 → Workflow 首发移植）已全部实现；
>   验收证据见 [docs/releases/v1.0.0.md](docs/releases/v1.0.0.md) 与 [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md)。
> - 发布动作（`npm publish` / `git tag` + `git push`）留给仓库属主执行，步骤清单见发布证据材料。
> - 设计基准（实现规范）：[docs/rebuild/blueprint.md](docs/rebuild/blueprint.md)
> - 开发 Spec：[issue #1](https://github.com/LUKAWI/toporealm/issues/1)
> - 决策档案与 ADR：[docs/rebuild/decisions-draft.md](docs/rebuild/decisions-draft.md) · [docs/adr/](docs/adr/)
> - 变更历史：[CHANGELOG.md](CHANGELOG.md)
>
> **0.x 已归档**：npm `@lukawi/toporealm@preview`（最高 0.1.3）不再演进，完整代码与文档保留于 `v0.1.x` 标签与 [GitHub Releases](https://github.com/LUKAWI/toporealm/releases)。工作流模块 [toporealm-workflow](https://github.com/LUKAWI/toporealm-workflow) 已同步移植 1.0（`wf.*` 命名空间，发布门为其仓库根 `npm test`）。

## 快速上手（工作区形态）

```bash
npm install                       # monorepo workspaces（发布物 = 各 workspace 包）
npx toporealm new mygraph         # 新建图并选中
npx toporealm status              # 单属主 daemon 自动拉起
npx toporealm module add @lukawi/toporealm-workflow   # 安装 workflow 领域模块
npx toporealm cmds                # 目录自省（wf.* 命令即顶层子命令）
npx toporealm host sync --host all                    # Claude Code / Pi 宿主投影
```

## 文档地图

| 内容 | 位置 |
|---|---|
| 设计哲学 | [Toporealm设计构想.md](Toporealm设计构想.md) |
| 0.x 现状勘察（重建依据） | [Toporealm代码库现状.md](Toporealm代码库现状.md) |
| 1.0 蓝图（实现规范） | [docs/rebuild/blueprint.md](docs/rebuild/blueprint.md) |
| 统一术语 | [CONTEXT.md](CONTEXT.md) |
| 架构决策 | [docs/adr/](docs/adr/) |
| 项目状态 | [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md) |

## 许可证

[MIT](LICENSE)
