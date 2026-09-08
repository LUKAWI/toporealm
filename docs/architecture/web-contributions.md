# TopoRealm Web UI 与模块贡献契约

状态：核心边界已确认，待用最小 research 模块验证。

## 目标

TopoRealm 复用现有 Super Plumber Web UI 的成熟外壳和画布交互，以最小改动把领域专属内容移出基座。Web UI、CLI 和 MCP 使用同一 `GraphRegistrySnapshot` 和 Core 操作入口，不建立前端专属领域模型。

## 基座固定能力

基座 Web UI 固定负责：

- 工作区与图切换、连接状态和模块状态；
- 通用画布、布局、缩放、平移、选择和搜索；
- 对象与关系的通用显示、创建、连接和删除；
- 基础字段、原始 YAML、基础校验和完整校验结果；
- 历史、快照、恢复以及缺失模块时的降级编辑；
- 动作发现、输入预览和执行结果展示。

固定七态颜色、任务前沿、context hull、ADR 专用叠加层和开发交付详情属于迁移后的模块，不属于基座。

## 复用边界

从现有 Web UI 迁入并逐步改名的部分包括应用外壳、多图状态桶、D3 画布、布局与视口、选择模型、WebSocket 连接、Markdown 展示和基础抽屉。首版不重写画布，也不更换 Svelte 或 D3。

现有 `NodeSchema`、`EdgeSchema`、七态渲染以及 `workflow/domain` 固定视图不能成为新基座 API。迁移时由通用 `Object`、`Relation` 与模块贡献替换这些假设，每一步保持 workflow 发行组合可用。

## 模块 UI 贡献

模块在 `ui/contribution.yaml` 中只登记三类内容：

```yaml
presentation: presentation.yaml
forms: forms.yaml
extension: entry.js
```

- `presentation`：类型的颜色、图标、标签和关系线样式；
- `forms`：对象、关系和动作输入的 Schema 驱动表单提示；
- `extension`：可选可信前端代码，仅在声明式贡献不足时使用。

操作菜单不另建一套 UI 配置，而是直接展示当前注册快照给出的适用动作。简单模块通常只提供 `presentation` 和 `forms`。

可信前端扩展只可注册到三个固定插槽：`canvas_overlay`、`inspector` 和 `workspace_panel`。扩展通过基座提供的只读选择与查询接口读取状态，通过动作接口请求修改；不能替换应用外壳、直接写图存储或注册清单外贡献。首版不增加更多插槽，只有真实纵向切片证明必要时才扩展协议。

## 缺失模块降级

模块不可用时，基座仍以通用对象、关系和原始数据展示图：

- 对象显示稳定 ID、原始 `kind`、标签和通用布局；
- 关系显示端点、方向和原始 `kind`；
- 未知 `data` 与 `capabilities` 原样保留；
- 模块表单、自定义渲染和动作禁用，并显示具体缺失原因；
- 用户仍可执行已确认的降级编辑，但不能获得完整校验结论。

## 后端与 Web UI 的增量同步

当前 Super Plumber 已能推送 `node:updated`，但节点写入同时会使派生 `index/` 失效。现有文件监听器把后续索引文件变化归为整图更新，再发送 `graph:update`；前端替换整张 `GraphIndex` 后可能重绘 D3 画布，因此产生闪烁。

TopoRealm 改为由 Core 在一次变更提交成功后发送一个事实级事件，而不从派生文件变化推断业务变更：

```yaml
type: graph:patch
graph: research-notes
revision: 18
changes:
  - op: object.upsert
    id: question-17
    value: { ... }
```

每张图只有一个单调递增的 `revision`。整图快照携带当前 revision；客户端只接受上一个 revision 的下一条 patch，并在现有图桶中原子归并 `changes`。对象更新保留其他对象和数组的稳定引用，关系更新只同步相关连线，视口、布局、选择和未变化组件不重置。

以下情况才执行全量同步：

- 首次连接；
- 断线重连；
- 客户端发现 revision 不连续；
- 文件系统外部编辑无法可靠转换为 patch。

首版不保存供客户端补拉的事件流。断线或版本断档直接读取最新快照。`index/`、事件日志及其他派生文件不触发 WebSocket 整图广播。

## research 最小示例

`research` 模块为 `research.question`、`research.source` 和 `research.claim` 提供颜色、图标与基础表单，并把“展开问题”等注册操作直接显示为适用动作。证据置信度可以使用声明式样式映射。

只有当纵向切片确实需要在画布上呈现普通样式无法表达的证据聚合时，才增加一个 `canvas_overlay` 扩展。更新问题状态时，Web UI 接收单个对象 patch，局部更新节点外观而不重建整张图。
