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
    version: 1.1.0

  mystudy:
    source: workspace
    path: modules/my-study

  exploration-dev:
    source: path
    path: ../exploration-module
```

`source` 首版只支持 `global`、`workspace` 和 `path`。`workspace` 与 `path` 均使用相对于 `.toporealm/` 的路径；解析后必须读取目标目录中的 `module.yaml`。同一个绑定只能指向一个完整模块来源。

## 模块读取顺序

对于 `graph.yaml` 中声明的每个模块，基座按以下顺序读取：

1. 读取图中的模块 ID、命名空间和数据模式版本；
2. 在工作区 `modules.yaml` 中查找该模块的显式绑定；
3. 将绑定解析为全局版本目录、工作区模块目录或外部开发目录；
4. 读取对应 `module.yaml`；
5. 核对模块身份、命名空间与数据模式兼容性；
6. 注册该模块声明的 Schema、操作、UI、Skills 和可选运行时。

绑定不存在、目标不可读或数据模式不兼容时，该模块视为不可用，图进入已定义的缺失模块降级模式。基座必须报告具体解析来源和失败原因。

## 尚待确定

- `module.yaml` 的最小字段与贡献索引方式；
- 模块依赖与版本约束；
- 类型、能力和操作的注册及冲突规则；
- 声明式校验、操作与可信代码钩子的边界。
