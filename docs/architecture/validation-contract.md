# TopoRealm 0.2 校验契约

状态：Core 0.2 Preview 的已冻结类型契约。
范围：公共 envelope、模块私有 Schema、snapshot/transition 上下文、诊断结果和模块运行时边界。
非范围：Schema 执行器、模块装载器、校验调度器和提交管线；这些由后续节点实现。

## 1. 校验的唯一边界

Core 为每次受支持校验准备一个完整的候选 `GraphSnapshot`。模块只通过 `ModuleRuntime` 的只读 validator 接口观察候选图；validator 不接收 `GraphStore`、文件系统、锁、历史或任何写入函数。

校验输入有两个互斥模式，使用 `kind` 作为判别字段：

```ts
type ValidationContext =
  | { kind: "snapshot"; candidate: ReadonlyGraphSnapshot }
  | {
      kind: "transition";
      before: ReadonlyGraphSnapshot;
      candidate: ReadonlyGraphSnapshot;
      changes: ReadonlyGraphPatch;
    };
```

- `snapshot` 只提供 `candidate`，用于完整候选图上的长期不变量。
- `transition` 同时提供不可变的 `before`、`candidate` 和现有 `GraphPatch` 的深只读 `changes`，用于判断状态迁移过程。
- `ManagedGraph.validate()` 只运行 snapshot validator；commit、undo、redo 和模块管理命令才运行 transition validator。
- validate-only 不调用 transition validator，也不伪造 `before` 或 `changes`。

`ReadonlyGraphSnapshot` 和 `ReadonlyGraphPatch` 是深只读类型。实现可以在调用前建立不可变快照，但 validator 不得依赖调用者之后如何修改原始对象。

## 2. Core envelope 与模块私有区

对象和关系都由 Core envelope 负责通用结构；字段职责如下：

| 区域 | Core 负责的字段 | 模块负责的字段 |
|---|---|---|
| object | `id`、`kind`、`label`、`meta` | `data`、`capabilities` |
| relation | `id`、`kind`、`source`、`target`、`direction`、`label`、`meta` | `data`、`capabilities` |

`id`、对象/关系的 `kind`、关系端点和 `direction` 属于公共 envelope，不由模块 Schema 接管。`data` 是主类型模块拥有的 kind data；`capabilities` 是各能力模块拥有的 capability state。Core 负责保存和无损传递私有区，但不解释其中的领域字段。

模块 Schema 必须声明一个 `ModuleSchemaTarget`，其区域只能是：

- `{ area: "data", kind: "<namespace>.<kind>" }`；或
- `{ area: "capabilities", capability: "<namespace>.<capability>" }`。

Schema 文档必须是 JSON Schema 2020-12（或合法的布尔 Schema），对象文档的 `$schema` 固定为 `https://json-schema.org/draft/2020-12/schema`。模块 Schema 不得借此声明或改写 Core envelope、其他模块的私有区、实体引用或迁移规则。

模块缺失时，Core 可以继续读取和保存未知私有区；受支持写入不得借助普通 envelope 更新改写该模块拥有的 `data` 或 `capabilities`。

## 3. Validator 运行时

`ModuleRuntime` 的字段全部可选：模块可以只提供 Schema，也可以提供 `execute` 或统一的 `validate`。每个 validator 由模块清单登记稳定 ID 与 `snapshot`/`transition` mode，Core 按登记顺序之外的稳定 ID 顺序调用同一个 runtime dispatch；这样一个模块可以提供多个规则，又不把两套生命周期方法扩进 interface。validator 是同步、确定性、只读函数，只返回 `ValidationDiagnostic[]`，不能返回 MutationPlan 或产生外部效果。

```ts
type ModuleValidator = (
  validatorId: string,
  context: SnapshotValidationContext | TransitionValidationContext,
) => readonly ValidationDiagnostic[];
```

Core 负责捕获异常并转换为稳定诊断；模块 validator 不自行吞掉异常，也不以抛异常作为业务诊断格式。后续执行器按 namespace、再按 validator ID 排序调用；validator 之间不得形成先后依赖。

## 4. 诊断与 complete

每条诊断至少包含 `code`、`message` 和 `severity`，可带 `entityId`、`path`、`moduleId`、`validatorId` 与 JSON `details`。`ValidationResult` 只表达三个稳定字段：

```ts
interface ValidationResult {
  ok: boolean;
  complete: boolean;
  diagnostics: readonly ValidationDiagnostic[];
}
```

`ok` 只表示诊断中没有 `severity: "error"`；`complete` 表示本次计划中的基础校验、已启用 Schema 和可用 validator 是否都实际执行，和 `ok` 正交。组合语义固定如下：

| 情况 | 诊断 | `ok` | `complete` | 是否允许提交 |
|---|---|---:|---:|---:|
| Core envelope 或 Schema 违规 | `error` | `false` | `true`（若没有执行缺口） | 否 |
| 模块规则不满足 | 模块返回的 `error` | `false` | `true`（若执行成功） | 否 |
| 仅有警告 | `warning` | `true` | `true` | 是 |
| 已声明的指定 validator 不可用 | `VALIDATOR_UNAVAILABLE`，`error` | `false` | `false` | 否；候选图不得提交 |
| validator 抛异常 | `VALIDATOR_EXCEPTION`，`error` | `false` | `false` | 否 |
| validator 返回非法诊断 | `INVALID_DIAGNOSTIC`，`error` | `false` | `false` | 否 |

模块整体不可用可以附带 `MODULE_UNAVAILABLE` warning；这使读取结果 `complete:false`，并由缺失模块私有区域保护限制写入。模块可用且已经声明 validator、但对应 runtime 校验能力不可用时属于 fail-closed error，不能提交候选图。缺失校验能力不能被描述为完整通过。模块 validator 返回的领域错误码由模块拥有，但必须是稳定字符串；Core 生成的边界错误使用 `VALIDATION_CODES` 中的固定值。

## 5. 稳定排序

Core 的执行顺序只为复现性服务：先 Core 基础检查，再按模块 namespace 的字典序，再按模块内 validator ID 的字典序。执行顺序不是依赖关系。

最终 `diagnostics` 通过 `sortValidationDiagnostics` 得到新数组，不修改 validator 返回的数组。排序键依次为：

1. `entityId`（缺失视为空字符串）；
2. `code`；
3. `path`；
4. `moduleId`；
5. `validatorId`；
6. `severity`；
7. `message`。

字符串比较使用稳定的代码点顺序，不依赖当前系统 locale；完全相同的诊断保留原始相对顺序。这样同一候选图和同一注册快照始终产生可比较的诊断序列。

## 6. 不在本节点实现的内容

本契约不实现 JSON Schema 解释器、简写 Schema adapter、模块文件扫描、validator 装载、异常捕获、诊断归一化或 `ManagedGraph` 提交。后续实现必须使用本文件的类型和错误组合，不得扩大 validator 的上下文权限或让 validate-only 运行 transition。
