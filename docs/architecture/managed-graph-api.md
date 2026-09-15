# ManagedGraph 公共 API 与兼容边界

状态：TopoRealm Core 0.2 已实现公共契约，2026-09-15。
范围：冻结 TypeScript 的调用面、结果形状和导出边界，并记录当前生产适配器的落地方式。

## 1. 唯一受支持的 Core seam

`ManagedGraph` 是 0.2 唯一受支持的图读取与写入 interface。它是同步 handle，且只提供以下五个方法：

| 方法 | 参数 | 返回值 | 语义 |
| --- | --- | --- | --- |
| `read` | 无 | `ManagedGraphReadResult` | 读取当前快照；可以携带恢复或外部编辑吸收提示 |
| `validate` | 无 | `ManagedGraphValidationResult` | 对当前图执行只读基础/完整校验 |
| `commit` | `MutationPlan` | `ManagedGraphCommitResult` | 校验并提交一个原子变更计划 |
| `undo` | `expectedRevision?` | `ManagedGraphUndoResult` | 撤销一个历史单元，并检查可选的当前 revision |
| `redo` | `expectedRevision?` | `ManagedGraphRedoResult` | 重做一个历史单元，并检查可选的当前 revision |

契约不公开通用 `execute`、phased session、preview 或 caller policy。`MutationPlan.expectedRevision` 仍是提交并发检查的一部分；`undo` 与 `redo` 的可选参数是单个 revision 数字，不引入第二套选项矩阵。

## 2. 结果类型

所有五个方法的结果都继承 `ManagedGraphResult`，保证产品表面可以统一处理以下字段：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `revision` | `number` | 结果对应的图 revision |
| `diagnostics` | `readonly ManagedGraphDiagnostic[]` | 稳定的结构化错误或警告列表；不得用非结构化字符串替代 |
| `complete` | `boolean` | 是否具备完成本次语义校验所需的模块/validator；缺失时为 `false` |
| `notice` | `ManagedGraphNotice?` | 非错误的恢复、外部编辑吸收或兼容提示；没有提示时省略 |

诊断至少包含 `code`、`message` 和 `severity`（`error` 或 `warning`），并可以带 `entityId`、`path` 与只读 `details`。error 阻止 `commit`；warning 随成功结果返回。诊断排序由 Core 实现按统一稳定规则完成，本节点只冻结其结构。

读取结果增加当前 `snapshot`：

```ts
interface ManagedGraphReadResult extends ManagedGraphResult {
  readonly snapshot: GraphSnapshot;
}
```

校验结果只携带通用结果字段，不隐含写入或持久化副作用：

```ts
interface ManagedGraphValidationResult extends ManagedGraphResult {}
```

提交、撤销和重做共享一个变更结果形状：

```ts
interface ManagedGraphMutationResult extends ManagedGraphResult {
  readonly snapshot: GraphSnapshot;
  readonly patch: GraphPatch;
  readonly history: {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
  };
}
```

`ManagedGraphCommitResult`、`ManagedGraphUndoResult` 和 `ManagedGraphRedoResult` 是该变更结果的语义别名。结果中的 `snapshot.revision` 与顶层 `revision` 必须对应同一个结果，不允许产品表面各自推断 revision。

## 3. 私有命令边界

Core 实现可以把五个方法映射到内部 `GraphCommand` 联合，再统一执行 revision 检查、候选图构造、Core/Schema/validator 校验、提交、历史和审计。`GraphCommand` 是 `src/core/managed.ts` 内部类型，**不导出**；调用者不能构造命令、注入文件系统或绕过 `ManagedGraph`。

当前实现由 `ManagedGraphController` 将五个公开方法分派到私有 `GraphCommand`，并统一进入候选构造、完整校验和可恢复提交。新建空图通过同文件内的 Core bootstrap 边界完成基础校验，再由 `GraphStore.initializeManaged` 写入 journal、history 与 audit；它不是对调用者公开的第六个图操作。

## 4. 导出清单

`src/core/index.ts` 暴露类型、错误、基础校验和 `ManagedGraph` 契约；包根 `src/index.ts` 对 Core 的星号导出也不再带出 `GraphStore`。`GraphStore` 不再从根入口或 `/core` 导出；`src/core/store.ts` 在迁移完成前仍可能作为仓库内部旧实现被引用，但这不是 0.2 公共承诺。

### `/core/legacy` 一轮兼容策略

后续兼容桥以 `/core/legacy` 作为明确的深路径边界，并只实现 `LegacyGraphReader` 的两个只读方法：

```ts
interface LegacyGraphReader {
  read(): GraphSnapshot;
  validate(): GraphValidationResult;
}
```

它只服务 `toporealm.graph/v1` 的现有图和当前无模块/缺失模块 fixture：读取必须无损保留未知 `kind`、`data`、`capabilities`；基础校验不可获得完整模块解释时返回 `complete: false`，并给出结构化兼容诊断。该边界没有 `commit`、`undo`、`redo`、`MutationPlan` 或可写 `GraphStore`，不会成为生产写入 seam。本节点只冻结可编译类型边界，实际深路径装配与 fixture 行为由 `l2_legacy_bridge` 完成。

## 5. 兼容期与移除条件

### 0.2.x

- 保留一轮旧简写 Schema adapter，允许现有 Workflow 0.1.0 图 fixture 无损读取。
- 缺失模块或正式 validator 时仍可读取并做基础校验，但结果明确为 `complete: false`；不得声称完成领域校验。
- adapter 产生 `LEGACY_SCHEMA_ADAPTED` 等结构化 notice/diagnostics，指向迁移命令，不静默改写原始 YAML。
- 生产入口迁移到 `ManagedGraph`；旧 `GraphStore` 不因兼容需要重新进入根入口或 `/core`。

### 0.3.0

只有在以下条件全部满足后才删除 0.2.x adapter：

1. 有公开、可 dry-run、逐文件诊断、备份并显式确认的 Schema 迁移命令；
2. 迁移幂等，失败不破坏原文件；
3. 所有正式维护模块已提供 JSON Schema 2020-12 及 snapshot/transition validators；
4. 0.2.x 最后一个版本的弃用诊断已指向迁移命令和删除时间；
5. Workflow 0.1.0、缺失模块、未知私有字段及多模块图都有迁移 fixture；
6. 未迁移模块仍能无损读取，并得到明确错误与 `complete: false`。

在这些条件满足前，不以简单删除代码制造数据迁移压力。

## 6. 当前实现范围

- YAML、锁、journal、恢复、history segment 与 audit 已位于 Core 的受控持久化边界。
- 模块装载、Schema adapter 和 snapshot/transition validator 已由 Workspace Runtime 装配；领域模块升级仍是独立版本工作。
- CLI、MCP、Server、Web 与 Module SDK 的生产路径均消费 `ManagedGraph`；`GraphStore.initialize` 只保留给仓库内低层测试和兼容实现。
