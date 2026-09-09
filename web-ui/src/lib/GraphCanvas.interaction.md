# GraphCanvas 交互契约（TopoRealm 版）

与 `D:/LUKAWI/AI_project/projects/topological-tool/web-ui/src/components/GraphCanvas.interaction.md` 同语言；
差异仅在数据语义（对象/关系无工作流状态，色彩表达 kind）。

## 交互约定

- **左键点击节点**：选中该对象，选中态 = 星芒增亮 + 标签提白 + 声呐环反馈；再次点击其他节点切换选择。
- **左键点击关系**：选中该关系（命中域为 12 单位透明加宽线）；hover 关系时提亮并显示 `source → target · kind` 标签。
- **空白点击**：清除当前选中（对象/关系一并清除），同时交还键盘焦点。
- **节点拖拽**：按住左键拖动星体，位置写入浏览器本地缓存（按图分桶）；不触发任何 Core 写入、不改变 revision。
- **空白/节点中键拖动**（`button=1`，非触控）：视图连续平移。开始时画布捕获该 pointer；
  `pointerup`、`pointercancel`、`pointerleave`、`lostpointercapture`、组件卸载均结束本次平移并释放 capture。
- **滚轮**：以指针为中心缩放（0.15×–4×）；关系线宽随缩放补偿（k<1 时按 1/√k 放大）。
- **双击**：重置视图到恒等变换。
- **触控**：由 d3-zoom 手势承担（pinch 缩放/拖动）；中键处理器只响应非触控的 `button=1`。
- **键盘**：`Tab`/`Shift+Tab` 只在可见星体间循环；`Enter`/`Space` 选中聚焦星体；
  `+`/`-` 缩放；`0` 适配全图；`Esc` 由外壳处理（清过滤/浮层）。
- **搜索 Enter**（外壳）：选中并平移居中首个命中对象。
- **fit 管线**：模拟收敛（alpha ≤ 0.3）或 4s 兜底后自动取景一次；用户手动动过视角（滚轮/中键）后不再抢取景；
  容器尺寸变化后 180ms 防抖重新取景。
- **过滤**：搜索与 kind 过滤不匹配的星体/关系整体淡化（opacity 0.3），不隐藏、不改变数据。
- **reduced motion**：`prefers-reduced-motion: reduce` 时关闭全部装饰动画（呼吸/闪烁/声呐环/入场渐显）。

## TopoRealm 视觉语义

- 星体色彩 = 对象 kind（模块 presentation 声明色优先，未声明时确定性回退色相）；交互反馈一律用明度。
- 关系线：`directed` = 源端亮 → 目标端渐隐的不对称渐变 + 72% 处方向折角；`undirected` = 两端对称渐隐。
- 关系 hover 标签：中点显示 `label ?? kind`，tooltip 显示 `source → target · kind`。
- 视图状态（缩放、平移、坐标缓存、选择、过滤）只存在于浏览器；Core revision 不因画布操作变化。
