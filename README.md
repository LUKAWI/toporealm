# TopoRealm｜拓境

TopoRealm 是一个以拓扑图组织工作、知识与未知领域的模块化本地工作空间。

它将图存储、查询、演化、CLI、MCP 和 Web UI 作为稳定基座，通过模块装载不同领域的对象、关系、规则、操作和视图。开发工作流、深度研究、个人学习与雾区探索都是基座上的模块组合。

当前仓库已完成 v1 基座与两条领域切片：Core、CLI、MCP、Server、Web、模块注册/降级、离线 research/exploration、workflow、npm 安装器和三宿主投影均有最小可运行实现。产品边界见 [docs/architecture/FOUNDATION.md](docs/architecture/FOUNDATION.md)，统一术语见 [CONTEXT.md](CONTEXT.md)，路线图见 [docs/architecture/implementation-roadmap.md](docs/architecture/implementation-roadmap.md)，冻结清单见 [docs/architecture/v1-freeze.md](docs/architecture/v1-freeze.md)。

本地开发要求 Node.js 20+：

```powershell
npm install
npm run verify

# 运行最小 CLI
node dist/cli/main.js read <graph-id>

# 安装本地或 npm 模块并同步宿主投影
node dist/cli/main.js module add <npm-spec>
node dist/cli/main.js host sync
```

现有项目 `../topological-tool` 是设计与实现参考。后续迁移应保持其独立，不在原工作区内重构。
