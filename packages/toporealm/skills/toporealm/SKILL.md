---
name: toporealm
description: TopoRealm 图工作空间的 CLI 操作手册——建图选图、增删改查、撤销重做、模块能力动态发现。凡会话涉及图工作空间、TopoRealm、建图、任务拓扑、对象关系、工作流执行、undo 撤销、模块安装或技能发现——哪怕用户没明说"图"——都按本技能用 toporealm CLI 操作，绝不直接读写图文件。
---

# TopoRealm CLI 使用指南

TopoRealm 是单属主 daemon 的本地图工作空间：**所有读写经 CLI，客户端绝不直接读写图文件**。图的 YAML 与提交日志是唯一事实，daemon 是唯一写者。

本技能只写主包高频动词，**不硬编码任何模块的能力**——模块的 kind/命令/技能随安装而变，一律当场动态发现（见「模块能力发现」）。

## 会话入场

会话涉及图工作 → 先跑三条发现命令，摸清现场再动手：

```bash
toporealm status        # 当前图/revision/kind 计数/undo redo 可用性/已装载模块/警告
toporealm cmds          # 已装载模块的命令目录（模块命令怎么调以目录为准）
toporealm skills index  # 全池模块技能索引（任务匹配某技能描述就加载它）
```

据此决定接下来用哪些动词、是否需要加载某个模块技能；机器可读加 `--json`。

未初始化目录（无 `.toporealm/`）不是故障：`status`/`cmds` 报 `NO_WORKSPACE`
（exit 1，fix 即建图命令），`skills index` 空输出 exit 0；照 fix 跑
`toporealm creategraph <名>` 即自愈。

图生命周期子命令（工作区文件操作，不触 daemon）：

- `toporealm init` — 初始化项目工作区（建 `.toporealm` + 全局目录 + AGENTS.md 提示）。
- `toporealm creategraph <名> [--label L]` — 新建图并选中（自动初始化工作区）。
- `toporealm use <名>` — 切换选定图；输出会提示 `export TOPOREALM_GRAPH=<名>`（见「多终端」）。
- `toporealm graphs` — 列出工作区全部图（`*` 标当前）。

## 读：read / find

- `toporealm read` — 全图读取（对象+关系）。
- `toporealm read <id>` — 单点邻域：锚实体 + 触达它的全部关系，一次读拿全上下文。
- 过滤读取：`toporealm read --kind <K> --where <k=v> --fields id,status --limit N`
  - `--kind`、`--where` 可重复出现，每次取一个值；`--fields` 逗号或重复写法等价
    （`--fields id,status`），裸键解析为 `payload.<键>`（写 `status` 即 `payload.status`）。
  - **互斥**：过滤旗标与单点 `read <id>` 不能同用（exit 2）——按 kind 过滤请用 find，或去掉 `<id>`。
- `toporealm find <k=v>... [--kind K] [--fields f]` — `read --where` 的糖，发现动词：
  - `toporealm find status=active`；`--kind` 可重复，多 kind 取**并集**：
    `toporealm find status=active --kind <K1> --kind <K2>`。
  - 0 命中不是错误。先 find 确认存在，再决定写什么。

## 写：四个动词，处处使用

写命令作用于解析出的当前图（`--graph` 旗标 > `TOPOREALM_GRAPH` 环境变量 > `use` 选定图）。写动词（add/set/link/rm/undo/redo）与模块命令的人类输出带 `[图名]` 前缀——**先看图名再确认结果**，多图工作区防误伤（读侧 read/find/status/log/cmds 无此前缀）。

- `toporealm add <kind> [--id X] [--payload '<json>']` — 新建对象，回显 created id；
  不给 `--id` 时 daemon 生成（`<主类型尾段>-<8位hex>` 形），一律以回显为准。
- `toporealm set <id> [k=v]... [--payload '<json>'] [--replace]` — 浅合并载荷；
  `k=null` 删键；`--replace` 整体替换（需给完整载荷）。k=v 的值按 JSON 解析，非 JSON 按字符串。
- `toporealm link <src> <tgt> [--kind ns.rel] [--id X]` — 建关系，端点必须存在
  （端点缺失时可与创建放同一提交）。图中只有一种关系类型时可省 `--kind`；
  **首条关系必须显式 `--kind`**（空图没有类型可推断）。
- `toporealm rm <id>` — 删除；仍有关系引用时被拦（DANGLING_RELATION 点名关系 id 并给 fix）：
  先 `toporealm rm <关系id>` 再删本实体。

## 容器类（represent 声明 + member_of）

模块在 module.yaml 声明 `represent: "container"` 的对象种类是**容器**（组织性类目，
如 workflow 模块的 `wf.domain`）：容器就是普通对象，靠公共归属关系 `member_of` 聚合成员。
**方向恒为 成员 → 类**（`link <成员id> <容器id> --kind member_of`）——**方向纯靠约定：
member_of 是公共类型（无命名空间前缀，跨模块共用），core 只查端点存在，两端不做任何领域校验**，
写反了不会报错，WebUI 的容器分组却会错位。

完整命令链（把任务 task-42 归入「认证域」容器）：

```bash
toporealm add wf.domain --id auth --payload '{"title":"认证域"}'   # 建容器（本质是普通对象）
toporealm link task-42 auth --kind member_of                       # 成员在前，类在后
toporealm read --kind member_of                                    # 按归属关系过滤
toporealm set auth title="认证域（后端）"                           # 容器照常 set
toporealm rm auth                                                  # 删容器：仍有成员关系引用时被拦（DANGLING_RELATION）——core 无级联删除，先逐条 rm 成员关系再删容器
```

附属对象（备注类）同理：`represent: "annotation"` 的 kind 渲染为宿主角标或附属侧栏，
仍是普通对象 + 需要的边；不声明 `represent` = 普通节点。

## 批注与人工确认（审阅回路）

用户在 WebUI 审阅拓扑后写的**批注**是公共 kind `annotation` 的普通对象（基座约定，
D48）：payload 带目标锚定（`target: {scope, ref}`，scope ∈ node/kind/graph）、内容
（`body`）、意图（`motivation`：comment/question/assessing）与解决状态（顶层布尔
`resolved`）。WebUI 1.5.2 起是**纯审阅界面**（批注 + checkpoint 确认），一切图编辑
在 CLI——用户批注就是审阅意见到达你的主要通道：

- **读未解决批注**：`toporealm find resolved=false --kind annotation`；单条上下文
  `read <批注id>`（`target.ref` 指向被批注的对象/类/整图）。
- **按批注行动**：批注是用户的审阅意见，优先级高于自拟计划；动手前先复述你理解的要点。
- **行动完成后收口**：`toporealm set <批注id> resolved=true resolvedAt=<ISO时间>`；
  误收口用 `toporealm set <批注id> resolved=false resolvedAt=null` 重开（null 删键）。
- **替用户写批注**：`toporealm add annotation --payload '{"title":"…","body":"…",
  "target":{"scope":"node","ref":"<id>"},"resolved":false,"author":"agent"}'`，
  node 锚定再补 `toporealm link <批注id> <宿主id> --kind annotation_of`（方向恒为
  批注 → 宿主，恰一条挂靠边时 WebUI 出宿主角标）。

流程类任务的 **checkpoint 人工确认**：用户在 WebUI 打 √/×，走模块命令（如 workflow
的 `wf.record-checkpoint`，input 带 `actor: "user"` + `by: "user"`）。`human` 档位
checkpoint 的终态**只能由 user 身份确认**——agent 冒充会被领域钩子拦下
（HUMAN_CONFIRMATION_REQUIRED），这是设计使然不是故障；已决策的检查点在 WebUI 只读展示。

## 撤销与历史

- `toporealm undo [N]` / `toporealm redo [N]` — 撤销/重做 N 步。undo 是用户的手，
  模块领域门禁不得拦（钩子豁免）。步数超出可撤/可重做范围时**钳位并报实际步数**。
- `toporealm log [-n N]` — 提交日志尾读（缺省 20）：变更审计与「谁改了什么」的主要来源。
  只显示 undo 游标之前的已生效提交——undo 后 log 变短是预期语义，不是丢数据。
- 拿不准就先 `toporealm status`（当前图/revision/kind 计数/undo redo 可用性/已装载模块/警告），
  再 `log` 对账。

## 模块能力发现（永远动态，不背目录）

模块能力随安装而变——不要假设，当场发现：

- `toporealm cmds [--module ns]` — 当前图已装载模块的命令目录，永远等于注册事实
  （did-you-mean 的真相源）。模块命令形如 `<ns.name> [target] [--input '<json>']`，
  作为顶层子命令调用；具体命令名与必填输入键以目录输出为准。
- `toporealm skills index` — 全池模块技能索引（技能名/模块/描述/**SKILL.md 绝对路径**；
  纯文件层不触 daemon，空索引 exit 0）。任务匹配某技能描述时，用 Read 加载该路径全文再行动。
- 新装/卸载模块无需重启 daemon：模块集摘要在**下次触达**任意 daemon 命令时自动检测换载。

## 机器可读与退出码

- 一切动词加 `--json`：成功 `{ok:true, data, revision?, instanceId?}`；
  失败 `{ok:false, error:{code, message, hint?, fix?, details?}}`。
- 退出码：**0** 成功 · **1** 领域错误（读 `error.hint`/`error.fix` 换方式重试）· **2** 用法错误。
- 错误里的 hint/fix 是可执行的修正建议，照做即可。
- 全局选项：`--root <dir>`、`--graph <id>`；`toporealm help [cmd]` 看单动词用法；`--version` 查版本。

## 多终端：TOPOREALM_GRAPH 锚

每个终端壳有自己的专注图：环境变量 `TOPOREALM_GRAPH` 覆盖工作区选定图。两个终端可在同一工作区各专注一个图互不干扰；`use` 只改工作区选定图，不动其它已开终端的解析结果。壳里锚一次：`export TOPOREALM_GRAPH=<名>`。指向不存在的图会在触达 daemon 时报 GRAPH_NOT_FOUND。`TOPOREALM_ROOT`（项目根）/ `TOPOREALM_HOME`（全局目录，缺省 `~/.toporealm`）同理按进程覆盖路径解析。

## 工作区布局

- `.toporealm/graphs/<图名>/` — 图存储（YAML + 提交日志，可入库）。
- `.toporealm/modules/<模块>/` — 项目池；`~/.toporealm/modules/` — 全局池（所有项目生效）。

## 边界与指路

本技能止步于此；下面的内容去对应技能（同仓随包分发）：

- **低频运维**——`module add/rm/list`、`migrate`（0.x 旧图迁移）、`serve`（WebUI）、
  多图策略、daemon 排障 → 读 `toporealm-ops` 技能。
- **建模原则**——对象 vs 关系怎么选、payload 设计、id 策略、反模式 → 读 `toporealm-design` 技能。
- **写模块**——从模板创建自己的模块 → 读 `module-creator` 技能。
