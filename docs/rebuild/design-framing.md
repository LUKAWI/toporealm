# 1.0 接口设计问题空间（Design-It-Twice 框架）

> 本文是三个 deep module 接口设计的统一简报。约束全部来自已冻结的决策基准（`decisions-draft.md` D1–D16 + ADR-0003~0006）。
> 词汇表：codebase-design（Module/Interface/Seam/Adapter/Depth/Leverage/Locality）+ `CONTEXT-draft.md`（daemon/载荷/提交日志/双层模块/命令/所有权法/校验钩子）。

## 待设计的三个 seam

### S1: daemon 客户端 API
- **缝的位置**：daemon 进程边界。CLI 与 Web UI 是仅有的两个 adapter（未来可能有 MCP adapter，桥不烧）。
- **缝后是什么**：内存图态、提交管线（所有权法 + 悬空边检查 + 校验钩子）、undo/redo（统一提交日志）、文件监视重载、模块装载。
- **依赖分类**（DEEPENING.md）：daemon 内部持久化 = local-substitutable（本地文件系统，测试用临时目录/内存 fs 替身）；daemon↔CLI = 本机跨进程（自动拉起，IPC）→ port + IPC adapter（生产 unix socket/named pipe，测试内存替身）；daemon↔浏览器 = HTTP+WS adapter。

### S2: 模块 runtime API
- **缝的位置**：daemon ← 模块代码（in-process，daemon 启动时装载、activate 一次）。
- **缝后是什么**：模块获得的全权 API（读图、提交、订阅事件、注册命令/钩子/表单）与 daemon 对模块的调用面（命令分发、钩子触发）。
- **依赖分类**：in-process（无 adapter，测试直接装载测试模块）。
- **约束**：所有权法是模块唯一感到的执法；命令元数据代码注册时声明；数据面是唯一互操作正道。

### S3: CLI 命令语法
- **缝的位置**：终端。双受众：人（HELP、表格输出）+ agent（`--json`、结构化错误码、稳定语法、命令目录自省）。
- **缝后是什么**：daemon 客户端 API（薄 adapter，不做业务）。
- **依赖分类**：in-process 转发；语法即公共契约。

## 全局约束（不可违反）

1. 四方法语义：read / commit / undo / redo；validate 不存在于 core。
2. 最小信封数据模型：对象/关系 {id, kind(命名空间化), payload(不透明), …}；revision 单调。
3. 目录式 YAML 磁盘格式 + 统一提交日志。
4. 执法仅两条：所有权法 + 悬空边检查；领域校验走 before-commit 钩子。
5. 模块集 daemon 启动时冻结；命令目录 daemon 自省提供。
6. WebUI 只要求 WS 实时同步；无 MCP；宿主仅 Claude Code + Pi。
7. 每个设计必须说明：interface（类型/方法/参数 + 不变量/顺序约束/错误模式）、用法示例、缝后隐藏了什么、依赖策略与 adapter、trade-off（leverage 高在哪、薄在哪）。
