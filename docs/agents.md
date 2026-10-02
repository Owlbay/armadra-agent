# Agent：子 Agent 与外部 Agent

模型只有一个入口：`task(agent=…)` 与 `task_ctl`（[wave5-plan.md](wave5-plan.md) D13）。`agent` 可以是 ama 自己的子 Agent 类型，也可以是外部 CLI Agent（Claude Code、Codex、ACP Agent）。

## 子 Agent

<!-- [W5-G] 子 Agent 定义文件、内置类型、task 参数、后台与通知、续聊、worktree 等由 W5-G 在本节补写。 -->

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

### 权限：只交给人

- 外部 Agent 先按它自己的策略判断；它决定要问人的请求才到 ama，到了以后**只走审批通道**（宿主 → 界面 → 无人值守拒绝）。ama 的 auto 分类器与模型都不参与，模型没有回答审批的工具。
- 对话框标出来源（`[claude · 会话 abc1]`）；RPC 的 `permission_request` 带 `context.origin`（Agent、会话、工具标题与种类、路径、选项）。
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

一次性打印模式不能审批，只在只读任务下用。

### 环境与账户

外部 Agent 用你在该 CLI 里的现有登录。为了不把订阅计费切成 API 计费，ama 起子进程时**缺省剥离**：全部内置供应商的 API key 变量、`*_BASE_URL`、`AMA_*`、`CODEX_API_KEY`、`ANTHROPIC_AUTH_TOKEN`；其余（PATH、HOME、LANG、代理、SSH、各 CLI 自己的配置目录与令牌）保留。确实要传的用 `agents.<id>.env.passthrough` 列出（`config.json`，只认用户级）：

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
- **记账**：每回合写 `custom{ama.agent-usage}`，会话建立写 `custom{ama.agent-session}`（外部 CLI 自己的会话 id，用于续聊）；`/session` 与 `get_session_stats` 的 `external` 段按 Agent 汇总。ama 会话只存最终文本、工具摘要、用量与引用，外部 Agent 的原始事件只在内存里显示，不落盘。
- **看门狗**：单回合缺省 30 分钟；中断后 15 秒内没有回合结束就关 stdin 再结束进程树；空闲 10 分钟关进程，能续接的下次续聊时以 resume 重开。外部 Agent 进程登记在 `<数据目录>/drivers/pids.json`，ama 异常退出留下的孤儿在下次使用时清理（核对命令行，pid 被复用的不杀）。

### 嵌入宿主

有宿主（`--profile` 带 `host`，如嵌入 Armadra）时 ama **不自己启动外部 CLI**：内置外部 Agent 一律不可用，`task(agent="claude")` 返回「由宿主提供」；只有宿主经 `HostApi.runners.provide(runner)` 注入的 runner 可用，它以同一个 `task(agent=…)` 入口出现，同名时替换内置的。

### 本地验证真实 CLI

CI 不跑真实 CLI。本机已登录 `claude` / `codex` 时：

```sh
AMA_E2E_AGENTS=1 pnpm vitest run src/drivers/agents.e2e.test.ts
```

每家两轮「只回 OK」加一次触发审批的写文件（临时目录），会使用你的订阅额度；Claude 跑前后比对 `~/.claude` 下 settings 文件的指纹。驱动的单元测试用 `test/fixtures/drivers/` 下的手写录制回放，不发起计费请求。
