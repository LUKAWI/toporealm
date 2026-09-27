---
name: toporealm
description: TopoRealm 本地图工作空间的 CLI 使用方法：建图/选图、增删改查、撤销、模块命令、技能索引。当用户要求管理图、任务拓扑、对象关系，或会话中出现 TopoRealm daemon/workflow 时使用。
---

# TopoRealm CLI 使用指南

TopoRealm 是单属主 daemon 的本地图工作空间：**所有读写经 CLI，客户端绝不直接写图文件**。
图的 YAML 与提交日志是唯一事实，daemon 是唯一写者。

## 会话入场（图入场）

1. `toporealm status` — 当前图、revision、undo/redo 可用性、已装载模块。
2. `toporealm read` — 全图读取（对象+关系）；`toporealm read <id>` — 单点邻域。
3. `toporealm log -n 20` — 近期提交（变更审计与「谁改了什么」的主要来源）。
4. `toporealm skills index` — 可用模块技能清单（技能名/模块/描述/**SKILL.md 绝对路径**）；
   任务匹配某技能描述时，用 Read 加载该路径全文再行动。

## 变更缝（三个动词学一次，处处使用）

- `toporealm add <kind> [--id X] --payload '<json>'` — 新建对象。
- `toporealm set <id> k=v --payload '<json>'` — 浅合并载荷（k=null 删键）。
- `toporealm link <src> <tgt> --kind <ns.rel>` — 建关系（端点必须存在）。
- `toporealm rm <id>` — 删除（悬空边会拦截并点名 fix）。
- 写操作的人类输出都带 `[图名]` 前缀——先看图名再确认结果，防误伤。

## 图与专注

- `toporealm creategraph <名>` 建图；`toporealm use <名>` 选定图。
- 编辑缺省作用于**选定图**；多图工作区中其它图在 WebUI 中为只读预览。

## 撤销与历史

- `toporealm undo [N]` / `redo [N]` — 撤销是用户的手，模块门禁不得拦（领域钩子豁免）。
- 提交日志即审计：不确定就先 `log`。

## 模块命令

- `toporealm cmds [--module ns]` — 命令目录（永远等于注册事实；did-you-mean 的真相源）。
- 模块命令形如 `<ns.name> [target] --input '<json>'`，例如 workflow 模组的 `wf.create-task`。

## 机器可读

- 一切动词加 `--json`：成功 `{ok:true,data,revision?,instanceId?}`，失败 `{ok:false,error}`。
- 退出码：0 成功 · 1 领域错误（读 fix/hint 换方式重试）· 2 用法错误。
- 错误信息里的 fix/hint 是可执行的修正建议。

## 工作区布局（1.1）

- `.toporealm/graphs/<图名>/` — 图存储（YAML + 提交日志，可入库）。
- `.toporealm/modules/<模块>/` — 项目池；`~/.toporealm/modules/` — 全局池（所有项目生效）。
- `toporealm init` — 初始化工作区；`TOPOREALM_HOME` / `TOPOREALM_ROOT` / `TOPOREALM_GRAPH` 覆盖解析。
