# ADR-0006: 砍掉 MCP，CLI 双受众契约

状态：已接受（2026-09，重建 grilling 会话 D13/D15）

## 背景

0.x 提供 11 工具 stdio MCP 作为 agent 接入面，与 CLI（16 命令）、Web 并列。deletion test 表明：daemon 架构下 MCP 是同一缝上的 pass-through adapter（删除后复杂度不在调用方重现——宿主 agent 全部有 shell 工具）。MCP 工具 schema 常驻宿主上下文，而 skills 渐进披露且能承载方法论。代价：无 shell 的 MCP-only GUI 宿主被排除。

## 决策

- MCP 整体移除；**CLI 是人和 agent 的共同入口**，按双受众契约设计：`--json` 机器输出、结构化错误码、稳定命令语法（语法即承诺，skills 押注其上）、命令目录自省（`commands --json`）。
- Skills 承担教 agent 使用 CLI 的职责（方法论层），随两宿主分发。
- daemon 客户端 API 保持干净：未来若出现真实 MCP-only 宿主需求，加回 MCP adapter 约 100 行。
- 宿主适配收缩为 **Claude Code + Pi**（codex 先砍）；保留 claude-code plugin 打包与 pi extension/skills 打包；session 钩子按需制（注意 Claude 钩子格式 ≠ pi extension 格式，不可混用）。

## 后果

- README 的"agent 友好"叙事从 MCP 工具表改为 CLI 契约 + skills。
- CLI 语法稳定性从"可以随手改"升格为公共契约，变更需走版本化流程。
