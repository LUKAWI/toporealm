# TopoRealm｜拓境

**以拓扑关系为核心的 agent 效率与流程管理工具：极简核心（单属主 daemon + CLI + 实时 WebUI）+ 高度自定义的双层模块系统。**

一张本地图，人与 agent 共同读写：人在终端与浏览器，agent 经 CLI/skills——全部打到同一个常驻 daemon，每笔变更实时互见、可撤销、可审计。

设计灵感是 [pi](https://github.com/badlogic/pi-mono)：最小的核心、体系化的扩展、一份人与 agent 共享的本地图数据。

## 安装

```bash
npm install -g @lukawi/toporealm        # toporealm（CLI）+ toporeald（daemon）两个 bin
```

要求 Node ≥ 20.6。第三方集成可单独安装 `@lukawi/toporealm-client`。

## 快速上手

```bash
toporealm new mygraph                  # 新建图并选中（工作区 = 当前目录）
toporealm add wf.task --id t-1 --payload '{"title":"写蓝图","status":"todo"}'
toporealm add wf.task --id t-2 --payload '{"title":"评审蓝图"}'
toporealm link t-1 t-2 --kind wf.blocks
toporealm find status=todo             # 按载荷浅等值查找
toporealm set t-1 status=doing         # daemon 端浅合并；k=null 删键
toporealm serve                        # 打开 WebUI：实时同步，无刷新互见
toporealm undo                         # 一切皆可撤销（含外部编辑）
```

任何命令触达时 daemon 透明自动拉起，空闲自动退出；浏览器、多个终端会话同图实时串通。

## 装上领域模块，能力即命令

```bash
toporealm module add @lukawi/toporealm-workflow    # 安装 workflow 领域模块
toporealm cmds                                     # 目录自省：wf.* 命令即顶层子命令
toporealm wf.create-task --input '{"title":"首发任务"}'
toporealm host sync --host all                     # 为 Claude Code / Pi 生成 skills 与钩子投影
```

模块是双层结构：`module.yaml` 声明身份/命名空间/词汇（管协调），`activate(api)` 注册命令、表单与钩子（管行为）。core 只执法两条——**所有权法**（模块只能写自己命名空间下的主类型）与**悬空边检查**；领域规则全部是模块的 before-commit 钩子（带变更前后双快照，可署名否决一切来源的提交）。写你自己的模块：装 [`@lukawi/toporealm-module-sdk`](https://www.npmjs.com/package/@lukawi/toporealm-module-sdk) 看类型即可。

## 给 agent 的话

- 所有命令恒定 `--json` 信封（成功含 `data/revision/instanceId`；失败含 `code/message/hint/fix`），退出码 `0/1/2`，错误自带可整句复制执行的修复命令，打错 id 给 did-you-mean。
- agent 主干路径预算：`status → find → set → link → set → log` ≈ 6 条命令。
- `toporealm host sync` 为 Claude Code（plugin）与 Pi（extension/skills）生成基座与模块的 skills 投影。

## 架构与文档

一句话：**人经 CLI、agent 经 CLI+skills、浏览器经 WS，全部打到一个单属主 daemon；模块是装载进 daemon 的双层扩展；core 只执法两条。**

| 包 | 职责 |
|---|---|
| `@lukawi/toporealm` | 聚合发布物（本包：toporealm + toporeald 两个 bin） |
| `@lukawi/toporealm-cli` | ~16 动词、`--json` 信封、退出码、did-you-mean |
| `@lukawi/toporealm-daemon` | 可执行入口：IPC/Web 伺服、自动拉起、空闲退出、instanceId |
| `@lukawi/toporealm-daemon-core` | 提交管线、内存图态、YAML 存储、提交日志、undo 游标、文件监视 |
| `@lukawi/toporealm-client` | DaemonClient 三实现：Memory / IPC / WS |
| `@lukawi/toporealm-module-host` / `-module-sdk` | 模块装载与作者类型 |
| `@lukawi/toporealm-web` / web-ui | HTTP+WS 伺服与 Svelte 5 + D3 前端 |
| `@lukawi/toporealm-distribution` | 模块安装器、host sync、migrate |

| 内容 | 位置 |
|---|---|
| 设计哲学 | [Toporealm设计构想.md](Toporealm设计构想.md) |
| 1.0 蓝图（实现规范） | [docs/rebuild/blueprint.md](docs/rebuild/blueprint.md) |
| 统一术语 | [CONTEXT.md](CONTEXT.md) |
| 架构决策 | [docs/adr/](docs/adr/) |
| 项目状态 | [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md) |
| 变更历史 | [CHANGELOG.md](CHANGELOG.md) |

> **库消费方注意**：各 `-*` 子包当前以 TS 源直发（`main`/`exports` 指向 `src/*.ts`），库形态消费需 TS 运行支持；CLI/daemon bin 已内置 tsx 加载，装完即用。
>
> **0.x 已归档**：npm `@lukawi/toporealm@preview`（最高 0.1.3）不再演进，完整代码与文档保留于 `v0.1.x` 标签与 [GitHub Releases](https://github.com/LUKAWI/toporealm/releases)。旧图经 `toporealm migrate` 一次性迁移。0.x→1.0 语义对照见 [Toporealm代码库现状.md](Toporealm代码库现状.md)。

English: [README.en.md](README.en.md)

## 许可证

[MIT](LICENSE)
