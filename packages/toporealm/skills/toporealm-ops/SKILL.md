---
name: toporealm-ops
description: TopoRealm 图生命周期运维——模块安装卸载与损坏自愈（module add/rm/list）、0.x 旧图迁移（migrate）、WebUI 启动（serve）、多图与专注图切换纪律、TOPOREALM_* 环境变量体系、daemon 排障（启动失败死因、空闲退出、socket/命名管道）。当用户要装/卸模块、迁旧图、起 WebUI、切图配环境变量，或 daemon 连不上/启动失败/WebUI 白屏时使用。Do not 讲日常读写图的动词用法（那是 toporealm 技能的事）；Do not 触及图内数据建模（那是 toporealm-design 技能的事）。
---

# TopoRealm 图生命周期运维（toporealm-ops）

本技能管低频运维与 daemon 排障。日常读写动词（read/add/set/link/rm/undo/log）
与模块能力动态发现见 `toporealm` 技能。图文件仍只有 daemon 一个写者；
module/migrate 是工作区文件层冷路径（不触 daemon），改动由 daemon 模块集摘要
在**下次触达任意 daemon 命令时**自动检测生效——装/卸模块没有"重启"这一步。

## 一、模块安装与卸载（module add / rm / list）

- **安装** `toporealm module add [--global] <npm包名|本地路径>`：
  - npm 来源走 `npm pack --ignore-scripts`；path 来源直接落位。
  - 落位 `.toporealm/modules/<id>/` 并绑定；`--global` 进全局池
    `~/.toporealm/modules/`（对全部项目生效）。
  - 重复安装同 id → `ID_EXISTS`；换版本 = 先 `module rm` 再 `module add`。
- **卸载** `toporealm module rm [--global] [--force] <id>`：
  - 只删带安装器所有权标记的目录 + 绑定；外来/无标记目录拒绝删除。
  - `--force` 只有一类用途：**清单不可读的损坏模块**自愈（损坏模块会让 daemon
    装载大声失败、砖化工作区）。清单可读的模块 `--force` 不豁免所有权检查。
    拒绝卸载的错误信息会给出可直接复制的 fix 命令，照做即可。
- **清点** `toporealm module list`：分段列出 path 绑定 / 项目池 / 全局池，带两种标注：
  - `(被更高优先级副本遮蔽)`——同 id 多池并存时，有效集优先级
    **path > 项目池 > 全局池**；被遮蔽副本仅展示、不参与生效集。
  - `(损坏：原因)`——目录存在但清单不可读；这是用 `--force` 卸载重装的前兆。
- **装后验证**：`toporealm cmds [--module <ns>]`（命令目录 = 注册事实）+
  `toporealm skills index`（技能可见）；跑一条命令实测。

## 二、0.x 图迁移（migrate）

- `toporealm migrate <旧图目录> [--dry-run]`：输入是 0.x 图目录
  （`graph.yaml` v1 + `objects/` + `relations/` + `.revision.json`）。
  1.0+ 图无需迁移——格式不符会明确拒绝，不猜。
- **机械映射，无判断**：`data` 浅合并进 payload；`capabilities` 浅合并（键冲突
  更名 `cap_<键>` 并记录）；`label` → `payload.title`；`meta` → `payload.meta`；
  kind / id / direction 原样。清单外字段丢弃并记录。
- 迁移语义要点（对照预期，别当 bug）：
  - revision 保留计数；**undo 游标清零、提交历史不迁移**（日志从空开始）。
  - 悬空关系**照迁**并单列点名——悬空边检查只执法运行期新提交。
  - 目标图写入 `.toporealm/graphs/<图id>/` 并**迁完即选中**；不覆盖既有图
    （目标已是可装载图 → `ID_EXISTS`，换 id 或删除后重试）。
- **先 `--dry-run`**：只出报告、不落盘、不选中。报告含
  conflicts / degradations / dangling / errors——人类输出给计数，明细看
  `--json` 信封的 `data.*` 字段。零问题再实迁。

## 三、WebUI（serve）

- `toporealm serve [--port P] [--no-open]`：确保带 web 伺服的 daemon 在跑
  （必要时自动拉起 detached `toporeald`，**透传 `--idle-ms 0`——serve 拉起的
  daemon 常驻，不空闲退出**，浏览器开着/关掉都不会 30 秒自旋消失）→ 打开
  浏览器即退。daemon 常驻，命令退出/Ctrl+C 都不影响它。
- 已有 daemon 在跑则**直接复用**，此时 `--port` 不生效（会明确提示，不静默吞）；
  要固定端口先停 daemon 再 `serve --port P`。`--no-open` 只打印 URL 不开浏览器。
- **`WEB_STATIC_MISSING`**（daemon 无 WebUI 静态产物 = 纯 WS 模式，打开只会白屏，
  故 serve 主动拒绝）：按错误里的 hint 处理——老 daemon 停掉后重试 serve
  （客户端自动拉起新 daemon）；或升级安装包；或设
  `TOPOREALM_WEB_STATIC=<web-ui dist 目录>` 指向静态产物。纯 `/api/*` 与 `/ws`
  不受影响，机器客户端可继续用。
- daemon 拉起超时 → `DAEMON_UNREACHABLE`，处理见「五、daemon 排障」。
- **画布语义分层来自模块声明**：module.yaml `ui.kinds` 里 `represent: "container"`
  的 kind 渲染为容器分区（成员 = 指向它的 `member_of` 边，方向恒为 成员 → 类），
  `represent: "annotation"` 渲染为宿主角标/附属侧栏，不声明 = 普通节点。core 不解释
  represent——错标只影响渲染，不影响图事实。

## 四、多图策略与专注图（use）

- 图存于 `.toporealm/graphs/<图名>/`（YAML + 提交日志，可入库）。
  `creategraph` 建图并选中；`graphs` 列全部（`*` 标当前）；`use <名>` 改工作区
  **选定图**。
- 解析优先级：`--graph` 旗标 > `TOPOREALM_GRAPH` 环境变量 > `use` 选定图。
  指向不存在的图，触达 daemon 时报 `GRAPH_NOT_FOUND`。
- **切换纪律**：
  - `use` 是工作区级共享状态：daemon 跟随选定图指针热换载——一个终端 `use`，
    其它终端的下一次触达也落在新图上。**确认输出里的图名再继续**
    （写操作人类输出带 `[图名]` 前缀，就是为此）。
  - 要让某个终端壳锚定自己的图：`export TOPOREALM_GRAPH=<名>`（per-shell 覆盖，
    `use` 动不了它；`use` 的输出会提示这一行）。多终端并行时以此为准绳，
    各壳解析互不干扰。
  - 多终端混跑时图状态本身在磁盘（每图独立目录），串行触达即可，不存在互写。
- **WebUI 与其它图**：WebUI 是纯审阅界面（批注 + checkpoint 确认，无图编辑），审阅对象
  始终是当前专注图；图选择器选中工作区其它图进**只读静态预览**（banner 标「只读预览」）——预览不是审阅，
  要审阅哪张图就 `use` 哪张。
- **环境变量体系**（对应旗标优先级更高）：
  - `TOPOREALM_GRAPH` — 专注图覆盖（per-shell）。
  - `TOPOREALM_ROOT` — 项目根覆盖；CLI 按 cwd 解析工作区，**子目录里看不到
    工作区**，agent 会话请在仓库根启动，跨仓场景用它。
  - `TOPOREALM_HOME` — 全局目录覆盖（缺省 `~/.toporealm`，全局模块池所在）。
  - `toporealm help` 尾部按当前环境回显解析后的实际路径，对不上先看这里。

## 五、daemon 排障

- **生命周期一句话**：daemon 由客户端按需自动拉起（detached 常驻，脱离拉起者
  独立存活），**空闲自动退出**（缺省 30 秒无连接且无请求；打开中的 WS/IPC 连接
  算活动——"开着页面盯图"不会退出；**`serve` 拉起的 daemon 例外：透传
  `--idle-ms 0` 常驻不退**；全局禁用空闲回收设 `TOPOREALM_IDLE_MS=0`），
  下次命令再自动拉起（冷启动约 1–2 秒）。
  **daemon 不在跑不是故障，不需要手工守护。**
- **端点事实**：`.toporealm/daemon/endpoint.json` 记录
  transport / address / pid / instanceId / graphId / webPort / webStatic / idleMs。
  - 传输按平台：**Windows = 命名管道**（`\\.\pipe\toporealm-<root哈希>`），
    **POSIX = tmpdir 下 unix socket**（限属主读写；监听前自动清理崩溃残留的
    陈旧 socket 文件）。
  - 陈旧 endpoint（pid 已死）会被自动清掉重拉；daemon 空闲退出也会清掉它——
    **endpoint.json 消失是正常现象，不需要手工删**。
- **启动失败死因上抛**：daemon 启动即退时（坏模块 / 坏 graph.yaml / 坏
  modules.yaml），stderr 落在见证文件
  `<tmpdir>/toporealm-<root哈希前16位>.toporeald-stderr.log`；客户端连接超时的
  错误消息会**直接附上 toporeald 的真实死因**——先读错误再动手，别盲目重试。
- **手动复现**：`toporeald --root <dir> --graph <id>`（可选 `--idle-ms 0` 常驻
  不退、`--no-web` 关 web 伺服、`--web-port P` 固定端口）。工作区没有选定图时
  它会退出并提示先 `toporealm use <graph>`。
- **错误分类速查**：
  - `DAEMON_UNREACHABLE` 且消息带退出原因 → 照死因修：多半是模块清单/图 YAML
    损坏，对照 `module list` 的损坏标注定位。
  - `DAEMON_UNREACHABLE` 且 `details.local = true` → CLI 本地内部错误，
    不是 daemon 的问题，别去查 daemon。
  - `SESSION_STALE` → daemon 反复与目标图不符（自动重拉数次后才放弃）；
    重试一次通常自愈，反复出现按上一条查死因。
  - `WEB_STATIC_MISSING` → 见「三、WebUI」。
