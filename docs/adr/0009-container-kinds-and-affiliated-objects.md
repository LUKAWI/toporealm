# ADR-0009: 容器类与附属对象的声明层裁决

状态：已接受（2026-09-29，1.4.0 规划 D46）

## 背景

1.4.0 的主题是 webUI 语义分层：图要能按容器分组呈现、把备注类对象与普通节点区分渲染。
动 UI 之前必须回答一个模型问题：「类」（把一批对象组织成可命名的类目）在 TopoRealm
模型里是什么地位——协议事实面的第四原语，还是约定层的呈现语义？

dev 图 dogfood 实测（2026-09-29）给出缺口的实证：全图 93 个对象（46 wf.task +
47 wf.execution_report）、52 条 wf.depends_on 边，其中 **57 个对象无任何关系挂靠**——
执行报告没有结构化的挂靠语义、任务缺少容器组织，「类」只能靠命名约定硬扛，WebUI 无从
投影分层。模型层面还叠着一个相邻缺口：给一条**边**挂内容（在关系本体之外附着结构化
数据）现有模型同样表达不了。

## 原语判据

一个概念要进协议事实面（成为原语），须至少居一：**结构性执法**（core 要为它执法）、
**布局语义**（磁盘/内存布局要为它分桶）、**一等查询语义**（read 过滤与目录投影要为它
立字段）。事实面是契约最贵的一层：进去容易出来难。

「类」按判据能及格——容器分组确有一等查询诉求（按容器过滤、目录标注）。但实现成本
清单否决 core 原语化：协议（Entity/Change/GraphPatch/ReadQuery）、core（内存态/落盘
布局/所有权与悬空检查/undo）、CLI（动词与信封）、client（三 adapter）、WebUI
（store/投影）、migrate（v3 格式）**全链重推，破坏面等同 2.0 级**；而相对「普通对象 +
member_of 边 + 声明投影」的表达力增益**为零**——类能做的一切今天就能做。

## 决策

- **`represent` + `member_of` 停在声明层**：类 = 普通对象 + 中立归属边 `member_of` +
  module.yaml `ui.kinds` 的 `represent: "container"` 声明。协议事实面零改动，core 执法
  仍仅两条（所有权法 + 悬空边检查）。
- **不设备注原语**：备注（annotation）= 对象 + 边 + `represent: "annotation"`；
  依赖（dependency）= 关系本身。三原语定案——对象/关系/类，其中「类」是约定层概念，
  不进事实面。
- **`member_of` 立为核心归属约定**（与 `payload.title` 显示名约定同级）：关系 kind 无
  命名空间前缀 = 公共类型，跨模块共用，所有权法放行——core 现行为（core.ts:465-466，
  `ns === null` 即放行），非新执法，core 零改动。
- **边级附着是已知缺口**：未来走 reification（边升格为对象）解决，本决策不解决、
  不预留机制。
- **类 core 原语化台阶留档备查**：若未来出现判据无法回避的诉求（例如 core 要为容器
  执法结构约束），原语化路径按本判据与成本清单重开，届时按语义版本规则升 2.0。

## 后果

- **协议仅目录投影扩展**：`Catalog.kinds[]` 增可选 `represent` 字段；module.yaml `ui`
  段新增 per-kind 映射 `ui.kinds`。core 不解释 represent（D8：声明层只协调不执法）。
- **catalog 向后兼容**：不声明 = 普通节点渲染；既有模块清单与既有图不受影响。
- **声明透传已验证宽松**：清单解析器对 `ui` 段整体 cast、无字段级校验
  （discover.ts:112-114），加键零解析改动；声明层透传面不构成阻碍。
- WebUI 语义分层的取数面即目录 represent 投影 + member_of 邻域查询
  （ReadQuery.adjacent，D36），无需新端点；workflow 模块 1.1.0 首发兑现（wf.domain
  容器类、assign-domain 命令、wf.report_of 同提交双写、checkpoint 内嵌
  payload.checkpoints，blueprint §7）。
- 代价：类的呈现语义由模块自律声明，错标 represent 只影响渲染、不影响图事实——
  可接受，声明层本就不执法。
