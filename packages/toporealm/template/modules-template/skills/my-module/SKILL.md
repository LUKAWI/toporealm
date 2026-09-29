---
name: my-module
description: my-module 模块的使用方法：my.add-card 建卡（title 必填，钩子门禁拦截空标题）、my.stats 统计、my.card 表单投影。当用户要在图里建卡/查卡，或会话中出现 my-module 时使用。
---

# my-module 使用指南（模块自带技能——随模块进池，经 `toporealm skills index` 到达 agent）

本技能是模块作者给 agent 的说明书模板：**替换为你模块的真实命令、输入键与领域规则**。

## 命令

- `toporealm my.add-card [card-id] --input '{"title":"...","priority":"mid"}'`
  新建 `my.card`；`title` 必填且只能放 `--input`（位置参数是目标实体 id，不是输入）。
  空标题会被 before-commit 钩子否决（VETOED，`details.vetoes[].module` 点名本模块）。
- `toporealm my.stats` — cards/links 统计。
- `toporealm my.<命令> [target-id] --input '<json>'` — 所有命令的权威清单：
  `toporealm cmds --module my`（目录永远等于注册事实；title 即输入键 schema）。

## 数据与所有权

- 本模块只触碰 `my.card` / `my.links`（module.yaml 词汇表 + 所有权法执法）。
- 钩子对一切来源生效（含人类直接 `toporealm add`）——绕过命令手写数据同样被门禁拦。
- 撤销是用户的手：`toporealm undo` 豁免领域门禁（D24①），钩子不得拦 undo/redo。
- 呈现声明：module.yaml `ui.kinds` 可给 kind 标 `represent: "container"`（WebUI 容器分区，
  成员经公共关系 `member_of` 挂靠，方向恒为 成员 → 类）或 `"annotation"`（宿主角标/附属侧栏）；
  不声明即普通节点。

## 输入纪律

- 写命令人类输出带 `[图名]` 前缀——先看图名再确认结果。
- `--json` 信封：成功 `{ok:true,data}`，失败读 `error.code/fix/hint`（fix 是可执行建议）。
