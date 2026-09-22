# TopoRealm 重建决策草案（grilling 会话记录）

> 状态：**草案**——每条只代表当前设想，未经最终确认；达成共识后提升为正式 ADR。
> 对照文档：`Toporealm设计构想.md`（哲学）、`Toporealm代码库现状.md`（现状）。

## D1. 兼容性立场：彻底重建，新契约

- **决定**：不背 0.x 兼容包袱。图格式 `toporealm.graph/v1`、模块清单 `toporealm.module/v1`、可恢复提交协议 v1 全部废弃，升为新版本契约。
- **含义**：
  - 已发布 Core 0.1.3 / 0.2.0 候选与 Workflow 0.1.0 不约束新架构；
  - Workflow 模块语义事后移植；
  - 旧图数据是否提供一次性迁移工具：待定（D-系列后续决定）。
- **理由**：preview 阶段用户面极小，打破契约成本处于历史最低点；旧契约（约束型模块协议）与新哲学（约束下放插件）方向相反。

## D2. 产品定位：平台/基座产品（非纯工具）

- **决定**：第三方模块作者仍是一等公民；npm 分发、安装/信任机制保留但重新设计。
- **⚠️ 挂起的张力**：此决定与“极简 core + 约束下放插件”的哲学存在直接张力——面向第三方时，信任边界不会消失，只能换位置（从 core 硬编码 → 协议/安装期/运行时沙箱？）。待模块系统分支展开时解决。
- **理由**：用户明确选择平台野心；与构想文档开头“工具”措辞不一致，术语待后续收敛（工具 = 基座产品？）。

## D3. 核心数据模型：最小类型信封

- **决定**：新 core 知道的全部领域概念 = 对象、关系、id、命名空间化 kind（唯一语义字段，core 只透传不解释）、不透明 payload、revision/历史。
- **砍掉的概念**：capabilities 独立结构（降为 payload 内约定）、label 语义字段、data/capabilities 私有区划分。
- **保留 kind 的理由**：跨模块互操作（关系挂载、动作适用性）、webUI 投影（着色/表单/路由）都需要一个共享类型标签；平台定位下纯哑核心会导致约定碎片化。

## D4. 核心操作面：四方法

- **决定**：read / commit / undo / redo 四方法；validate 从 core 表面彻底移除，校验在模块协议里重新设计（服务或钩子，待模块分支定案）。
- **未定**：undo/redo 的历史存储方式（现状段式机制随存储分支重审）；undo 是否可跨模块整体撤销（应保留，属 MutationPlan 语义延续）。

## D5. 进程模型：单属主 daemon

- **决定**：一个常驻本地进程独占图（内存态 + 原子落盘）；CLI/MCP/Web 全部是薄客户端。
- **随之砍掉**：文件锁、journal 崩溃恢复状态机、staging、外部编辑吸收事务（改为文件监视 + 重载）、跨进程 revision 冲突协议。
- **新增义务**：daemon 生命周期管理（CLI/MCP 调用时自动拉起、空闲自动退、快速冷启动）。
- **理由**：同时满足构想里的实时 webUI + 热重载；把并发从跨进程文件协议降维成进程内队列；删掉 core 约 500 行事务工程。

## D6. 磁盘格式：目录式 YAML

- **决定**：每图一个目录：graph.yaml（含 revision）+ objects/<id>.yaml + relations/<id>.yaml；每实体一文件。
- **消失**：.revision.json / .audit.jsonl / .history 段 / .toporealm.lock / .toporealm-txn 全部事务文件。
- **理由**：git 逐实体 diff（用户已有把 .graph/ 提交进 git 的工作流）、人类可直接读改（daemon 监视重载）、daemon 全量载内存后无性能负担。

## D7. 持久化状态：图事实 + 统一提交日志

- **决定**：daemon 持久化 = 图事实（YAML 目录）+ 单一 append-only 提交日志（JSONL：patch、来源、label、时间）+ cursor（存 graph.yaml）。
- **一个文件三个功能**：undo/redo 栈、近期变更查询（join/入场场景）、事实审计。审计与历史不再分开存储。
- **理由**：undo 栈每一项本质就是提交记录，加几个元数据字段即兼作审计与变更史；daemon 重启后人类保留撤销能力。

## D8. 模块形态：双层

- **决定**：模块 = 声明层 + 代码层。① 声明层（module.yaml）：namespace、kinds、UI 投影、动作目录（含输入 schema）——角色是**协调契约**（注册/发现/防冲突），不是执法依据；② 代码层（runtime 入口）：in-process 加载、全权 API（读图、提交、订阅事件、注册命令）。
- **信任模型**：信任在安装时刻完成（npm install 本来就是代码执行）；运行时不再做伪沙箱。
- **理由**：声明管“你是谁、你有什么”，代码管“你做什么”；纯声明式是现状重量的主要来源，纯代码式在平台模式下缺协调层。

## D9. 运行时执法：命名空间所有权一条法

- **决定**：core 唯一执法规则 = 一个模块的 commit 只能触碰自己 namespace 下的 kind（或无主/公共 kind）。
- **性质**：协调边界（防手滑、模块互信地基），不是安全边界（in-process 代码防不了恶意）；恶意代码在安装时刻拦截。
- **免费收益**：“模块缺失时其数据冻结保护”（现状 75 行守卫）退化为同一规则的退化情形。
- **死掉的东西**：fail-closed validator、schema 门禁、STALE_ACTION、私有区守卫等全部其余门禁。

## D10. 领域校验：钩子制

- **决定**：领域校验 = 模块订阅 before-commit 钩子，可附诊断、可否决；core 不聚合、不 fail-closed、不排序诊断。是否生效由图装载哪些模块自然决定。
- **内置保留**：悬空关系检查（边指向不存在对象）作为 commit 内置引用完整性检查（~5 行），不属校验框架。
- **砖化风险接受**：模块钩子理论上可否决全图写入——这是模块与用户的契约，daemon 明示“被 X 否决”，卸载即恢复。
- **死掉的东西**：validation-types.ts 179 行 + validation.ts 126 行 + fail-closed 机制 + JSON Schema 2020-12/Ajv 全套 schema 编译。

## 设计方法（后续架构方案阶段采用）

- 用户指定：采用 codebase-design 方法论（deep module 词汇：Module/Interface/Seam/Adapter/Depth/Leverage/Locality）。
- core 接口设计时用 Design-It-Twice：并行子代理各出一个截然不同的接口方案，按 depth/locality/seam 位置对比后综合。

## D11. 模块组合：数据面正道

- **决定**：① 模块互操作唯一正道 = 图数据面（跨 namespace 建关系、读对方实体）；模块间运行时直接 import 不支持。② requires.modules 依赖声明保留，daemon 装载时检查、不满足大声失败（诊断信息，非运行时执法）。③ 模块集在 daemon 启动时冻结，改模块 = 重启 daemon（热装卸非第一版）。
- **消灭的问题类**：registry snapshot 随 revision 重算、STALE_ACTION、激活重算——整类过期引用问题不存在了。

## D12. 模块贡献分层：瘦声明 + 代码注册一切行为

- **决定**：manifest（module.yaml）只留：身份（id/namespace/version）、依赖声明、kind 词汇表、静态 UI 投影（颜色/图标）、entry 入口。代码 activate(api) 时注册：命令（含全部元数据：适用类型、输入 schema、描述）、钩子、表单。
- **术语钉定**：现状“动作 (action)” → 改称**命令 (command)**：模块注册的、人和 agent 都可调用的操作，目标绑定可选；原“动作引用”的快照修订号绑定语义随 D9 死亡。命令目录由 daemon 自省提供（CLI/MCP/UI 随时可查），不再有 YAML 声明与实现对不上的问题类。

## D13. 砍掉 MCP

- **决定**：MCP 整体移除。v1 对外表 = CLI（双受众契约：--json 机器输出、结构化错误码、稳定命令语法、命令目录自省）+ Skills + WebUI。
- **结构性依据**：真正的缝是 daemon 客户端 API；CLI/Web 两个 adapter 已撑住缝的真实性（deletion test 不通过 = MCP 是 pass-through）。
- **代价接受**：无 shell 的 MCP-only GUI 宿主被排除；CLI interface 必须按契约认真设计（语法即承诺，skills 押注其上）。
- **桥未烧**：未来需要时在 daemon 缝上加回 MCP adapter 约 100 行工作量。

## D14. WebUI：从轻，只保留实时同步

- **决定**：WebUI 尽可能轻量。唯一硬需求 = daemon→浏览器实时节点状态同步（无刷新）；daemon 内存态 + WS 推送 + 浏览器就地更新（现有 store 层已是此模型，天然继承）。
- **非目标**：前端开发期 HMR（vite dev 集成不做）、运行期模块 UI 热重载（改模块=重启 daemon，与 D11 一致）。
- **技术栈**：待设计阶段定；默认倾向继承 Svelte 5 + D3（分层干净，组件逐个审、该拆拆），除非出现更轻选项。daemon 伺服构建产物。

## D15. 宿主适配：只做 Claude Code + Pi

- **决定**：宿主适配从三宿主收缩为两宿主：Claude Code 与 Pi；**Codex 适配先砍掉**。
- **保留**：plugin 包（适配 claude-code 的打包机制）；skills 分发随 plugin/pi 打包完成。
- **钩子**：按需制——有用就加，无 v1 硬性要求。**注意**：Claude 钩子格式与 pi extension 格式不同，实现时不可混用。
- **死亡**：MCP 配置生成（随 D13）、codex 投影。

## D16. 旧世界退场：同名包 1.0.0 + 迁移 CLI + workflow 后置

- **决定**：① 沿用 `@lukawi/toporealm`，新架构以 1.0.0 发布；0.x 标记 deprecated。② 提供一次性迁移 CLI（旧 graph v1 → 新格式：data/capabilities 机械合并进 payload，kind 保留）。③ Workflow 模块移植不阻塞 v1，作为首发模块验证新协议（dogfood + 协议试金石）。

## 默认值（未经单独盘问，可反悔）

- **模块打包**：npm 包 + 本地路径两种安装源；**禁 install 脚本保留**（安装期信任的唯一执法点，与 D8/D9 一致）；捆绑 node_modules 依赖**允许**（信任码就不假装限制它的依赖）。
- **daemon 生命周期**：CLI/MCP/浏览器触达时自动拉起；空闲自动退出；冷启动要快（这是 daemon 模型的UX生命线，设计阶段作为硬约束）。

## D17. 接口综合裁决（Design-It-Twice 收束，详见 interface-comparison.md）

- ① 命令 handler 自由调用 api.commit（非返回 mutations 代提交）；② undo/redo 用游标实现（四方法独立为接口，实现层与 apply/外部重载统一管线）；③ CLI 取调用者优先形态 ~16 动词（模块命令做顶层子命令，错误带 hint/fix）；④ read 带 C-lite 投影查询（ids/kinds/where 浅等值/fields）。
- 默认值：direction 为关系可选结构字段（默认 "directed"，不占执法）；钩子 v1 仅同步。
- 所有权法明示只约束 module 来源提交；用户（cli/web/external）豁免——人是图最终属主（D9 本义）。
