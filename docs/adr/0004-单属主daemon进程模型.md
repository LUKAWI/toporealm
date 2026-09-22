# ADR-0004: 单属主 daemon 进程模型

状态：已接受（2026-09，重建 grilling 会话 D5/D6/D7/D14）

## 背景

0.x 采用库模型：每次 CLI 调用、每个 MCP 进程、Web 服务器都直接打开 YAML 存储。多进程同写迫使 core 内置：文件锁（wx + PID 存活检测）、journal 崩溃恢复状态机（prepared→…→committed 六态）、old/new staging、外部编辑吸收事务（digest 比对 + 历史段封存）。这套事务工程约 590 行，占 core 42%，且锁覆盖整个"读盘-校验-写盘"事务。

## 决策

- 一个常驻本地 daemon 独占图工作区：图态驻内存，唯一写者，原子落盘（临时文件 + rename）。
- CLI 与 Web UI 是薄客户端；CLI 触达时自动拉起 daemon，空闲自动退出，冷启动速度是硬约束。
- 磁盘格式：每图一个目录——`graph.yaml`（含 revision 与 undo 游标）+ `objects/<id>.yaml` + `relations/<id>.yaml`；每实体一文件，git 逐实体 diff 友好。
- 除图事实外只持久化一份**统一提交日志**（append-only JSONL：patch、来源、label、时间），兼任 undo/redo 栈、近期变更查询与审计；不再有独立审计文件与段式历史。
- 外部编辑改为文件监视 + 重载；跨进程 revision 冲突协议、journal、staging、外部编辑吸收事务全部废除。
- WebUI 从轻：唯一硬需求是 daemon→浏览器实时状态同步（WS 推送、无刷新）；无开发期 HMR、无模块 UI 热重载。

## 后果

- 并发从跨进程文件协议降维成进程内队列；删掉约 500 行事务工程与整类恢复路径测试。
- daemon 成为可用性单点：崩溃 = 客户端等待自动拉起；磁盘格式保证崩溃只损失内存 undo 栈之外的任何东西。
- "用户直接改 YAML"的语义从"被吸收"变为"被监视重载"。
