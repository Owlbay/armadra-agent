# R4 子 Agent（Sub Agent）调研：业界对照、ama 现状与「够用」设计

调研日期 2026-10-02。对象仓库 `/Users/yovinchen/Projects/Rust/Tauri/armadra-agent`（HEAD `fb36ecd`）。只读，未改代码。

---

## 0. 结论（先看这里）

1. **ama 的 `task` 现在是「同步、一次性、匿名」的子 Agent**：能起一个全新上下文的同进程子会话、限工具 / 换模型 / 限轮数，深度 ≤ 1、并发池 4、审批串到父、abort 级联、独立 JSONL、缓存统计汇总到父。**缺的恰好是业界已成共识的五件事**：① 定义文件（`.ama/agents/*.md`）与内置类型（explore / plan / general）；② 后台运行 + 完成通知；③ 续聊（按 id / name 再发消息）；④ 写文件型子 Agent 的 worktree 隔离；⑤ 只读类型的**强制**工具限制（现在只是模型自己填 `tools` 数组）。
2. 还有两个实现层的坑：**`task` 声明为 `sequential`，同一轮模型发出的多个 `task` 会被 tool-runner 整批串行**（`src/agent/tool-runner.ts:330-334`），「并发 4」只在 codemode 脚本里 `Promise.all` 时才生效；**结果全文无上限**直接进父上下文（`src/tools/task.ts:109`）。
3. 业界对照：六家里五家已用「Markdown + YAML frontmatter（name / description / tools / model）+ 正文即系统提示」定义子 Agent（Claude Code、OpenCode、Gemini CLI、Cursor、Pi 扩展示例），只有 Codex 用 TOML。内置类型几乎都收敛到 **通用 + 只读探索（+ 计划）** 三个。深度普遍 1（Codex、Gemini、OpenCode 缺省），Claude Code 缺省 3。后台 + 通知 + 续聊是 Claude Code / Codex / OpenCode 的现行形态。
4. **推荐「够用」方案（分三阶段）**：
   - **P1（必须）**：`.ama/agents/*.md` 与 `~/.config/ama/agents/*.md`，frontmatter 与 Skill 同风格（`name / description / tools / disallowed-tools / model / thinking / max-turns / permission-mode / isolation / background`）；内置 `general`、`explore`（只读强制）、`plan`（只读强制）；`task` 增参 `agent`；同轮多个 `task` 并行（改 `executionMode`，靠 pool 限流）；结果 50 KB 上限 + 全文落 `outputs/`。
   - **P2（应该）**：`background: true` → 立即返回 `taskId`，完成后以 `<task-notification>` 作为 followUp 注入父会话；新增一个 `task_ctl`（`send / wait / stop / list`）或复用 `task` 的 `taskId` 参数实现续聊；`isolation: "worktree"`；RPC 事件 `subagent_start / subagent_update / subagent_end`、TUI 子任务面板。
   - **P3（可选）**：`fork` 模式（继承父前缀、复用缓存）、外部 CLI Agent 作为同一接口的另一种 `runner`（`runner: ama | claude | codex | …`），与 Armadra 画布工具统一。
5. **缓存要点**：全新上下文子 Agent 只要**工具表与系统提示字节相同**就能命中父的「tools + system」前缀；ama 现在 `+task` 时子会话去掉了 `task`，工具表字节不同 → 子会话首请求整段未命中。建议子会话保留与父**相同的工具 schema**、运行时拒绝 `task`（深度错误），并让内置类型尽量共用父的工具表（只读靠权限层拒绝写类工具，而不是改工具表）。fork 模式只有在这一点做到后才有价值。

---

## 1. 业界子 Agent 机制对照

### 1.1 总表

| 维度               | Claude Code 2.1.285                                                                                                                                                                            | Codex CLI                                                                                                               | OpenCode                                                                               | Gemini CLI                                                                                                      | Pi 1.0（扩展示例）                                           | Amp                                     | Cursor                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------ |
| 调用工具           | `Agent`（原 Task）+ `SendMessage` + `TaskStop`                                                                                                                                                 | `spawn_agent / send_input(send_message) / wait_agent / resume_agent / close_agent`                                      | `task`（`subagent_type, background, task_id`）                                         | 每个子 Agent 暴露为一个工具                                                                                     | 扩展注册 `subagent` 工具（single / parallel / chain）        | 内置 Task、Search、Oracle、Librarian 等 | Task 工具 + `/name` 显式调用                                                         |
| 定义方式           | `.claude/agents/*.md`、`~/.claude/agents/*.md`，插件、SDK `agents`                                                                                                                             | `.codex/agents/*.toml`、`~/.codex/agents/*.toml`，或 `config.toml` `agents.<name>`                                      | `.opencode/agents/*.md`、`~/.config/opencode/agents/`，或 `opencode.json`              | `.gemini/agents/*.md`、`~/.gemini/agents/*.md`                                                                  | `~/.pi/agent/agents/*.md`；`.pi/agents/*.md` 需 `agentScope` | 不可自定义（产品内置角色）              | `.cursor/agents/*.md`、`~/.cursor/agents/`；兼容读 `.claude/agents`、`.codex/agents` |
| frontmatter / 字段 | name, description, prompt(正文), tools, disallowedTools, model, effort, permissionMode, mcpServers, hooks, maxTurns, skills, initialPrompt, memory, background, omitClaudeMd, isolation, color | name, description, developer_instructions；可选 model, model_reasoning_effort, sandbox_mode, mcp_servers, skills.config | description, mode(primary/subagent/all), model, temperature, top_p, permission, prompt | name, description, kind(local/remote), tools(支持通配), model, temperature, max_turns, timeout_mins, mcpServers | name, description, tools, model                              | —                                       | name, description, model(inherit/fast/id), readonly, is_background                   |
| 内置类型           | general-purpose、Explore（只读）、Plan（只读）、fork、statusline-setup 等                                                                                                                      | default、worker、explorer（社区称还有 monitor）                                                                         | general、explore（只读）、scout（只读，外部依赖）                                      | codebase_investigator、generalist、cli_help、browser_agent                                                      | 示例：scout、planner、reviewer、worker                       | Search、Oracle、Librarian、Task worker  | Explore、Bash、Browser                                                               |
| 工具 / 权限        | `tools` 替换缺省集，`disallowedTools` 做减法；Explore/Plan 用 disallowedTools 去掉写类工具；权限模式继承父，可被 frontmatter 覆盖                                                              | 继承父的 sandbox 与审批策略，审批冒泡到终端                                                                             | `permission` 按工具 allow/ask/deny（bash 支持 glob）；子会话缺省禁 `task`、`todowrite` | `tools` 白名单；策略引擎可按 `subagent` 写规则                                                                  | 子进程 `pi --mode json -p --no-session --tools …`            | 各角色固定工具；Oracle 偏只读           | `readonly: true`                                                                     |
| 模型               | 参数 `model` > frontmatter `model`（可 `inherit`）> 缺省子 Agent 模型 > 父                                                                                                                     | 参数 > 角色 > `agents.default_*` > 父                                                                                   | 缺省继承调用方                                                                         | 缺省继承，可覆盖                                                                                                | 缺省继承父模型与思考级别                                     | 每角色不同模型（可在 The Dial 固定）    | inherit / fast / 具体 id                                                             |
| 上下文             | 全新；`subagent_type: "fork"` 继承父完整对话并共享缓存                                                                                                                                         | 缺省全新；V2 有 `fork_turns:"all"` 分叉父历史                                                                           | 全新子会话（parentID 指父）                                                            | 隔离的独立循环                                                                                                  | 独立进程，全新                                               | 全新，只回摘要                          | 独立上下文                                                                           |
| 前台 / 后台        | 缺省后台，完成后通知；`run_in_background:false` 同步                                                                                                                                           | 异步线程，`wait_agent` 取结果                                                                                           | `background` 可选                                                                      | 同步（作为工具）                                                                                                | 同步                                                         | 同步并行                                | 2026-02 起可后台                                                                     |
| 并行上限           | 并发 20（env `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`）                                                                                                                                          | `agents.max_threads` 缺省 6                                                                                             | 未见硬上限                                                                             | 文档未述                                                                                                        | 一次最多 8 个、并发 4                                        | 未公开                                  | 未公开                                                                               |
| 结果回传           | 后台：`<task-notification>` 作为 user 角色消息；另给 `output_file` 路径（提示不要偷看）                                                                                                        | `wait_agent` 返回最后一轮结果                                                                                           | 最终文本 + metadata（sessionID、jobId）                                                | 工具结果                                                                                                        | 每个最终输出，单个上限 50 KB                                 | 只回最终摘要                            | 最终结果                                                                             |
| 续聊               | `SendMessage({to: name/agentId})`，已结束的也可恢复                                                                                                                                            | `send_input` / `resume_agent`                                                                                           | `task_id` 复用旧子会话                                                                 | 不支持                                                                                                          | 不支持                                                       | 不支持（不接受中途指导）                | —                                                                                    |
| 嵌套深度           | 缺省 3（env `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`）                                                                                                                                           | `agents.max_depth` 缺省 1                                                                                               | `subagent_depth` 可配，缺省禁 task                                                     | 禁止嵌套                                                                                                        | 子进程未阻止，但示例未鼓励                                   | 1                                       | 后台版可嵌套                                                                         |
| 隔离               | `isolation: worktree`（无改动自动清理）/ `remote`                                                                                                                                              | 线程共享工作区，sandbox 继承                                                                                            | 共享                                                                                   | 共享                                                                                                            | 共享 cwd                                                     | Orbs（每线程一台机器）                  | Cloud Agent：云端 VM + 分支 + PR                                                     |
| 界面               | 任务列表 / 后台任务面板；进度事件 `tool_progress{parent_tool_use_id, subagent_type}`                                                                                                           | `/agent` 切换线程                                                                                                       | 子会话导航（下进入、左右切兄弟、上回父）                                               | 工具调用行                                                                                                      | 折叠：状态 + 最近 5–10 项 + 用量；展开看全文                 | 折叠显示                                | 侧栏                                                                                 |
| 中断               | `TaskStop`；父中断级联                                                                                                                                                                         | `close_agent`                                                                                                           | abort 级联                                                                             | 随工具                                                                                                          | Ctrl+C 杀子进程                                              | —                                       | —                                                                                    |
| 成本               | fork 共享父缓存；可设子 Agent 缓存 TTL                                                                                                                                                         | 官方提示子 Agent 更耗 token                                                                                             | —                                                                                      | —                                                                                                               | 显示每个子 Agent 的 cacheRead/Write、费用                    | 子角色用便宜模型                        | 云端按计算分钟另计                                                                   |

### 1.2 Claude Code（打包产物 `/tmp/cc-src/big.txt` 逆向，只取行为）

- **定义字段**：frontmatter 校验表里的字段为 `name / description / model / tools / disallowedTools / color / effort / permissionMode / mcpServers / hooks / maxTurns / skills / initialPrompt / memory / background / omitClaudeMd / isolation`（另有内部 `observer`、`experimental.cacheTtl`）。语义要点：
  - `tools`：描述为 "Tools available to this agent. Replaces the default set."；`disallowedTools` 是减法，`tools` 已设时忽略。
  - `model` 可写 `inherit`；`omitClaudeMd` 让子 Agent 不加载 CLAUDE.md，只靠委派 prompt。
  - `initialPrompt` 只在该 Agent 作为主会话（`--agent`）时用，作子 Agent 不读。
  - `background: true` 让该类型缺省后台运行。
- **工具入参**：`description, prompt, subagent_type, model(sonnet|opus|haiku|fable), run_in_background, name, isolation(worktree|remote), cwd`；`mode`、`team_name` 已弃用（"Subagents inherit the parent session's permission mode"）。`name` 使其可被 `SendMessage({to: name})` 寻址，保留名 `main / user / system / team-lead`。
- **内置类型**：`general-purpose`（`tools: ["*"]`，系统提示要求最后给精简报告、不要整体再委派）；`Explore` 与 `Plan` 用 `disallowedTools` 去掉写类与 Agent 工具，`model: "inherit"`、`omitClaudeMd: true`，并对这两类省略 git status（减少前缀）。
- **fork**：系统提示原文要点——fork "inherits your full conversation context, runs in the background"，且 "shares your cache"；规则是「不要偷看输出文件」「不要猜测结果」，fork 的 prompt 写成指令而非背景介绍；fork 忽略 `model` 参数（必须同模型才能共享缓存）。
- **后台与通知**：缺省后台；结果作为 user 角色消息里的 `<task-notification>` XML 送达，提示模型这不是用户发言。工具结果给 `output_file` 路径。
- **并发 / 深度**：`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` 缺省 20，超限直接报错「Do not retry」（不排队）；`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 缺省 3。
- **worktree**：并行写同一仓库的 Agent 要求各自 `isolation: "worktree"`；worktree 被删时拒绝回落到共享目录（防止静默写到主仓库）；无改动自动清理。
- **续聊 / 中断恢复**：会话重启后对未完成的后台 Agent 提示「用 SendMessage 再发一条以恢复并取状态」，转录保存在磁盘，进度不丢。
- **SDK 事件**：`tool_progress` 带 `parent_tool_use_id`、`task_id`、`subagent_type`、子 Agent 重试信息；消息带 `subagent_type`、`task_description`。

### 1.3 Codex CLI

- 工具：`spawn_agent / send_input / resume_agent / wait_agent / close_agent`（`features.multi_agent`，现缺省开）。V2 增 `fork_turns:"all"` 分叉父历史、`task_name` 形成层级路径、`send_message(target=…)`。
- 定义：每角色一个 TOML（`name / description / developer_instructions` 必填，`model / model_reasoning_effort / sandbox_mode / mcp_servers / skills.config` 可选）；**未信任项目的 `.codex/agents/` 静默忽略**。
- 限制：`agents.max_threads`（新名 `agents.max_concurrent_threads_per_session`）缺省 6；`agents.max_depth` 缺省 1；CSV 批量 `spawn_agents_on_csv` 每行一个 worker、`job_max_runtime_seconds` 缺省 1800。
- 继承：模型 / 推理强度（未覆盖时）、权限模式、sandbox、运行时 `/permissions` 改动；审批从任一线程冒泡到终端。
- 界面：`/agent` 在线程间切换，可直接对子线程说话。官方提醒子 Agent 工作流 token 消耗更高。

### 1.4 OpenCode

- Agent 分 `mode: primary | subagent | all`；内置 primary（build、plan）与 subagent（general、explore、scout）。
- `task` 参数 `description, prompt, subagent_type, background, task_id, command`；**`task_id` 复用已有子会话 = 续聊**；子会话 `parentID` 指父，缺省禁 `task` 与 `todowrite`，权限由父规则派生，`subagent_depth` 可配。
- 用户可 `@general …` 直接点名调用；primary 用 `permission.task` 控制能调用哪些子 Agent。
- TUI 子会话导航是亮点：子会话就是普通会话，可进入查看、切兄弟、回父。

### 1.5 Gemini CLI

- `.gemini/agents/*.md`，正文即系统提示；`kind: remote` 走 A2A 协议委派到远端 Agent——**本地 / 远程同一种定义**，这一点与「ama 子 Agent 也可以是外部 Agent」的诉求最接近。
- 明确「子 Agent 不能调用子 Agent」；`tools` 支持 `*`、`mcp_*` 通配；`timeout_mins`、`max_turns` 双重限制。

### 1.6 Pi 1.0（`/tmp/pi-1.0/pi-coding-agent/examples/extensions/subagent/`）

- Pi 核心不内置子 Agent，以**扩展示例**提供，`index.ts` 约 1 000 行：每个子 Agent 是 `pi --mode json -p --no-session --model … --tools …` 子进程，读 JSON 事件流做流式显示。
- 三种模式：single `{agent, task}`、parallel `{tasks:[…]}`（`MAX_PARALLEL_TASKS = 8`、`MAX_CONCURRENCY = 4`）、chain `{chain:[…]}`（`{previous}` 占位串接）。
- 安全：缺省只加载用户级 agents；项目级需 `agentScope: "project"|"both"` 并在未信任项目里交互确认。
- CHANGELOG 里修过的坑值得 ama 直接规避：并行模式只回 100 字符预览（后改为每任务上限 50 KB 全文 + 失败诊断）；子 Agent 丢失父的模型 / 思考 / 工具配置；YAML 数组形式的 `tools` 解析。
- 预置工作流 prompt：`/implement`（scout → planner → worker）、`/scout-and-plan`、`/implement-and-review`——**用 prompt 模板编排，而不是做编排引擎**。

### 1.7 Amp、Cursor

- **Amp**：子 Agent 不可自定义，是产品内置的「角色 + 模型」组合：Search（快模型检索代码）、Oracle（强推理模型给第二意见，偏只读）、Librarian（检索外部仓库）、Task worker（并行干活）。子 Agent 拿不到父上下文、不能中途接受指导、只回最终摘要。启示：**按角色绑定不同（更便宜或更强）的模型**，比让模型自由填 model 更可控。
- **Cursor**：2.4 引入子 Agent，`.cursor/agents/*.md`（`name / description / model / readonly / is_background`），并**兼容读取 `.claude/agents/` 与 `.codex/agents/`**（同名时 `.cursor/` 优先）；2026-02 起子 Agent 可后台、可嵌套。Cloud Agent（原 Background Agent）是另一条产品线：云端 VM、独立分支、完成开 PR。

### 1.8 共识与分歧

- **共识**：Markdown + frontmatter；`description` 是模型选型依据；正文即系统提示；工具白名单 / 黑名单；模型 `inherit`；只读探索类型是标配；子 Agent 缺省全新上下文；深度缺省 1；项目级定义需要信任。
- **分歧**：同步（Gemini、Pi、Amp）vs 后台 + 通知（Claude Code、Codex、OpenCode、Cursor）；排队（ama、Pi）vs 超限报错（Claude Code）；fork 上下文只有 Claude Code 与 Codex V2 有；worktree 隔离只有 Claude Code 内置。

---

## 2. ama 现状（代码证据）

### 2.1 能做什么

| 能力        | 现状                                                                                                              | 证据                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 工具入参    | `prompt, description?, tools?, model?, thinkingLevel?, maxTurns?(30)`                                             | `src/tools/task.ts:28-35,74-90`                                    |
| 上下文      | 全新子会话；`system` 复用父的 `systemInput`（同一份 AGENTS.md / Skill 索引），消息为空                            | `src/agent/session.ts:578-585`、`session-subagent.ts:211`          |
| 会话文件    | 独立 JSONL，头 `parentSession` 指父，首条 `custom{ama.task}` 记父 toolCallId 与 description；父在内存则子也在内存 | `session-subagent.ts:218-233`                                      |
| 工具        | 缺省 = 父活动集；总是去掉 `task`；请求的名字必须在父可用集里                                                      | `session-subagent.ts:234-237`                                      |
| 模型 / 思考 | 可指定 `provider/model`；思考级别缺省继承父                                                                       | `session-subagent.ts:212-217,243`                                  |
| 深度        | 子会话 `depth 1`、`subagents:false`，task 返回错误                                                                | `task.ts:95-97`、`session-subagent.ts:208,251`                     |
| 并发        | `SubagentPool` 计数信号量，缺省 4，超出排队；排队中 abort 抛 aborted                                              | `session-subagent.ts:144-162`、`session-core.ts:82-83`             |
| 权限        | 继承父的权限管线与 Hook；broker 包一层带 `context{depth, parentToolCallId}`，审批对话框标 `[task]`，事件转发父    | `session-subagent.ts:179-186,245-248,257-258`                      |
| 中断        | 父 signal abort → `child.abort()`                                                                                 | `session-subagent.ts:253-254`                                      |
| 进度        | 只把子会话 `tool_execution_start` 变成一行 `[task] <toolName>` 的 `onUpdate`                                      | `session-subagent.ts:255-256`                                      |
| 结果        | 子会话最后一条助手文本**全文**；`details{sessionFile, usage, stopReason}`                                         | `task.ts:103-110`、`session-subagent.ts:280-307`                   |
| 缓存        | 子会话有自己的缓存控制器，缺省不保温（`cache.warmSubagents`），命中与重计费汇总进父 `stats.cache.subagents`       | `session-cache.ts:136,163,292-338`、`docs/rpc.md:216`              |
| 未命中归因  | 父在 task 运行期间空转超 TTL 归为 `subtask`                                                                       | `docs/wave3-plan.md:121`                                           |
| 暴露        | `default` 预设里 task 只能在 codemode 脚本里调用；`+task` 才直接暴露；嵌入 Armadra 时 `disable("task")`           | `docs/design.md` §5.6、§5.4                                        |
| 界面        | TUI 显示「子 Agent · 运行中 1m05s」，完成摘要 `完成 · 耗时 · ↑in ↓out`                                            | `src/modes/interactive/tool-view.ts:197`、`tool-summary.ts:64,225` |

### 2.2 限制与缺口

| #   | 缺口                                                                                                                                                | 影响                                                                                                                    | 业界对照                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| G1  | **没有定义文件 / 类型**，每次都要模型把角色、工具、模型写进参数                                                                                     | 模型不会稳定地给「只读探索」配只读工具；用户无法沉淀 reviewer / tester 等角色；`docs/gap-audit-2026-10.md:32` 已列为 P2 | 6 家里 6 家有                                        |
| G2  | **只读不是强制的**：`tools` 由模型填，缺省继承全部（含 edit / write / bash）                                                                        | 探索型子 Agent 可能改文件；审批串到父，用户难判断是谁在写                                                               | CC Explore/Plan、OpenCode explore、Cursor `readonly` |
| G3  | **同轮多个 task 串行**：`executionMode: "sequential"`（`task.ts:92`），tool-runner 只要批中有一个 sequential 就整批串行（`tool-runner.ts:330-334`） | 直接暴露时「并行 3 个探索」退化成顺序跑；pool=4 只在 codemode `Promise.all` 时起作用                                    | CC / Pi / Amp 同轮并行                               |
| G4  | **没有后台**：task 阻塞父回合直到子结束                                                                                                             | 父不能边等边和用户聊；长子任务期间父缓存过期（已有 `subtask` 归因，说明真实发生过）                                     | CC、Codex、OpenCode、Cursor                          |
| G5  | **不能续聊**：子会话结束即 `dispose()`（`session-subagent.ts:308`）                                                                                 | 追问「再查一下 X」要重新起子 Agent、重读文件                                                                            | CC SendMessage、Codex send_input、OpenCode task_id   |
| G6  | **结果无上限**：最后助手文本原样进父上下文                                                                                                          | 子 Agent 若贴大段代码会撑爆父上下文；没有全文落盘路径                                                                   | Pi 50 KB、CC output_file                             |
| G7  | 只取「最后一条助手文本」：若最后一轮是工具调用后被 maxTurns 截断，结果为空 / 上一段                                                                 | 用户看到「(the sub-agent returned no text)」；`stopReason` 有但不会提示「轮数耗尽，部分结果如下」                       | CC 系统提示要求最后给报告                            |
| G8  | **无 worktree 隔离**                                                                                                                                | 两个写型子 Agent 并行改同一仓库会互相覆盖；readFiles 先读后写检查是每会话独立的，挡不住                                 | CC `isolation: worktree`                             |
| G9  | 子 Agent 的系统提示与父完全相同，没有「你是子 Agent，最后给精简报告、不要再委派」这段角色说明，也不能加类型自己的提示                               | 输出风格不可控                                                                                                          | CC、Pi worker.md 都规定输出格式                      |
| G10 | **缓存前缀不对齐**：`+task` 时父工具表含 task、子不含 → 工具表字节不同，子会话首请求连「tools+system」前缀都未命中；换模型时当然也不命中            | 每个子 Agent 多付一次完整前缀写入                                                                                       | CC fork 强制同模型、共享缓存                         |
| G11 | 事件太薄：RPC / TUI 只有一行 `[task] toolName`，看不到子会话的流式文本、轮数、用量；无法进入子会话查看                                              | 用户只能等结果；Armadra 嵌入时无法渲染子任务                                                                            | OpenCode 子会话导航、Pi 折叠 / 展开                  |
| G12 | 不能把外部 CLI Agent 当子 Agent；外部 Agent 只在嵌入 Armadra 时经 `canvas_*` 工具调用，接口与 task 不同                                             | 独立模式下无法「让 Codex 审一下」；两套心智模型                                                                         | Gemini `kind: remote`（A2A）                         |

---

## 3. 推荐设计

原则：**少工具、少字段、与 Skill 同风格、缓存友好、不做编排引擎**（编排交给 codemode 脚本与 prompt 模板）。

### 3.1 定义文件

位置（与 Skill 发现顺序一致，复用 `src/skills/discover.ts` 的来源与信任逻辑）：

1. `--agent-dir`（可重复）→ profile `agentDirs` → `~/.config/ama/agents/*.md`（用户级）
2. `<cwd>/.ama/agents/*.md`（项目级，**需信任**；未信任时跳过并在 `ama doctor` / 启动提示列出，参照 Codex 静默忽略、Pi 交互确认）
3. 兼容读取（可选、缺省关，`agents.compat: ["claude"]`）：`.claude/agents/*.md`，只映射 `name / description / tools / model` 四个字段，未知字段忽略——Cursor 已这么做，用户现成的定义可以直接用。

同名：先发现者胜并 warning（与 Skill 相同），内置类型可被用户级 / 项目级同名覆盖。

格式（字段名用 kebab-case，与 Skill 的 `disable-model-invocation`、`allowed-tools` 一致）：

```markdown
---
name: reviewer # ^[a-z0-9-]{1,64}$，缺省取文件名
description: 只读审查改动，按文件与行号报告问题。 # 必填，≤ 1024，进 task 工具描述
tools: read, grep, glob, bash # 白名单；与 disallowed-tools 二选一
disallowed-tools: edit, write # 黑名单（相对父活动集）
permission-mode: read-only # 可选：read-only | inherit（缺省 inherit）；只能更严
model: inherit # inherit | provider/model | 别名（fast / strong，见 3.5）
thinking: low # 可选
max-turns: 20 # 可选，缺省 30
isolation: none # none | worktree（缺省 none）
background: false # 缺省前台
runner: ama # ama（缺省）| 外部 Agent 名，见 3.8；P3
---

（正文 = 追加到子会话系统提示的角色说明）
```

不做的字段：`hooks`、`mcpServers`（ama 不做 MCP）、`memory`、`color`、`initialPrompt`、`observer`。`skills` 也不做：子会话本来就继承父的 Skill 索引。

### 3.2 内置类型（三个，够用）

| 类型              | 工具                       | 权限                                                                                      | 系统提示追加                                                                                   | 模型                                              |
| ----------------- | -------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `general`（缺省） | 父活动集                   | 继承                                                                                      | 「你是被委派的子 Agent；直接完成，不要再委派；结束时给精简报告：做了什么、关键发现、改动文件」 | inherit                                           |
| `explore`         | read、grep、glob、ls、bash | **read-only 强制**：写类工具在权限层拒绝；bash 只放行只读命令白名单，其余拒绝（不弹审批） | 「只定位、不评审；返回路径与行号；说明搜索范围」                                               | inherit（可配 `agents.explore.model` 指便宜模型） |
| `plan`            | 同 explore                 | read-only 强制                                                                            | 「输出分步计划、关键文件、取舍；不得修改文件」                                                 | inherit                                           |

说明：

- 只读要**在权限层强制**（新增权限模式 `read-only`：write / execute 类一律拒绝、bash 走只读识别，识别不了就拒），而不是靠改工具表——这样工具表与父相同，缓存前缀可复用（见 3.6）。`design.md` §5.6 已论证「识别只读 bash 不可靠」，所以 explore 里 bash 的策略是「识别不了就拒绝」，宁可少用。
- `/agents` 命令列出所有类型与来源；`/agent:<name> <任务>` 让用户直接点名（对应 OpenCode `@agent`、Cursor `/name`）。

### 3.3 工具形态

**一个 `task` 工具**，参数加两个：

```ts
interface TaskInput {
  prompt: string;
  agent?: string; // 类型名，缺省 general；工具描述里列出 name: description（总预算 ~400 token，超出只列名字）
  description?: string;
  background?: boolean; // 缺省取类型的 background
  taskId?: string; // 给出时：向已有子会话追加一条消息（续聊），忽略 agent/tools/model
  // 以下仍保留但不推荐模型使用（描述里不展开）：tools, model, thinkingLevel, maxTurns
}
```

**再加一个 `task_ctl`（P2）**：`{ action: "wait" | "stop" | "list" | "output", taskId? }`。

- 理由：续聊并进 `task`（`taskId`）已经覆盖 send；`wait / stop / list` 合成一个工具，避免 Codex 那样五个工具。
- `default` 预设里 `task_ctl` 与 `task` 一样只在 codemode 里可见；`+task` 时两者一起暴露。

**同轮并行**：把 `task` 的 `executionMode` 改为 `parallel`（子会话之间靠 pool 限流，写冲突靠 worktree 或用户约定）。注意 tool-runner 的「批中任一 sequential 则整批串行」规则不变，所以 `task` + `edit` 同批时仍串行，这是合理的。

**codemode 编排**：脚本里 `await Promise.all([tools.task({agent:"explore", prompt:a}), tools.task({agent:"explore", prompt:b})])`，只把汇总文本交回模型——这正是 §5.5 的设计初衷，子 Agent 结果不必每个都进父上下文。文档里给一个「并行探索 → 汇总」的脚本样例即可，不做 Pi 那种 chain 模式参数（脚本更通用）。

### 3.4 前台 / 后台与结果回传

- **前台**（缺省）：同现在，阻塞直到结束，结果作为工具结果。
- **后台**（P2）：立即返回 `{ taskId, status: "running", outputFile }`；子会话完成后，往父会话的 **followUp 队列**（`src/agent/queue.ts` 已有 steer / followUp）放一条：
  ```
  <task-notification taskId="t3" agent="explore" status="completed" turns="7" tokens="…">
  …最终报告（≤ 50 KB；超出截断并给 outputFile）…
  </task-notification>
  ```
  父空闲时由它触发新一回合；父正忙则在下一回合边界注入。系统提示里一句说明「这不是用户发言」。
- **结果上限**：前后台统一，最终文本 > 50 KB（与 read / bash 截断一致）保留首尾，全文写 `outputs/<taskId>.md`；`maxTurns` 耗尽时在结果前加一行「轮数耗尽，以下为最后输出」，并在最后一轮强制要求模型给报告（`toolChoice: none` 收尾一轮，`StreamOptions.toolChoice` 已在 W3 契约里）。
- **生命周期**：子会话结束后不立即 `dispose`，保留在会话内注册表（上限 16 个，LRU 释放内存，磁盘 JSONL 永远在），以支持 `taskId` 续聊；父会话 resume 时从 `custom{ama.task}` 条目重建注册表（未完成的标 `interrupted`，与 CC 的「没有完成记录，发消息续上」一致）。

### 3.5 模型选择

- 优先级：调用参数 `model` > 类型 frontmatter `model` > 配置 `agents.<name>.model` > `subagents.defaultModel` > 父当前模型。
- 支持两个别名 `fast` / `strong`，映射在 `config.json` `models.aliases`（与 R1 模型调研对齐），让 Amp 式「探索用便宜模型、审查用强模型」只改配置不改定义文件。
- 工具描述里**不鼓励**模型自填 model（CC 的描述写明只有用户明确要求时才设）。

### 3.6 上下文与缓存策略

两种模式，缺省「全新」：

|            | 全新（fresh，缺省）                         | 分叉（fork，P3）                                     |
| ---------- | ------------------------------------------- | ---------------------------------------------------- |
| 子会话消息 | 只有委派 prompt                             | 父当前分支全部消息 + 指令                            |
| 前缀命中   | tools + system 与父相同时命中；消息部分全新 | 同模型、同工具表、同 system 时整段命中父缓存         |
| 适合       | 委派边界清楚的任务；可换便宜模型            | 「我需要中间产物但不想污染自己上下文」的调研         |
| 风险       | prompt 要写全                               | 必须同模型；子上下文从父的长度起步，压缩阈值更早触发 |

要做的缓存改动（P1 就做，成本小）：

1. **子会话工具表与父字节一致**：不从 schema 里去掉 `task`，改为子会话 `depth ≥ 1` 时 task 运行时报错（现在 `task.ts:95` 已有这条分支）。内置只读类型靠权限层，不改工具表。若类型用 `tools:` 白名单，则工具表必然不同，接受未命中（在 `/session` 子任务统计里能看到）。
2. **系统提示的角色追加放在最末**（system 尾部或首条 user 消息前缀），保证父的 system 主体是子的前缀。
3. 缓存键：OpenAI 端点 `prompt_cache_key` 在 fork 模式沿用父 / 根会话 id（`wave3-plan.md:209` 已为 `/fork` 这样做），fresh 模式也可沿用以提高同机路由命中——这是路由提示，不是安全边界。
4. 父在前台等子时已有 `streaming` 相保温（`wave3-plan.md:208`）；后台模式下父可能空闲，按现有 `idle` 保温经济性判断即可，不新增配置。
5. fork 模式强制忽略 `model` 参数（与 CC 一致）。

### 3.7 权限、隔离、深度与并发

- **权限继承**：沿用现状（同一管线、broker 包装、审批串到父、对话框标 `[task:<agent>]`）。类型可声明 `permission-mode`，**只能比父更严**（父 `default`、子 `read-only` 可以；子要 `auto` 不行），与 §7.2「项目级只能更严」同一规则。后台子 Agent 的审批照常弹给父的界面（CC 也是如此）；`-p` 非交互下后台子 Agent 的 ask 视同拒绝。
- **worktree 隔离（P2）**：`isolation: worktree` 时在 `<repo>/.ama/worktrees/<taskId>`（或系统临时目录）`git worktree add -b ama/task-<taskId>`，子会话 cwd 指向它；结束时无改动自动删除，有改动保留并在结果里给分支名与 `git diff --stat`，由父 / 用户决定合并。非 git 目录直接报错，不回落到共享目录（CC 的做法）。需要处理 `context-files.ts:7` 注释提到的「worktree 在主仓库内向上会碰到同一份 AGENTS.md」——这里是期望行为。
- **深度**：保持 ≤ 1。理由：所有对照里只有 CC 缺省 3，而且 CC 的 general-purpose 提示还要专门禁止「整体再委派」；ama 的协调型场景由 Armadra 画布承担。配置 `subagents.maxDepth` 先不开放。
- **并发**：保持排队式 `maxConcurrent: 4`，另加 `maxPending: 16`（超出报错「不要重试」）。后台任务也计入池。

### 3.8 与「操控外部 CLI Agent」统一

目标：模型只认识一个 `task(agent=…)`；`agent` 可以是 ama 自身的类型，也可以是外部 Agent。

- 抽象一个 `SubagentRunner` 接口（core 内，`src/agent/runners/`）：
  ```ts
  interface SubagentRunner {
    start(req: { prompt; cwd; signal; onEvent }): Promise<RunnerHandle>;
  }
  interface RunnerHandle {
    send(text: string): Promise<void>; // 续聊
    wait(): Promise<SubagentResult>;
    stop(): Promise<void>;
    readonly id: string;
  }
  ```
  - `AmaRunner`：现在的 `runSubagent`，同进程。
  - `ProcessRunner`（P3，与 R2 外部 Agent 控制调研对接）：以非交互 / JSON 流方式起外部 CLI（如 `claude -p --output-format stream-json`、`codex exec --json`、ACP 适配器），续聊靠各自的 `--resume <id>`。权限：外部 Agent 保留其 CLI 自己的账户、模型与权限策略（与 Armadra AGENTS.md 一致），ama 只对「启动这个 runner」走一次 `execute` 类审批。
  - `HostRunner`：嵌入 Armadra 时由宿主注册（`HostApi`），把 `task(agent="codex-1")` 映射到画布成员——这样 `disable("task")` 可以改为「task 由宿主接管」，协调者不必学两套工具。
- 定义文件里 `runner:` 字段选择实现；`runner` 非 ama 时 `tools / permission-mode / isolation` 中只有 `isolation` 有效（worktree 由 ama 建好后传 cwd），其余字段忽略并 warning。
- 结果统一为 `SubagentResult`（文本 + usage 可缺 + sessionRef），事件统一为下节的 `subagent_*`。

### 3.9 界面与 RPC 事件

新增会话事件（`SessionEvent`，RPC 原样透传，`docs/rpc.md` 登记）：

| 事件              | 字段                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `subagent_start`  | `taskId, parentToolCallId, agent, description, background, model, sessionFile?, cwd`                                  |
| `subagent_update` | `taskId, kind: "tool" \| "text" \| "turn", toolName?, textDelta?(节流), turn, usage`                                  |
| `subagent_end`    | `taskId, status: completed \| failed \| aborted \| max_turns, usage, cache?, outputFile?, worktree?{branch, changed}` |

- 现有 `[task] toolName` 的 `onUpdate` 保留作兼容。
- 父会话的审批事件已带 `context.depth / parentToolCallId`，再补 `taskId`。
- TUI：工具行折叠时显示 `agent · 状态 · 轮数 · 最近 3 个工具 · ↑↓ token`（Pi 的做法）；展开看子会话最终文本；`/tasks` 列出后台任务（状态、耗时、费用），回车进入子会话只读视图（OpenCode 的子会话导航，可放 P3）。
- `/session` 的「子任务」行已有 count / hitRate / reBilledTokens，补费用。

### 3.10 分阶段实施

| 阶段                                   | 内容                                                                                                                                                                                                                                          | 主要文件                                                                                                                                           | 验收                                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1 类型与正确性**（约 1 周）         | 定义文件发现与解析（复用 skills/frontmatter）；内置 general / explore / plan；`task.agent` 参数与描述列表；权限模式 `read-only`；`executionMode: parallel`；结果 50 KB 上限 + `outputs/`；maxTurns 收尾报告；子工具表与父对齐；`/agents` 命令 | 新 `src/agents/{discover,builtin,types}.ts`；改 `tools/task.ts`、`agent/session-subagent.ts`、`permissions/`、`agent/system-prompt.ts`             | 单测：只读类型调用 write 被拒；同轮 3 个 task 并发 ≤ 4 且真并行；未信任项目跳过 `.ama/agents`；`cache-stability` 测试证明子会话首请求命中 tools+system 前缀 |
| **P2 后台、续聊、隔离**（约 1–1.5 周） | `background` + `<task-notification>` followUp；子会话注册表与 `taskId` 续聊；`task_ctl(wait/stop/list/output)`；resume 重建；`isolation: worktree`；`subagent_*` 事件、TUI 折叠视图与 `/tasks`                                                | `agent/session-subagent.ts` 拆 `subagent-registry.ts`、`agent/queue.ts`、`modes/rpc`、`modes/interactive/tool-view.ts`、新 `src/agent/worktree.ts` | e2e：后台起 2 个 explore，父继续对话，两条通知按完成顺序到达；`taskId` 续聊复用同一 JSONL；worktree 无改动自动删除                                          |
| **P3 fork 与外部 runner**（按需）      | `mode: fork`（同模型、复制分支、共享缓存键）；`SubagentRunner` 抽象、`ProcessRunner`、`HostRunner`；子会话进入视图；`.claude/agents` 兼容读取                                                                                                 | `agent/runners/*`、`host/`                                                                                                                         | fork 首请求 cacheRead ≈ 父前缀；外部 runner 与 ama 子 Agent 的事件 / 结果形状一致                                                                           |

---

## 4. 风险与待定项

1. **后台通知注入的时机**：父正在流式输出时到达的通知放 followUp 还是 steer？建议 followUp（不打断），但用户等待很久时可能希望立刻看到——待定，可加配置。
2. **审批与后台冲突**：后台子 Agent 的审批弹窗会打断用户与父的对话；`-p` 非交互下只能拒绝。需要决定后台子 Agent 是否缺省 `read-only`（Codex / CC 都没这么做，但 ama 缺省模式对 bash 每次都问，影响更大）。
3. **只读 bash 识别**：§5.6 已论证不可靠；explore 若禁用 bash 会少很多能力（git log / diff）。折中：只放行极小白名单（`git log|show|diff|status`、`ls`、`wc`），其余拒绝——需要实测成功率。
4. **并行写冲突**：`executionMode: parallel` 后，两个 general 子 Agent 可能同时改同一文件；`file-mutex.ts` 只保证单次写原子，不保证语义。缓解：工具描述写明「并行写同一仓库请用 isolation: worktree」（CC 的写法），或 general 类型在已有运行中的写型子 Agent 时自动串行——待定。
5. **缓存收益依赖供应商**：tools+system 前缀复用在 Anthropic 显式缓存与 OpenAI 自动前缀缓存上成立；国产中转（Kimi / MiniMax / DeepSeek）行为不一，MiniMax 已观察到 task 后 cacheRead 归零。P1 的工具表对齐要用 `bench-presets` 在真实中转上测一轮再写结论。
6. **worktree 的成本**：大仓库 `git worktree add` 秒级、依赖（node_modules）不共享，子 Agent 跑测试前要装依赖。需要明确「worktree 只给写代码，不保证可运行」，或提供 `worktree.setup` 钩子（可复用命令式 Hook）。
7. **外部 runner 的权限边界**：外部 CLI 各有权限策略，ama 无法拦截其内部工具调用；审批只能在「启动」时做一次。与 Armadra「不得替人回答权限提示」的约定一致，但需在文档里写清楚。
8. **字段命名**：kebab-case（与 Skill 一致）还是 camelCase（与 CC 一致，兼容读取更省事）——建议定义文件用 kebab-case，兼容层做映射。
9. **深度是否放开到 2**：Cursor / CC 允许嵌套；ama 暂不放开，但 fork 子 Agent 若需要再委派 explore 会受限——等 P3 有真实需求再议。
10. **`description` 列表的 token 预算**：类型多了工具描述变长、每轮都在前缀里；建议总预算 400 token，超出只列名字，`/agents` 或 `read` 定义文件看详情（与 codemode `describeTool` 同思路）。

---

## 附：资料来源

- Claude Code 2.1.285 打包产物文本 `/tmp/cc-src/big.txt`（frontmatter 校验表、Agent 工具 schema、内置 Explore / Plan / general-purpose 定义、fork 提示、并发与深度环境变量）。
- Pi 1.0：`/tmp/pi-1.0/pi-coding-agent/examples/extensions/subagent/{README.md,index.ts,agents/*.md}`、`CHANGELOG.md`。
- Codex：[Subagents（官方）](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Configuration Reference](https://developers.openai.com/codex/config-reference)、[Multi-Agent Orchestration v2 社区指南](https://codex.danielvaughan.com/2026/04/11/codex-cli-multi-agent-orchestration-v2-complete-guide/)。
- OpenCode：[Agents 文档](https://opencode.ai/docs/agents/)、[task.ts 源码](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/task.ts)。
- Gemini CLI：[Subagents 文档](https://geminicli.com/docs/core/subagents/)。
- Amp：[The Dial](https://ampcode.com/docs/the-dial)、[Modes & Models](https://ampcode.com/modes)、[Manual](https://ampcode.com/manual)。
- Cursor：[Subagents 文档](https://cursor.com/docs/subagents)、[2.4 Changelog](https://cursor.com/changelog/2-4)、[Background/Cloud Agents 指南](https://www.morphllm.com/cursor-background-agents)。
- ama：`src/tools/task.ts`、`src/agent/session-subagent.ts`、`src/agent/session.ts:578-600`、`src/agent/session-cache.ts:136-338`、`src/agent/tool-runner.ts:330-334`、`src/skills/discover.ts`、`docs/design.md` §5.2 / §5.4–§5.6、`docs/wave3-plan.md` §1.9、`docs/gap-audit-2026-10.md:32`。
