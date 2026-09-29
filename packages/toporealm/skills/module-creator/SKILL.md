---
name: module-creator
description: TopoRealm 模块创建指南：从 modules-template 模板起步创建一个新模块——命名规则、module.yaml 声明层、activate 可注册面（命令/钩子/表单）、自包含构建、安装与验证。当用户要求创建 TopoRealm 模块/插件、脚手架模块，或询问模块结构时使用。
---

# TopoRealm 模块创建指南（module-creator）

从基座自带模板起步：模板位于聚合包内 `template/modules-template/`
（全局安装形态 = `$(npm root -g)/@lukawi/toporealm/template/modules-template`；
本仓库内 = `packages/toporealm/template/modules-template`）。**复制它，不要从零手写**——
模板覆盖了模块所有可能板块，带完整注释。

## 七步创建

1. **复制**：`cp -r <模板路径> /path/to/your-module`（复制到你自己的仓库，别留在
   toporealm 仓里；`node_modules` 不要复制）。
2. **改名**：`module.yaml` 改 `id`（全局唯一 kebab-case）、`namespace`
   （全局唯一短小写，成为 kind/命令前缀）；`package.json` 改 `name`/`description`。
   命名冲突 = 装载期命名空间冲突 / 安装期 ID_EXISTS。
3. **词汇表**：`kinds.objects/relations` 填你在图里的主类型（实际 kind =
   `<namespace>.<主类型>`）。词汇**只增不删**（删除会让已入图数据成孤儿）。
4. **写 activate**（`src/index.ts`）：按需注册——
   - `api.command({name,title,target?,input}, handler)`：命令（目录 id =
     `<namespace>.<name>`；`title` 必填——agent 的唯一文档，要写明输入键；
     `input` 是 JSON Schema 说明书，强烈建议写；`target` 绑定实体类型或全局）。
   - `api.hook("before-commit", fn)`：领域门禁——可 veto（返回 `{veto: 理由}`）；
     对一切来源生效；`conversion === "undo"|"redo"` 时豁免（撤销是用户的手）。
   - `api.hook("after-commit", fn)`：响应式追加，可 `api.commit`（排队，不嵌套）。
   - `api.form(kind, {fields})`：WebUI inspector 载荷表单。
   - handler 内用 `api.commit/read/get/byKind`（同步内存态）；commit 以
     `module:<id>` 来源过所有权法——**只能触碰自己 namespace.* 或公共/无主 kind**。
5. **模块技能**：`skills/<name>/SKILL.md` 教你的命令与领域规则（frontmatter 只要
   `name`+`description`；技能随模块进池，`toporealm skills index` 对 agent 可见）。
6. **构建**：`npm install && npm run build`。红线：`dist` 自包含——模块 SDK 只
   `import type`（emit 后擦除），否则 daemon 装载会因缺 node_modules 失败。
7. **安装与验证**：
   - `toporealm module add <目录>`（path 来源，开发期）或 `npm pack` 后装 tgz；
     `--global` 进全局池。装了就生效（下次触达自动换载），没有第三步启用动作。
   - 验证清单：`toporealm cmds --module <ns>`（目录=注册事实）→ `toporealm skills
     index`（技能可见）→ 跑一条命令 → 故意触发一次 veto（确认门禁与
     `details.vetoes[].module`）→ `toporealm undo`（确认豁免）→ WebUI 看画布颜色/图标。

## 呈现声明：ui.kinds.represent

module.yaml 的 `ui` 段支持 per-kind 呈现声明 `ui.kinds: { <kind>: { represent: ... } }`，
告诉 WebUI 怎么渲染你的 kind（core 不解释 represent，只影响投影渲染，不影响图事实）：

- `represent: "container"` — 该 kind 渲染为**容器分区**（组织性类目）；成员 = 指向它的
  公共归属边 `member_of`（方向恒为 成员 → 类）。
- `represent: "annotation"` — 渲染为**宿主角标或附属侧栏**（备注类对象）。
- 不声明 = 普通节点渲染（向后兼容，既有模块无需改动）。

## 纪律红线（装载与执法边界）

- 双层：module.yaml 只管协调，**不是执法依据**；行为全在 activate；注册面 activate
  返回后冻结（迟到注册 = LATE_REGISTRATION）。
- 钩子内禁止 commit（REENTRANT_COMMIT）；core 执法只有所有权法 + 悬空边两条，
  你的领域规则全部走 before-commit 钩子。
- 错误码封闭集：模块领域错误抛 `{code, message}` 鸭子形状由宿主认领，码只用既有集合。
- 同名两套职责别混：`module.yaml` 的 `kinds` 是图数据词汇；`input` schema 是命令输入
  契约——都要写，agent 靠它们干活。

## 发布（可选）

`prepack` 已接 build；`files` 只带 `dist`/`module.yaml`/`skills`/`README.md`。
包名可与模块 id 不同；包根 `package.json` 可用 `"toporealm": "<清单相对路径>"`
重定向清单位置（缺省 = 包根 module.yaml）。发布后用户 `toporealm module add <npm 包名>` 即装。

## 模板路径速查

| 安装形态 | 模板位置 |
|---|---|
| 全局 npm（最常见） | `$(npm root -g)/@lukawi/toporealm/template/modules-template` |
| 本仓库开发 | `packages/toporealm/template/modules-template` |
