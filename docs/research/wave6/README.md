# 第六波调研报告（2026-10-03）

`docs/wave6-plan.md` 的设计依据，只用于追溯；现状以代码与 `docs/` 其余文档为准。报告里的代码行号对应写作时的 `main`（`cdc9408` / `07f5088`），`/tmp/...` 路径是调研时的本地材料，不在仓库中。引用第三方产品只记录行为，原文引用每段不超过 15 词。报告不含任何 token、密钥或账户信息（归档前已 grep 核对）。

| 报告                                             | 主题                                                                                  | 对应设计章节 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------ |
| [R6-oauth.md](R6-oauth.md)                       | 订阅类 OAuth 登录（ChatGPT SIWC 与 Codex 客户端；Claude / Copilot / Gemini 为何不做） | §4           |
| [R7-memory.md](R7-memory.md)                     | Memory 模块（缺省关闭、文件型、索引常驻正文按需）                                     | §3           |
| [R8-i18n.md](R8-i18n.md)                         | 中英双语：盘点、机制选型、测试策略、文档方案、拆分                                    | §5           |
| [R9-agent-view-trace.md](R9-agent-view-trace.md) | Agent 栏、子 Agent 全屏视图、轨迹持久化与 `/trace` / HTML / `get_trace`               | §1、§2       |
| [R10-config.md](R10-config.md)                   | `/config` 设置面板与 `ama config get                                                  | set`         | §6  |

报告中的推荐与 `wave6-plan.md` §0 决定表不一致时（例如 R6 以借用 Codex 客户端为主方案），以决定表为准。
