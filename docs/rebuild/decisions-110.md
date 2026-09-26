# TopoRealm 1.1.0 决策草案（grilling 会话记录，2026-09-26）

> 状态：**定稿归档**——本文件是论证过程与对抗评审档案；**权威规范文本已提升至
> `blueprint.md` §1.8（D25–D32）**，架构级决策正式化为 `docs/adr/0007`（作用域模型）
> 与 `docs/adr/0008`（宿主技能分发）。两者冲突时以蓝图与 ADR 为准。
> 背景：1.0.0 已发布（2026-09-23）。1.1.0 规划从头开始，旧 D25 提案作废未占用，本文件自 D25 起编号。
> 基调（用户定）：**边开发边利用**——用 1.0.0 本体 + workflow 模组管理 1.1.0 开发本身（dogfood）。

## D25. 兼容性立场：1.1.0 直接破坏

- **决定**：动词改名不保留旧名、布局变更不做迁移工具、CHANGELOG 声明 breaking。semver 严格性（破坏应升 2.0）明确放弃。
- **理由**：真实用户基数≈0（1.0.0 发布当天全局安装一份）；为不存在的用户负担别名表与迁移器不值；红线「CLI 语法破坏性变更必须升版本」以 1.1.0 满足。

## D26. 双层工作区：全局目录 + 项目目录

- **决定**：
  - 全局目录 `~/.toporealm/`（可用 `TOPOREALM_HOME` 覆盖，测试注入）：**安装本体时自动创建**（npm postinstall + CLI 首次运行兜底确保），内容 = 全局模块池 `modules/<id>/`，目录即注册，无绑定文件（来源记录沿用 `.toporealm-source.json` 安装标记）。
  - 项目目录 `<root>/.toporealm/`：图存储收编进来——`graphs/<图名>/` 从项目根挪到 `.toporealm/graphs/`（多图结构 1.0 已有，纯挪位）；`daemon/`、`active` 照旧。
  - 显式 `toporealm init` 动词初始化项目工作区；若 `AGENTS.md` 不存在则生成、已存在则打印建议片段**不自动改**（不碰用户文件），内容为提示 agent 读 toporealm 技能。
- **理由**：1.0 的工作区寄生在图上（必须先建图），模块注册与图存储无分层；用户痛点实证（建图存储散乱、装模块被迫先建图）。

## D27. 作用域模型：装了就生效，项目遮蔽全局

- **决定**：
  - 模块集 = 全局池 ∪ 项目池，**无第三步启用动作**（1.0 的「图级启用」废除——其实现本就是工作区级装载，graph.yaml 的 modules 列表仅为记录）。
  - 项目装同 id 模块时**项目遮蔽全局**（就近优先）。
  - **不做项目级排除**；命名空间冲突靠现有执法大声报错（启动失败）。
  - graph.yaml 删除 `modules` 字段，清单格式升 **`toporealm.graph/v3`**（诚实标记契约变化；1.0 图不兼容，破坏已定调）。
- **理由**：与「图清单声明启用」的旧分层相比，安装位置决定作用域更符合直觉；1.0 实现的模块装载本就按 root 全量装载（`ModuleHost.load`），改动距离小。

## D28. 宿主技能分发终案：池即唯一存储 + 原生通道读取

- **决定**：模块技能文件**只存在于池中**（全局 `~/.toporealm/modules/<id>/skills/`、项目 `.toporealm/modules/<id>/skills/`），零拷贝、零投影再生。两宿主各走原生通道：
  - **claude code**：基座 marketplace 插件（toporealm 仓库根声明 marketplace，用户一次性 `claude plugin marketplace add LUKAWI/toporealm` + install）。插件内容纯静态：基座 CLI 技能 + SessionStart 钩子。钩子运行 **`toporealm skills index`**（新增子命令）：扫描两个池各模块的 `skills/`，读 SKILL.md frontmatter，逐行输出「技能名 · 所属模块 · 一句话描述 · 绝对路径」，stdout 注入会话上下文；agent 需要时用 Read 加载全文（复刻渐进披露两阶段）。索引按当前工作区解析链生成 → 项目模块技能只在本项目会话出现（作用域隔离免费）。
  - **pi**：主聚合包加 `pi` 字段成为 pi 包（`pi install npm:@lukawi/toporealm` 一次性），内置扩展订阅 **`resources_discover`** 事件，返回池内各模块 skills 目录 + 基座技能目录作为 `skillPaths`——pi 原生发现注册，技能文件仍只在池中。
  - **`toporealm skills index` 同时是 agent 可随时手动跑的命令**（会话中途装模块后自行刷新）。
  - **`host sync` 动词与整套投影机器删除**（所有权标记投影、重同步、冲突跳过）。
  - 模块作者义务收缩为：按 Agent Skills 标准带 `skills/` 目录即可，两宿主同时生效。
- **实测证据**（2026-09-26，项目级 `.agents` 真实目录试验）：
  - claude/ZCode 对 skills 的扫描是**严格一层**：`.agents/skills/<名>/SKILL.md` 可见；`.agents/.toporealm/modules/workflow/skills/<名>/SKILL.md`（池内深层）不可见；`.agents/skills/<ns>/<模块>/<名>/`（skills 内两层/三层嵌套）不可见。与官方文档「浅层固定模式、不递归」一致 → 原生发现池内技能此路不通，钩子索引为既定方案。
  - pi 扩展 API 有 `resources_discover`（session_start 后触发，可贡献 skillPaths/promptPaths/themePaths）→ pi 侧原生动态发现成立。
  - claude 本地目录 marketplace 的相对路径插件「就地加载」（内容不拷贝、每次会话重读）——已 research 确认，本方案未采用（插件纯静态化，无需就地再生）；留作将来演进位。
- **理由**：「装了就生效」一条哲学贯穿模块能力与技能；技能版本 = 池中版本天然锁步；模块作者负担最小；toporealm 不写任何宿主自有目录（`~/.claude`、`.pi`、`.agents`）。

## D29. CLI 动词面（破坏性，无别名）

- **决定**：
  - 改名：`new` → **`creategraph`**；`version` 子命令删除，新增 **`--version`** 旗标。
  - 新增：`init`；`module add/rm` 的 **`--global`**；**`skills index`**。
  - 删除：`host sync`。
  - 不变：`use` / `graphs` / `status` / `read` / `find` / `add` / `set` / `link` / `rm` / `undo` / `redo` / `log` / `cmds` / `serve` / `migrate`（migrate 输出位置随布局变 `.toporealm/graphs/`，1.1 起 migrate 产 v3 图）。
  - `module list` 分全局/项目两段显示、标注遮蔽关系；重复 add 语义与 1.0 一致（`ID_EXISTS`，更新 = rm + add）。
- **理由**：`creategraph` 与领域术语（Graph）一致；动词面一次改齐避免二次破坏。

## D30. 多图专注模型：工作区单数 + daemon 内存换载

- **决定**：
  - 一次一图不变（单属主 daemon 每 root 一进程、当前开一张图）。
  - 切图从「杀 daemon 重启」改为**内存换载**：握手携带目标图 → daemon 冲刷旧图、装载新图（**模块集 root 级，无需重载**）→ instanceId 轮转 → 已连 WS/IPC 客户端收 reset 全量重读（I3 自愈机制已有）。SESSION_STALE 不再用于图不匹配。
  - **专注的唯一改变者 = `use`**：解析链 `--graph` > `TOPOREALM_GRAPH` > active 不变；输出回显「选定图: X（之前 Y）」+ 一行 `export TOPOREALM_GRAPH=X` 提示；所有写命令人类输出回显当前图名（防误伤）。
  - WebUI：专注图 = 实时编辑器（换载后自动跟随）；**其它图 = 静态预览**（新只读端点：图枚举——daemon 扫 `.toporealm/graphs/`；图快照——直接读该图 graph.yaml/objects/relations 渲染，不载入 core）。预览页标注「只读预览 · 当前编辑图是 X · 切换执行 `toporealm use <id>`」。
  - **1.1.0 预览页不提供切换按钮**：专注切换保持 CLI 唯一入口（多终端场景防意外震荡；将来加按钮 = 一行 wire op）。
  - **并编两张图明确不支持**（切图 = 全局动作，WebUI 跟随）；将来确有需求再演进 per-graph daemon（endpoint 按 (root, graph) 定址，已论证可行）。
- **理由**：并编互踩的真实痛点（agent 与 WebUI 指向不同图时 daemon 被拉来拉去、WebUI 被甩图）由「预览替代并编」化解；换载消除了切图 1–2s 冷启动；改动集中在 daemon 生命周期层，core 零改动。

## D31. dogfood 形态

- **决定**：toporealm 仓库根作为工作区（init），建单图 `dev`（单图起步，任务用依赖边表达阶段先后，跨图依赖本就不可行）；用 1.0.0 全局 CLI + npm 安装的 workflow 模组（1.0 语法 `new` + `module add`）管理 1.1.0 开发全程；daemon 运行时文件进 gitignore，图文件与提交日志入库。
- **理由**：图与代码同源、记录随仓库走；单图避免依赖拓扑被图边界切碎。

## 阶段划分

- **P0 dogfood 起步**（1.0.0 语法）：仓库根建图 → 装 workflow 模组 → 录入 P1–P3 全部任务。
- **P1 地基**：先改 blueprint（§1.8 新裁决落档 + §5 daemon 换载规格修订）→ 全局目录 / 布局挪位 / manifest v3 / 双池装载 / 内存换载 / use 增强与写命令回显 / web 图枚举+快照端点与静态预览 UI / 动词面改造 / 测试全量更新。
- **P2 分发**：skills index 子命令 → claude marketplace 插件（基座技能 + 钩子）→ 主包 pi 化（扩展 + 基座技能）→ init 提示文件 → workflow 模块仓库 skills/ 对齐核查。
- **P3 文档与发布**：blueprint / CONTEXT.md 术语（「图级启用」→ 作用域语义；新增「全局池」「技能索引」「专注」；删 host sync 相关条目）/ CHANGELOG（breaking 声明）/ README → 版本对齐 1.1.0 → 发布（npm + marketplace 验证）。

## 拟立 ADR（评审通过后正式化）

- **ADR-0007 作用域模型**：装了即生效、项目遮蔽全局、无排除、v3。
- **ADR-0008 宿主技能分发终案**：池即唯一存储 + claude 钩子索引 / pi 路径贡献；host sync 废除。
- daemon 内存换载属运行时实现裁决（可逆、不意外），记 blueprint §5 修订即可，不立 ADR。

## 附：关键实现事实（源码核查，2026-09-26）

- 装载链：`modules.yaml` 绑定 → `ModuleHost.load` 全量解析（global 来源现跳过+warning，`host.ts:108`）→ 命名空间唯一 → requires 完备 → 拓扑排序 → activate → 冻结；`graph.yaml.modules` 仅记录（`core.ts:127`，被 `setLoadedModules` 覆盖）。
- 解析链：`--graph` > `TOPOREALM_GRAPH` > `.toporealm/active`（`workspace.ts:53`）；root = 显式 > `TOPOREALM_ROOT` > cwd。
- daemon 换图现状：connect 图不符 → handshake `SESSION_STALE` → 客户端等旧 daemon 退出重拉（`ipc.ts:143`）。
- 安装器：npm pack --ignore-scripts → 落位 `.toporealm/modules/<id>/` + 所有权标记 + `modules.yaml` 绑定（D23④ win32 System32 前置已内置）。
- 1.0 claude 投影内容：plugin.json + skills/toporealm/SKILL.md + hooks.json（SessionStart → `toporealm status`）——静态化后原样进 marketplace 插件。
- pi 包形态（本机实证）：npm 包 `pi.extensions: ["./extensions/*.ts"]` + 可选 `skills/`；全局位 `~/.pi/agent/npm/`；`pi install npm:<pkg>`；用户级技能发现位 `~/.pi/agent/skills/` 与扩展位 `~/.pi/agent/extensions/` 真实存在。

## 附二：对抗评审记录（2026-09-26，oracle 红队；结论：全盘采纳）

评审核对 decisions 全文、blueprint 相关章节与 10 处源码；红线层面全部干净（core 执法未扩张、
客户端不直写图、依赖单向、无双宿主格式混用、无 MCP）。以下修正已并入蓝图 §1.8 权威文本：

**🔴 致命（不修则返工）**
- **R1 换载 re-binding 缝**：ModuleHost 命令/钩子闭包硬绑定构造时的 DaemonCore
  （host.ts:67,296-315）——换载新建 core 后直接复用模块会向旧图落盘。修正：ModuleHost
  改持 core 引用（间接层），换载时向新 core 重挂钩子/词汇观察者；activate 恰好一次不变。
- **R2 换载 wire 语义**：换载失败若回 SESSION_STALE，客户端会等一个永不退出的 pid 再重拉
  第二个 daemon 互踩。修正：换载在请求处理内串行完成；失败返回明确错误码且旧图继续服务；
  SESSION_STALE 保留给模块集变化。
- **R3 「无绑定文件」矛盾**：`source: path` 绑定是模块作者工作流与三套测试的接缝。
  修正：两池 = 目录即注册；modules.yaml 收缩为 path 链接的唯一载体。

**🟡 重要**
- **Y1 digest**：哈希遮蔽解析后的有效集（`pool:id@version`），禁止 id 并集或文件原文；
  requires 跨池联合解析、遮蔽发 warning；global 池坏模块跳过+warning（项目池仍大声失败）。
- **Y2 换载竞态**：swap 与 commit/undo/redo 互斥、排空 after-commit 队列、取消外部编辑
  计时器；事件订阅随 re-binding 迁移；reset 事件增补 graphId/instanceId 载荷。
- **Y3 跟随机制（净简化）**：WebUI 自动跟随原设计（握手带图名）有触发盲区（use 后无下一条
  命令则永不跟随）。改为 daemon 每请求检查 active 指针（mtime 缓存），显式 req.graph 优先——
  CLI/Web 统一跟随。
- **Y4 skills index 容错**：纯文件层绝不拉 daemon；坏 frontmatter/超大跳过；重名并列输出
  靠模块列消歧；钩子命令兜底静默；无工作区空输出 exit 0；cwd 子目录索引为空（与 CLI root
  语义一致，init 提示写明会话须在仓库根启动）；pi 侧重名行为 P2 实测。
- **Y5 dogfood 自举**：P0 用 1.0 建的图在 P1 改布局时自己也要迁移——P1 首步显式加入
  自举迁移（杀 daemon → git mv → 手改 v3 → dev 版 CLI 验证）。
- **Y6 postinstall 删除**：纯冗余失败面，CLI 惰性确保覆盖。

**🟢 建议（并入 P1 清单）**：B1 改名波及 fix/hint 文案与 golden 测试全量扫描；B2 1.0 投影
残留手工清理说明（P2 文档）；B3 快照读撞非原子写 = 明确报错不重试；B4 多终端换载不做滞回；
B5 gitignore 粒度（graphs/.log 入库，daemon/modules/active 不入库）；B6 `^1.0.0` 客户端
破坏 README 声明；B7「core 零改动」表述更正（仅指提交管线与执法面）。
