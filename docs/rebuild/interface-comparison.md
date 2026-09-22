# 1.0 接口设计对比与综合（Design-It-Twice 第三步）

> 输入：`interface-minimal.md`（A 极简）、design-extensible（B 扩展）、design-caller-first（C 调用者优先）。
> 本文：逐维对比 → 四个关键分歧点的裁决建议 → 综合方案（hybrid）骨架 → 遗留开放点。
> 词汇：codebase-design（depth=单位接口的杠杆、locality=变更局部性、seam=缝位置）。

---

## 1. 三方案速览

| | A 极简 | B 扩展 | C 调用者优先 |
|---|---|---|---|
| S1 入口 | **4 方法**（read 联合 / commit 吃下 undo/redo / call / subscribe） | Session 分组 ~12 方法（graph 四方法独立 / daemon / log / commands / modules / events） | ~13 成员（四方法独立 + set 糖 + log/commands/run/status/use/events） |
| S2 形态 | activate(api)，api 4+1 成员；命令自由持有 api（可多次 commit） | api 分面（self/graph/register*/on）；**handler 返回 mutations，daemon 代提交**（一命令至多一提交） | api 7 成员；命令自由 commit；钩子必须同步；after-commit 可排队提交 |
| S3 命令数 | **7**（use/read/commit/run/serve/module/migrate；undo/redo 是 commit 的旗标） | ~17（传统动词 + schema + host sync） | ~17（git/LLM 先验动词：set/add/link/rm/find；**模块命令即顶层子命令**） |
| 错误码 | **8** | ~17（传输/图/命令分层） | 15，**每个带 hint+fix（可复制的恢复命令）** |
| 写词汇 | upsert_object / upsert_relation / delete | object.put/delete / relation.put/delete / manifest.patch（按集合分桶） | **put / rel / merge★ / del**（merge=daemon 端浅合并，主路径） |
| 并发 | **无 expectedRevision**（队列串行+钩子把关） | expectedRevision 可选 | ifRevision 可选 |
| 事件 | sync 首发必达 / transition / shutdown | AsyncIterable + **fromRevision 回放**（重连免全量）+ instanceId 失效协议 | hello / commit / reset（自愈） |
| 所有权豁免 | 未明说（隐含对一切 apply 生效） | **用户提交豁免**——人是图最终属主 | **I6 明示**：所有权法只约束 module 来源 |
| 钩子入参 | mutations + read() | **before/after 双快照**（钩子直接读候选图） | 注记过的 changes + 自行 read |
| 输出契约 | **stdout 恒 JSON**（--pretty 给人） | --json 信封 {ok,data,revision,instanceId} | --json flag + **错误自带 fix** |
| 独门绝技 | 转换统一（apply/undo/redo/file 同形）→ 钩子/日志/补丁零分叉；生命周期出缝 | port/adapter 对称 + instanceId + 回放；契约包零依赖根治双向依赖 | merge + 动词先验 + created 回显 + hint/fix → **6 命令 ≈750 token 完成任务流转** |

## 2. 逐维对比

### Depth（单位接口的杠杆）
- **A 最高压缩**：4 方法、7 命令、8 错误码，每个入口承载巨大语义（commit 吃下 undo/redo；read 吃下目录/历史自省）。但杠杆以参数形状复杂度为代价——`commit({undo:true})`、read 判别联合把认知负担从"多入口"转移到"入口内分型"。
- **B 的杠杆面向客户端多样性**：一份 port 喂 IPC/WS/内存三个 adapter，MCP 复活是结构事实。Session.instanceId 把"模块集重启失效"形式化了。
- **C 的杠杆面向调用者 token 与往返**：merge 让改状态一条命令零预备往返；created 回显免二次 read；hint/fix 让错误自愈。接口成员多但每个近似零学习成本（git/LLM 先验）。
- **判定**：A 赢在纯度，C 赢在产品杠杆，B 赢在结构杠杆。三者不互斥——A 的统一是**实现层**美德，C 的动词是**表现层**美德，B 的 port 是**契约层**美德。

### Locality（变更局部性）
- A：四种转换同形 → 管线零分支，locality 极致；外部编辑可撤销是统一性的免费礼物。
- B：集合分桶 patch → 新资源种类是增量字段；instanceId 把失效收敛为一个判别点。
- C：undo=普通条目/管线固定顺序，心智局部；但 inverse-append 的 undo 模型使日志增长与 redo 推导有隐性耦合（可 redo 性依赖日志尾部形状）。
- 判定：A/B 的 locality 模型可直接并入实现；C 的 undo-append 有隐性复杂度，**不采**。

### Seam 位置
- 三方案在宏观上一致：S1=daemon 边界（IPC/WS/内存 adapter），S2=in-process activate，S3=薄 CLI。
- 分歧在**生命周期归属**：A 把图 init/list/switch 与模块安装彻底逐出 daemon 缝（daemon 只见"一张已被决定的图"）；B/C 把 use/graphs 留在客户端 API。
- 判定：**A 的切法更深**——daemon 永不对"多图"负责，自动拉起+空闲退出让换图近乎免费；CLI 的 use/graphs 是文件层操作。采纳 A，但 CLI 表面保留 use/graphs/new（用户可见性不受缝位置影响）。

## 3. 四个关键分歧点的裁决建议

| 分歧 | 选项 | **裁决建议** | 理由 |
|---|---|---|---|
| ① 命令写入模型 | handler 自由 commit（A/C）vs 返回 mutations 由 daemon 代提交（B） | **A/C：自由 commit** | 平台定位下模块作者心智最轻（"就是写代码"）；一命令一提交的原子性诉求由模块自律或拆分命令解决；钩子重入防护照搬（钩子内禁 commit） |
| ② undo 实现 | 游标（A/B/D7）vs inverse-append（C） | **游标** | C 模型日志无界增长、redo 推导依赖尾部形状；游标模型下 D7"一个文件三个功能"严格成立（undo 是日志上的位置，不是新事实） |
| ③ CLI 形态 | 7 命令（A）vs ~17 动词（B/C） | **C 形态 ~16 动词**（含模块命令做顶层子命令、cmds 目录、hint/fix 错误） | D13 的全部价值在 agent 主干路径；`set t-7 status=running` 与 `E_VETOED→fix` 是 agent 效率的直接兑现；skills 押注的语法面虽大但每个动词都是先验词，漂移风险反而低 |
| ④ 读查询力 | 无查询（A/B 全量）vs ids/where/fields 投影（C） | **C-lite**：ids + kinds + where 顶层浅等值 + fields 投影；depth 预留 | agent 的 token 经济是真实成本（C 预算表：找目标 250 vs 全图万级）；where 保持浅等值防止查询语言膨胀 |

## 4. 综合方案（hybrid）骨架

**立场**：C 的主干体验 + B 的契约结构 + A 的实现统一。

### S1 daemon 客户端 API（port，~12 成员）
```ts
// 契约包 @lukawi/toporealm-client（types-only，零运行时依赖——根治 0.x 双向依赖）
interface DaemonClient {
  connect(opts?: { root?: string; graph?: string }): Promise<Session>;
}
interface Session {
  readonly graphId: string;
  readonly instanceId: string;              // B：模块集/目录失效的判别点
  status(): Promise<GraphSummary>;
  read(query?: ReadQuery): Promise<ReadResult>;        // C-lite 查询：ids/kinds/where/fields
  log(opts?: { limit?: number }): Promise<LogEntry[]>; // D7 统一提交日志尾读
  commit(input: CommitInput): Promise<CommitResult>;   // changes: put/rel/merge/del
  undo(steps?: number): Promise<CommitResult>;         // 四方法独立（D4 字面），实现层统一管线（A）
  redo(steps?: number): Promise<CommitResult>;
  catalog(module?: string): Promise<Catalog>;          // 命令/表单/投影自省（D12）
  run(commandId: string, opts?: { target?: EntityId; input?: unknown }): Promise<CommandRunResult>;
  events(listener, opts?: { fromRevision?: number }): Promise<Unsubscribe>;  // B 回放 + hello/commit/reset（C）
  close(): Promise<void>;
}
// ifRevision?: number 在 CommitInput 上（可选护航，WebUI 表单建议恒带）
// 错误码 ~14，全带 hint/fix（C）
```

### S2 模块 runtime API（api 8 成员）
```ts
export default { activate(api) {} };
interface ModuleApi {
  readonly self: { id; namespace; version };
  read(query?): ReadResult;                    // 同步，in-process
  get(id): Entity | undefined; byKind(kind): Entity[];   // B 的便捷直取
  commit(input): CommitResult;                 // 所有权法执法点：module 来源，触碰 self.namespace 或公共 kind
                                               // 用户（cli/web/external）豁免——人是图最终属主（B/C 明示，D9 本义）
  command(spec, handler): void;                // handler 自由调用 api（裁决①）；注册后冻结
  hook(name: "before-commit" | "after-commit", fn): void;   // v1 同步（C）；after-commit 可排队提交
  form(kind, formSpec): void;
}
// before-commit 入参 = { before, after, changes, source }（B 双快照——钩子直接对候选图做领域判断）
// 钩子内禁 commit（重入防护）；first-veto 短路；core 不聚合不排序（D10）
```

### S3 CLI（~16 动词，C 形态）
```text
status / read / find / set / add / link / rm / undo / redo / log
use / graphs / new / cmds / serve / module(add|rm|list) / migrate / host sync
<ns.name> [target] [--input json]     ← 模块命令即顶层子命令（C）
--json 信封 + 退出码 0/1/2 + 错误带 hint/fix
```

### 实现层统一（A 的洞见，不进接口）
- 提交管线对 commit/undo/redo/外部重载**同形**：所有权法（module 来源）→ 悬空边 → before-commit 钩子 → 原子落盘+日志 → after-commit → 广播。钩子可否决任何来源（含 undo）。
- 图生命周期（init/switch/模块安装）在 daemon 缝之外：daemon 只见一张图；换图/装模块 = 空闲退出 + 自动拉起。
- 错误码天花板 ~14（A 的 8 + C 的环境/实体类），全库总表冻结。

### 包结构（B/C 共识，结构性修复双向依赖）
```text
protocol（纯类型，零依赖）◄── client（port + ipc/ws/memory adapter）◄── cli / web-ui
     ▲                              ▲
daemon-core（管线/存储/watch/日志，绝不 import module-host）
     ▲
module-host（装载/api 构建/目录聚合）──► 模块（仅类型依赖 module-sdk）
```

## 5. 遗留开放点（实现期可反悔）

1. **direction 字段**：A 进载荷（默认有向）vs B 结构保留 vs C 未提。建议：结构上可选字段默认 "directed"（画布需要；不占执法）。
2. **B 的 `schema` 命令**（输出 Mutation 信封 JSON Schema 供 agent 自举）：目录已含命令 input schema，全局 schema 命令是廉价补充，v1.1 可加。
3. **async 钩子**：v1 同步；`hook(name)` 的机制按类型名扩展（B 原则），异步化是增量。
4. **after-commit 链式写入**：C 允许排队追加；注意与 undo 游标的交互（排队提交发生在当前转换完成后，正常追加）。
5. **大 payload**（长报告/二进制）：约定层解决（外置文件+引用），缝不管（B 判断采纳）。
