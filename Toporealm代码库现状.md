# TopoRealm 代码库现状描述

> 基准：工作区 `0.2.0` 候选（未发布），公开 Preview 为 Core `0.1.3`。
> 本文只描述事实，不含建议。所有行号以当前工作区为准。
> 对照文本：《Toporealm设计构想.md》。

---

## 0. 设计构想与现状的一句话对照

设计构想追求的是 **pi 式结构**：极简核心（最少工具、高度可扩展）+ 体系化的模组系统 + 实时 WebUI。
当前代码库的实际形态是：**一个把存储事务、崩溃恢复、校验、模块治理、宿主分发全部内置的单体内核**（src/core 1,804 行 + module-sdk 871 行，共 20 道写路径门禁、约 60 个诊断/错误码），模组系统与核心存在双向类型依赖，Web 端没有热重载。

---

## 1. 代码库全景

### 1.1 规模

| 区域 | 行数 | 说明 |
|---|---:|---|
| `src/core` | 1,804 | store 692 / recoverable 394 / managed 285 / validation-types 179 / types 116 / validate 45 / errors 45 / legacy 35 / index 9 |
| `src/module-sdk` | 871 | registry 365 / runtime 260 / validation 126 / actions 72 / index 48 |
| `src/cli` | 436 | index 386 + main 50 |
| `src/server` | 222 | node:http + ws |
| `src/distribution` | 366 | installer 200 / hosts 141 / skills 25 |
| `src/runtime` | 129 | workspace.ts 128（组合根） |
| `src/web` | 115 | patch 投影 + 静态资源 |
| `src/mcp` | 138 | 11 个固定工具 |
| `src/product-identity` + 其他 | — | 版本单一真相源 |
| `web-ui/src` | 6,471 | Svelte 5 + D3；App.svelte 1,239 / GraphCanvas.svelte 1,195 / InspectorEditor 365 |
| `tests/` | 27 个文件 ≈108 用例 | 另有 web-ui 8 文件 ≈44 用例 |

### 1.2 现行分层（自上而下全部汇入同一组合根）

```
Web UI (Svelte5+D3)   CLI (16 命令)   MCP (11 工具)   模块 runtime
      │                  │               │               │ 返回 MutationPlan
      └────────┬─────────┴───────┬───────┘               │
               ▼                 ▼                       │
        Workspace Runtime（src/runtime/workspace.ts，唯一组合根）
               │                                         │
               ▼                                         │
   ManagedGraph 五方法 ◄── ActionExecutor ───────────────┘
   read/validate/commit/undo/redo
               │
   GraphCommand 私有管线：revision 检查 → 候选图 → 校验 → 可恢复提交 → history/audit
               │
   GraphStore（YAML 目录持久化）＋ RecoverableGraphPersistence（锁/journal/事务）
```

### 1.3 磁盘布局（每图）

```
<workspaceRoot>/.toporealm/
├── active                        # 当前图 id
├── modules.yaml                  # 模块绑定（workspace/global/path 三源）
├── modules/<id>/                 # 工作区安装的模块
└── graphs/<graphId>/
    ├── graph.yaml                # 清单：format/id/label/modules[]/sources/meta
    ├── objects/<id>.yaml         # 每对象一文件，文件名必须=记录 id
    ├── relations/<id>.yaml
    ├── .revision.json            # {revision, commitId?, snapshotDigest?}
    ├── .audit.jsonl              # JSONL 审计（commitId/来源/前后 revision/digest/recoveryStatus）
    ├── .toporealm.lock           # 同机互斥锁（wx 创建 + 存活 PID 检查）
    ├── .toporealm-txn/           # 事务 staging（old/、new/、journal.json）
    └── .history/                 # 段式历史：index.json + segments/seg_NNNN.json
```

数据模型：对象 `{id, kind, label, data?, capabilities?, meta?}`；关系为一等实体 `{id, kind, source, target, direction, ...}`；`data`/`capabilities` 是模块私有区，Core 只保存不解释；kind/能力使用 `模块命名空间.名称`。

---

## 2. Core 的实际重量分布

### 2.1 逐关注点行预算（src/core 1,804 行）

| 关注点 | 约占行数 | 位置 |
|---|---:|---|
| **持久化与原子写** | ~200 | store.ts L64-127/L551-580；recoverable.ts staging L211-246 |
| **锁 + journal + 崩溃恢复状态机** | ~225 | recoverable.ts：acquireLock L283-300、commitUnlocked 六态状态机 L146-209、recoverUnlocked L113-144、journal L302-316 |
| **undo/redo 段式历史** | ~140 | store.ts HistoryState L23-36、prepareTransition L414-448、readHistory/writeHistory L583-663 |
| **外部编辑吸收** | ~160 | store.ts StoreNotice L46-56、readManaged L288-317、prepareExternalAbsorption L451-475、externalState L667-695；recoverable.ts classify L232-238 |
| **审计** | ~90 | store.ts audit+digest L478-529、snapshotDigest L700-710；recoverable.ts markRecoveryAudit L248-275 |
| **记录形状检查** | ~135 | store.ts validateManifest/Object/Relation、ID 安全 L88-208 |
| **校验编排**（managed.ts） | ~85 | execute/validationResult/assertValid L153-234 |
| **缺模块私有区守卫**（managed.ts） | ~75 | missingModuleMutationDiagnostics L239-285 |
| **类型定义** | ~330 | types.ts 116 + validation-types.ts 99 + managed.ts 结果类型 95 |
| legacy 兼容桥 | 35 | legacy.ts（生产死代码，见 §6.3） |

粗略结论：**约 42% 的 core 行数是存储机制**（持久化 + 锁/journal/恢复 ≈ 590 行，不含审计）；历史 + 外部吸收 ≈ 300 行；真正"图语义"的基础校验只有 45 行（validate.ts：重复 ID、悬空关系）。

### 2.2 关键机制事实

- **`read()` 也跑全量校验**：ManagedGraphController.execute（managed.ts:153-181）对 read/validate/commit/undo/redo 全部执行 `validationResult`——即每次读取都对全图执行 基础校验 → 缺模块守卫（transition 时）→ 每条记录 × 每个编译后 schema（Ajv）→ 每个 mode 匹配的模块 validator。读取不是被动行为。
- **校验 fail-closed**：任何 error 级诊断抛 `VALIDATION_FAILED`（managed.ts:230-233）；validator 缺失/抛异常/返回非结构化分别转为 `VALIDATOR_UNAVAILABLE` / `VALIDATOR_EXCEPTION` / `INVALID_DIAGNOSTIC` error（runtime.ts:94-133, 250），`complete=false`。
- **外部编辑即事务**：任何写操作前检测外部 YAML 修改（digest 比对，store.ts:667-695）；检出后**丢弃本次候选变更**，改为执行"吸收提交"（封存历史段、revision+1、清空 redo、返回 `EXTERNAL_EDIT_ABSORBED` notice，store.ts:288-317, 451-475）。
- **锁覆盖整个事务**：读盘、digest、YAML 解析、候选构造、全部校验、落盘都在同一把图锁内（store.ts:320-345, recoverable.ts:89-102）。
- **故障注入后门**：`FaultPoint` 内置于生产类 RecoverableGraphPersistence（recoverable.ts L10-70 区间），供测试触发中断点。

---

## 3. 写路径门禁全清单（20 道）

一次 `commit/undo/redo` 依次经过：

| # | 门禁 | 位置 | 失败码 |
|---|---|---|---|
| 1 | 同机文件锁（wx + 陈旧 PID 清理） | recoverable.ts:283-300 | GRAPH_LOCKED |
| 2 | 事务前崩溃恢复（journal 分类） | recoverable.ts:121-144 | RECOVERY_REQUIRED |
| 3 | 变更路径白名单（禁绝对/越界/锁/txn 路径） | recoverable.ts:277-283 | INVALID_COMMIT_PATH |
| 4 | revision 区间不变量（next = base+1） | recoverable.ts:150 | INVALID_COMMIT |
| 5 | 提交前逐文件 before-digest 竞态比对 | recoverable.ts:153-158 | EXTERNAL_EDIT_RACE |
| 6 | 外部编辑检测 → 吸收并**丢弃本次变更** | store.ts:288-317, 667-695 | EXTERNAL_EDIT_ABSORBED（notice） |
| 7 | expectedRevision 乐观并发检查 | store.ts:546-551 | REVISION_CONFLICT |
| 8 | 基础校验（重复 ID、悬空关系） | validate.ts:20-44 | DUPLICATE_ID / DANGLING_RELATION |
| 9 | 记录形状与 ID 安全 | store.ts:88-208 | INVALID_ID / INVALID_OBJECT / INVALID_RELATION / INVALID_MANIFEST / FILE_ID_MISMATCH |
| 10 | 缺模块私有区变更守卫（transition） | managed.ts:239-285 | MISSING_MODULE_PRIVATE_MUTATION |
| 11 | 模块 JSON Schema 2020-12（Ajv，全记录×全 schema） | runtime.ts:128-179 | MODULE_SCHEMA_INVALID |
| 12 | 模块 validator（snapshot/transition 按 mode） | managed.ts:208-213 | VALIDATION_FAILED（聚合） |
| 13 | validator fail-closed 三态 | runtime.ts:94-133, 250 | VALIDATOR_UNAVAILABLE / VALIDATOR_EXCEPTION / INVALID_DIAGNOSTIC |
| 14 | MutationPlan 命名空间归属检查 | registry.ts:377-400 | MODULE_UNAVAILABLE / CONTRIBUTION_NOT_FOUND |
| 15 | 动作注册快照新鲜度 | actions.ts:38 | STALE_ACTION |
| 16 | 动作目标存在 + applies_to 匹配 + 输入形状 | actions.ts:41-55 | INVALID_INPUT / ACTION_NOT_APPLICABLE |
| 17 | 模块激活门禁（namespace 匹配、schema 版本、硬依赖 semver） | registry.ts:220-282 | unavailable + reason |
| 18 | 模块绑定一致性（id/版本与清单一致） | registry.ts:172-190 | INVALID_MODULE_MANIFEST |
| 19 | 安装禁 install 脚本 + 所有权标记双校验 | installer.ts:77, 152, 187-189 | MODULE_INSTALL_SCRIPT / MODULE_TARGET_UNOWNED |
| 20 | Web patch 连续性（fromRevision 必须衔接） | web/index.ts:26-32 | PATCH_GAP |

模块路径另有逃逸禁令（MODULE_PATH_ESCAPE，registry.ts:320、installer.ts:57、runtime.ts:76）。

---

## 4. 诊断/错误码表面积

全库约 **60 个**稳定错误/诊断/notice 码：

- core：24 个（REVISION_CONFLICT、NO_UNDO/NO_REDO、GRAPH_LOCKED、INVALID_ID、INVALID_GRAPH_FILE、INVALID_GRAPH_STATE、INVALID_MANIFEST、INVALID_OBJECT、INVALID_RELATION、GRAPH_NOT_FOUND、EXTERNAL_EDIT_ABSORBED、DANGLING_RELATION、DUPLICATE_ID、FILE_ID_MISMATCH、RECOVERY_REQUIRED、INVALID_COMMIT、EXTERNAL_EDIT_RACE、INVALID_COMMIT_PATH、VALIDATION_FAILED、MISSING_MODULE_PRIVATE_MUTATION、INTERNAL_ERROR、MODULE_REGISTRY_UNAVAILABLE、MODULE_UNAVAILABLE、LEGACY_READ_ONLY/LEGACY_WRITE_UNSUPPORTED）
- module-sdk：19 个（STALE_ACTION、INVALID_INPUT、ACTION_NOT_FOUND、MODULE_UNAVAILABLE、ACTION_NOT_APPLICABLE、RUNTIME_FAILED、INVALID_MODULE_FILE、INVALID_MODULE_MANIFEST、INVALID_MODULE_CONTRIBUTION、INVALID_MODULE_UI、MODULE_PATH_ESCAPE、CONTRIBUTION_NOT_FOUND、INVALID_MODULE_RUNTIME、INVALID_MODULE_SCHEMA、LEGACY_SCHEMA_ADAPTED、VALIDATOR_UNAVAILABLE、VALIDATOR_EXCEPTION、INVALID_DIAGNOSTIC、MODULE_SCHEMA_INVALID）
- 周边（cli/server/web/distribution）：约 17 个（WORKSPACE_NOT_FOUND、GRAPH_REQUIRED、CLI_ERROR、CLI_USAGE、INVALID_GRAPH_ID、INVALID_OPERATION、NOT_FOUND、BAD_REQUEST、MODULE_ASSET_NOT_FOUND、PATCH_GAP、INVALID_PRODUCT_IDENTITY、INVALID_MODULE_PACKAGE、INVALID_MODULE_ID、MODULE_PATH_ESCAPE、MODULE_INSTALL_SCRIPT、MODULE_PACK_FAILED、MODULE_TARGET_UNOWNED、MODULE_SOURCE_NOT_FOUND、HOST_TARGET_UNOWNED）
- 另有 `VALIDATION_CODES` 常量集合（validation-types.ts:150-159）中的 `CORE_ENVELOPE_INVALID`、`CORE_DUPLICATE_ID`、`CORE_DANGLING_RELATION` 为**已声明但无抛出点**的预留契约。

---

## 5. 对外表面现状

### 5.1 CLI（16 命令）
`init / list / switch / status / read / apply <JSON> / undo / redo / validate [--complete] / serve / mcp / module add|remove|list / action list|execute / host sync / help / version`，全局 `--root/--graph`，环境变量 TOPOREALM_ROOT/GRAPH/HOME。中文 HELP。

### 5.2 MCP（11 工具，固定表）
`graph_list / graph_read / graph_create / graph_select / graph_validate / graph_apply / graph_undo / graph_redo / module_status / action_list / action_execute`。工具表由基座冻结，模块只贡献 Action Reference，不新增 MCP 工具。

### 5.3 Web（REST + WS）
- REST：GET graph/graphs/history/validate/modules/module-assets；POST graph/switch、actions、mutations、undo、redo。
- WS `/api/events`：每次提交广播 `graph:patch {graphId, revision, patch, diagnostics, complete, notice?}`。
- 客户端语义：写请求携带 expectedRevision；`REVISION_CONFLICT` / `PATCH_GAP` 进入恢复态而非静默覆盖；**WS 断线 = 全量 reload**（GET 全套 + 重建 WS，store.svelte.ts:297-325）。
- **无热重载**：server 只伺服 `web-ui/dist` 构建产物（或打包的 web-assets）；改 web-ui 代码必须重新 build，改模块 manifest/贡献必须重启 server（registry/runtime 在 createWorkspaceRuntime 一次性装配，无 watch）。无 vite dev 代理/开发模式。
- 模块 UI：`/api/module-assets/<id>/*` 直接从模块目录读文件，浏览器 `import()` extension.js 挂载自定义元素，注入 `{snapshot, disabled, executeAction, selectObject}` props——**同源执行、无任何隔离、无认证**；声明式 `ui.contribution.yaml` 投影为颜色/图标/表单字段/操作按钮（moduleProjection.ts）。

### 5.4 分发与宿主
- 模块安装：`npm pack --ignore-scripts` → tar 解包 → 校验（禁 install 脚本、禁外部依赖/node_modules）→ 带 `.toporealm-source.json` 所有权标记原子移动 → 写 module-sources.yaml + 绑定。
- `host sync`：为 Codex / Claude / Pi 三宿主生成 `.toporealm/generated/<host>/` 投影（.mcp.json、SessionStart 钩子、plugin manifest、skills 副本），带所有权标记，未标记目录不覆盖。
- 4 个基础 Skills（toporealm / -design / -join / -grilling）。

---

## 6. 模块体系现状

### 6.1 模块作者需要交付的产物（完整集成时）

1. `module.yaml`（format 字面量、id、namespace、version、supports.schemas、可选 requires.modules 硬依赖 semver）
2. `contributes`：object_kinds / relation_kinds / capabilities / validators / operations 五类声明文件（每项 `{id, schema?, declaration}`，缺 declaration 或文件缺失 → 整模块 unavailable）
3. `runtime/index.js`（ESM default export `{execute?, validate?}`；execute 签名 `(operation, {snapshot, target?, input}) => MutationPlan | {result, effects?}`）
4. `ui/contribution.yaml`（presentation.color/icon、forms.<kind> 字段表）
5. `ui/extension.js`（自定义元素，同源 import，无隔离）
6. `skills/SKILL.md`
7. 接线：图 `graph.yaml` 声明模块引用 + 工作区 `.toporealm/modules.yaml` 绑定

schema 支持正式 JSON Schema 2020-12 或 0.2.x 简写（legacy adapter 降级 `complete=false` + `LEGACY_SCHEMA_ADAPTED` notice；0.3.0 计划删除）。

### 6.2 模块受到的约束

- **无图写权限**：模块只能返回声明式 MutationPlan，由 Core 校验后原子提交；一次成功计划 = 一个原子撤销单位。
- **运行时无沙箱**：与 Core 同进程 `import()`，信任边界靠安装渠道（用户主动安装 + 禁安装脚本），不靠隔离。
- **激活门禁 14 种失败模式**（§3 第 17 项展开：无绑定、版本缺失、清单缺失/非法、id/版本不一致、namespace 不匹配、schema 版本不支持、硬依赖缺失/不满足、贡献文件缺失/非法、路径逃逸）。
- **动作前置 6 种失败模式**：STALE_ACTION、INVALID_INPUT、ACTION_NOT_FOUND、MODULE_UNAVAILABLE、ACTION_NOT_APPLICABLE、RUNTIME_FAILED。
- **私有区保护**：模块缺失时其 namespace 下的 kind/data/capabilities/关系端点变更被拒（MISSING_MODULE_PRIVATE_MUTATION），保证"缺失模块无损读取、但不得声称完整校验"。

### 6.3 模块生态的现实状态

- **仓库内没有任何生产级模块**。`src/modules/` 目录不存在；research / exploration / workflow 只是 `tests/fixtures/data/modules/` 下的边界测试 fixture（module.yaml 24-34 行 + 少量 runtime fixture）。README 明示它们"仅是边界测试 fixture"。
- 唯一端到端完整样例是 `tests/fixtures/packages/example-module`（runtime 15 行 + extension.js 3 行）。
- 已发布的 `@lukawi/toporealm-workflow` 在独立仓库（本工作区不含其源码）。
- **`src/core/legacy.ts`（35 行）是生产死代码**：仅 tests/legacy-bridge.test.ts 引用。
- **`GraphStore.apply/undo/redo/initialize`（store.ts:344-356, 220）仅测试使用**：生产表面全部走 ManagedGraph，但这批无校验低层写方法仍留在公开类上（core/index.ts 有意不导出 store，但类本身可经 runtime 子路径触达）。

---

## 7. 依赖关系现状（分层不干净处）

- **core → module-sdk**：`core/managed.ts:12-14` import registry/runtime/validation 三处；`core/validate.ts:2` import registry。"核心"在编译期依赖"模块 SDK"。
- **module-sdk → core**：actions/registry/runtime/validation/index 五个文件全部 import core（CoreError、ManagedGraph、types、validation-types）。
- 结果：**core 与 module-sdk 构成类型层双向依赖**（运行时无环，但包内分层边界不存在——两者同包编译，无包边界强制）。
- module-sdk 内部：runtime.ts（260 行）同时承担 Ajv 编译、runtime 装载/形状校验、validator fail-closed 执行、legacy schema 适配四职。
- 组合根 workspace.ts（128 行）本身很薄，但它是唯一知道"所有部件"的地方：store + resolver + activator + schema/validator 编译 + runtime 装载 + ActionExecutor + ManagedGraph。

---

## 8. 测试与质量现状

- 27 个测试文件 ≈108 用例：可恢复提交协议（两文件 14 用例，含故障注入）、历史守卫 16、core-store 10、managed-graph 管线 8、CLI 6、MCP 真实 stdio 握手 3、distribution/host 投影、模块 registry/runtime-schema、legacy 桥、协议冻结、产品身份、web-product、browser-smoke 1（协议级全链路：编辑→历史→动作→冲突→持久化）。
- web-ui 8 文件 ≈44 用例（store 20、组件与协议其余）。
- 盲区：无真实浏览器 E2E；MCP 无并发/断线场景；宿主投影仅文件级断言（未验证 Codex/Claude/Pi 实际加载）；Windows 路径/shell 覆盖薄弱。
- 代码内无 TODO/FIXME/HACK 标记；两处 `writeAtomic` 实现不一致（store.ts:70-75 先 unlink 再 rename，有窗口期；recoverable.ts:414-419 不 unlink，Windows 覆盖可能 EPERM）。
- 撤销栈存完整 before/after 快照克隆，段文件随提交数线性膨胀，无压缩/上限；diff 与校验全量 O(n)，JSON.stringify 键序敏感比较。

---

## 9. 与《设计构想》逐条对照（事实映射，非建议）

| 设计构想 | 代码库现状 |
|---|---|
| "极简的核心……用最少的工具" | core 1,804 行中 ~42% 是存储事务机制；基础图语义校验仅 45 行；CLI 16 命令、MCP 11 工具（pi 本体为 4 工具量级） |
| "安全问题……交给专门插件替代" | 锁、journal 恢复、revision 并发、fail-closed 校验、外部编辑吸收、所有权标记、路径白名单、install 脚本禁令——全部硬编码在 core/module-sdk，无一可卸载或替换；core 无插件点（唯一扩展机制是模块贡献五种声明） |
| "对模组的约束太多" | 模块面 14 种激活失败模式 + 6 种动作失败模式 + fail-closed validator + 私有区守卫 + STALE_ACTION 新鲜度检查；module.yaml 必填 `supports.schemas` 数字数组 |
| "多个模组无缝衔接" | 有依赖声明机制（requires.modules + semver），但无自动求解（显式绑定）；命名空间冲突 = 同 namespace 模块互斥；组合验证仅 fixture 级 |
| "webUI……冷启动热重载实时前后端通信" | 实时通信具备（WS graph:patch + expectedRevision 冲突恢复）；**无任何热重载**（改前端需 rebuild、改模块需重启 server、断线即全量 reload） |
| pi 的扩展哲学（skills/extensions 体系化） | 已有 skills 宿主投影体系（三宿主 + 所有权标记）；模块 UI 扩展存在但仅一种形态（自定义元素）且无隔离；Core 自身无扩展点 |
| 继承 topological-tool 的任务拓扑 | 已由独立 Workflow 模块承载（七态、依赖门禁、checkpoint、执行报告），不在本仓库 |
| 多入口并行/上下文串通 | 支持同机多进程（文件锁 + journal 恢复 + revision 冲突 + Web patch 广播）；无跨机/网络能力（明确非目标） |

---

## 10. 已核实的问题清单（描述性汇总）

1. **写入口不彻底**：声明"ManagedGraph 是唯一写 seam"，但 `GraphStore.apply/undo/redo/initialize`（无校验低层写方法）仍在公开类上，仅靠文档和测试纪律约束。
2. **core ↔ module-sdk 双向类型依赖**：分层边界在编译层面不存在。
3. **读取即全量校验**：`read()` 执行完整三段校验管线，读放大与写相同。
4. **校验/治理逻辑不可插拔**：20 道门禁全部内联在 core/module-sdk 执行路径中，无任何"以模块替代内置行为"的机制。
5. **生产死代码**：legacy.ts 整文件、GraphStore 低层写方法、diffSnapshots 对外导出。
6. **预留契约无实现**：CORE_ENVELOPE_INVALID / CORE_DUPLICATE_ID / CORE_DANGLING_RELATION 已声明无抛出点。
7. **原子写双实现不一致**（Windows 语义差异，见 §8）。
8. **无热重载/开发模式**：前后端迭代都要 build/重启。
9. **无生产级模块范例**：模块开发的全部现实样例是测试 fixture；唯一已发布模块在本仓库之外。
10. **锁窗口 = 整个读-校验-写事务**；PID 复用可能误判锁属主存活。
11. **全量快照模型**：undo 栈、diff、digest、校验均为全图 O(n)，无增量路径（文档明确接受，未列优化）。
12. **审计解析静默容错**（store.ts:563-565 `catch {}` 回退 .revision.json）。

---

*数据来源：三路源码勘察 + 人工复核（managed.ts 全文、store.ts 写方法、依赖 import 逐条验证、行数实测）。*
