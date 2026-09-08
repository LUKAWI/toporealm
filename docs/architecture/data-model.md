# TopoRealm 最小数据模型

状态：讨论中。本文随 `toporealm-foundation/l1_data_model` 的逐项决策更新。

## 已确认：事实来源与文件布局

TopoRealm 使用目录式 YAML 作为唯一事实来源。一张图的对象和关系分别按稳定 ID 存入独立文件，图清单只保存图级信息、模块声明和实体目录来源。

```text
.toporealm/
└─ graphs/
   └─ <graph-name>/
      ├─ graph.yaml
      ├─ objects/
      │  └─ <id>.yaml
      └─ relations/
         └─ <id>.yaml
```

采用这一布局是为了同时满足人工编辑、Git 审阅、多 agent 分工和大型图的增量处理。单一大 YAML 文件会集中制造写冲突；数据库作为事实来源会降低人工可读性和版本审阅质量。

## 派生数据

邻接索引、搜索索引、布局坐标和其他加速数据不是事实来源。它们可以使用 JSON、SQLite 或其他适合实现的格式，但必须能够仅根据 YAML 事实源重新生成。删除派生数据不得改变图的业务含义。

## 已确认：图清单的最小结构

`graph.yaml` 声明格式版本、图身份、图中使用的模块数据模式，以及对象和关系的目录来源：

```yaml
format: toporealm.graph/v1alpha1
id: attention-research
label: 注意力机制研究

modules:
  - id: research
    namespace: research
    schema: 1
  - id: exploration
    namespace: exploration
    schema: 1

sources:
  objects: objects/*.yaml
  relations: relations/*.yaml

meta:
  created_at: 2026-09-08T10:00:00+08:00
  updated_at: 2026-09-08T10:00:00+08:00
```

`format`、`id` 和 `sources` 是必填字段；`label`、`modules` 和 `meta` 没有内容时可以省略。每个模块声明包含稳定模块 ID、图中唯一的 `namespace` 和数据模式版本 `schema`。`schema` 不是本机安装的软件包版本；模块运行时只要声明支持该模式版本，就可以解释这些数据。

图清单不逐个列出对象和关系。基座根据 `sources` 发现实体，使不同 agent 新增实体时只创建各自文件，无需共同修改中央清单。首版来源只支持图目录内的相对 glob，暂不引入远程来源。

## 已确认：模块命名空间与自建模块

`kind` 和能力 ID 的第一段是模块命名空间，不是文件扩展名。例如 `research.question` 表示 `research` 模块命名空间中的 `question` 类型，`exploration.unknown` 表示 `exploration` 命名空间中的 `unknown` 能力。

模块命名空间由模块清单声明，并在一张图内保持唯一。对象、关系和能力只通过该命名空间引用模块贡献；命名空间冲突时不得同时激活，首版不增加图内别名机制。

用户自建模块与官方模块使用同一份模块协议。自建模块提供模块清单后，可以通过本地安装或链接进入环境，再由图清单激活。简单模块可以只有声明和 Schema；需要领域逻辑时再增加可信本地运行时、Web UI 贡献和 Skills。基座不设置能力受限的“自定义扩展”类别。

当已声明的模块未安装时，基座仍可根据图清单识别命名空间归属，将相应类型和能力标记为缺少解释器并保留数据；模块恢复后重新启用完整解释、校验和交互。

## 无损边界

模块缺失时，基座必须保留未知模块字段的层级、键、值和数组顺序，使其读取后再次保存仍具有相同语义。基座不承诺保留 YAML 的原始缩进、键顺序、空行、锚点、别名或注释位置。

## 已确认：对象的最小结构

对象由基座字段、主类型数据和能力状态组成：

```yaml
id: question-001
kind: research.question
label: 注意力机制为什么有效？

data:
  scope: transformer

capabilities:
  exploration.unknown:
    confidence: low

meta:
  created_at: 2026-09-08T10:00:00+08:00
  updated_at: 2026-09-08T10:00:00+08:00
```

字段职责如下：

- `id`：图内稳定对象标识，由基座负责引用完整性；
- `kind`：带模块命名空间的唯一主类型，表达对象“是什么”；
- `label`：供人和通用界面识别对象的简短名称；
- `data`：由 `kind` 的定义模块拥有和解释；基座只负责保存；
- `capabilities`：以带命名空间的能力 ID 为键，值为该能力拥有的状态；无状态能力可以使用空映射；
- `meta`：基座拥有的通用记录信息，首版只定义 `created_at` 和 `updated_at`。

`data`、`capabilities` 和 `meta` 在没有内容时可以省略。对象不再设置单独的 `extensions` 区域；主类型数据统一进入 `data`，附加行为和状态统一进入 `capabilities`，避免同一语义存在多个存放位置。

当主类型模块或能力模块缺失时，基座可以修改 `label` 等已知基座字段，但必须原样保留未知的 `kind`、`data` 和 `capabilities` 内容。模块恢复后，这些数据应重新获得原有语义。

## 已确认：关系的最小结构

关系是一等实体，由基座连接信息、关系类型数据和可选能力状态组成：

```yaml
id: supports-001
kind: research.supports
source: evidence-001
target: claim-001
direction: directed

label: 支持

data:
  strength: strong

capabilities:
  temporal.validity:
    valid_until: 2027-01-01

meta:
  created_at: 2026-09-08T10:00:00+08:00
  updated_at: 2026-09-08T10:00:00+08:00
```

`id`、`kind`、`source`、`target` 和 `direction` 是必填字段。`direction` 只能是 `directed` 或 `undirected`，使基座在关系类型模块缺失时仍能正确遍历。对于无向关系，`source` 与 `target` 只提供稳定的存储顺序，不表达语义方向。

`label`、`data`、`capabilities` 和 `meta` 的所有权规则与对象相同，且没有内容时可以省略。关系拥有独立 `id`，因此可以被引用、单独编辑、附加能力并在 Web UI 中作为一等实体检查。

## 已确认：标识符作用域

对象和关系共享一张图内的统一 ID 空间。任意两个实体不得使用相同 `id`，ID 创建后保持不变；用户可见名称的变化通过 `label` 表达。基座必须把重复 ID、文件名与实体 ID 不一致以及关系端点不存在视为基础校验错误。

关系的 `source` 和 `target` 在首版只能引用同一张图中的对象。图外指代使用 `<graph-id>#<entity-id>` 限定形式，例如 `attention-research#question-001`，但这种限定引用只作为数据或模块能力保存，不作为首版基座关系的端点。

首版不实现跨图关系。这样一张图可以独立移动、复制和删除，不会静默破坏另一张图的拓扑。需要跨图导航、同步或聚合的模块可以先在自己的数据中保存限定引用，后续再根据实际用例决定是否提升为基座能力。

## 尚待确定

- 未知模块数据允许进行哪些基础编辑；
