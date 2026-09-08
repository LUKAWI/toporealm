# TopoRealm 模块契约

状态：v1 已冻结。本文记录 TopoRealm v1 的模块协议。

## 已确认：模块装载单元

每个模块是一个自包含目录，`module.yaml` 是基座识别模块的唯一入口。基座不依赖目录名或扫描约定猜测模块能力。

```text
research/
├─ module.yaml
├─ schemas/
├─ runtime/
├─ ui/
└─ skills/
```

除 `module.yaml` 外，其余目录均按模块贡献选用。简单模块可以只有清单和 Schema；复杂模块可以逐步增加可信本地运行时、Web UI 贡献和 Skills。清单内路径均以模块目录为基准解析。

模块必须作为完整单元解析。同一模块不能从一个来源读取 Schema、再从另一个来源拼入运行时或 UI。

## 已确认：三级模块结构

TopoRealm 区分全局可用、工作区绑定和图级启用：

1. **全局安装**：模块位于 `$TOPOREALM_HOME/modules/<module-id>/<version>/`，可供本机多个工作区选择；
2. **工作区绑定**：`.toporealm/modules.yaml` 明确当前工作区为某个模块选择全局版本、工作区内目录或显式外部开发目录；
3. **图级启用**：`graph.yaml` 声明本图使用的模块身份、命名空间和数据模式。

工作区内模块统一放在 `.toporealm/modules/`：

```text
<workspace>/
└─ .toporealm/
   ├─ modules.yaml
   ├─ modules/
   │  └─ my-study/
   │     └─ module.yaml
   └─ graphs/
      └─ <graph-id>/
         └─ graph.yaml
```

`.toporealm/modules.yaml` 使用显式绑定，不采用静默的“工作区覆盖全局”规则：

```yaml
bindings:
  research:
    source: global
    version: 1.1.0

  mystudy:
    source: workspace
    path: modules/my-study

  exploration-dev:
    source: path
    path: ../exploration-module
```

`source` 首版只支持 `global`、`workspace` 和 `path`。`global` 按模块身份和准确版本定位 TopoRealm 用户目录中的已安装模块；`workspace` 通过 `path` 定位 `.toporealm/modules/` 中的模块；`path` 来源用于显式外部开发目录。相对路径以 `.toporealm/` 为基准。解析后必须读取目标目录中的 `module.yaml`，同一个绑定只能指向一个完整模块来源。

## 模块读取顺序

对于 `graph.yaml` 中声明的每个模块，基座按以下顺序读取：

1. 读取图中的模块 ID、命名空间和数据模式版本；
2. 在工作区 `modules.yaml` 中查找该模块的显式绑定；
3. 将绑定解析为全局版本目录、工作区模块目录或外部开发目录；
4. 读取对应 `module.yaml`；
5. 核对模块身份、命名空间与数据模式兼容性；
6. 注册该模块声明的 Schema、操作、UI、Skills 和可选运行时。

绑定不存在、目标不可读或数据模式不兼容时，该模块视为不可用，图进入已定义的缺失模块降级模式。基座必须报告具体解析来源和失败原因。

## 已确认：模块清单的职责

`module.yaml` 只保存模块元数据和贡献索引。对象类型、关系类型、能力、操作、Web UI 和 Skills 的完整定义使用独立文件或目录，首版不支持把完整定义内联到清单中。

```yaml
format: toporealm.module/v1
id: research
namespace: research
version: 0.1.0

supports:
  schemas: [1]

contributes:
  object_kinds:
    - id: question
      schema: schemas/objects/question.yaml
    - id: source
      schema: schemas/objects/source.yaml

  relation_kinds:
    - id: supports
      schema: schemas/relations/supports.yaml

  capabilities:
    - id: confidence
      schema: schemas/capabilities/confidence.yaml

  operations:
    - id: expand-question
      declaration: operations/expand-question.yaml

runtime:
  entry: runtime/index.js

ui:
  contribution: ui/contribution.yaml

skills:
  directory: skills/
```

`format`、`id`、`namespace`、`version` 和 `supports.schemas` 是模块清单的基础身份字段。其余字段按实际贡献省略。每项贡献在清单中登记模块内局部 ID 和相对路径；完整身份由模块命名空间与局部 ID 组合，例如 `research.question`。

基座先读取清单以建立贡献注册表，再按实际操作加载相应定义。所有路径必须留在已解析模块目录内。清单中未登记的文件不构成模块贡献。

使用单一引用形式可以避免内联定义与文件定义的覆盖顺序、迁移方式和错误位置出现两套规则。最小模块因此至少包含一个 `module.yaml` 和其登记的定义文件。

## 已确认：最小模块依赖模型

模块可以在 `module.yaml` 中声明硬依赖及其 SemVer 兼容范围：

```yaml
requires:
  modules:
    - id: temporal
      version: ">=1.0.0 <2.0.0"
```

模块依赖表达运行时和贡献契约的兼容要求，与 `graph.yaml` 中约束持久化数据格式的 `schema` 分开。工作区必须在 `.toporealm/modules.yaml` 中为每项依赖显式选择准确版本或路径；TopoRealm 只检查已绑定模块是否满足范围，不执行自动下载或版本求解。

启用依赖方模块的图也必须显式启用其所有依赖。基座不得因加载一个模块而静默激活另一个模块。依赖图必须无环，并按拓扑顺序完成解析和注册。

硬依赖缺失、未在图中启用或版本不兼容时，依赖方模块整体视为不可用，图进入相应降级模式。其他已正确解析的模块不受影响。

首版不提供可选依赖、条件贡献、远程依赖解析和自动安装。模块自身运行时代码使用的普通程序库不属于 TopoRealm 模块依赖；对外分发模块必须在发布前把这些依赖打入可直接装载的运行时或 UI bundle。

## 已确认：npm 只作为获取渠道

模块的统一格式始终是包含 `module.yaml` 的自包含纯文件目录。npm 只提供包发布与 tarball 获取能力，不定义第二种模块格式，也不成为安装后的运行目录。

统一安装入口为 `toporealm module add`：

```powershell
# 默认安装到当前工作区
npx @toporealm/cli module add npm:@toporealm/research@1.2.0

# 安装到用户级模块目录
npx @toporealm/cli module add npm:@toporealm/research@1.2.0 --global
```

安装器使用 `npm pack --ignore-scripts` 获取 tarball，在临时目录解包，校验 `package.json`、`module.yaml` 及全部登记文件，然后原子移动到目标目录：

```text
工作区：<workspace>/.toporealm/modules/<module-id>/
用户级：$TOPOREALM_HOME/modules/<module-id>/<version>/
```

安装后不保留专属或宿主项目的 `node_modules`。npm 模块、压缩包模块和用户手写模块进入同一套清单校验、贡献注册和宿主投影流程。安装器只为受管模块保留轻量来源记录，用于更新和卸载；没有该记录的用户手写目录不会被安装器覆盖或删除。

```yaml
bindings:
  research:
    source: workspace
    path: modules/research

  exploration:
    source: global
    version: 1.1.0

  mystudy:
    source: workspace
    path: modules/my-study
```

npm 包的 `package.json` 必须使用 `toporealm` 字段指向模块清单，并把清单引用的全部文件包含在发布内容中：

```json
{
  "name": "@toporealm/research",
  "version": "1.2.0",
  "type": "module",
  "toporealm": "./module.yaml",
  "files": [
    "module.yaml",
    "schemas",
    "operations",
    "runtime",
    "ui",
    "skills"
  ]
}
```

包版本必须与 `module.yaml` 中的模块版本一致。模块清单还必须声明兼容的 TopoRealm API 范围。可选运行时必须以可直接加载的 JavaScript 发布，首版不在装载阶段编译 TypeScript。

发布包必须自包含：`runtime/index.js` 已编译并打包普通 JavaScript 依赖，Web UI 扩展也是可直接装载的 bundle。首版允许使用 Node 内置模块，但不支持运行时依赖外部 `node_modules`、安装阶段编译、安装脚本或原生二进制依赖。其他 TopoRealm 模块依赖仍由 `module.yaml` 和工作区显式绑定管理。

用户发布的 npm 模块、官方 npm 模块和纯文件模块拥有相同注册能力，来源只影响获取、更新、卸载和来源信息。Codex、Claude 与 Pi 可以提供宿主便捷命令，但都调用同一个 TopoRealm 安装核心；模块不能提供自己的安装脚本。

## 已确认：两阶段分类注册

模块从“工作区可用”到“在某张图生效”分为两个阶段：

1. `WorkspaceModuleResolver` 根据工作区绑定解析模块来源、准确版本、清单和依赖，形成已解析模块目录；
2. `GraphActivator` 根据 `graph.yaml` 的显式启用项，生成该图专属、不可变的 `GraphRegistrySnapshot`。

注册快照按贡献职责分为对象类型、关系类型、能力、校验器、操作和 UI 等类别。贡献 ID 只要求在所属类别内唯一，完整身份仍由模块命名空间与局部 ID 组成；不同类别可以使用相同局部 ID，不使用一个跨类别扁平 ID 空间。

单个模块的贡献必须原子注册。清单、依赖、定义或冲突检查失败时，该模块不留下任何部分贡献，并进入不可用状态；其他没有依赖它且能正确解析的模块仍可进入快照。依赖方在依赖不可用时也整体不可用。

注册快照带修订号，并在一次 Core、CLI、MCP 或 Web UI 请求期间保持不变。模块绑定、模块文件或图级启用发生变化后，基座生成新快照，不就地修改旧快照。运行时代码只能为清单已登记的校验器和操作绑定实现，不能修改注册表或登记清单外贡献。

## 已确认：版本兼容不静默迁移

`graph.yaml` 声明的是模块数据模式版本。安装或升级模块不能自动改写图；新模块版本只有在明确支持图中模式时才能提供完整解释和编辑能力。不兼容时，图进入模块不可用的降级读取状态，原数据保持不变。

v1 不预先建设通用 Schema 迁移框架。首次出现真实的新数据模式需求时，再为该模块设计显式迁移动作；迁移必须由用户主动触发并通过 Core 的正常变更入口执行。

## 已确认：模块故障局部隔离

单个模块装载失败时，该模块整体不可用，但 Core 和其他无依赖模块继续工作。某次运行时动作抛错只使该动作失败，不永久禁用模块；模块数据继续按缺失模块规则无损读取。

自定义 UI 插槽使用独立错误边界，扩展崩溃后回退到通用对象和关系界面。首版不增加熔断器、健康评分或可配置自动重试系统。

## 已确认：MCP 固定工具与动作引用

MCP 顶层工具表由基座定义并保持稳定，首批工具围绕读取图、读取实体、查询、校验、读取模块状态、发现动作和执行动作设计。模块不动态增加 MCP 工具，而是贡献操作声明及其处理器。

查询实体或动作时，基座可以返回动作引用（Action Reference）：

```yaml
operation: research.expand-question
target: question-17
registry_revision: 42
input_schema: research.expand-question/input-v1
input_template:
  depth: 2
```

`execute_action` 在调用模块运行时前统一检查：模块是否可用、操作是否仍存在、操作是否适用于目标、输入是否符合声明，以及动作引用的快照修订号是否仍有效。失败使用稳定错误代码并附恢复提示：

- `MODULE_UNAVAILABLE`
- `ACTION_NOT_FOUND`
- `ACTION_NOT_APPLICABLE`
- `INVALID_INPUT`
- `STALE_ACTION`
- `RUNTIME_FAILED`

实体和查询响应可以附带适用动作，减少 agent 为发现操作而额外调用。返回内容应支持只取动作摘要或按需读取完整输入模式，避免大型图把 MCP 上下文撑大。

Super Plumber 迁移期间保留已有命名 MCP 工具作为兼容适配器；适配器调用同一操作核心，不形成第二套领域实现。待实际迁移验证 agent 兼容性后，再决定旧工具的退役范围。

## 已确认：可信运行时与图写入边界

声明式定义负责贡献身份、Schema、适用条件、输入输出和界面元数据。可选可信运行时只能为 `module.yaml` 已登记的校验器和操作绑定处理器，不能在运行时新增或修改贡献。

校验器是只读函数。查询、推荐和导出操作可以返回结构化结果或产物；需要改变图的操作必须返回声明式 `MutationPlan`，例如：

```yaml
operations:
  - op: object.update
    target: question-17
    patch:
      data.status: explored
  - op: relation.create
    value:
      id: supports-23
      kind: research.supports
      source: source-8
      target: question-17
      direction: directed
```

Core 是受支持契约中唯一写入图事实来源的组件。它在应用变更计划前统一完成输入与适用性检查、计划结构和模块 Schema 校验、引用检查与并发控制，再原子写入并记录事件。失败时不得留下部分计划结果。

人或 agent 可以在一次编辑中修改多个已装载模块拥有的数据。Core 按命名空间把计划中的各部分交给所属模块校验；全部通过后才把整个计划作为一个原子编辑和一个撤销单位提交。模块运行时代码不能绕过 Core 直接写图，也不能替代其他模块解释其私有字段。

可信本地 JavaScript 首版不提供代码沙箱。运行时直接使用文件系统修改图文件属于契约外行为，不获得事务、校验、并发控制和事件记录保证；TopoRealm 可以把检测到的此类变化视为外部编辑并重新装载，但不承诺恢复其语义正确性。

为控制 agent 上下文成本，MCP 默认返回变更计划摘要，包括变更数量、涉及实体、校验结果和事件身份；只有预览、诊断或显式请求时才返回完整计划。动作发现默认返回名称、目标、简短说明和输入模板，完整 Schema 按需读取。

## 已确认：最小副作用声明

操作只使用一个可选字段声明图外写入：

```yaml
id: export-notes
effects: artifact
```

`effects` 只有三个取值，省略时默认为 `none`：

- `none`：不产生图外写入；外部数据读取也归入此类；
- `artifact`：向 TopoRealm 管理的产物位置写出文件；
- `external`：对外部系统产生不能由 Core 原子回滚的变化。

动作发现、预览和执行结果必须显示非 `none` 标识。Core 对受管产物和外部执行结果记录事件，但只对 `MutationPlan` 与受管产物提供统一写入保证，不能承诺回滚 `external` 操作。

首版不增加权限矩阵、逐资源声明、回滚策略或多层副作用参数。模块自行保证外部操作必要的幂等性并报告结果；只有实际模块证明三分类不足时，才通过后续协议版本扩展。

## 尚待确定

- 无。模块清单与运行时契约可进入实现验证。
