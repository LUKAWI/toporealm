# TopoRealm 模块契约

状态：讨论中。本文随 `toporealm-foundation/l1_module_contract` 的逐项决策更新。

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
    package: "@toporealm/research"
    version: 1.1.0

  mystudy:
    source: workspace
    path: modules/my-study

  exploration-dev:
    source: path
    path: ../exploration-module
```

`source` 首版只支持 `global`、`workspace` 和 `path`。`global` 和 `workspace` 可以通过 `package` 定位 TopoRealm 管理的 npm 包，`workspace` 也可以通过 `path` 定位 `.toporealm/modules/` 中的纯文件模块；`path` 来源用于显式外部开发目录。相对路径以 `.toporealm/` 为基准。解析后必须读取目标目录中的 `module.yaml`，同一个绑定只能指向一个完整模块来源。

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
format: toporealm.module/v1alpha1
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

首版不提供可选依赖、条件贡献、远程依赖解析和自动安装。模块自身运行时代码使用的普通程序库不属于 TopoRealm 模块依赖，由其分发载体负责提供。

## 已确认：npm 分发与安装

模块的统一格式始终是包含 `module.yaml` 的纯文件目录。npm 是可选的分发和安装载体，不定义第二种模块格式。npm 包解析完成后，其包根目录与工作区纯文件模块进入完全相同的清单校验和贡献注册流程。

TopoRealm 为 npm 模块使用独立于宿主项目的安装环境：

```text
<workspace>/.toporealm/packages/
├─ package.json
├─ package-lock.json
└─ node_modules/

$TOPOREALM_HOME/packages/
├─ package.json
└─ node_modules/
```

基座不扫描宿主项目根目录中的普通 `node_modules`。`source: workspace` 的包只从工作区专属环境解析，`source: global` 的包只从全局专属环境解析。

```yaml
bindings:
  research:
    source: workspace
    package: "@toporealm/research"
    version: 1.2.0

  exploration:
    source: global
    package: "@toporealm/exploration"
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

模块运行时使用的普通 JavaScript 依赖由 `package.json` 管理；其他 TopoRealm 模块依赖仍由 `module.yaml` 和工作区显式绑定管理。用户发布的 npm 模块、官方 npm 模块和纯文件模块拥有相同注册能力，来源只影响安装、更新和来源信息。

## 已确认：两阶段分类注册

模块从“工作区可用”到“在某张图生效”分为两个阶段：

1. `WorkspaceModuleResolver` 根据工作区绑定解析模块来源、准确版本、清单和依赖，形成已解析模块目录；
2. `GraphActivator` 根据 `graph.yaml` 的显式启用项，生成该图专属、不可变的 `GraphRegistrySnapshot`。

注册快照按贡献职责分为对象类型、关系类型、能力、校验器、操作和 UI 等类别。贡献 ID 只要求在所属类别内唯一，完整身份仍由模块命名空间与局部 ID 组成；不同类别可以使用相同局部 ID，不使用一个跨类别扁平 ID 空间。

单个模块的贡献必须原子注册。清单、依赖、定义或冲突检查失败时，该模块不留下任何部分贡献，并进入不可用状态；其他没有依赖它且能正确解析的模块仍可进入快照。依赖方在依赖不可用时也整体不可用。

注册快照带修订号，并在一次 Core、CLI、MCP 或 Web UI 请求期间保持不变。模块绑定、模块文件或图级启用发生变化后，基座生成新快照，不就地修改旧快照。运行时代码只能为清单已登记的校验器和操作绑定实现，不能修改注册表或登记清单外贡献。

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

## 尚待确定

- 声明式校验、操作与可信代码钩子的边界。
