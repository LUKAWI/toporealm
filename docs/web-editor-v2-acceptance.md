# TopoRealm Web 编辑器 v2 验收报告

- 图：`toporealm-web-editor-v2`（3 context + adr_0001 + 8 task；人审 gate `l4_human_review` 已由用户批准）
- 初版执行者：zcode-root；本次返工执行者：codex-root（browser use = Chromium/Playwright 真实页面）
- 预览：`http://127.0.0.1:8945/`（临时工作区 fixture research-demo + second-demo，不写仓库 fixture）；拓扑 serve 预览 `http://localhost:8936`
- 参考实现（只读）：`D:/LUKAWI/AI_project/projects/topological-tool/web-ui`

## 一、三大人审阻塞的修复证据

### 1. 点击画布节点显示具体内容（v1 阻塞一）

- 链路实现：画布点击 → `store.selection {type,id}` → `ObjectDetail`/`RelationDetail` 玻璃抽屉（换选重播滑入）。
- 浏览器证据（IAB）：点击 claim-1 星体后 `.drawer.visible` 打开，显示「对象详情」+ 实体标题 + meta chips（稳定 ID / kind 色点 / revision）+ 标签 + 关系清单（→/← 方向 + 端点 ID，可跳转）+ data/capabilities/meta 折叠 JSON（可复制）。
- 稳定性：连续快速切换 3 个对象 + 关系后抽屉内容正确跟随，`is-selected` 计数为 1，无空白检视器、无旧选择残留；Esc / 空白点击 / 关闭按钮三种退出均验证。
- 未知 kind（alien.creature）：显示降级原因 + 原始 JSON 可展开可复制；幽灵 ID 不崩溃、不渲染脏数据（组件测试）。

### 2. 完全沿用 Super Plumber 设计语言（v1 阻塞二）

设计语言对照清单（与 `topological-tool/web-ui` 逐项核对）：

| 对照项 | 结果 |
| --- | --- |
| `:root` 设计令牌 | ✅ 63/63 逐项一致（脚本比对，零缺失/零差异/零多余） |
| 纯黑画布 + 近黑玻璃 chrome | ✅ `--bg #000` / `--glass 0.72` / `--glass-strong 0.88` |
| 白色洗刷阶梯 + ink 阶梯 | ✅ wash-1/2/3、ink-muted/faint 全部沿用 |
| 单排 48px 顶栏（品牌砖 + 分段过滤组 + 图标搜索框） | ✅ 同构（kind chips 计数即图例，替代工作流状态 chips） |
| 左缘浮动玻璃 dock + flyout | ✅ 图库/校验/模块/原始快照/撤销/重做/缩放/刷新/只读 |
| 右缘悬浮玻璃抽屉（DetailDrawer 舱体） | ✅ 几何/头部/Esc 提示/圆角/动效逐项同构 |
| 星体视觉（halo/八向星芒/红蓝残像/白炽核） | ✅ V4 棱星正本直译，色彩语义改为 kind/模块 |
| 关系渐隐星座线 | ✅ directed 不对称渐隐 + 方向折角；undirected 对称 |
| hover/selected/focus 声呐反馈（ring-bloom/flash/星芒增亮） | ✅ 同语言（明度表达，无彩色交互态） |
| 加载骨架屏 / 错误态 / 空态 | ✅ 参考同款（骨架脉冲、波浪错误图 + 重试、虚线星图空态） |
| 银河带 + 微尘氛围层 | ✅ 屏幕固定层同参数 |
| 字体/字号/间距/圆角/缓动/z-index | ✅ 全部走同一令牌（含 mono 仅用于数据文本） |
| 缩放提示条 / 玻璃胶囊徽章 | ✅ 同款 |
| 响应式（窄屏 dock 落底、抽屉变底部舱） | ✅ 同断点同结构 |
| `prefers-reduced-motion` | ✅ 装饰动画全部关闭 |

（v1 的自创元素——蓝色三栏、CORE ONLINE 徽章、Inter 变量字体栈——已全部移除。）

### 3. 鼠标与画布交互流畅、编辑流程可用（v1 阻塞三）

指针契约（browser use 逐项，见各节点执行报告）：

- ✅ 左键点击对象/关系 → 选中反馈 + 稳定 ID（`aria-label`/DOM 断言）
- ✅ 节点拖拽平滑，松手不粘连，revision 6→6 不写 Core
- ✅ 中键平移（空白与节点上），pointer capture 释放后可再次开始（连续两次平移验证）
- ✅ 滚轮缩放 k 1→1.39；线宽随缩放补偿
- ✅ 双击重置 k→1；`+` 键 k→1.3；`0` 适配 k→1.26（fit 非恒等，正确）
- ✅ 触控 pinch 模拟 k→2.09
- ✅ 空白点击清除选中，与缩放/平移互不抢事件
- ✅ 键盘 Tab 循环 + Enter 选中（选中「补丁式更新可保留修订链」）

编辑核验（browser use 全流程）：

- ✅ 新增对象（r16，acceptance-1 出现）→ 修改（r8 改名）→ 从选中对象创建关系（source 预填，rel-edited r9）→ 删除对象（r12，关联关系级联消失）→ undo（r10）/redo（r11）→ 刷新持久化（r12 保持）
- ✅ 409 冲突：外部推进 revision 后提交，表单保留输入「冲突中的修改」+ 内联 `REVISION_CONFLICT` 错误条；点击「重新读取」后快照升级、冲突提示清除、未提交输入继续保留；patch gap 由 store 单测覆盖（本地快照不变更）
- ✅ 只读模式：徽标「只读」，新增/撤销/详情编辑按钮全部禁用，查看/搜索/校验/原始数据保留
- ✅ 模块动作：research.expand-question 一键执行 r14→r15，新对象即时上画布；修复 `structuredClone` 无法克隆 $state 代理的真实缺陷

## 二、命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run verify`（PATH 加 System32，见下） | ✅ 根 build + 26/26 测试；web typecheck 0/0 + build + 42/42 测试 |
| `npm run web:browser-smoke` | ✅ 真实 Server + 生产构建资源 + 编辑/历史/动作/冲突/完整校验/模块回归 |
| `graph validate` | ✅ 0 错误 0 警告（收尾复验见拓扑记录） |
| `git -C topological-tool status` | ✅ 仅存任务前既有 `integrations/plugin/skills/sp-grilling/agents/openai.yaml` 修改 |

环境备注：本会话 Git Bash 的 PATH 使 GNU tar 优先于 Windows bsdtar，`tests/distribution.test.ts`（npm pack + tar 解包）需 `export PATH="/c/Windows/System32:$PATH"` 后运行；仓库代码未改动，已记忆存档。

## 三、自动化回归覆盖

- `web-ui/src/lib/protocol.test.ts`：patch 连续应用、PATCH_GAP 不变更本地快照、409 稳定错误对象（v1 资产延续）
- `web-ui/src/lib/store.test.ts`（7）：加载/提交/409 recovery/patch gap recovery/只读拦截/图切换状态清理/写入与切图双向互斥
- `web-ui/src/App.test.ts`（4）：加载渲染、409 恢复链路（含重载入口点击）、校验区分显示、只读同步
- `web-ui/src/lib/GraphCanvas.test.ts`（3）：数量一致 + 端点缺失剔除 + directed 折角、选择稳定 ID + 空白清除、kind 过滤淡化
- `web-ui/src/lib/components/detail-chain.test.ts`（4）：画布点击→选择→抽屉全链路、未知 kind 降级 + 原始 JSON、幽灵 ID 防护、关系端点跳转
- `web-ui/src/lib/components/editor-panel.test.ts`（4）：提交计划、source 预填 + 非法 JSON 保留、冲突保留输入 + 重载入口、只读禁用
- `web-ui/src/lib/components/module-projection.test.ts`（3）：声明投影、动作执行 + RUNTIME_FAILED 错误边界、缺失模块降级
- `web-ui/src/lib/layout.test.ts`（5）：确定性种子网格 + fit 变换 + 仅可信用户输入接管视口
- `tests/browser-smoke.test.ts`：真实 Server/生产资源/编辑/undo-redo/409/基础-完整校验/模块/动作/持久化

## 四、本次返工复验（2026-09-09）

- TDD：首轮新增 4 个失败断言；独立评审继续发现切换响应在途、旧详情重开、写请求先发出及 history/module 写入口等竞态，均先以延迟 Promise 或调用计数形成红灯再修复。最终回归覆盖双向互斥。
- 编辑隔离：切图开始即清空 editor/selection，`switching` 期间拒绝 `openEditor`、commit、undo/redo 和模块动作；commit、history、模块动作共用 `writing` 状态，任一写请求在途时拒绝切图。延迟测试确认被拒绝路径不调用 Core API，旧图写入不能落到新 `activeStore`。
- 冲突恢复：制造 r17→r18 的真实 409 后，点击「重新读取」，错误提示清零、图升级到 r18、表单输入「本地冲突输入」仍保留。
- 画布可达：1440×900 首载等待布局稳定后 7/7 节点可见；同页缩到 600×800 后仍为 7/7 可见。
- 点击命中：直接点击节点文字区域即可打开对应对象详情，不再要求命中星体中心。
- 样式未改：本次未修改 CSS、设计令牌、布局样式或动效；生产构建 CSS 仍为 `index-DtKFY9Hh.css`，仅 JS 逻辑产物更新为 `index-BUAvvLwY.js`。
- 回归：`npm run verify` 全通过（根测试 26/26，Web 测试 42/42，Svelte 0 error/0 warning）；`npm run web:browser-smoke` 1/1 通过。

## 五、收口结论与后续边界

- `l4_human_review` 已依据用户在真实浏览器中的明确批准关闭；整张 `toporealm-web-editor-v2` 图已完成。
- 大图（>600 节点）Canvas 路径、标签碰撞退让等参考实现的性能优化未迁移——TopoRealm 当前图规模不需要，后续按需引入。
