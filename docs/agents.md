# Agent：子 Agent 与外部 Agent

模型只认识两个工具：`task`（委派）与 `task_ctl`（管理后台任务）。`task(agent=…)` 的 `agent` 既可以是 ama 自己的子 Agent
类型，也可以是外部 CLI Agent（外部部分见下文「外部 Agent」节）。设计依据：[wave5-plan.md](wave5-plan.md) §7、D13、D22–D24。

## 子 Agent

### 何时可用

`task` 与 `task_ctl` 同进退：`default` 预设下只在 codemode 脚本里可调用，`--tools …,task` 或 `tools.default: ["+task"]`
时直接暴露；嵌入宿主时宿主可以禁用。子 Agent 运行在同一进程的新会话里（全新上下文，看不到父对话，`prompt` 要写全），
有自己的 JSONL（与父会话同目录，头的 `parentSession` 指回父文件）。深度最多 1：子 Agent 里调用 `task` / `task_ctl` 会被拒绝。

### 内置类型

| 类型              | 工具       | 权限                                  | 角色说明（追加在子会话系统提示末尾）       |
| ----------------- | ---------- | ------------------------------------- | ------------------------------------------ |
| `general`（缺省） | 父的活动集 | 与父相同                              | 直接完成、不再委派，结束时给精简报告       |
| `explore`         | 父的活动集 | plan 模式：写类工具与非只读 bash 被拒 | 只定位不评审，返回路径与行号，说明搜索范围 |
| `plan`            | 父的活动集 | plan 模式                             | 输出分步计划、关键文件与取舍，不修改文件   |

只读靠权限层：只读类型的子会话用一条 plan 模式的权限管线（规则与父相同），需要确认的调用一律直接拒绝，**不弹审批**。
工具表与父会话逐字节相同（`task` / `task_ctl` 也在表里，运行时拒绝），子会话的首个请求能复用父会话已缓存的 tools + system
前缀；角色说明是系统提示最后一个节（`role`），父会话的全部节都是它的前缀。只有类型声明了 `tools` / `disallowed-tools`
（或调用时传了 `tools`）时工具表才不同，此时首个请求不命中父的缓存。

### 定义文件

一个 `*.md` 是一个类型，frontmatter 与 Skill 同一套写法（字段名 kebab-case），正文是角色说明：

```markdown
---
name: reviewer # ^[a-z0-9-]{1,64}$，缺省取文件名
description: 只读审查改动，按文件与行号报告问题。 # 必填，≤ 1024 字符，出现在 task 工具描述里
tools: read, grep, glob, bash # 白名单；与 disallowed-tools 二选一
permission-mode: plan # plan | inherit（缺省）；只能比父更严
model: fast # inherit（缺省）| fast | strong（models.aliases）| provider/model
thinking: low
max-turns: 20 # 缺省 30
isolation: none # none（缺省）| worktree
background: false
runner: ama # ama（缺省）| claude | codex | acp:<程序>
---

引用改动时写 file:line，先列严重问题。
```

发现顺序（同名先发现者胜，并给出提示；内置类型可被同名定义覆盖）：

1. `--agent-dir <目录>`（可重复），之后是 profile 的 `agentDirs`；
2. config 的 `agents.dirs`；
3. `~/.config/ama/agents/*.md`（用户级）；
4. `<项目>/.ama/agents/*.md`（项目级，**需要信任**；未信任时跳过并在启动时提示）。

不合格的文件不加载并给出提示（名字非法、缺 description、`tools` 与 `disallowed-tools` 同时给出、取值不认识等）。
不支持的字段（`hooks`、`mcpServers`、`memory`、`color`、`initialPrompt`、`skills`）忽略；子会话本来就继承父的 Skill 索引。

模型选择：调用参数 `model` > 定义的 `model`（非 inherit）> config `agents.<类型>.model` > `subagents.defaultModel` > 父当前模型。
`fast` / `strong` 经 `models.aliases` 映射，没配置时用父模型并提示。

### `task` 参数

| 参数                                             | 说明                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| `prompt`                                         | 必填，完整的任务说明                                                       |
| `agent`                                          | 类型名，缺省 `general`                                                     |
| `description`                                    | 显示用的短标签                                                             |
| `background`                                     | `true`：立即返回 `taskId`，完成后父会话收到通知；缺省取类型的 `background` |
| `taskId`                                         | 续聊：向已有任务的子会话追加一条消息（忽略 `agent` / `tools` / `model`）   |
| `isolation`                                      | `worktree`：在独立 git worktree 里运行                                     |
| `budgetUsd`                                      | 外部 Agent 的美元预算                                                      |
| `tools` / `model` / `thinkingLevel` / `maxTurns` | 保留的高级参数（描述里不展开）                                             |

同一条回复里的多个 `task` **并行**执行，由会话的任务池限流（`subagents.maxConcurrent`，缺省 4）；排队超过
`subagents.maxPending`（缺省 16）直接报错，提示模型不要重试。并行且会写文件的任务请用 `isolation: "worktree"`。
与 `edit` 等串行工具出现在同一批时，按工具执行规则整批串行。

结果是子 Agent 的最终报告，前面带 `[task tN]`。超过 50 KB 时保留开头 70% 与结尾 30%，中间注明省略了多少字节，
全文写到会话目录的 `outputs/<会话 id>-<taskId>.md`（内存会话写到系统临时目录）。轮数用尽且最后一步停在工具结果上时，
ama 以「不允许调用工具」再跑一轮要最终报告，结果前加 `[Turn limit reached; …]`，状态 `max_turns`。

### 后台任务与 `task_ctl`

`background: true` 立即返回 `taskId` 与输出文件路径。任务完成后，ama 在父会话空闲时投递一条 user 消息（`origin: "task"`）
并开始新回合；父正忙则等这一轮结束再投递，不打断。多条通知按完成顺序到达：

```text
<task-notification taskId="t3" agent="explore" status="completed" turns="7" tokens="12.3k" outputFile="…">
…最终报告（≤ 50 KB）…
</task-notification>
```

系统提示的规则里写明这类消息是后台任务的报告、不是用户发言。被 `task_ctl stop` 停止或随会话关闭的任务不发通知。
后台任务的审批照常交给父会话的界面 / RPC 客户端（`-p` 下需要确认的调用视同拒绝）；后台任务的全文总会写到输出文件。

`task_ctl` 的动作：

| `action` | 说明                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| `list`   | 列出本会话的任务：编号、类型、状态、轮数、token、耗时、是否后台、描述              |
| `wait`   | 等任务结束（`timeoutMs` 缺省 30 000，最多 600 000）；超时说明仍在运行              |
| `stop`   | 停止任务，返回终态                                                                 |
| `output` | 运行中返回已有输出，结束后返回最终文本（同样有 50 KB 上限）                        |
| `send`   | 向任务追加一条消息并放到后台运行（等价于 `task{taskId, prompt, background:true}`） |

### 续聊、保留与 resume

每个任务有会话内唯一的 `taskId`（`t1`、`t2` …）。子会话结束后不立即释放，最多保留 16 个（最久未用的先释放内存；
JSONL 一直在）。`task{taskId}` / `task_ctl send` 续聊时，保留中的直接追加消息，已释放的按会话文件重新打开再追加——
同一个任务始终写同一个 JSONL。父会话在任务开始、每次续聊与结束时写一条 `custom{ama.task}`
（[session-format.md](session-format.md)）；`--resume` 时据此重建任务列表，当时还在运行的标 `interrupted`，仍可续聊。
内存会话（`--no-session`）的任务被释放后不能续聊。

### worktree 隔离

`isolation: "worktree"` 时，ama 在父 cwd 所在仓库里执行
`git worktree add -b ama/task-<名字> <仓库>/.ama/worktrees/<名字>`（名字 = 会话 id 前 8 位 + `taskId`），子会话的 cwd 是
worktree 里与父 cwd 对应的目录。结束时没有改动（工作区干净且没有新提交）就删掉 worktree 与分支；有改动则保留，结果末尾给出
分支名、路径与 `git diff --stat`（含未跟踪文件），由你决定是否合并。`.ama/worktrees/` 下自动写一个 `.gitignore`（`*`），
父仓库的 `git status` 与 grep / glob 都看不到这些目录。不在 git 仓库里时直接报错，不会退回共享目录。
worktree 里的编辑不记进父会话的检查点。注意：worktree 不共享依赖（`node_modules` 等），不保证能直接构建或运行测试。

### 事件与统计

RPC / SDK 事件 `subagent_start` / `subagent_update` / `subagent_end` 见 [rpc.md](rpc.md)「子 Agent 事件」。
`getStats().tasks` 给出任务总数、运行中数量与按状态的计数；子会话的缓存命中与重计费仍汇总在 `cache.subagents`。
RPC `get_tasks` / `get_agents` 返回任务快照与可用类型（来源、定义文件路径）。

### 配置

| 键                                | 说明                                        |
| --------------------------------- | ------------------------------------------- |
| `subagents.maxConcurrent`         | 同时运行的子 Agent，缺省 4                  |
| `subagents.maxPending`            | 排队上限，缺省 16                           |
| `subagents.defaultModel`          | 子 Agent 缺省模型，不设继承父会话           |
| `agents.dirs`                     | 追加的定义目录                              |
| `agents.<类型>.model`             | 某个类型的模型（如让 `explore` 用便宜模型） |
| `models.aliases.fast` / `.strong` | 定义文件里 `model: fast / strong` 的映射    |

### 限制

- 子 Agent 不能再委派（深度 1）；协调多个 Agent 的场景交给宿主（如 Armadra 画布）。
- 只读类型的 bash 只放行 plan 模式认可的只读命令，识别不了的一律拒绝，宁可少用。
- 不读取 `.claude/agents`；不支持 fork 模式（继承父对话的子 Agent）。
