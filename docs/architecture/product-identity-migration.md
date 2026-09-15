# Product Identity 与 0.2 迁移契约

状态：TopoRealm Core 0.2 实施契约，2026-09-14。
目标发行：`@lukawi/toporealm@0.2.0`，npm channel 为 `preview`。
边界：本契约只重组基座产品和兼容层，不升级 `@lukawi/toporealm-workflow` 源码。

## 1. 单一 Product Identity

`package.json` 是包名和版本的唯一人工维护真相源，`publishConfig.tag` 是发布 channel 的唯一人工维护真相源。生产源码、生成投影、测试和脚本不得再保存一份手写版本常量。

0.2 在 `src/product-identity.ts` 提供只读 implementation：运行时从包根 manifest 读取并校验以下最小形状，再导出 `PRODUCT_IDENTITY`。

```ts
interface ProductIdentity {
  readonly packageName: "@lukawi/toporealm";
  readonly version: string;
  readonly channel: "preview";
  readonly cliName: "toporealm";
  readonly mcpServerName: "toporealm";
}
```

它是 manifest 的 adapter，不是第二份配置。源码运行、编译后的 `dist/` 和 npm 安装包都必须解析同一个包根 `package.json`。测试若需要非当前版本，显式注入 `ProductIdentity` fixture，不修改全局常量。

派生规则：

| 消费者 | 派生值 |
|---|---|
| npm 包与 release | `packageName`、`version`、`channel` 直接来自 manifest |
| MCP server metadata | `{ name: mcpServerName, version }` |
| Codex/Claude manifest | manifest `version` 使用 `version`，MCP npx spec 使用 `${packageName}@${version}` |
| Pi package projection | 投影包自身版本使用 `version`，MCP npx spec 使用精确 Core 版本 |
| SessionStart/before_agent_start hooks | npx spec 使用精确 Core 版本，命令名使用 `cliName` |
| CLI version/help | 使用 `version`，不从测试或文档反推 |
| package smoke | 从待打包 manifest 取得 expected identity，再核验安装包运行时 identity |
| registry smoke | 从发布工作区 manifest 形成精确 `${packageName}@${version}`，安装后再次读取并对比 |
| README 通用安装示例 | 使用 `@preview`，避免每个补丁版本都改文档 |
| 版本化 release notes | 可以写精确版本；它是历史记录，不是运行时配置 |

Product Identity 不包含图格式、模块格式或模块版本。fixture 中的 `module.version: 0.1.0`、MCP 测试 client 自身版本和历史发布文档均不得机械替换。

## 2. 当前漂移位置与迁移验证

| 当前位置 | 漂移 | 0.2 改法 | 独立验证 |
|---|---|---|---|
| `src/mcp/index.ts` | server metadata 固定 `0.1.0` | 导入 `PRODUCT_IDENTITY` | MCP initialize 返回 0.2.0 |
| `src/distribution/hosts.ts` | 三宿主 manifest、npx 和 hooks 固定 `0.1.0` | `syncHosts` 默认消费 identity，并允许测试注入 | 三套生成目录的 manifest、MCP、hook 都指向同一版本 |
| `tests/host-integrations.test.ts` | 断言固定旧版本 | 从被测 identity 构造 expected | 修改 package version 后无需同步手改断言 |
| `scripts/package-smoke.mjs` | MCP client 写 0.1.0，未核对运行时 identity | client 版本改为测试自身常量；产品断言读取 packed manifest | tarball、运行时、CLI、MCP 报告一致 |
| `scripts/registry-smoke.mjs` | 安装和断言固定 0.1.0 | 读取仓库 manifest 后安装精确目标 | registry manifest 与本地候选 identity 一致 |
| README MCP 示例 | 固定 0.1.0 | 通用文档使用 `@preview`；发布页保留精确值 | 文档检查不再发现活动说明中的旧安装 spec |
| host/plugin caches | 可能保留旧生成物 | 只更新 canonical generator，重新生成再 check | 生成检查为 0 diff，三个宿主均可直接导入 |

验收时使用定向搜索，但只把“产品身份消费点”判为漂移：

```powershell
rg -n '0\.1\.[0-9]+|@lukawi/toporealm@0\.1' src integrations scripts tests README.md README.en.md
```

命中 fixture、历史 release notes 或第三方 MCP client identity 时允许保留，并在验证报告解释类别。

## 3. Core 与 Workflow 兼容矩阵

| Core | Workflow/图输入 | 读取 | 写入与校验结论 |
|---|---|---|---|
| 0.2.x | `toporealm.graph/v1`、当前简写 module schema | 无损读取；私有数据原样保留 | adapter 执行可表达的基础字段校验；缺少正式 validator 时 `complete:false`，不得声称完整校验 |
| 0.2.x | `@lukawi/toporealm-workflow@0.1.0` 图与 fixture | 无损读取，模块存在/缺失均不得改写未知区域 | 仅在该模块实际提供的能力范围内执行；缺少 0.2 validator 时完整校验不可用 |
| 0.2.x | 未来 `@lukawi/toporealm-workflow@0.1.1` | 通过正式 JSON Schema 读取 | 加载 snapshot/transition validators 后才能得到 `complete:true` |
| 0.3.0 | 尚未迁移的简写 schema | 读取图事实，但模块声明诊断为 legacy unsupported | 不执行模块私有写入；迁移完成前 `complete:false` |

Workflow 0.1.1 必须在独立模块仓库完成 JSON Schema、状态迁移 validator、连接测试和多模块组合测试，并声明 Core `>=0.2.0 <0.3.0`。本仓只提供跨包契约 fixture，不把 Workflow 代码移回 Core。

## 4. 0.2.x 兼容 adapter 生命周期

兼容 adapter 接受当前 module schema 简写，产出统一内部 `CompiledModuleSchema` 和结构化 notice：

- `code: LEGACY_SCHEMA_ADAPTED`；
- module ID、声明路径和检测到的简写版本；
- `complete:false` 的原因（缺少正式 JSON Schema 或 validator）；
- 建议运行的迁移命令，但不静默写回文件。

adapter 不猜测复杂约束，不把 `required`、枚举值之外的字段扩展成不存在的业务语义，也不修改原始 YAML。

## 5. 0.2.0 Preview 执行清单

1. 将 `package.json` 版本设为 0.2.0，并保持 `publishConfig.tag=preview`。
2. 建立 manifest-backed `PRODUCT_IDENTITY`，接通 MCP、CLI、host generator、hooks 和 smoke。
3. 实现简写 Schema adapter 与结构化 notice；添加当前 Workflow 0.1.0 fixture 契约测试。
4. 将活动 README、API 和迁移文档从 GraphStore 写例迁移为 ManagedGraph；通用安装示例使用 `@preview`。
5. 运行 typecheck、全量测试、Web 验证、package smoke 和三个宿主真实导入。
6. 在用户发布门通过后发布精确候选，核验远端 commit/tag、npm version/dist-tag、GitHub Release 和 registry 干净安装。

## 6. 0.3.0 删除 adapter 的必要条件

以下条件全部满足后才能删除 0.2.x adapter：

1. 提供公开 CLI 命令，对指定工作区做 dry-run、逐文件诊断、备份和显式确认后的 schema 迁移；
2. 迁移命令幂等，重复运行不产生差异，并能在失败时保持原文件；
3. 所有正式维护模块均发布 JSON Schema 2020-12，并登记所需 snapshot/transition validators；
4. 0.2 最后一个 minor/patch 的弃用诊断已经指向该命令和 0.3 删除时间；
5. 迁移 fixture 覆盖当前 Workflow 0.1.0、模块缺失、未知私有字段和多模块图；
6. 0.3 对未迁移模块返回明确错误和 `complete:false`，仍保持图事实无损可读。

未满足任一条件时，0.3 不得通过简单删除代码制造数据迁移压力。
