# TopoRealm｜拓境

**一个可扩展、可视化、对 agent 友好的本地图工作空间。**

TopoRealm 把图存储、版本化变更、CLI、MCP 和 Web UI 做成稳定基座，再让用户按需安装领域模块。它适合希望用同一份本地数据连接人、agent 与不同工作方法，同时又不愿把任务流、研究流或学习流写死在 Core 里的用户。

> `0.1.0` 是公开 Preview：图格式和模块协议已冻结为 v1，但 npm 包不内置任何领域模块。`research`、`exploration`、`workflow` 目前仅作为非发布测试 fixture；它们将在 v0.1 发布后独立开发，并分别完成连接测试和多模块组合测试。

[English](README.en.md) · [架构边界](docs/architecture/FOUNDATION.md) · [模块协议](docs/architecture/module-contract.md) · [发布清单](docs/releases/v0.1.0-preview.md)

## 你得到什么

- **Core**：本地 YAML 图、稳定 ID、revision、原子变更、并发冲突、撤销/重做、基础与完整校验。
- **Web UI**：画布、搜索、图切换、通用编辑、历史、模块状态，以及模块声明式贡献的样式和表单。
- **CLI 与 stdio MCP**：人和 agent 通过同一 Core 读写图；MCP 固定提供图、校验、历史、模块和动作入口。
- **模块生态**：安装、绑定、图级启用、注册快照、缺失模块无损读取、`MutationPlan` 动作和卸载。
- **四个基础 Skills**：`toporealm`、`toporealm-design`、`toporealm-join`、`toporealm-grilling`。
- **三宿主投影**：为 Codex、Claude Code 与 Pi 生成各自可直接使用的 manifest、Skills、MCP 配置和只读入场钩子。

## 5 分钟开始

需要 Node.js 20 或更高版本。

```bash
npm install --global @lukawi/toporealm@preview

mkdir my-realm
cd my-realm
toporealm init demo
toporealm status
toporealm serve --open
```

`serve` 会输出本地地址；不使用 `--open` 时可以手动在浏览器打开。工作区通过向上查找 `.toporealm/` 自动识别，也可以显式传入 `--root <目录>` 和 `--graph <图 ID>`。

常用命令：

```bash
toporealm list
toporealm switch demo
toporealm read
toporealm validate
toporealm validate --complete
toporealm undo
toporealm redo
```

## 给 agent 接入 MCP

任何支持 stdio MCP 的宿主都可以启动：

```json
{
  "mcpServers": {
    "toporealm": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@lukawi/toporealm@0.1.0", "mcp"]
    }
  }
}
```

也可以先进入工作区，再直接运行 `toporealm mcp`。固定工具包括 `graph_list`、`graph_read`、`graph_create`、`graph_select`、`graph_validate`、`graph_apply`、`graph_undo`、`graph_redo`、`module_status`、`action_list` 和 `action_execute`。

## 安装模块与同步宿主

模块是独立 npm 包，而不是 Core 的隐藏内置功能：

```bash
toporealm module add <npm-package-or-local-path>
toporealm module list
toporealm host sync
```

`host sync` 在当前工作区的 `.codex/`、`.claude/`、`.pi/` 下生成 TopoRealm 所有的宿主资产，并保留没有 TopoRealm 所有权标记的用户文件。模块卸载后，缺少模块的图仍能无损读取原有数据，但不能声称完成领域级完整校验。

### 模块信任边界

v0.1 只加载用户主动安装的可信本地代码，不提供第三方代码沙箱或远程模块市场。模块可以提供由 Core 调用的领域操作实现，但没有图存储写权限；所有图变更只能以 `MutationPlan` 形式交给 Core 校验并提交。Core 是受支持契约中唯一写入图事实来源的组件。

## 基础 Skills

| Skill | 作用 |
|---|---|
| `toporealm` | 识别当前工作区、图和模块，把请求路由到基座或合适的模块 Skill。 |
| `toporealm-design` | 设计领域中立的对象、关系、能力组合、图层与可读性。 |
| `toporealm-join` | 新会话只读了解图的范围、模块、主要对象和近期变化。 |
| `toporealm-grilling` | 与用户对齐需求、识别真实意图，并在关键产品或协议歧义处逐问收敛。 |

这些 Skills 不替代领域模块决定业务对象、生命周期或完成规则。

## 作为库使用

```ts
import { GraphStore } from "@lukawi/toporealm/core";
import type { MutationPlan } from "@lukawi/toporealm/module-sdk";
```

公开子路径还包括 `cli`、`mcp`、`server`、`web` 和 `distribution`。完整术语见 [CONTEXT.md](CONTEXT.md)，稳定契约见 [v1 冻结清单](docs/architecture/v1-freeze.md)。

## 开发与验证

```bash
npm install
npm --prefix web-ui install
npm run verify
git diff --check
```

`npm run verify` 覆盖类型检查、Core/CLI/MCP/模块/宿主测试、Web 类型与组件测试，以及从真实 npm tarball 安装后的 CLI、MCP 和 Web smoke。CI 在 Windows、macOS、Linux 的 Node.js 20 上运行同一套门禁。

## 许可证

[MIT](LICENSE)
