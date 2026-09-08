# TopoRealm 最小数据模型

状态：讨论中。本文随 `toporealm-foundation/l1_data_model` 的逐项决策更新。

## 已确认：事实来源与文件布局

TopoRealm 使用目录式 YAML 作为唯一事实来源。一张图的对象和关系分别按稳定 ID 存入独立文件，图清单只保存图级信息、模块声明和实体引用。

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

## 尚待确定

- `graph.yaml` 的最小字段和模块版本声明；
- 未知模块数据允许进行哪些基础编辑；
- 标识符在单图、工作区和跨图引用中的作用域。
