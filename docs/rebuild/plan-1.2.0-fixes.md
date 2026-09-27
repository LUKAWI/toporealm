# TopoRealm 1.2.0 修复计划汇总（代码修复与优化版本）

> 2026-09-26 · 依据：improve-codebase-architecture 架构走查（深度/缝词汇）+ oracle 全量源码反“屎山”深审，4 项 P0 经主代理逐行亲验。评审 HTML 报告存于 OS 临时目录 `architecture-review-20260926-224145.html`，不入仓库。
> 本文件未提交，供 1.2.0 规划评审；评审通过后可纳入版本管理。

## 版本定位

- **纯修复 + 内部优化版本**：不新增用户可见功能；不改 CLI 语法、错误码封闭集语义、wire 既有消息、module.yaml schema、toporealm.graph/v3 清单格式（全部只增不改）。
- 取 minor 的理由：protocol 有唯一加法扩展（E5 邻域查询），另有跨包内部重构。
- 总评：**不是屎山**——分层纪律实测成立（全库 0 个 `as any`/`ts-ignore`、错误码无越集、daemon-core 无 module-host import、公共缝测试真实存在）。风险集中在**并发面**：提交管线、图换载、事件重连三条路径都假设“无并发异步入口”，而 wire 层是并发的。

## 规范前置动作（AGENTS.md：先改 blueprint 再写代码）

| 编号 | 需要的决策记录 | 原因 |
|---|---|---|
| PRE-1 | E5 ReadQuery 加法扩展（`adjacent` / 关系类型聚合） | 协议加法，蓝图 §1 事实面需附决策记录 |
| PRE-2 | core.catalog 收窄为 kinds、删除 core.run（C2） | 触碰蓝图 §1“图事实面”描述 |
| PRE-3 | client→module-host 依赖边登记（memory.ts:17，MemoryClient 装载 ModuleHost） | 蓝图 §2 依赖图未列此边；发布包 @lukawi/toporealm-client 因此拖入 module-host，需裁决（登记或解耦） |
| PRE-4 | IpcResultMap 处置：随 C1 转正为 SessionTransport 类型脊柱，或删除 | 现状为定义后零使用的死代码（wire.ts:38-52） |

## 批次 A · P0 正确性修复（最高优先，约 20 行核心改动 + 回归测试）

| ID | 位置 | 问题 | 修法 | 验收 |
|---|---|---|---|---|
| A1 | `daemon-core/src/core.ts:540,662,759-769` | convert 管线无串行化：revision 在 stage 分配（`revision_+1`）、land 才生效，persistAsync 每个 await 都是让渡点；wire 层 `void dispatcher.handle` 完全并发 → 并发 commit 同 revision 双写、内存丢更新、.log 同 revision 两条、ifRevision/undo 栈失真 | convert 入口 promise 链互斥（`this.tail = this.tail.then(run, run)`）；convertSync 不受影响；wire/CLI 契约零变化 | 新增并发 commit 回归测试（N 路并发提交 → revision 严格递增、log 无重复 revision、内存=全量合并） |
| A2 | `client/src/ws.ts:365-368,578` | 缺口自愈先 bump `lastRevision` 再 resync，回放起点=已推进值 → 缺口事件（6/7）永不补齐，违反 ws.ts:25 自声明不变量 I3；WebUI 靠 store 全量重读掩盖，但 WsSession 是公共缝，M5 宿主将直接消费 | bump 前捕获 `missedFrom`，resync 用它作起点（重复事件被 store 单调吸收去重，无害） | 新增缺口回放测试（模拟 patch 跳号 → 断言回放覆盖缺口区间） |
| A3 | `daemon/src/runtime.ts:104-109` | ensureGraph 绕过 `swapPromise` 直呼 doSwap：两个客户端 hello 不同图并发 → 双开 DaemonCore（一个泄漏，fs.watch 存活=可后台写盘）、dispose 可能落到刚换入的当前 core、Y2 换载独占被绕过 | 与 maybeSwap 同构：`this.swapPromise ??= this.doSwap(g).finally(() => this.swapPromise = null)` 后 await | 新增“并发 hello 不同图”runtime 测试（断言单次换载、旧 core dispose 恰一次） |
| A4 | `daemon/src/server.ts:62,75` | stop() dispose 启动时捕获的旧 core 引用：任意一次换载后，当前图内核的 3 个 fs.watch + reconcile 定时器永不清理（detached 进程靠 process.exit 兜底，库用法/测试泄漏） | dispose 责任归 GraphRuntime：新增 `runtime.dispose()`，stop() 只调它（两路代理独立收敛发现） | runtime 生命周期测试 + serveDaemon 换载后 stop 断言无存活 watcher |

## 批次 B · P1 公共面与资源修复（8 项，Quick 级为主）

| ID | 位置 | 问题 → 修法 |
|---|---|---|
| B1 | `cli/src/index.ts:447-450` | find 多 `--kind` 恒空集（core.read where 是交集语义，cli/index.ts 与 core.ts:1272-1285）→ 多 kind 时本地多次 read 合并（wire 不变，不引 OR 语义） |
| B2 | `client/src/provision.ts:61,40` | 公共错误 fix 文案引用已废除动词 `toporealm new`（照抄即 UsageError）→ 统一 `creategraph`（workspace.ts:49,59 已是正确写法） |
| B3 | `cli/src/index.ts:893-898` | CLI 本地 bug 伪装成 DAEMON_UNREACHABLE 出街 → 非 TopoError 加 `cli internal error:` 前缀或 `details.local:true`（错误码封闭集不破；web/dispatch.ts:93-105 是 wire 有意语义，不动） |
| B4 | `distribution/src/modules-yaml.ts:53` | writeBinding 全库唯一非原子写，安装器能写出让 daemon 启动大声失败的半个 modules.yaml → 改用 daemon-core 已导出的 atomicWriteFile；installer 遇非法条目抛同款 TopoError（同时收窄 B5 的双真相） |
| B5 | `web-ui/src/lib/store.svelte.ts:89-93` | graphsList/previewGraphId/previewData/previewLoading 漏 `$state` → 图列表/静态预览不响应；补 `$state` + 预览开关断言（store 预览路径现零测试） |
| B6 | `daemon-core/src/core.ts:1173-1176,1191` | reconcileExternal 吞一切错误：EACCES/ENOSPC 与执法拒绝不可区分，外部编辑静默丢弃 → catch 下沉 `this.warn(...)`（warnings 已是公共可观察面，加法不破契约） |
| B7 | `distribution/src/install.ts:80-90` | npm pack/tar 子进程无超时，registry 挂起 → `module add` 永久挂死 → 可注入 timeout（默认 120s），超时 kill + TopoError |
| B8 | `cli/src/usage.ts:88` | help 承诺 `version` 动词、实际只有 `--version` 旗标（cli/index.ts:862-871）→ 文案改齐（help 即公共契约） |

## 批次 C · 结构深化（deepening，按建议强度排序）

| ID | 强度 | 位置 | 内容 |
|---|---|---|---|
| C1 | Strong | `client/src/{ipc,ws,memory}.ts` | **SessionTransport 基座**：10 个 Session 方法在三 adapter 手写转发，pending/timeout/failAll/listener 管道 ipc 与 ws 各写一遍（ipc.ts:276-317 ≈ ws.ts:386-438）→ 共享传输基座（pending 表+超时+failAll+泛型 request），三 adapter 只覆盖传输策略；`IpcResultMap`（wire.ts:38-51，现零使用）转正为类型脊柱。**契约套件三 adapter 复跑即安全网，测试面零变化。** 删除测试：删三份转发，复杂度收敛进基座 |
| C2 | Strong | `daemon-core/src/core.ts:389-419`、`module-host/src/host.ts:380` | **删 core 假面**：core.run 恒抛 UNKNOWN_COMMAND 全仓零调用者；catalog 的 modules("0.0.0")/commands([]) 无消费者 → 删 run、catalog 收窄 kinds，目录聚合归 module-host 独占。需 PRE-2 决策记录 |
| C3 | Worth exploring | `distribution/{install,modules-yaml}.ts`、`module-host/{discover,bindings}.ts` | **清单解析归一**：module.yaml 严格版（discover）vs 宽松版（install probe，不查 requires/kinds 形状）、modules.yaml 校验版 vs 静默跳过版，错误发现点后移一个 seam → 一份解析 module（distribution→module-host 单向借入或下沉叶子），install/load 严格度=一个参数；modules-yaml.ts（54 行 shallow）消失。注意保持 distribution 不反向依赖（无环已验证） |
| C4 | Worth exploring | `client/provision.ts:74-100`、`web/server.ts:173-205`、`distribution/skills.ts:120`、`daemon-core/paths.ts` | **布局知识收口**：图枚举三处复制（同序 readdir→滤隐藏→sort→loadManifest）+ web-ui 手写返回形状 + skills.ts 手拼池路径 → paths.ts 长全（projectPoolDir/globalPoolDir）+ 单一 listGraphs（daemon-core 文件层）；顺带收敛 lifecycle.ts/runtime.ts 的 re-export 链。防“预览列表与 `toporealm graphs` 行为漂移” |
| C5 | Worth exploring | `protocol/src/query.ts`、`daemon-core/src/core.ts`、`cli/src/index.ts:390-411,540-555`、`module-host/src/host.ts:443-451` | **邻域查询协议加法**：`read <id>` 一次命令 3 次全图读、link 缺省 --kind 全图枚举、host did-you-mean 两连读 → ReadQuery 增 `adjacent`（或 kind 聚合 op），core 一处实现（normalize 已按端点建索引），三 caller 删客户端过滤；wire 面 O(全图)→O(邻域)。需 PRE-1 决策记录 |
| C6 | Speculative | `daemon-core/src/core.ts:1115-1216` | **watch/reconcile 拆分**（可选）：约 100 行外部编辑监视与提交管线正交，拆 `daemon-core/watch.ts`（adapter 产出 changes 喂回 convert），core 回纯管线且 watch 可独立测试（现只能经 MemoryClient.reconcileNow 绕行）。核心管线本身判定 deep，不动 |

## 批次 D · P2 清理（机械项合一批）

- 死代码：`module-host/host.ts:194-196` parseManifest、`protocol/events.ts:25` RunResult、`distribution/install.ts:507-513` distributionVersion（IpcResultMap 随 C1 裁决）。
- 注释漂移：`protocol/entities.ts:49`“M1 恒为空数组”、`core.ts:1269-1270` 化石块、`migrate.ts:404-416`（注释说继续写入实际中止）、`web-ui/App.svelte:239` MCP 死文案（ADR-0006 残留）。
- 重复收敛：commit/commitSync 的 ifRevision 块（core.ts:222-262）、undo/redo 提参（core.ts:312-385）、cli `g.root ?? defaultRoot(deps)` ×15 → withRoot helper、cli/index.ts:270 死分支（CORE_VERBS 无含连字符动词）。
- 类型与魔数：`store.ts:241` `parsed.rec as never` 条件收窄；`ws.ts:433-438` 排队上限 15s 与重连预算（最长约 40s+）对齐；`cli/index.ts:683` serve 轮询同查。
- 顺序修正：`install.ts:399-401` removeModule 先删绑定后删目录 → 倒序（防孤儿目录）。
- 测试基建：bindingYaml ×3（host.test.ts:19 / modules.contract.test.ts:19 / envelope.test.ts:225）→ 共享 helper；CLI golden 助手两套合一；孤儿 0.x 夹具 `tests/fixtures/runtimes/*.ts`（引用已删除路径，全仓零引用）删除；可选：ModuleHost 同步“装载诊断”出口替代 `globalThis.__toporealm_late_catch__`（host.test.ts:445-479）。
- 覆盖缺口补齐：web/dispatch 分支 + static 路径穿越 403、core.events fromRevision 回放与 undo/redo 后 reset 分支（core.ts:472-507）、web-ui store 预览路径。

## 执行顺序与依赖

1. **PRE-1～PRE-4 蓝图决策记录先行**（半天；PRE-3/PRE-4 可与 A 批并行讨论）。
2. **批次 A**（P0 四修 + 回归测试）——一切的地基，C1 的重构也要踩在这块地上。
3. **批次 B**（8 项 Quick 级，可并行散做；B4 顺带收窄 C3 范围）。
4. **批次 C**：C1（契约套件护航）→ C2 → C3 → C4 → C5（协议加法最后做，单独过 golden）。
5. **批次 D** 机械清理随时插入，独立成 commit。
6. 收口：全量门禁 + 发布（对齐 1.1.x 节奏：CHANGELOG、跨包版本同步、npm publish 冒烟）。

## 验收门

- 全量 vitest 绿（现基线 218+ 用例）+ 10 包 typecheck 绿；新增测试：并发 commit、缺口回放、并发 hello 换载、换载后 stop、静态预览响应、find 多 kind。
- 红线七条 grep 复验清单（daemon-core 无 module-host import、错误码无越集、core 无 payload 解释、无 fail-closed 新门禁）。
- npm pack 冒烟：陌生环境建图全流程（Windows 下先 `export PATH="/c/Windows/System32:$PATH"` 规避 GNU tar 坑）。
- dogfood dev 图冒烟：dev CLI/dev daemon 接管后 P0–P3 路径复跑抽样。

## 明确不做（1.2.0 范围外）

- 不新增任何用户可见功能；不动 CLI 动词语法（除 B8 文案、B2 fix 文案这类纠错）；不引 MCP；不新增 core 执法；不推翻任何现行 ADR；web-ui 不做框架/构建升级；0.x 迁移（migrate）逻辑不动（仅注释纠偏）。

---

# 增补（2026-09-26 深夜 · 1.1.3 发布后 · 功能性核验轮）

## 基线更新

- 当前 HEAD `27d2288` = **1.1.3**：D34 WebUI 白屏根修（`prepack` 构建 web-ui 入包、静态解析序 TOPOREALM_WEB_STATIC > 本包自定位 ../dist > 工作区 web-ui、新错误码 `WEB_STATIC_MISSING`、`endpoint.webStatic` 布尔、GET / 纯 WS 模式 503 说明文本）+ claude 插件载荷收窄进 `plugins/toporealm/` 自包含目录（Windows marketplace add EPERM 根修）。
- **全量测试基线转红 → 已归因（功能性核验轮）**：44 failed / 182 passed（226 用例，7 文件）。后端组对照实验：默认环境 38 failed（后端域）→ `TOPOREALM_HOME=<空目录>` 隔离后仅剩 1 个（paths.test 缺省解析用例自身未 sanitize 环境变量，干净 CI 必过）；CLI 组：cli/distribution 域隔离后 121/121 全绿。**结论：0 产品回归，100% 为测试隔离债**——开发者机 `~/.toporealm/modules/workflow`（ns=wf）泄漏进未注入 globalRoot 的 `ModuleHost.load`，与 fixture 命名空间冲突（host.ts:147-159），wf.* 命令混入 host.test.ts:471 冻结断言同根。修复方案见批次 G5。

## 批次 F · UX 待修任务（quick 级；来源：grill-with-docs 会话 + dogfood dev 图 `ux-*` 对象）

| ID | 归属 | 内容 | 改法 |
|---|---|---|---|
| F1 | CLI | `ux-argv-positionals`：Argv.positionals() 原样返回 rest，未消费 flag 混入位置参数（module add --global 已修一例，通用性未收） | positionals() 过滤 `--` 前缀 token，或文档写明「先 flag 后位置」纪律 |
| F2 | CLI | `ux-read-undefined`：read `--fields` 投影缺键时人类输出显示 `[undefined]` | 缺键输出空白或省略方括号段 |
| F3 | workflow 模块 | `ux-create-task-id`：create-task 帮助说「id 必填」但不说 id 在 `--input`；位置参数传 id 报 UNKNOWN_ID 误导 | 帮助写明 id 位置，或位置参数兼容作为 id |
| F4 | workflow 模块 | `ux-claim-claimby`：claim-task 输入键 `claimBy` 与帮助描述 `assignedTo` 不一致 | 帮助列出输入键名 |
| F5 | workflow 模块 | `ux-depends-direction`：depends_on 方向语义（source=前置、target=后继）帮助/cmds 均未说明——agent 首次建模 30 条边全部写反，直到 DEPENDENCY_UNMET 才暴露 | 帮助写明方向；考虑创建时就绪期校验提示（环/悬空） |
| F6 | workflow 模块 | `ux-verify-keys`：verify-task 报错不点名输入键（mode:self 报「source 不能为空」无法定位）；12 条 wf.* 帮助统一列输入键名与类型 | 报错点名缺失键归属；cmds 帮助含输入键 schema |
| F7 | workflow 模块 | record-report `id` 语义易混淆（会话点名，dev 图无独立对象）：input.id 是报告自身 id（报告是独立证据对象），target 才是任务 | 帮助消歧 id 与 target 语义 |

注：F3–F7 落在 workflow 模块源（dogfood dev 工作区经 workspace 池装载，`modules.yaml: workflow: source: workspace`）；实施时先确认模块仓归属（本仓参考源 vs 独立仓）。

## 执行顺序增补

批次 F 与批次 B 同级并行（均为 quick 级，F1/F2 随 CLI 动词面改动顺手收；F3–F7 在 workflow 模块源单独一批）。功能性核验轮（前端/后端/CLI/功能齐全性四路）的补充发现回填批次 A–F。

---

# 功能性核验轮回填（四路子代理 · 2026-09-26 深夜）

## 核验方式与总判定

- 前端：web-ui 全量走链 + 4 场景运行复现（临时目录，DOM 级断言）；CLI：全部动词真实执行 + README 照抄 + 退出码/信封全查；后端：真实 daemon 13 组实验（NDJSON IPC/裸 WS/双连接）+ 测试隔离对照；齐全性：blueprint §1–§10 / CHANGELOG 1.1.0–1.1.3 / README 中英 / CONTEXT / ADR 全量对账。
- **总判定：44 个红测试 100% 为测试隔离债，0 产品回归**；但产品存在 **5 个运行实证的功能缺陷**（用户例子的切图整链死 + 并发 commit 双写 + WS 重连漏事件 + 换载 TOCTOU 跨图落盘 + 损坏模块砖化无自愈），另有一批承诺漂移与解析陷阱。

## 批次 A 证据升级（静态 → 运行实证）

- **A1 并发 commit 双写（实锤）**：同连接管线双 commit → 均返回 rev2、`.log=[1,2,2]`、先提交对象从内存 read 消失、重启后从实体文件「复活」并产生幻影 redo 段（undoCursor 钳制）；`ifRevision` 护航失效（比较发生在 land 前）。修法不变（convert promise 链互斥），测试用「同连接管线双 commit」作回归。
- **A3 换载 TOCTOU（实锤）**：active=g2、连接钉 g1，同连接两个 commit 分别落 `g2.log` 与 `g1.log` 且都返回 ok——`beginOp` check-then-act（runtime.ts:112-118）+ `activeStampCache` 先于 `swapPromise` 赋值（runtime.ts:92 vs 97）+ ensureGraph 不设 swapPromise（:104-109）。修复须三处一起收口。
- **A2 新增第二处 WS 回放缺陷（与缺口路径同修）**：重连握手覆写回放起点——`ws.ts:279` `lastRevision = res.revision` 后 `:284-290` 用覆写值重订，落在退避窗口内的提交 **3/3 复现永不补送且无 reset**（instanceId 未变）。WebUI 将「看似在同步」实则带着旧数据。

## 批次 G · 功能核验补充修复

### G1 前端（web-ui）

| ID | 位置 | 问题 → 修法 |
|---|---|---|
| G1-1 | `store.svelte.ts:89-93`（消费点 App.svelte:26,28,101,169） | **切图整链死根因（运行复现实锤）**：graphsList/previewGraphId/previewData/previewLoading 四字段漏 `$state` → `App.svelte:101` 的 `{#if store.graphsList.length>0}` 首评 false 后永不重跑（下拉永不渲染）；`previewing` derived 永不翻转（预览覆盖层永不出现）。事件链与数据链实测全通，只断响应性。**修法：四字段补 `$state()` 一处即复活整链**。原计划项 B5 升级为 critical |
| G1-2 | `store.svelte.ts:186` + `App.svelte:218,389-395` | openPreview 失败进黑洞：置 `error` 但错误态要求 `!store.snapshot`（假）→ 无任何 UI 反馈 → 失败可见性（actionMessage 或错误态条件修正） |
| G1-3 | `store.svelte.ts:340-351→208-211→132-154` | WS 会话泄漏：`load()` 无条件新建会话不 close 旧的——每次 reset（external-edit/daemon-restarted/graph-switched）与 recovery 都堆一条连接 → `load()` 开头 dispose 旧会话 |
| G1-4 | `store.svelte.ts:315-317` | graph-switched 提示复用「daemon 已重启」文案 → 按 reason 分文案 |
| G1-5 | `store.svelte.ts:93,174,188` | previewLoading 有写无读 + openPreview 无 in-flight 守卫（修 G1-1 后快速连选两图会暴露后发先至）→ 补加载指示 + 守卫 |
| G1-6 | `App.svelte:837-999` 等 | 约 25 条死 CSS（.graphs-flyout/.validation-* 等，0.x 图库浮层残留，编译器逐条告警）→ 删 |
| G1-7 | `web-ui/vite.config.ts` | dev 模式无 `/api` 代理：`npx vite` 下 refreshGraphs/openPreview 静默 404（生产同源不受影响）→ 补 proxy |
| G1-8 | 测试 | 预览整条路径零测试（决定性盲区：**纯 store 字段断言测不出 $state 缺失**，必须 mount + DOM 断言——43/43 全绿与功能坏死并存的直接原因）→ mount 级预览用例 |

### G2 CLI / daemon 可观测性与解析陷阱

| ID | 位置 | 问题 → 修法 |
|---|---|---|
| G2-1 | `client/src/ipc.ts:82`（stdio:"ignore"）+ `:131-137` | **daemon 启动失败真实原因被吞**：项目池坏模块 / modules.yaml 损坏 / graph.yaml 非 v3 三种场景 CLI 只见 `[DAEMON_UNREACHABLE] 等待就绪超时`（10s），精确原因只在被丢弃的 toporeald stderr（含 hint 让用户「手动运行 toporeald 观察输出」自认丢信息）→ spawn 捕获 stderr，超时错误体携带真实死因（封闭码不变） |
| G2-2 | `usage.ts:125-142`（values 收集到下一个 --flag 才停）+ `cli/index.ts:438-450,390-392` | **flag 在前的文档写法直接坏**：`find --kind X k=v` → k=v 被吞进 kind 报用法错误；`read --kind X <id>` → id 被当 kind **静默返回整类数据 exit 0**（agent 无感拿错数据）；`read <id>` 单点模式静默丢弃 --kind/--where/--fields/--limit → Argv 解析收口 + 单点模式对旗标显式报错或生效 |
| G2-3 | `cli/index.ts:749-751` | undo 99（仅 6 步可撤）谎报「undid 99 step(s)」→ 打印实际步数 |
| G2-4 | `cli/index.ts:695-705` | serve `--port` 在 daemon 已运行时被静默忽略 → 复用路径校验并明示 |
| G2-5 | `cli/index.ts:857` | migrate 报告明细提示写错信封位置（error.→data.）→ 改 `data.conflicts/...` |
| G2-6 | `web/src/dispatch.ts:168-223` | 未知 wire op 无响应（switch 无 default）请求悬挂 30s → 回封闭码错误响应 |
| G2-7 | `daemon-core/src/store.ts:270-276,289-316` | **无换行残行毒化好行**：半行残行后新提交 appendFile 直接拼接 → 重启后该好行被吞（审计断档、undo 幅度缩水）且无 warning → 追加前确保换行或加载时检测修复 |
| G2-8 | `module-host/src/bindings.ts`（parse 路径） | modules.yaml 损坏抛裸 YAMLParseError 绕过封闭错误码（大声失败成立，码契约缺位）→ 包 TopoError |
| G2-9 | 产品决策 | 损坏项目池模块砖化 daemon（设计内大声失败）但 CLI 无自愈：`module rm` 因无所有权标记拒删，唯一出路手工 rmdir；且 `module list` 对同目录优雅标注（同一损坏两种待遇）→ 决策：提供损坏模块清理路径（如 `module rm --force` 或 rm 对「清单不可读」目录豁免 marker）+ 错误文案直指清理命令 |
| G2-10 | `cli/index.ts:270,894` 等 | 杂项：含 `-` 错拼动词跳过 did-you-mean；`--version` 任意位置劫持；`help <核心动词>` 无 per-verb 帮助；本地目录不存在被 auto-detect 当 npm spec 去 pack（友好报错不可达）；`module rm 未安装id` 报「无所有权标记」误导 |
| G2-11 | `core.ts:208-218` | log 只显示 undo 游标前提交（undo 全部后 log 空、canRedo=true）——审计叙事与直觉有张力 → help/文档写明语义或调整 |

### G3 契约承诺缺口（AGENTS 约定：先改 blueprint 再写代码）

| ID | 承诺 vs 现实 | 改法 |
|---|---|---|
| G3-1 | 蓝图 §1.1：VETOED「点名否决模块 + 理由」——实现只有理由无模块名（core.ts:556-571，module-host 注册时未包装归属 host.ts:301-307） | module-host 注册钩子包装归属补实现；或蓝图改注「模块自行报家门」 |
| G3-2 | 蓝图 D24②：WebUI inspector 表单从目录读取——module-host/wire 已投影 catalog.forms，**web-ui 零消费**（moduleProjection.ts:3 自注「预留 v1.1」） | 1.2.0 补 WebUI forms 消费端，或蓝图/CHANGELOG 改注预留 |
| G3-3 | 蓝图 D28 Y4④/ADR-0008：claude SessionStart 钩子「CLI 不在 PATH 兜底静默」——hooks.json:10 是裸命令无兜底，CLI 缺席时会话启动必报错噪音 | hooks.json 补跨平台静默兜底（或包装脚本），否则改文案并记录依据 |
| G3-4 | 蓝图 D27：「warning 必须上浮到 status/module list」——status 无 warnings 通道（GraphSummary 无字段），装载期 warning 只落 detached daemon 的 stderr（用户实际看不见） | protocol 增量加 GraphSummary.warnings（加法）+ status 渲染；或蓝图改注 |
| G3-5 | 蓝图 D26：help 回显解析后的全局根/项目根——help 是纯静态文本（module list 已做） | help 尾部补两行实际路径回显，或蓝图收窄承诺 |
| G3-6 | 蓝图 D25：README 声明 @lukawi/toporealm-client ^1.0.0 break——CHANGELOG 有，README 中英均无 | README 安装节补一句 |
| G3-7 | 蓝图 D30⑥：reset 事件 instanceId 载荷——events.ts:18-22 只有 graphId | 补字段（加法）或蓝图删字（实际影响≈0） |
| G3-8 | pi 扩展 session_start 入场摘要 Windows 恒不可用：pi-briefing.ts:54 `execFile("toporealm")` 不经 shell 无法执行 .cmd shim → 静默 catch | Windows 经 shell/spawn 或 cmd /c 包装 |
| G3-9 | `install.ts:251` ID_EXISTS hint「模块集启动冻结，更新后需重启 daemon」实测为假——真实机制：hello 摘要复验→SESSION_STALE→daemon 自旋退出→客户端重拉（每次触达 PID 都变）；同文件 note「下次触达自动装载」为真 | 删「需重启」表述，两句话统一为「下次触达自动生效（daemon 自动换血）」 |
| G3-10 | plugins/toporealm/.claude-plugin/plugin.json version=1.1.2 vs 整仓 1.1.3 | 版本对齐并纳入发布流程同步清单 |

### G4 文档纠错（一次批量 PR）

- `PROJECT-STATUS.md`：停在 1.1.0、包表仍列已删的 host sync（两处）→ 刷到 1.1.3。
- README：包表「~16 动词」实为 20；中英结构漂移（中文多包职责表与哲学链接）；`Toporealm设计构想.md` 被链为现行哲学但仍写「CLI/MCP 工具」（ADR-0006 冲突）→ 加 0.x 标注。
- blueprint：§2:591 module-sdk「子路径」→ 独立包名；§1.8 前言「§2–§9 仍为 1.0 形态」→ 实际 §3/§4/§5 已收敛；D30⑥ instanceId 措辞对齐 G3-7；titleKey 补「1.x 未投影，显示名约定 payload.title」。
- CONTEXT.md「静态预览」vs UI 实际用词「只读预览」（App.svelte:172）、「专注图」vs「（编辑中）」——术语与 UI 二选一对齐。
- README 第 12 步 wf.create-task 示例补 `id`（照抄即失败，实测 exit 1）。

### G5 测试隔离债与盲区（红基线的根治）

- **全部涉及 ModuleHost/双池的测试注入显式 `TOPOREALM_HOME`/globalRoot**（约 5 个测试文件：modules.contract、host.test、三份 contract、envelope/e2e 间接）——当前测试结果依赖开发者机器 `~/.toporealm` 状态，CI 干净所以绿、本机必红。
- paths.test.ts 缺省解析用例对自身环境变量 sanitize（隔离实验中反被绊倒）。
- 补运行实证缺陷的回归测试：同连接管线双 commit（A1）、重连退避窗口事件补送（A2b）、双图交叉提交落图断言（A3）、webUI 预览 mount 级用例（G1-8）、未知 op 错误响应（G2-6）、残行后追加恢复（G2-7）。

## 执行顺序增补（修订）

1. 批次 A（P0 并发四修，证据已升级）→ 2. 批次 G1-1 一行主修（切图复活，可随 A 同车）→ 3. 批次 G5 测试隔离债先行合入（让全量门在本机也真实可信）→ 4. 批次 B + F + G2/G4 快赢批 → 5. 批次 C 深化 → 6. 批次 G3 契约缺口（随 blueprint 决策记录）→ 7. 收口发布。
