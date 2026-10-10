# 文档索引

[English](en/README.md) · 简体中文

本文件是 `docs/` 的入口，新增文档登记在这里。仓库内的相对链接与源码注释里的 `docs/…md` 路径由
`pnpm check:docs`（`scripts/check-doc-links.mjs`）校验。

| 目录          | 内容                                                          |
| ------------- | ------------------------------------------------------------- |
| `guides/`     | 使用说明与现行行为，与代码同步维护                            |
| `reference/`  | 协议与文件格式，形状改动必须同步（见 `AGENTS.md`「协议面」）  |
| `design/`     | 目标设计与视觉规范；首段写明状态，现状以代码与 `guides/` 为准 |
| `history/`    | 已完成的实施计划与审计，只用于追溯，不作为实施要求            |
| `research/`   | 调研报告，只用于追溯                                          |
| `benchmarks/` | 实测记录与原始数据                                            |
| `en/`         | 英文译本，按同样的分层放；中英不一致时以中文版为准            |
| `assets/`     | README 用的字标等图片                                         |

## guides/ 使用与现状

| 文档                                      | 内容                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| [终端界面](guides/tui.md)                 | 布局、状态栏、按键、命令、回滚、审批、Agent 栏、轨迹、`/config`；组件库 API |
| [供应商与模型](guides/providers.md)       | 内置供应商、渠道、API Key、ChatGPT 登录、中转、models.dev、图像、缓存       |
| [权限](guides/permissions.md)             | 六种模式、判定顺序、`auto` 的三层判定                                       |
| [Plan 模式](guides/plan.md)               | 只读调研、计划格式、审批入口与持久化                                        |
| [会话](guides/sessions.md)                | 统计、检索、`--from` 复用、导出、轨迹、检查点                               |
| [子 Agent 与外部 Agent](guides/agents.md) | `task` / `task_ctl`、fork、worktree 隔离、外部 Agent 驱动与能力矩阵         |
| [记忆](guides/memory.md)                  | 跨会话笔记，缺省关闭                                                        |
| [命令式 Hook](guides/hooks.md)            | `hooks.json` 的事件、退出码与 stdout JSON                                   |
| [codemode](guides/codemode.md)            | 模型写脚本批量调用工具，子进程与权限                                        |
| [操作系统级沙箱](guides/sandbox.md)       | macOS `sandbox-exec` 与 Linux bubblewrap，codemode 与 bash 接入             |
| [界面语言](guides/i18n.md)                | 中英双语的选择规则与开发约定                                                |

## reference/ 协议与格式

| 文档                                        | 内容                                                     |
| ------------------------------------------- | -------------------------------------------------------- |
| [RPC 协议](reference/rpc.md)                | `ama --mode rpc` 的 stdio JSONL 命令、响应与事件         |
| [ACP](reference/acp.md)                     | `ama --mode acp` 服务端、登录方法、偏差，以及 ACP 客户端 |
| [宿主适配器 API](reference/host-api.md)     | `@armadra/agent/host`：注册工具、审批、注入消息、状态    |
| [会话文件格式](reference/session-format.md) | JSONL 条目树、头、条目类型与版本                         |

## design/ 目标设计

| 文档                                     | 状态与内容                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| [总体设计](design/design.md)             | 架构、工程约定、缓存保证与决定表；硬约束仍以此为准，细节现状见 `guides/`   |
| [终端界面视觉规范](design/tui-design.md) | 主题、逐屏样稿与交互细节；已按此实现，作为界面改动的规范                   |
| [检索与网络搜索](design/search-plan.md)  | 只实施了本地检索增强；`web_fetch`、`web_search` 与引用呈现保留为将来的设计 |
| [本地扩展](design/extensions.md)         | 设计草案，尚未实现                                                         |

## history/ 已完成的计划与审计

| 文档                                                       | 内容                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| [第二、三波实施设计](history/implementation-plan.md)       | 组装根、RPC / SDK、交互模式、codemode 各批次               |
| [第三波计划](history/wave3-plan.md)                        | 缓存设计与验收、其余批次编排                               |
| [第五波计划](history/wave5-plan.md)                        | 状态栏、模型元数据、渠道、外部 Agent、Plan、子 Agent、压缩 |
| [第六波计划](history/wave6-plan.md)                        | Agent 栏、轨迹、记忆、ChatGPT 登录、双语、`/config`        |
| [检查点与回滚](history/rewind-plan.md)                     | 检查点、回滚与影子 git                                     |
| [ACP 补全](history/acp-plan.md)                            | 对照 ACP v1 schema 的补全                                  |
| [Agent 切换与并行交流](history/agents-concurrency-plan.md) | Agent 栏进入方式、后台审批停靠                             |
| [内存占用优化](history/memory-plan.md)                     | read 流式、ACP 释放、图片驻留                              |
| [模型调用效率](history/model-efficiency-plan.md)           | 缓存、用量、重试与元数据                                   |
| [缺口与默认值审计](history/gap-audit-2026-10.md)           | 2026-10-02 的只读审计                                      |

## research/ 与 benchmarks/

- [调研报告](research/README.md)：第五波 R1–R5、第六波 R6–R10、ACP 差距审计、模型调用效率与内存占用审计。
- 实测记录：
  - [外部 Agent 驱动实测](benchmarks/external-agents-2026-10.md)
  - [模型调用效率实测](benchmarks/efficiency-2026-10.md)
  - [内存占用实测](benchmarks/memory-2026-10.md)
  - [缓存验收实验](benchmarks/cache-2026-10-02.md)、[自动压缩 E6](benchmarks/cache-e6-2026-10-02.md)、[对话中途的 system 消息](benchmarks/cache-midconvo-2026-10-09.md)
  - [三预设基准](benchmarks/presets-2026-10-02.md)、[todo 进 default](benchmarks/presets-todo-2026-10-02.md)、[多步长任务复测](benchmarks/presets-todo-2026-10-03.md)

## en/ 英文译本

[终端界面](en/guides/tui.md)、[供应商与模型](en/guides/providers.md)、[权限](en/guides/permissions.md)、
[会话](en/guides/sessions.md)、[RPC 协议](en/reference/rpc.md)、[ACP](en/reference/acp.md)、
[宿主适配器 API](en/reference/host-api.md)。译本头部记着翻译时的中文版提交，`pnpm release:check` 在中文版
之后改动较多时提示同步。
