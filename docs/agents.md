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
background: false # 不写 = 按 config subagents.background
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

| 参数                                             | 说明                                                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                                         | 必填，完整的任务说明                                                                                                                                     |
| `agent`                                          | 类型名，缺省 `general`；也可以是外部 Agent（见「外部 Agent」节）                                                                                         |
| `description`                                    | 显示用的短标签                                                                                                                                           |
| `background`                                     | `true`：立即返回 `taskId`，完成后父会话收到通知；`false`：等结果。缺省取类型的 `background`，类型没写时按 `subagents.background`（见下文「前台与后台」） |
| `taskId`                                         | 续聊：向已有任务的子会话追加一条消息（忽略 `agent` / `tools` / `model`）                                                                                 |
| `isolation`                                      | `worktree`：在独立 git worktree 里运行                                                                                                                   |
| `budgetUsd`                                      | 外部 Agent 的美元预算                                                                                                                                    |
| `tools` / `model` / `thinkingLevel` / `maxTurns` | 保留的高级参数（描述里不展开）                                                                                                                           |

同一条回复里的多个 `task` **并行**执行，由会话的任务池限流（`subagents.maxConcurrent`，缺省 4）；排队超过
`subagents.maxPending`（缺省 16）直接报错，提示模型不要重试。并行且会写文件的任务请用 `isolation: "worktree"`。
与 `edit` 等串行工具出现在同一批时，按工具执行规则整批串行。

结果是子 Agent 的最终报告，前面带 `[task tN]`。超过 50 KB 时保留开头 70% 与结尾 30%，中间注明省略了多少字节，
全文写到会话目录的 `outputs/<会话 id>-<taskId>.md`（内存会话写到系统临时目录）。轮数用尽且最后一步停在工具结果上时，
ama 以「不允许调用工具」再跑一轮要最终报告，结果前加 `[Turn limit reached; …]`，状态 `max_turns`。

### 前台与后台

是否后台的优先级：调用参数 `background` > 类型定义的 `background:` > config `subagents.background`。
`subagents.background` 缺省 `auto`：交互界面、RPC、ACP 下后台（模型需要结果才写 `background: false`），`-p` 下前台；
`always` / `never` 固定。两种缺省对应两版 `task` 工具描述，会话内不变，不影响缓存前缀稳定。

前台任务运行中可以转后台，任务不中断，`task` 工具调用立即返回一段固定英文结果（含 `taskId` 与输出文件），完成后照常发
`<task-notification>`：

- 交互界面：`Ctrl+B` / `/tasks bg [id]` / Agent 栏里按 `b`（见 [tui.md](tui.md)「子 Agent」）；
- RPC：`background_task { taskId? }`（[rpc.md](rpc.md)），SDK：`session.backgroundTask(taskId?)`，返回实际转了的 `taskId`；
  不给 `taskId` 时转全部前台运行中任务，正在 `task_ctl wait` 的等待也一并打断；
- 自动：`subagents.autoBackgroundAfterMs` 大于 0 时，前台任务运行超过该毫秒数自动转后台（缺省 0 关闭）。

转后台发 `subagent_background { taskId, parentToolCallId, reason }` 事件（`user` / `timeout` / `host`）。
父会话 `Esc` 中断只连带中止仍在前台的任务，后台任务不受影响；停止后台任务用 `task_ctl stop` 或 `/tasks stop`。

`-p` 下（缺省前台）显式 `background: true` 仍生效：主回合结束后若还有任务在跑或通知待投递，stderr 一行提示，等它们结束、
跑完通知回合再输出，输出的文本是最后一条助手回复；等待受 `--max-turns` / `--max-cost` / `limits.*` 约束（到限停止等待、
退出码 8），`Ctrl+C` / SIGTERM 照常中止（未结束的任务随会话关闭被停止，退出码 130 / 143）。`--output-format json` 的结果带
`tasks`（同 `getStats().tasks`）。

### 后台任务与 `task_ctl`

后台任务立即返回 `taskId` 与输出文件路径。任务完成后，ama 在父会话空闲时投递一条 user 消息（`origin: "task"`）
并开始新回合；父正忙则等这一轮结束再投递，不打断。多条通知按完成顺序到达：

```text
<task-notification taskId="t3" agent="explore" status="completed" turns="7" tokens="12.3k" outputFile="…">
…最终报告（≤ 50 KB）…
</task-notification>
```

系统提示的规则里写明这类消息是后台任务的报告、不是用户发言。被 `task_ctl stop` 停止或随会话关闭的任务不发通知。
后台任务的审批照常交给父会话的界面 / RPC 客户端（`-p` 下需要确认的调用视同拒绝）；后台任务的全文总会写到输出文件。

`task_ctl` 的动作：

| `action` | 说明                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------- |
| `list`   | 列出本会话的任务：编号、类型、状态、轮数、token、耗时、是否后台、描述                                   |
| `wait`   | 等任务结束（`timeoutMs` 缺省 30 000，最多 600 000）；超时说明仍在运行；被转后台时立即返回并说明不必再等 |
| `stop`   | 停止任务，返回终态                                                                                      |
| `output` | 运行中返回已有输出，结束后返回最终文本（同样有 50 KB 上限）                                             |
| `send`   | 向任务追加一条消息并放到后台运行（等价于 `task{taskId, prompt, background:true}`）                      |

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

RPC / SDK 事件 `subagent_start` / `subagent_update` / `subagent_background` / `subagent_end` 见 [rpc.md](rpc.md)「子 Agent 事件」。
`getStats().tasks` 给出任务总数、运行中数量与按状态的计数；子会话的缓存命中与重计费仍汇总在 `cache.subagents`。
RPC `get_tasks` / `get_agents` 返回任务快照与可用类型（来源、定义文件路径）。交互界面的 `/tasks`、`/agents` 与 task 工具行的折叠显示见 [tui.md](tui.md)「子 Agent」。

### 配置

| 键                                | 说明                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `subagents.maxConcurrent`         | 同时运行的子 Agent，缺省 4                                                       |
| `subagents.maxPending`            | 排队上限，缺省 16                                                                |
| `subagents.defaultModel`          | 子 Agent 缺省模型，不设继承父会话                                                |
| `subagents.background`            | `auto`（缺省）\| `always` \| `never`，见「前台与后台」；用户 / 项目 / 宿主级都认 |
| `subagents.autoBackgroundAfterMs` | 前台任务运行超过该毫秒数自动转后台，缺省 0（关闭）；用户 / 项目级都认            |
| `agents.dirs`                     | 追加的定义目录                                                                   |
| `agents.<类型>.model`             | 某个类型的模型（如让 `explore` 用便宜模型）                                      |
| `models.aliases.fast` / `.strong` | 定义文件里 `model: fast / strong` 的映射                                         |

### 限制

- 子 Agent 不能再委派（深度 1）；协调多个 Agent 的场景交给宿主（如 Armadra 画布）。
- 只读类型的 bash 只放行 plan 模式认可的只读命令，识别不了的一律拒绝，宁可少用。
- 不读取 `.claude/agents`；不支持 fork 模式（继承父对话的子 Agent）。

## 外部 Agent

ama 能以各 CLI 自己的账户、模型与权限策略驱动外部编码 Agent，结果作为 `task` 的工具结果回到协调者（按资料处理，不是指令）。

### 支持的 Agent 与驱动

每个 Agent 有一条候选链，按优先级取第一个已安装、且支持当前模式的：原生 ACP > 已装的 ACP 适配器 > 原生结构化协议 > 一次性打印模式。

| `agent`                                   | 候选（优先级从高到低）                                                                                              | 已验证版本          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `claude`                                  | `claude-agent-acp`（ACP 适配器）→ `claude -p` stream-json（原生）→ `claude -p --output-format json`（一次性，只读） | stream-json：2.1.x  |
| `codex`                                   | `codex-acp`（ACP 适配器）→ `codex app-server`（原生）→ `codex exec --json`（一次性，只读）                          | app-server：0.160.x |
| `gemini`                                  | `gemini --acp` → `gemini -p --output-format stream-json`（一次性，只读）                                            | 未验证              |
| `qwen`                                    | `qwen --acp`（0.23.x 有不发权限请求的问题，只在 plan 下用）                                                         | 未验证              |
| `kimi` / `opencode` / `goose` / `copilot` | 各自的 ACP 子命令                                                                                                   | 未验证              |
| `ama`                                     | `ama --mode acp`                                                                                                    | 随 ama              |
| `acp:<program>`                           | 任意 ACP Agent：表里有同名程序就用它的参数，否则不带参数启动                                                        | —                   |

版本越过已验证区间时仍会启动，但会提示协议可能有变化（Claude 的 stream-json 控制协议不是公开接口，Codex app-server 标为实验）。`/agents` 与 RPC `get_agents` 列出探测结果（只查 PATH 与 `--version`，不联网、不计费；结果缓存在 `<数据目录>/drivers.json`）。

### 在 `task` 里使用

- **名字**：`task(agent="claude")`、`"codex"`、`"acp:<程序>"`（如 `acp:ama`、`acp:gemini`），以及上表的其它 id（`gemini`、`qwen` …；
  裸 `ama` 不是外部 Agent，ama 自己经 ACP 写 `acp:ama`）；定义文件里 `runner: claude | codex | acp:<程序>` 的类型同样走这里。
  启动时 PATH 上找得到的 `claude` / `codex` 写进 task 工具描述的类型清单（只查 PATH，不起进程）；其余名字按需解析、不进描述
  （描述在会话内字节不变，缓存前缀不受影响）。
- **首次确认**：每个会话第一次以某个外部 Agent 运行时问一次「将以你在该 CLI 的现有登录运行，模式 Y」（`execute` 类）：
  allow 规则 `task` 或 `task(<id>)`（如 `task(claude)`、`task(acp:*)`）与 `full-auto` 直接放行；deny 规则 `task(<id>)` 拒绝；
  `allowlist` 与无人值守（`-p`）没有 allow 规则时拒绝；其余交给人（不经 auto 分类器）。同一 Agent 本会话只问一次。
  宿主注入的 runner 不问（审批由宿主管）。Manual 模式下 `task(agent="claude")` 本来要问两次（task 调用本身一次、首次运行一次），
  交互界面合并为一次：task 调用的审批框写明「以你在该 CLI 的登录运行（含本会话首次运行确认）」，允许后紧接着的首次运行
  确认自动通过；中间夹了别的审批、被拒、超过 60 秒或不是这次调用建立的任务时照常弹出（[tui.md](tui.md)「子 Agent」）。
- **前台 / 后台 / 续聊**：与 ama 子会话相同——结果是外部 Agent 的最终文本加工具摘要与修改的文件（≤ 50 KB）；
  `background: true` 完成后收到 `<task-notification>`；`task{taskId}` / `task_ctl send` 在同一外部会话里续聊（进程还在就直接
  追加一轮；空闲关闭或被停止过的，以外部会话 id `resume` 重开）；`task_ctl stop` 发协议级中断，挂起的审批回「已取消」。
- **模型**：`agents.<id>.model` 或 `task` 的 `model` 参数原样交给外部 CLI；`subagents.defaultModel`（ama 的模型）不传。
- `/agents` 与 RPC `get_agents` 列出类型目录与外部 Agent（`installed` / `version`，会话建立时异步探测并缓存）；`/tasks` 查看任务输出、
  停止任务。界面见 [tui.md](tui.md)「子 Agent」。
- 外部 Agent 自己报告的提示（预算用尽、超时、模式降级、拒答提问等）在交互界面的消息区显示为一行 `[claude · t3] …`，
  其它入口只写进诊断日志（`[task tN] …`，没有对应事件）。

### 权限：只交给人

- 外部 Agent 先按它自己的策略判断；它决定要问人的请求才到 ama，到了以后**只走审批通道**（宿主 → 界面 → 无人值守拒绝）。ama 的 auto 分类器与模型都不参与，模型没有回答审批的工具。
- 对话框标出来源（`[claude · 会话 abc12345]`，三种来源标注见 [permissions.md](permissions.md)「审批对话框的来源标注」）；RPC 的 `permission_request` 带 `context.origin`（Agent、会话、工具标题与种类、路径、选项）与 `context.taskId`（来源任务）。
- 选项：「允许」→ 允许一次；「本会话允许」→ 交给外部 Agent 自己记住（Codex `acceptForSession`；Claude 只回传它给出的会话范围建议，会写配置文件的建议不替你接受）；「拒绝」→ 拒绝一次。会改外部 CLI 持久配置的选项（Codex execpolicy 修订、永久拒绝）不提供。
- 无人值守（`-p`、RPC 未声明 approvals）：一律拒绝；Claude 以 `--permission-prompts none` 启动，Codex 用 `approval_policy = never`。
- 中断、`task_ctl stop`、超时：挂起的请求回「已取消」。
- 外部 Agent 向你**提问**（Claude `AskUserQuestion`、Codex `requestUserInput`、MCP elicitation）时 ama 不代答：拒绝并请它把问题写进最终回复，界面给出提示。

### 模式：不比 ama 宽

外部 Agent 的模式不得比 ama 当前模式宽；用户级 `agents.<id>.maxMode` 可以显式放宽。父会话在 `plan` 或 `allowlist` 时外部 Agent 只能只读（`allowlist` 也按 `plan`：外部 Agent 的放行规则来自它自己的配置，与 ama 不等价）。

| ama 模式    | Claude Code `--permission-mode`      | Codex `approval_policy` / `sandbox`                        | ACP `session/set_mode`                                   |
| ----------- | ------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------- |
| `plan`      | `plan`                               | `never` / `read-only`                                      | `plan`（没有只读模式的 Agent 拒绝启动）                  |
| `allowlist` | `plan`                               | `never` / `read-only`                                      | `plan`                                                   |
| `default`   | `manual`（旧版本 `default`）         | `on-request` / `read-only`                                 | 同名模式，没有则用它的缺省模式（需要授权的操作仍交给你） |
| `auto-edit` | `acceptEdits`                        | `untrusted` / `workspace-write`                            | 同上                                                     |
| `auto`      | `auto`                               | `on-request` / `workspace-write`                           | 同上                                                     |
| `full-auto` | `auto`（从不给 `bypassPermissions`） | `never` / `workspace-write`（从不给 `danger-full-access`） | 同上                                                     |

ACP Agent 不给 `modes`、改用 category `mode` 的配置项表达模式时，按上表同一映射在配置项的可选值里找，经 `session/set_config_option` 设置（见 [acp.md](acp.md)「作为客户端」）。

一次性打印模式不能审批，只在只读任务下用。

### 环境与账户

外部 Agent 用你在该 CLI 里的现有登录。为了不把订阅计费切成 API 计费，ama 起子进程时**缺省剥离**：全部内置供应商的 API key 变量、`*_BASE_URL`、`AMA_*`、`CODEX_API_KEY`、`ANTHROPIC_AUTH_TOKEN`，以及 `ARMADRA_*`（`ARMADRA_ASKPASS_*` 除外，见「嵌入宿主」）；其余（PATH、HOME、LANG、代理、SSH、各 CLI 自己的配置目录与令牌）保留。确实要传的用 `agents.<id>.env.passthrough` 列出（`config.json`，只认用户级）：

```json
{
  "agents": {
    "maxConcurrent": 3,
    "sessionBudgetUsd": 5,
    "claude": { "maxConcurrent": 2, "model": "sonnet", "env": { "passthrough": ["HTTPS_PROXY"] } },
    "codex": { "maxMode": "auto-edit" }
  }
}
```

`--bare`（只认 API key）永不使用。

### 信任、并发、预算、记账

- **信任**：只在 ama 已信任的目录里起外部 Agent（`claude -p` 会跳过目录信任对话框并执行项目 hooks 与配置）；未信任时 `task` 报错并提示 `ama trust`。
- **并发**：外部 Agent 总共 `agents.maxConcurrent`（缺省 3），每个 Agent 另有上限（`agents.<id>.maxConcurrent`，claude 缺省 2）；超出排队，排队可被中断。与 ama 子会话的并发分开计。
- **预算**：`task` 的 `budgetUsd`（Claude 透传 `--max-budget-usd`，其余按用量累计、超限中断）；`agents.sessionBudgetUsd` 是本会话外部 Agent 的美元总额，用尽后不再启动。Codex 订阅 token、Copilot premium request 按各自单位记，不换算美元；Claude 的 `total_cost_usd` 是它自己的估算。
- **记账**：每回合写 `custom{ama.agent-usage}`，会话建立写 `custom{ama.agent-session}`（外部 CLI 自己的会话 id，用于续聊）；`/session` 与 `get_session_stats` 的 `external` 段按 Agent 汇总。外部 Agent 报告了上下文占用与窗口（ACP 的 `usage_update`、Codex app-server 的 `tokenUsage`）时，只记这两个数字：任务记录与 `ama.agent-usage` 带 `contextTokens / contextWindow`，`external.byAgent` 取最近一次，`/tasks` 与 Agent 栏的任务行显示 `ctx 34%`（低于 10% 保留一位小数）；回合中途变化也会即时更新。ama 会话只存最终文本、工具摘要、用量与引用，外部 Agent 的原始事件只在内存里显示，不落盘。
- **看门狗**：单回合缺省 30 分钟；中断后 15 秒内没有回合结束就关 stdin 再结束进程树；空闲 10 分钟关进程，能续接的下次续聊时以 resume 重开。外部 Agent 进程登记在 `<数据目录>/drivers/pids.json`，ama 异常退出留下的孤儿在下次使用时清理（核对命令行，pid 被复用的不杀）。

### 嵌入宿主

有宿主（`--host` 或 profile 的 `host`，如嵌入 Armadra）时 ama **不自己启动外部 CLI**：内置外部 Agent 一律不可用，不写进 task 描述，`task(agent="claude")` 以「由宿主提供」失败；只有宿主经 `HostApi.runners.provide(runner)` 注入的 runner 可用，它以同一个 `task(agent=<id>)` 入口出现，同名时替换内置的。`create()` 时已注入的 runner 写进 task 描述（`- <id>: <description>`），之后注入的也能用但不进描述。runner 的 `start` 收到 `prompt`、`cwd`、`mode`（父会话当前模式）、`taskId`、`signal`、`onEvent`；不经首次确认。宿主注入的 runner id 也可以是 `ama`（例如画布上另一个 ama 节点）：`task(agent="ama")` 交给宿主，不起子会话；没注入时 `ama` 照旧不是可用类型，内置类型（`general` / `explore` / `plan`）始终是 ama 子会话。

**在 Armadra 画布终端里直接运行 ama（没有 `--host`）**：此时 ama 按独立模式工作，自己启动的外部 Agent 是这个终端节点里的子进程，不会出现在画布上，也不经连线授权；需要让多个 Agent 在画布上协同，就在画布上连线 Agent 节点，或以宿主模式嵌入 ama。终端带着该节点的身份变量（`ARMADRA_NODE_ID`、`ARMADRA_SESSION_ID`、Hook 端点、`ARMADRA_CANVAS_CONTROL` 等），ama 起子进程时一律剥离（askpass 除外），否则 Armadra 装在 Claude / Codex 上的 Hook 会把子 Agent 的事件记到这个节点名下。

### 本地验证真实 CLI

CI 不跑真实 CLI。本机已登录 `claude` / `codex` 时：

```sh
AMA_E2E_AGENTS=1 pnpm vitest run src/drivers/agents.e2e.test.ts src/agents/external-task.e2e.test.ts
```

驱动层每家两轮「只回 OK」加一次触发审批的写文件（临时目录），会使用你的订阅额度；Claude 跑前后比对 `~/.claude` 下 settings 文件的指纹。`task` 层每家一次写文件（首次确认与写文件审批由测试代替人允许）加一轮 `taskId` 续聊；父会话用 fake 供应商。驱动的单元测试用 `test/fixtures/drivers/` 下的手写录制回放，`task` 层的零费用端到端是 ama 驱动 ama（`src/agents/external-task.test.ts`），都不发起计费请求。
