# 可恢复提交与外部编辑协议

状态：`l1_persistence_contract` 冻结稿；适用 `@lukawi/toporealm` 0.2.0 Preview。
协议标识：`toporealm.recoverable-commit/v1`
范围：同机同一图目录的 Core 持久化边界。Core 是唯一受支持的写入者；Web、CLI、MCP 和模块动作只能提交 `MutationPlan`，不能直接写事实文件。

本文冻结的是可执行协议，不是存储实现。实现必须把本文的阶段、恢复判断、历史边界和审计字段落成同一套状态机；不得用“启动时扫一遍目录”替代 journal 或把多个 YAML 文件的顺序写入当成原子提交。

## 1. 目标、不变量与非目标

### 1.1 目标

- 同机多个 Core 进程对同一图目录串行写入；冲突返回稳定的 `GRAPH_LOCKED`，不静默覆盖。
- 一次提交在支持的 Core 读入口中只暴露完整旧版或完整新版。进程在任一内部阶段崩溃后，下一次取得锁的进程能确定回旧或完成新。
- 外部编辑以“吸收”为事实事件：保留用户写入、建立新的 revision 基线、封存旧 history segment、清除 redo，并返回结构化 notice。
- 审计只记录提交索引信息，不复制模块私有对象、关系或 `data`/`capabilities` 内容。

### 1.2 不变量

1. 每张图只有一个单调递增的 `revision`；提交的 `nextRevision` 必须是 `baseRevision + 1`，外部文件里携带的 revision 不能倒灌进 Core。
2. `expectedRevision` 在锁内、恢复和外部编辑吸收之后检查。过期时返回 `REVISION_CONFLICT`，本次计划不进入 staging。
3. 所有当前事实文件按规范化字节排序后形成一个 `snapshotDigest`。digest 只用于发现外部变化和旧/新分类，不作为业务数据。
4. journal、旧备份、新 staging、history 和 audit 都必须在清理完成前可恢复；任何一个临时目录未清理都不能使下一次读到半份事实。
5. 事务中的路径均为图根目录内的相对路径；拒绝 `..`、绝对路径、符号链接逃逸和未列入 manifest 的写入。
6. 支持的 Core 读、写、undo、redo 和恢复都先取得同一图锁。直接打开 YAML 的编辑器不获得一致读保证；它的修改只能在下一次 Core 入口被检测并吸收。

### 1.3 非目标

- 不做跨机器/网络文件系统的分布式锁，不做 CRDT、字段级自动合并或 redo 分支合并。
- 不把模块校验器、模块私有运行时或外部副作用复制进 Core audit；缺模块时只按无损读取/基础校验规则处理。
- 不保证外部编辑器在 Core 正在提交的瞬间看到一致的中间文件；支持的 Core 入口会被锁串行化。

## 2. 持久化对象与目录布局

以下是 0.2 目标布局。事实文件仍保持现有图格式，内部实现可以用等价的 generation/pointer，只要对外满足相同的状态机和恢复结果。

```text
<graph-root>/
  graph.yaml                         # 图 manifest
  objects/<id>.yaml                  # 对象事实
  relations/<id>.yaml                # 关系事实
  .revision.json                     # { revision, snapshotDigest }
  .history/index.json                # 当前 segment、cursor、已封存 segment 索引
  .history/segments/<segment>.json   # segment baseline 与 undo/redo entries
  .audit.jsonl                       # 只追加的最小审计记录
  .toporealm.lock                    # 同机互斥锁，进程崩溃后可回收
  .toporealm-txn/<commit-id>/
    journal.json                     # 单事务状态，原子更新
    old/<相对路径>                   # 提交前完整备份
    new/<相对路径>                   # 提交后完整 staging
```

`facts` 是 `graph.yaml`、`objects/*.yaml`、`relations/*.yaml` 及 `.revision.json` 的完整集合；`.history` 和 `.audit.jsonl` 是与事实同一提交边界维护的持久化元数据。实现若采用 immutable generation，generation 目录必须包含同样的完整 facts，active pointer 的替换必须等价于本文的 `atomicReplace`。

### 2.1 journal 最小形状

```json
{
  "protocol": "toporealm.recoverable-commit/v1",
  "commitId": "c_20260914_01J...",
  "state": "prepared",
  "source": "web",
  "label": "修改标题",
  "baseRevision": 3,
  "nextRevision": 4,
  "baseDigest": "digest:v1:...",
  "nextDigest": "digest:v1:...",
  "stageComplete": true,
  "factPaths": ["graph.yaml", "objects/a.yaml", "relations/r.yaml", ".revision.json"],
  "allPaths": ["graph.yaml", "objects/a.yaml", "relations/r.yaml", ".revision.json", ".history/index.json", ".audit.jsonl"],
  "historySegmentId": "seg_0001",
  "appliedPaths": []
}
```

journal 只保存路径、revision、digest、阶段和恢复所需索引；`factPaths` 是事实集合，`allPaths` 还必须覆盖本事务会更新的 history/audit 路径。旧/新文件内容分别在 `old/` 与 `new/`。每次阶段变化都以同目录临时文件写入、flush、再 `atomicReplace` `journal.json`；不能先删除目标再 rename，因为那会制造可见空洞。

### 2.2 原子替换原语

实现必须提供下面两个原语，所有事实、revision、history 和 audit 的文件更新只能通过它们完成：

1. `atomicReplace(path, bytes)`: 在同一目录写唯一临时文件，写完并 flush，使用平台支持的“替换目标”原子 rename，再 flush 父目录（平台不支持时至少保证 rename 的原子语义，并记录能力限制）。目标存在和不存在都必须得到同一结果。
2. `atomicRemove(path, backupPath)`: 先把旧目标原子 rename 到本事务 `old/` 备份，再 flush；禁止直接 `unlink` 作为提交步骤。恢复时可将备份原子放回。

临时文件名必须带 `commitId`，恢复只认 journal 列出的正式路径；孤儿 `.tmp-*` 和不完整事务目录只能在持锁后清理，不能参与读图。

## 3. 同机多进程锁

### 3.1 获取、持有与释放

锁文件使用同图根目录的排他创建（等价于 `O_CREAT | O_EXCL`），内容为：

```json
{
  "protocol": "toporealm.recoverable-commit/v1",
  "pid": 1234,
  "host": "same-machine-identity",
  "token": "random-owner-token",
  "startedAt": "2026-09-14T12:00:00.000Z",
  "heartbeatAt": "2026-09-14T12:00:00.000Z"
}
```

- `read`（包括读取前恢复）、`commit`、`undo`、`redo` 和外部编辑吸收都取得同一个排他锁；锁持有覆盖整个事务和清理阶段。
- 获取成功后以 `token` 作为 owner；只有 token 相同的 owner 才能释放锁。正常释放发生在 journal 清理之后。
- 已有锁且 owner 仍存活时立即返回 `GRAPH_LOCKED`，不等待、不覆盖、不使用 agent `force`。
- 同一进程的嵌套操作必须复用当前 token；不同进程即使提交相同 `expectedRevision` 也不能共享锁。

这是一种**同机**锁：`host` 不匹配、PID 状态不可判断或图目录位于不可靠网络文件系统时，不宣称分布式安全。

### 3.2 崩溃锁回收

取得恢复资格的进程按以下顺序处理遗留锁：

1. 读取 lock 记录；owner 存活或 `host` 不同，返回 `GRAPH_LOCKED`/`LOCK_RECOVERY_REQUIRED`，不删除。
2. owner 在同机且确认已退出，并且 heartbeat 已超过实现声明的 stale 阈值时，将旧锁原子 rename 为 `.toporealm.lock.stale-<token>`，随后以新 token 重试排他创建。
3. 有未完成 journal 时，回收锁后必须先执行第 5 节恢复；没有 journal 时只清理锁和孤儿临时文件。
4. 任一步无法确认 owner 已退出，保留锁并返回 `LOCK_RECOVERY_REQUIRED`；不得靠 PID 猜测强拆。

## 4. 提交状态机

### 4.1 状态与合法迁移

| 状态 | 进入条件 | 此时事实集 | 下一步 | 幂等恢复动作 |
|---|---|---|---|---|
| `idle` | 无本事务 journal | 完整旧版或上次已提交版 | `prepared` | 无操作 |
| `prepared` | old/new staging、digest 和 journal 均 durable，尚未替换正式路径 | 完整旧版 | `applying` 或回旧 | 校验 stage；不完整则丢弃事务并保持旧版 |
| `applying` | 已开始逐路径 `atomicReplace` | 可能旧/新混合，仅锁内不可读 | `facts-applied` 或回旧 | 按 old/new digest 分类；混合时恢复旧版 |
| `facts-applied` | facts 全部等于 new，`.revision.json` 为 `nextRevision` | 完整新版；history/audit 可能旧 | `history-applied` | 补写 new history 与 revision，继续完成新提交 |
| `history-applied` | new history/index 与 segment 已 durable | 完整新版 | `audit-applied` | 补写 new audit，继续完成新提交 |
| `audit-applied` | new audit 已 durable | 完整新版 | `committed` | 保持新版，执行清理 |
| `committed` | 提交标记已 durable | 完整新版 | 删除 txn 与释放锁 | 清理可重试，不改事实 |
| `recovery-required` | 发现既不匹配 old 也不匹配 new 的路径 | 不可安全判断 | 停止并报告 | 保留 txn、锁定写入口，等待人工处理 |

`facts-applied` 是业务事实的 commit point：恢复可从路径 digest 推断它，即使进程在“最后一个 facts 替换完成”和 journal 状态写入之间中断。只有 `facts` 全部为 new 才完成新提交；否则恢复到 old。支持的读入口不会在 `applying` 中间状态返回。

### 4.2 正常 commit 序列

1. 取得锁，执行遗留事务恢复，再读取当前 facts；若发现外部变化，先走第 6 节吸收，不把旧计划自动合并进去。
2. 在锁内检查 `expectedRevision`，运行 Core 基础校验、已启用模块的 snapshot/transition 校验；error 直接结束，不产生 journal。
3. 生成 `commitId`、`baseRevision`/`nextRevision` 和 canonical digest；把完整旧 facts 复制到 `old/`，把完整候选（含新 revision）写入 `new/` 并验证 staging digest。
4. 写 `state=prepared, stageComplete=true` 的 journal；成功后才允许触碰正式事实路径。
5. 按稳定路径序逐个替换 facts，之后写 `state=facts-applied`；所有替换都是 `atomicReplace`/`atomicRemove`。
6. 原子替换 history index/segment，写 `state=history-applied`；再用旧 audit 加一条新记录整体替换 audit，写 `state=audit-applied`。
7. 写 `state=committed`，删除事务目录和临时文件，释放锁，返回 snapshot、patch、history 状态及审计索引。

任何步骤的业务校验失败都走“未开始提交”路径；任何进程崩溃都按 5.1 表恢复，不能以重启重放 plan 代替 journal。

### 4.3 恢复判定算法

持锁后发现 journal，恢复器必须先验证 `protocol`、路径集合、old/new digest 和 staging 完整性，再读取每个正式路径：

1. 任一路径既不等于 old digest，也不等于 new digest：写入 `recovery-required`，保留所有文件和 journal，返回 `RECOVERY_REQUIRED`；这表示有未受 Core 锁保护的并发外部写入，不能猜测覆盖。
2. `stageComplete=false` 或所有事实仍为 old：原子恢复 old facts/history/audit，记录一次 `rolled-back` 恢复审计，删除事务；业务事实回到完整旧版。
3. facts 有部分 new、部分 old：统一恢复 old（即使 history/audit 已部分写 new），再记录 `rolled-back`；绝不把混合态作为成功。
4. facts 全部 new：以 new 为最终选择，补齐或修复 history/audit，写 `committed` 并清理；若 audit 尚未写入，恢复审计记录的 `recoveryStatus` 为 `recovered-complete`。
5. 清理阶段再次中断时，看到 facts 全 new 仍只继续清理；看到完整 old 则只清理回滚事务。清理必须幂等，不能删除当前正式路径。

内部崩溃的每个标准中断点都只产生两个业务结果：完整旧版（rollback）或完整新版（finalize）。第 5.1 的 `external_during_apply` 是外部编辑器越过 Core 锁的安全异常，不是可自动判定的内部崩溃，必须停在 `RECOVERY_REQUIRED`，以免覆盖用户事实。

### 4.4 revision 与失败语义

- `nextRevision` 只在 facts 全部 new 的 commit point 生效；回滚保持 `baseRevision`，不重用失败事务的 `nextRevision`。
- `REVISION_CONFLICT`、校验 error 和 `GRAPH_LOCKED` 均不生成 history entry；若已写 journal 但尚未 commit，恢复审计可记录 rollback，但不制造可撤销编辑。
- 不允许通过减少 `.revision.json`、重放旧 journal 或编辑 history 来绕过单调 revision。

## 5. 中断点覆盖矩阵

| `pointId` | 可能的最后动作 | 恢复选择 | 结果 | 是否幂等 |
|---|---|---|---|---|
| `lock_before_journal` | 锁已创建，尚无 journal | 保持旧版，回收锁 | 无提交 | 是 |
| `staging_incomplete` | old 或 new 未完整 flush | 丢弃未完成 txn，保留旧版 | 无提交 | 是 |
| `journal_prepared` | journal=prepared，正式路径未动 | 丢弃 staging，保持 old | rollback | 是 |
| `applying_before_first` | journal 切到 applying，尚无替换 | 恢复 old | rollback | 是 |
| `applying_partial` | 任意数量正式路径已 new | old/new digest 分类后统一恢复 old | rollback | 是 |
| `facts_complete_marker_gap` | 最后 facts 已 new，状态仍 applying | 识别 facts 全 new，补 history/audit | finalize | 是 |
| `history_partial` | facts new，history 未完整 | 保持 facts new，修复 history | finalize | 是 |
| `audit_partial` | facts/history new，audit 未完整 | 保持 new，重建 old+新记录的 audit | finalize | 是 |
| `commit_marker_cleanup` | committed 已 durable，清理未完成 | 保持 new，继续删除 txn | finalize | 是 |
| `cleanup_partial` | 部分临时文件已删除 | 按事实集选择 old/new，重复清理 | rollback 或 finalize | 是 |

`external_during_apply` 不在上述内部崩溃选择中：若某路径 digest 两边都不匹配，恢复器必须停止并返回 `RECOVERY_REQUIRED`；只有用户/裁决方解决该外部冲突后才能再次运行恢复。

## 6. 外部 YAML 编辑吸收

### 6.1 检测边界

Core 每次持锁进入 `read`、`commit`、`undo` 或 `redo` 时，都把当前 `graph.yaml`、对象、关系和 revision 整理成 canonical bytes，并与最近一次完成提交的 `snapshotDigest` 比较：

- digest 和已记录 revision 都相同：没有外部编辑，按普通流程继续。
- facts digest 或 revision 元数据不同，且没有未完成 journal：认定为外部编辑；不使用外部 revision 覆盖单调 revision，进入吸收流程。
- 有未完成 journal：**先恢复 journal，再重新检测**；不能把事务中间态误报成外部编辑。
- 外部编辑了 `.history`、`.audit.jsonl` 或 `.toporealm-txn` 私有路径：不吸收其元数据；若造成 old/new digest 无法分类，返回 `RECOVERY_REQUIRED`。

digest 的输入不包含自身字段，也不包含 audit/history；它包含 facts 的相对路径、文件规范化字节和当前 Core revision，使用版本化的 `digest:v1` 表示。实现可以选择 SHA-256 等稳定算法，但算法标识必须随摘要保存，不能在同一图内静默更换。

### 6.2 吸收序列

外部吸收是一种特殊的 Core 提交，仍复用第 4 节的事务状态机：

1. 取得锁并完成遗留恢复；读取用户当前 facts，先做 YAML 语法、公共 envelope、文件名与关系端点的基础校验。
2. 基础校验失败时不写 revision/history/audit，不把损坏内容当作提交；返回 `EXTERNAL_EDIT_INVALID` 与可修复路径。旧 audit 和旧 history 不删，事务不进入 applying。
3. 基础校验通过时保留当前所有可读取字段（包括未知模块 namespace 的 `data`、`capabilities` 和额外 YAML 字段），**不尝试字段级合并或推断逆操作**。模块缺失或完整 validator 不可用不阻止吸收，但结果的 `complete=false` 并列出 `missingModules`/诊断。
4. 以旧 Core revision 为 `fromRevision`，分配 `toRevision=fromRevision+1`；新的 facts 以外部内容为准，外部 YAML 里的 revision 只作为被吸收事实，不作为计数器。
5. 封存当前 segment，创建新的 `segmentId`，其 baseline 就是 `toRevision` 的外部 facts，cursor=0、entries=[]；因此旧 segment 的 undo/redo 不可达。
6. 用 `source="external"`、`label="吸收外部编辑"` 和 `recoveryStatus="absorbed"` 写新 audit。audit 采用旧日志加一条新记录整体 `atomicReplace`，绝不截断旧记录。
7. 返回新的 snapshot（或完整 reload 所需的 revision）和以下结构化 notice。notice 是调用者识别“这不是普通 mutation”的唯一稳定入口。

```json
{
  "code": "EXTERNAL_EDIT_ABSORBED",
  "fromRevision": 7,
  "toRevision": 8,
  "segmentId": "seg_0002",
  "redoCleared": true,
  "auditPreserved": true,
  "preserved": true,
  "complete": false,
  "missingModules": ["workflow"]
}
```

`missingModules` 无缺失时返回空数组；`complete=false` 只表示完整模块校验暂不可得，不表示丢失或过滤了外部事实。吸收本身不产生可撤销 entry，不能由普通 `undo` 回到吸收前的旧 segment。

notice 的稳定字段为 `code`、`fromRevision`、`toRevision`、`segmentId`、`redoCleared`、`auditPreserved`、`preserved`、`complete` 和 `missingModules`；实现不得用一条自由文本替代这些字段。

### 6.3 吸收期间的竞态

外部编辑器可能在 Core 读取后、staging 完成前再次保存。Core 在写正式路径前必须重新比较 `baseDigest`：

- 未变：继续事务；
- 已变但能完整读取：放弃当前 plan/吸收 staging，返回 `EXTERNAL_EDIT_RACE`，下一次入口重新吸收；不自动合并；
- 已变且不可读取，或与 old/new 均不匹配：保留现场，返回 `RECOVERY_REQUIRED`。

因此一次普通 MutationPlan 不会悄悄覆盖外部 YAML。用户确认后，以新的 baseline/revision 重新提交是唯一受支持的合并方式。

## 7. History segment 与 undo/redo 边界

### 7.1 segment 形状

`.history/index.json` 至少保存当前 segment、cursor 和封存列表；每个 segment 至少包含：

```json
{
  "id": "seg_0001",
  "baseRevision": 0,
  "baselineDigest": "digest:v1:...",
  "sealed": false,
  "entries": [
    {
      "id": "entry_0001",
      "beforeRevision": 0,
      "afterRevision": 1,
      "beforeSnapshotRef": "rev-0",
      "afterSnapshotRef": "rev-1",
      "label": "创建卡片"
    }
  ],
  "cursor": 1
}
```

`SnapshotRef` 指向 Core 保留的完整旧/新 facts（实现可以内联恢复值，但不能只保存无法恢复的摘要）。模块私有数据允许在 history 恢复值中保留；“不复制私有数据”只约束 audit。

### 7.2 普通编辑、撤销与重做

- 一次成功的 `MutationPlan` 是一个 entry；同一计划写入多个对象/关系仍只占一个 entry。entry 的 before/after 值必须足以整体恢复。
- 在当前 segment 内，`undo` 要求 `cursor>0`，恢复前一 entry 的 before snapshot，并以新的单调 revision 提交；`redo` 要求 `cursor<entries.length`，恢复后一 entry 的 after snapshot，同样产生新 revision。
- undo/redo 本身是事务，分别以调用者 source 和 `[undo]`/`[redo]` label 写 audit，但不向 entries 追加新的编辑 entry；提交成功后只移动 cursor。
- 每个操作先恢复 journal、吸收外部编辑并检查 expected revision；一旦吸收建立新 segment，原请求返回 history boundary/notice，不跨段替用户撤销外部事实。
- `canUndo = cursor > 0`、`canRedo = cursor < entries.length`，两者只针对当前 segment；封存 segment 永远不能被公开 undo/redo 选中。

### 7.3 新编辑清 redo

撤销后在 cursor 位置产生新的普通编辑时，删除（或标记不可达）cursor 之后的 entries，再追加新 entry；旧 audit 不删，新的 audit 的 label/校验摘要记录该事实。首版不保留分支树，`canRedo` 立即为 false。

外部吸收比普通新编辑更强：旧 segment 整体 `sealed=true`，新 segment 从外部 baseline 开始，旧 segment 的 redo 和 undo 都不可达；notice 必须明确 `redoCleared=true`。

### 7.4 history 恢复与清理

history 的 index、segment 和其引用的 SnapshotRef 在事务完成前不得删除。恢复器按 facts 的 old/new 选择修复 history：facts old 就回到旧 cursor/segment，facts new 就完成新 cursor/segment。清理只删除不再被当前或封存 segment 引用的事务 staging；v1 不要求历史压缩。

## 8. 最小 audit 协议

### 8.1 记录形状

`.audit.jsonl` 每行一个 JSON 对象，**键集合固定且不得扩展为模块私有快照**：

| 字段 | 类型/取值 | 约束 |
|---|---|---|
| `commitId` | 非空字符串 | 对应一次事务；恢复回滚时可用 `<commitId>/recovery` 作为独立恢复记录 |
| `source` | `core` / `web` / `cli` / `mcp` / `module` / `external` / `recovery` | 来源是调用面/事件来源，不是模块名自由扩展 |
| `fromRevision` | 非负整数 | 事务选择 old 时的 revision |
| `toRevision` | 非负整数 | 成功新提交必须为 from+1；恢复回滚记录允许 from=to |
| `timestamp` | ISO 8601 字符串 | 记录写入时间，不参与事实 digest |
| `label` | 非空字符串 | 用户/系统可读；undo/redo 以 `[undo]`/`[redo]` 前缀标识 |
| `checksumSummary` | 对象 | 只含 `algorithm`、`before`、`after`、`fileCount` 四个键；before/after 是 snapshotDigest |
| `recoveryStatus` | `committed` / `recovered-complete` / `rolled-back` / `absorbed` | 说明该事务最终如何落地 |

示例：

```json
{
  "commitId": "c_20260914_01J...",
  "source": "web",
  "fromRevision": 3,
  "toRevision": 4,
  "timestamp": "2026-09-14T12:00:02.000Z",
  "label": "修改标题",
  "checksumSummary": {
    "algorithm": "digest:v1",
    "before": "digest:v1:old...",
    "after": "digest:v1:new...",
    "fileCount": 4
  },
  "recoveryStatus": "committed"
}
```

禁止字段包括 `objects`、`relations`、`data`、`capabilities`、`moduleState`、原始 YAML、模块 runtime 返回值和外部副作用结果。audit 必须是旧日志加新行的原子替换；外部吸收只追加，不重写或截断旧行。恢复 rollback 不伪造成功 mutation：它可以追加 `source=recovery, recoveryStatus=rolled-back, fromRevision=toRevision=baseRevision` 的最小记录。

### 8.2 与 notice、history 的对应关系

- 普通提交：audit `source` 取调用面，`recoveryStatus=committed`；history 当前 segment 追加一个 entry。
- undo/redo：audit 仍取调用面，label 前缀分别为 `[undo]`/`[redo]`；只移动当前 segment cursor，不追加新的编辑 entry。
- 外部吸收：audit `source=external`、`recoveryStatus=absorbed`；旧 audit 全部保留，新 segment cursor=0，并返回 `EXTERNAL_EDIT_ABSORBED` notice。
- 恢复完成新提交：若原 audit 尚未落盘，以 `recoveryStatus=recovered-complete` 写一次；若原 audit 已落盘则保持唯一 commitId，不重复追加成功记录。
- 恢复回旧版：旧 audit 保持，追加独立 recovery 记录；业务事实、revision 和 history 回到 old，事务目录随后清理。

## 9. 可执行合同与实现验收

`tests/recoverable-commit-protocol.test.ts` 是本文的合同 fixture，不创建临时图、不调用生产存储，也不模拟文件写入。它固定验证以下事实：

1. `PROTOCOL_PHASES` 覆盖 `prepared → applying → facts-applied → history-applied → audit-applied → committed`，每个阶段有可判定的恢复动作和幂等声明。
2. `RECOVERY_CASES` 覆盖第 5 节的所有内部中断点；每个点的结果只能是 `rollback` 或 `finalize`，外部竞态单独标为 `manual-required`。
3. `AUDIT_KEYS` 与 `checksumSummary` 的键集合固定；audit 不得出现模块私有字段；`EXTERNAL_NOTICE_KEYS` 覆盖吸收、revision、segment、redo 和完整性提示。
4. `HISTORY_RULES` 固定 cursor/segment 边界：外部吸收创建新 baseline 并清 redo，undo/redo 不跨 sealed segment，撤销后新编辑清除旧 redo。
5. 文档中出现所有 fixture 的 phase/point/字段标识，避免合同测试通过但说明书漏写。

合同测试通过只代表协议表完整；它不代表 `ManagedGraph` 已实现。真正实现节点还必须以延迟进程、崩溃注入和多进程 fixture 验证本文状态机，生产实现不得绕过 Core 写入边界。
