# Changelog

## Unreleased

- **feat(base)**：模块模板与 module-creator 基座技能（blueprint §1.12 D43）——聚合包
  `files` 增 `template/modules-template`（覆盖声明层全部字段 + activate 全注册面
  （命令双形态/before-commit 门禁与 conversion 豁免/after-commit 排队追加/form）+
  模块自带 skill + 自包含构建链的可构建脚手架）；基座技能
  `skills/module-creator` 教授从模板创建模块全流程（复制→改名→词汇表→activate→
  构建→安装→验证）；pi 扩展改为枚举 `skills/` 子目录（新增基座技能自动可见）；
  claude 插件 skills/ 增同源副本。
- **feat(cli)**：新动词 `discover`（blueprint §1.12 D45）——agent 入场三件套一命令
  拼装：status + 命令目录 + 技能索引（拉 daemon，与 cmds 同语义；技能索引仍纯
  文件层不建第二存储）；`--json` data = `{status, commands, skills, warnings}`
  （内核 warning 上浮一处），人类模式紧凑分节；CORE_VERBS/help/per-verb help
  收录；golden 信封与 usage 用例补齐（envelope 共享 exec 注入隔离
  `TOPOREALM_HOME`——deps.env 是 CLI 全局路径解析唯一出处，全局池读路径不再看
  开发机真目录）。
- **feat(toporealm)**：四基座技能定稿（D45）——`toporealm`（入口：CLI 动词手册 +
  动态发现纪律，目录自 toporealm-cli 更名）、`toporealm-design`（机械建模原则）、
  `toporealm-ops`（低频运维与 daemon 排障）与既有 `module-creator`；命名约定
  `toporealm-*` 前缀（模块技能一律 `<模块id>-*`）；聚合包与 claude 插件 skills/
  同源副本；资产防漂移用例随目录改名更新。
- **feat(base)**：claude 插件删 SessionStart 钩子（D44）——`hooks/`（hooks.json +
  skills-index.mjs）退役，插件载荷收敛为纯技能包（`.claude-plugin/plugin.json` +
  `skills/`）；被动感知由 AGENTS.md 工作区层（init 提示补「本工作区是 toporealm
  工作区，agent 入场先跑 discover」）+ 入口技能→discover 承接；ADR-0008 池即
  唯一存储不变。
- **feat(workflow)**：模块仓 `@lukawi/toporealm-workflow` 同升 1.0.2（独立仓提交）——
  `workflow-design` 技能开头补「机械建模原则见基座 `toporealm-design` 技能」；
  版本钉点同步（package.json/module.yaml/src 身份常量/模块仓测试），主仓
  workflow 模块 e2e 版本断言随升 1.0.2。

## 1.2.0 - 2026-09-26

主题：**修复与内部优化**（blueprint §1.11，D35–D42）。依据：架构评审 + 四路功能核验
（`docs/rebuild/plan-1.2.0-fixes.md`）。公共契约不变：CLI 语法、错误码封闭集（仅加
`details` 字段）、wire 既有消息（仅加 `ReadQuery.adjacent`）、module.yaml schema、
graph v3 格式。模块仓 `@lukawi/toporealm-workflow` 同发 1.0.1（帮助与报错 UX 五项）。

### 正确性修复（并发面，全部有运行级回归测试）

- **fix(daemon-core)**：commit/undo/redo/外部吸收管线 promise 链互斥——原实现
  revision 在 stage 定版、land 才生效，persist 的 await 让渡点上并发提交同
  revision 双写、内存丢更新、`ifRevision` 失效（实测 `.log=[1,2,2]`、先提交对象
  重启后才"复活"）。同步提交路径（模块 `api.commit`）经 module-host 的
  `runExclusive` 段独占管线（发布前对抗审查抓出的遗漏，异步 handler 中途
  api.commit 与在途管线交织可复现同签名腐蚀）。
- **fix(client)**：WsSession 回放双缺陷——缺口自愈先推进基准再重订（缺口事件永不
  补齐，违反自声明 I3）；重连握手覆写 `lastRevision`（退避窗口内提交 3/3 复现
  永不补送且无 reset，WebUI"看似在同步"实则带旧数据）。
- **fix(daemon)**：换载门 TOCTOU 收口——`startSwap` 先挂 `swapPromise` 再执行
  （消除 `beginOp` 穿透）；`ensureGraph` 走同一互斥门（并发双开内核、跨图劈半
  落盘实测修复）；`GraphRuntime.dispose()` 归一当前核清理（原 stop() 只 dispose
  启动时的旧核，换载后 watcher 泄漏）。

### 功能修复（看似没 bug 但实际不可用的一批）

- **fix(web-ui)**：顶栏图切换下拉与只读预览覆盖层整链复活——四个 store 字段漏
  `$state` 致模板永不重渲染（D30 功能自发布起不可达的根因）；预览失败可见性、
  reset 重读的会话泄漏、按 reason 分文案、in-flight 守卫、死 CSS 清理、vite dev
  代理、mount 级预览用例 11 例。
- **fix(cli)**：`find` 多 `--kind` 恒空集（交集语义）改本地并集；`--kind` 改可重复
  单值（`read --kind X <id>` 不再把 id 吞进 kind 静默返回整类）；单点 `read` 对
  过滤旗标显式报错；undo/redo 打印实际步数；`serve --port` 复用时明示；migrate
  信封位置文案；`help` 去除已废除的 version 动词承诺。
- **fix(client)**：daemon 启动失败真实死因上抛（原 CLI 只报「等待就绪超时」，
  坏模块/坏 modules.yaml/坏 graph.yaml 的精确原因被 `stdio:"ignore"` 丢弃）。
- **fix(distribution)**：`writeBinding` 原子写（能写出让 daemon 拒启的半个
  modules.yaml）；npm pack/tar 子进程 120s 超时；**损坏模块自愈（D42）**：
  `module rm <id> --force` 对清单不可读目录豁免所有权标记（原 CLI 内无任何命令
  能修复砖化的项目池）。
- **fix(daemon-core)**：.log 追加前确保末尾换行（半行残行毒化后续好行，重启丢审计）；
  外部编辑吸收被拒下沉 warning（盘错误与执法拒绝可区分）。
- **fix(web)**：未知 wire op 回 UNKNOWN_COMMAND（原悬挂 30s）；换载重订阅收口
  （reset 只推有订阅连接，消除瞬态错图窗口）。
- **fix(module-host)**：modules.yaml 损坏包 TopoError（不再裸 YAMLParseError）。

### 契约补全（blueprint D36–D38，均只增不改义）

- `ReadQuery.adjacent`：邻域查询——`read <id>` 单命令单次读（原命中路径 2 次读、
  wire 全量），协议加法。
- `VETOED` 的 `details.vetoes[]` 增 `module` 字段：点名否决模块（对齐 §1.1 既有承诺）。
- `GraphSummary.warnings?`：status 上浮装载期 warning（原只落 detached daemon 的
  stderr，用户实际不可见）。

### 结构优化

- **SessionTransport 基座（D40）**：Session 十法与 pending/超时/failAll 管道收敛
  唯一份，三 adapter 只留传输个性（删重复约 220 行）；`IpcResultMap` 转正为
  op→result 类型脊柱；契约套件零改动全绿；浏览器出口不变。
- **core 假面收口（D35）**：删恒抛的 `core.run`，`core.catalog` 收窄 kinds 投影，
  命令目录聚合归 module-host 独占。
- **清单解析归一**：安装器与装载器共用 `parseModuleManifest`/`readModuleBindings`
  （严格度=一个参数），`modules-yaml.ts` 删除；requires/kinds 形状坏的清单**安装期
  即拒**（原装载期才炸）。
- **布局收口**：`projectPoolDir`/`globalPoolDir`/单一 `listGraphs`（CLI 与
  `/api/graphs` 同一实现）；批次 D 机械清理净删 406 行。

### 面向 workflow 模块用户（`@lukawi/toporealm-workflow` 1.0.1）

- 12 条 `wf.*` 帮助统一列出必填/可选输入键；`create-task` 帮助写明 id 只放
  `--input`；`claim-task` 键名统一 `claimBy`；`create-relation` 写明 `depends_on`
  方向语义（source=前置/target=后继）；输入缺键报错点名命令与键名（原
  「source 不能为空」无法定位归属）；`record-report` 消歧 input.id=报告自身、
  target=任务。

### 文档与配套

- PROJECT-STATUS 刷新；README 中英（动词数、快速上手 id、1.0→break 声明、0.x
  构想标注）；blueprint 错误码 fix 示例/§2 包名/§1.8 前言形态分层对齐；CONTEXT
  「静态预览」用词注记；claude 插件 hooks 兜底静默（CLI 不在 PATH 时会话启动
  零噪音）+ 插件版本对齐 1.2.0；测试隔离债根治（默认环境全量绿，不再依赖开发者机
  `~/.toporealm` 状态）。

## 1.1.3 - 2026-09-26

- **fix(web)：WebUI 白屏根修（blueprint §1.10 D34）**——1.1.2 的
  `@lukawi/toporealm-web` tarball 从未包含 web-ui 构建产物，且缺省解析按 monorepo
  私有名 `@toporealm/web-ui`（npm 上不存在）定位：全局安装必落空 → daemon 静默
  降级纯 WS 模式（GET / 空体 404）而 serve 照常开浏览器——用户看到白屏。修法：
  ① web 包 `prepack` 构建 web-ui 并复制 `dist/` 入包（`scripts/pack-web-dist.mjs`）；
  ② 静态目录解析序 `TOPOREALM_WEB_STATIC` > 本包自定位 `../dist` > 工作区 `web-ui/`；
  ③ 守卫：`endpoint.json` 新增 `webStatic` 布尔，serve 纯 WS 模式抛
  `WEB_STATIC_MISSING`（错误码新增）且不开浏览器，无静态处理器时 GET / 返回 503
  说明文本；老 endpoint（无 `webStatic` 字段）以一次 HTTP 探测判定。
- 面向用户：全局安装 `toporealm serve` 现在能直接打开 WebUI 界面，白屏问题升级即修。

## 1.1.2 - 2026-09-26

- **fix(daemon)：unix socket 短路径修复（blueprint §1.9 D33）**——1.1.0 在 macOS/Linux
  上 daemon 首次拉起必挂（CI 三平台实测抓出）：serveDaemon listen 前从不创建 daemon
  目录，libuv 把 bind 的 ENOENT 转译为 EACCES；macOS 另有工作区内 socket 路径超
  sun_path 上限（104 字节）被静默截断。现落 `os.tmpdir()/toporealm-<sha256(root) 前
  16 hex>.sock`（总长 ≤ 80），listen 前建目录、bind 后 chmod 0600（tmpdir 共享目录
  防他用户连）；客户端发现（endpoint.json）与单属主互斥语义不变，Windows 命名管道不变。
- ci: Node 20→22——WS 传输依赖全局 WebSocket（Node 22+），CI matrix 此前不达标；
  README（中英）与 `@lukawi/toporealm-cli`、`@lukawi/toporealm` 的 engines 声明
  Node ≥22。CI 三平台首次全绿。

## 1.1.1 - 2026-09-26

- fix(cli): `module add/rm --global` 的 flag 查询顺序修复——`--global` 先于位置参数被解析
  （1.1.0 首发验收抓出的发布阻断 bug：`--global` 被当包名传给 npm pack）。仅 cli 与聚合包发 1.1.1。

## 1.1.0 - 2026-09-26

主题：**双层工作区 + 作用域模型 + 技能池分发 + 内存换载**（blueprint §1.8，D25–D32；ADR-0007/0008）。

### ⚠️ 破坏性变更（D25：不留别名、无自动迁移）

- **动词面**：`new` → `creategraph`；`version` 子命令废除（改 `--version` 旗标）；`host sync` 删除；
  新增 `init`、`skills index`、`module add/rm --global`。
- **布局**：图存储 `graphs/` → `.toporealm/graphs/`；新增全局目录 `~/.toporealm`（`TOPOREALM_HOME` 可覆盖）。
  1.0 v2 图无自动迁移（手工路径见 `docs/releases/v1.1.0.md`）。
- **manifest**：`toporealm.graph/v3`（删除 modules 字段）。
- **作用域**：模块集 = 全局池 ∪ 项目池 ∪ path 绑定，「装了就生效」（项目遮蔽全局）；
  「图级启用」废除；`modules.yaml` 只剩 path 绑定职责。
- `@lukawi/toporealm-client` 的 `^1.0.0` 依赖会随本版 break。

### 新能力

- **双层工作区**（D26）：`toporealm init` 显式初始化（AGENTS.md 提示：不存在生成、存在只打印建议）；
  全局目录由写路径惰性确保（无 postinstall）。
- **双池装载**（D27）：discover 双池发现，遮蔽 path > project > global，项目池坏模块大声失败、
  全局池坏模块跳过+warning，requires 跨池联合解析；模块集 digest = sha256(pool:id@version)。
- **宿主技能分发**（D28，ADR-0008）：技能文件只存在于池中（零拷贝）——claude 走 marketplace 插件
  （基座技能 + SessionStart 钩子运行 `toporealm skills index` 注入索引）；
  pi 走主包内置扩展（resources_discover 贡献 skillPaths）；host sync 与投影机器删除。
- **内存换载**（D30）：daemon 切图不再杀进程——active 跟随（WebUI 自动重载）+ 显式图钉住会话；
  换载互斥（排空 after-commit）；失败旧图继续服务；runtime 级稳定 instanceId；
  换载推送 reset(graph-switched)，订阅迁移到新图。
- **专注 UX**：`use` 输出「选定图： X（之前 Y）」+ per-shell export 提示；写命令输出带 `[图名]` 前缀。
- **WebUI 静态预览**：图枚举与快照只读端点；顶栏图切换 + 只读预览覆盖层（无切换按钮——专注切换 CLI 唯一入口）。

### 内部

- module-host：双池发现器（discover.ts）+ attach re-binding seam（评审 R1）；parseModuleManifest 提取共用。
- web：wire 分发器 runtime 化（per-request core 解析）。
- 测试：30→31 文件、208→223+ 用例（新增 paths/dual-pool/skills/runtime 换载 e2e）。


## 1.0.0 - 2026-09-23

TopoRealm 1.0 重建完成（M1–M5，blueprint §9）。本仓库不含领域模块；workflow 模块的 1.0 移植见 [toporealm-workflow](https://github.com/LUKAWI/toporealm-workflow)（同步发布 1.0.0）。

### 发布形态（发布前补齐）

- 新增聚合包 `@lukawi/toporealm`（blueprint §2 发布物）：bin `toporealm` + `toporeald`，依赖 cli/daemon/client/distribution。
- `cli`/`daemon` 增 `tsx` 运行时依赖（bin 包装器 TS 加载，装完即用）；`cli` 增 `daemon` 依赖（独立安装亦可透明拉起 daemon）。
- README 重写为发布形态（中/英）。

### M1 骨架

- `protocol`：全量契约类型 + 错误码封闭集（§1.1 全表，只增不改义）。
- `daemon-core`：单属主图内核——提交管线固定序（所有权法 → 悬空边 → before-commit 钩子 → 原子落盘+日志+游标 → after-commit → 广播）、YAML 存储、统一提交日志（D7）、undo 游标、文件监视外部编辑吸收。
- `client`：DaemonClient 三实现——MemoryClient（测试主缝）/ IpcClient（CLI）/ WsClient（浏览器）；自动拉起、重连、instanceId 失效检测。
- `cli`：16 核心动词 + `--json` 信封 + 退出码 0/1/2 + did-you-mean。

### M2 模块系统

- `module-host` / `module-sdk`：双层模块（module.yaml v2 协调 + activate 行为）；命令目录自省（D12 目录永远为真）；所有权法 namespace 映射（D20）；钩子相位执法（LATE_REGISTRATION / REENTRANT_COMMIT / after-commit 排队，D19/D21）；requires 拓扑排序 + MISSING_MODULE。

### M3 Web

- `web` + `web-ui`：HTTP 静态产物 + `/ws`（与 IPC 共用同一 wire 信封与事件扇出，D22）；WsClient 重连补洞与 reset 自愈；web-ui 走 Session 契约（0.x REST 面与 MutationPlan 不迁移）；`serve` 动词。

### M4 分发与迁移

- `distribution`：模块安装器（`npm pack --ignore-scripts` + 本地路径 → `.toporealm/modules/<id>/` + 所有权标记，D23①）；host sync（claude-code plugin / pi extension+skills，钩子格式不混用，D23②）；`migrate`（0.x v1 图机械映射 + 迁移报告，D23③）。

### M5 Workflow 首发移植（本版新增）

- **D24（§1.7）**：`CommitCandidate.conversion`（undo/redo 游标移动豁免领域钩子）；Catalog `forms` 目录投影（D22④ 补课）；workflow 图级档位落 `wf.settings` 单例；模块鸭子类型领域错误分发面认领重建。
- **workflow 模块 1.0**（toporealm-workflow 仓库）：module.yaml v2（ns `wf`）、12 个 `wf.*` 命令、七态/依赖/完成/代签/checkpoint 门禁入 before-commit 钩子；发布门 = 其仓库根 `npm test`（10 文件 45 用例，0.x 语义测试的 1.0 形态）。
- **host sync 模块 skills 投影**：模块包 `skills/<名>/SKILL.md` → claude-code plugin 同层 + pi 原生发现位；基座名保留、冲突记 warning、卸载后重同步即消失。
- **集成验收 e2e**：真实 workflow 模块本地 path 安装 → daemon 装载 → cmds 可见 12 条 `wf.*` → 命令端到端 + VETOED 门禁 + undo。
- 版本对齐 `1.0.0`（root + 10 包 + 跨包依赖）。

### 兼容与边界

- 0.x 图不直接可读：经 `toporealm migrate <旧图目录>` 一次性迁移（报告含冲突/降级/悬空边清单）。
- 无 MCP；宿主适配仅 Claude Code（plugin）与 Pi（extension/skills）。
- 专用 Web 领域视图、registry snapshot / STALE_ACTION / ActionExecutor 六道门禁按蓝图 §7 死亡，不迁移。
