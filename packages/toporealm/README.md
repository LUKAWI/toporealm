# @lukawi/toporealm

TopoRealm 1.0 聚合发布物（blueprint §2）：安装即得 `toporealm`（CLI）与 `toporeald`（单属主 daemon）两个 bin。

本包是纯聚合壳，实现分居各 workspace 包：

| bin | 来源包 | 职责 |
|---|---|---|
| `toporealm` | `@lukawi/toporealm-cli` | 核心动词 + 模块/分发/宿主投影动词 + `--json` 信封 |
| `toporeald` | `@lukawi/toporealm-daemon` | 单属主守护进程：内存图态 + 原子落盘 + Web(WS) 伺服 |

依赖方向与包结构见仓库根 [README](https://github.com/LUKAWI/toporealm#readme) 与 [docs/rebuild/blueprint.md](https://github.com/LUKAWI/toporealm/blob/main/docs/rebuild/blueprint.md) §2。
