# modules-template — TopoRealm 模块模板

覆盖模块**所有可能板块**的可构建脚手架。创建模块 = 复制本目录 → 改名 → 填词汇表 →
写 activate → 构建 → 安装。`module-creator` 基座技能（`toporealm skills index` 可见）
教完整流程；本 README 是板块对照表。

## 板块对照表（谁必填、谁消费）

| 板块 | 位置 | 必填? | 消费者 |
|---|---|---|---|
| `format` | module.yaml | ✅ 固定 `toporealm.module/v2` | 装载校验 |
| `id` | module.yaml | ✅ 全局唯一 kebab | 安装落位 / 所有权来源 `module:<id>` |
| `namespace` | module.yaml | ✅ 全局唯一短小写 | 所有权边界 + kind/命令前缀 |
| `version` | module.yaml | ✅ semver 字符串 | 模块集 digest / 目录事实 |
| `requires.modules` | module.yaml | 可选 | 装载期依赖检查（缺失 = daemon 拒启大声失败）+ 拓扑序 |
| `kinds.objects` / `kinds.relations` | module.yaml | 建议 | 所有权法词汇表 + 目录投影；**只增不删** |
| `ui.color` / `ui.icon` / `ui.titleKey` | module.yaml | 可选 | WebUI 画布/CLI 目录静态投影（core 不解释） |
| `entry` | module.yaml | ✅ | daemon import 的构建产物（必须自包含、零运行时依赖） |
| `command(spec, handler)` | activate | 按需 | 目录事实 `cmds`；`target` 绑定实体或全局；`input` JSON Schema 是 agent 的唯一文档 |
| `hook("before-commit")` | activate | 按需 | 领域门禁唯一标准形态：可 veto（first-veto 短路）；对一切来源生效；undo/redo 豁免（D24①） |
| `hook("after-commit")` | activate | 按需 | 响应式追加：可 `api.commit`（排队，land 后排空，不嵌套） |
| `form(kind, form)` | activate | 按需 | WebUI inspector 载荷表单（经 catalog.forms 携带；1.x WebUI 消费预留） |
| `api.read/get/byKind/commit` | activate 与 handler 内 | — | 同步内存态读写缝；`api.commit` 以 `module:<id>` 来源过所有权法 |
| `skills/<name>/SKILL.md` | 模块根 | 建议 | 随模块进池 → `toporealm skills index` → agent 入手（frontmatter 只需 name+description） |
| `dist/`（构建产物） | entry 指向 | ✅ | daemon 直接 import；**零运行时依赖**（SDK 只类型导入，emit 后擦除） |

## 使用步骤

1. 复制本目录为你的模块仓（不要放 toporealm 仓库里）。
2. `module.yaml`：改 `id` / `namespace` / `kinds` / `ui`（命名规则见各字段注释）。
3. `package.json`：改 `name` / `description` / `repository`。
4. `src/index.ts`：改 `CARD`/`LINKS` 词汇常量与命令/钩子/表单。
5. `skills/my-module/SKILL.md`：目录改名 + frontmatter 改名 + 教你的真实命令。
6. `npm install && npm run build`。
7. 安装：`toporealm module add <本目录>`（path 来源）或 `npm pack` 后装 tgz；
   `--global` 进全局池。
8. 验证：`toporealm cmds --module my`（命令目录）→ `toporealm skills index`
   （技能可见）→ 跑一条命令 → 试一次空 title（钩子 VETOED）→ `toporealm undo`。

## 发布（npm 形态）

- `prepack` 已接 build——`npm publish` 前自动构建；`files` 只带 dist/module.yaml/skills。
- 装包名与模块 id 可不同；包内 `package.json` 可用 `"toporealm": "<清单路径>"` 把清单
  指到非根位置（缺省 = 包根 module.yaml）。
- 自包含红线：dist 对平台/其它包零运行时依赖——`module-sdk` 只 `import type`。

## 纪律（装载与执法的边界）

- 声明层（module.yaml）只管协调，**不是执法依据**；行为全在 activate。
- core 执法仅两条：所有权法（只拦 `module:*` 来源提交触碰他家命名空间）+ 悬空边。
  你的领域规则全部走 before-commit 钩子；不要指望 core 替你校验。
- 钩子内禁止 commit（REENTRANT_COMMIT）；注册面 activate 返回后冻结
  （LATE_REGISTRATION）。
- 错误码是封闭集：模块领域错误用鸭子类型（抛 `{code, message}` 形状，host 认领重建
  TopoError）；码只用 protocol/src/errors.ts 现有集合。
