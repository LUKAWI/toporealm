# TopoRealm v1 冻结清单

状态：候选基线已完成，等待最终用户审核。

## 稳定协议

- 图格式：`toporealm.graph/v1`。
- 模块清单：`toporealm.module/v1`。
- Core 只定义图、对象、关系、稳定 ID、revision、历史和通用错误；领域类型由模块注册。
- 模块缺失或不兼容时保留未知字段，基础读取继续可用；不做自动 Schema 迁移。
- 所有写入通过单一 `MutationPlan` 和图级 revision，持久化线性撤销/重做；旧 revision 被拒绝。

## 已验证切片

- `research` 与 `exploration`：固定本地资料、动作、跨模块编辑、MCP、Web patch、缺失模块降级/恢复。
- `workflow`：状态转移、依赖门禁、checkpoint、execution report、下一行动。
- 分发：npm `pack --ignore-scripts`、工作区/全局生命周期、来源记录和 Codex/Claude/Pi 投影。

## 破坏性变更规则

冻结后若修改图或模块机器契约，必须升级对应格式版本并提供显式迁移动作；不得静默改写已有图。Super Plumber `.graph` 仍是独立格式，不属于 v1 兼容范围。

## 验证命令

```powershell
npm run verify
git diff --check
```
