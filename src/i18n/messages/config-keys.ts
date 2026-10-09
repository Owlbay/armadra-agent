/**
 * 消息目录：config 领域的配置键说明（config.schema.json 的 description、`ama config show`、`/config`
 * 面板）。[W6-I4] 由 `messages/config.ts` 挂到 `msg().config.keys` / `msg().config.dynamicDefaults`，
 * 取用走 `config/key-docs.ts` 的 `keyDoc(path)`。
 *
 * 键是配置路径（`permission.mode`）；段落本身也有一条。键与 schema 一一对应由 json-schema.test.ts 守住。
 */

import type { Messages } from "../types.js";

/** 缺省值由运行时决定的键 → 规则（schema 不写 default）。 */
const dynamicDefaultsEn = {
  $schema: "ama init writes ./config.schema.json",
  defaultModel: "picked automatically with zero configuration",
  "permission.autoModel": "the current session model",
  "codemode.mode": "follows the tool preset",
  "ui.ascii": "auto-detected",
  "ui.statusLine": "full in a standalone terminal, compact in an embedding host (with a profile)",
  "plan.directory": "<data dir>/plans",
  "plan.model": "unset: keep the current model",
  "plan.thinkingLevel": "unset: keep the current thinking level",
  "agents.sessionBudgetUsd": "unset: unlimited",
  "subagents.defaultModel": "unset: inherit the parent session model",
  "models.aliases.fast": "unset: fast is treated as inherit",
  "models.aliases.strong": "unset: strong is treated as inherit",
  "models.enabled": "unset: /model shows every model of configured providers",
  fallbackModel: "unset: no fallback",
  "limits.maxTurns": "unset: unlimited",
  "compaction.contextBudget": "unset: the model's context window",
  "limits.maxCostUsd": "unset: unlimited",
  "ui.replyLanguage": "unset: no reply-language rule is appended (zero-byte change)",
  "ui.agentBar": "auto (embedding hosts turn it off in their profile)",
  "auth.chatgpt.clientId":
    "siwc registers dynamically on first login; codex uses the public client id (AMA_CHATGPT_CLIENT_ID overrides)",
  "auth.chatgpt.redirectPorts": "siwc 1455 → any free port; codex 1455 → 1457",
};

const dynamicDefaultsZh = {
  $schema: "ama init 写 ./config.schema.json",
  defaultModel: "零配置自动选择",
  "permission.autoModel": "当前会话模型",
  "codemode.mode": "跟随预设",
  "ui.ascii": "自动检测",
  "ui.statusLine": "独立终端 full，嵌入宿主（有 profile）compact",
  "plan.directory": "<数据目录>/plans",
  "plan.model": "不设：沿用当前模型",
  "plan.thinkingLevel": "不设：沿用当前思考强度",
  "agents.sessionBudgetUsd": "不设：不限",
  "subagents.defaultModel": "不设：继承父会话模型",
  "models.aliases.fast": "不设：fast 按 inherit 处理",
  "models.aliases.strong": "不设：strong 按 inherit 处理",
  "models.enabled": "不设：/model 显示已配置供应商的全部模型",
  fallbackModel: "不设：不回退",
  "limits.maxTurns": "不设：不限",
  "compaction.contextBudget": "不设：模型的上下文窗口",
  "limits.maxCostUsd": "不设：不限",
  "ui.replyLanguage": "不设：不追加回复语言规则（零字节变化）",
  "ui.agentBar": "auto（嵌入宿主要关在自己的 profile 写 off）",
  "auth.chatgpt.clientId":
    "siwc 首次登录动态注册；codex 用公开客户端 id（AMA_CHATGPT_CLIENT_ID 覆盖）",
  "auth.chatgpt.redirectPorts": "siwc 1455 → 任意空闲端口；codex 1455 → 1457",
} satisfies Messages<typeof dynamicDefaultsEn>;

/** 键路径 → 说明（段落本身也有一条）。 */
const keysEn = {
  $schema: "Path to the JSON Schema used by editors",
  version: "Config file format version; always 1",
  defaultModel:
    "Default model provider/model or provider/model@channel; when unset it is picked automatically (ama config show shows which one and why)",
  thinkingLevel: "Thinking level",
  providers: "Custom providers and overrides of built-in providers (docs/providers.md)",
  permission: "Permissions (docs/permissions.md)",
  "permission.mode": "Permission mode; project level can only make it stricter",
  "permission.allow": "Allow rules, e.g. bash(npm test); cannot be added at project level",
  "permission.deny": "Deny rules, e.g. write(**/.env); accumulated across levels",
  "permission.builtinDeny":
    "Built-in deny list (writes to .git/**, reads and writes to .ssh/**): true enables all, false removes all, an array lists the rule texts to remove; user level only",
  "permission.autoModel":
    "Model provider/model for the auto-mode classifier; the current session model when unset; user level only",
  "permission.autoSafeCommands":
    "Extra entries for the auto-mode safe list (word prefixes or globs with *); user level only",
  compaction: "Automatic compaction",
  "compaction.enabled": "Compact automatically when the context nears its limit",
  "compaction.reserveTokens": "Tokens reserved for the reply; compaction starts when less is left",
  "compaction.keepRecentTokens": "Tokens of recent messages kept verbatim when compacting",
  "compaction.contextBudget":
    "Soft context window (tokens, at least 32768): pruning, compaction and context-pressure notices use min(model window, this value); lower it to keep long sessions cheaper on large-window models",
  "compaction.prune":
    "Tier-one pruning (old tool results replaced with placeholders); user level only (effective from wave 5 W5-H1)",
  "compaction.prune.keepResults": "Keep the most recent N tool results unpruned",
  "compaction.prune.clearAtLeast":
    "Prune only when at least this many tokens are saved (avoids breaking the cache too often); auto = max(20000, 0.1 × context budget)",
  "compaction.pruneExclude":
    "Tool names never pruned by tier one; user level only (effective from wave 5 W5-H1)",
  retry: "Retrying failed requests",
  "retry.enabled":
    "Retry retryable errors (rate limits, server errors, dropped connections…) automatically",
  "retry.maxRetries": "Maximum number of retries",
  "retry.baseDelayMs":
    "Wait before the first retry (ms, exponential backoff; Retry-After wins when present)",
  "retry.maxDelayMs": "Upper bound for a single wait (ms)",
  tools: "Built-in tools",
  "tools.preset":
    "Tool preset: default (six tools; codemode added when the network is isolated; todo needs +todo in tools.default), minimal, codemode-only, coordinator; codemode is the old name of codemode-only; project level can only make it stricter",
  "tools.default":
    "Tweak the preset: +name adds, -name removes, bare names replace the preset's built-in tools as a whole; user level only",
  "tools.maxToolResultChars":
    "Character limit for one tool result in the context; beyond it head and tail are kept",
  "tools.bashTimeoutMs": "Default bash timeout (ms; overridable per call, max 600000)",
  "tools.disabled": "Disabled tool names; accumulated across levels",
  codemode: "codemode: the model writes scripts that call tools in batches (docs/codemode.md)",
  "codemode.mode":
    "off | on | only; when unset it follows the preset: default → on (Node ≥ 25; Node 22 / 24 → off), codemode-only → only, minimal / coordinator → off; project level only accepts off",
  "codemode.inlineBudget":
    "Budget (estimated tokens) for inlining tool declarations in the description in only mode; beyond it only names are listed",
  "codemode.requireStrict":
    "true: disable codemode when the runtime Node does not isolate the network (Node 22 / 24)",
  "codemode.maxHeapMb":
    "V8 heap limit (MB) for the script child process; a script that exceeds it ends with an error; 0 sets no limit",
  hooks: "Hook settings (the hooks themselves live in hooks.json)",
  "hooks.timeoutMs": "Default timeout for a single hook command (ms)",
  ui: "Terminal interface",
  "ui.theme":
    "Color theme: dark, light, or auto (guessed from COLORFGBG without querying the terminal; dark when unsure)",
  "ui.markdown": "Render replies as Markdown",
  "ui.showThinking": "How thinking content is shown",
  "ui.tuiMode": "Terminal interface layout (only regular for now)",
  "ui.quietStartup": "How much the startup screen shows",
  "ui.ascii":
    "ASCII glyphs (> * L, + - |); when unset it is detected: on when the locale lacks UTF-8, TERM=linux or a legacy conhost; AMA_ASCII=1/0 overrides",
  "ui.compact": "No blank lines between message blocks and no AMA logo in the startup header",
  "ui.logo":
    "AMA logo in the startup header: auto draws it when the terminal is at least 48 columns wide, off shows only the info lines",
  "ui.animation":
    "false: the spinner stays still while running and redraws only when seconds change; the startup logo does not animate",
  "ui.restoreOnCancel":
    "When Esc interrupts a run before any reply or tool call in this turn, withdraw the turn and put the message back into the input box",
  "ui.enterWhileRunning":
    "Enter while a run is in progress: queue (default) queues the message as a steer delivered at the next delivery point; interrupt stops the current turn and sends it at once. The app.message.interrupt key (default Ctrl+X) does the other one",
  "ui.programStatus":
    "Report run state to the terminal with OSC 7501 (idle / working / blocked / done / error): auto (default) sends only after the terminal answers the detection query (off inside tmux), on sends without detecting (inside tmux wrapped in passthrough; needs allow-passthrough on), off never sends. Interactive TUI only",
  "ui.statusLine":
    "Bottom info line: full shows two lines (rate line + status line), compact one; toggle at runtime with Ctrl+G or /statusline (effective from wave 5 W5-A)",
  "ui.language":
    "Interface language: auto decides from LC_ALL / LC_MESSAGES / LANG (zh* is Chinese, anything else English), zh, en; AMA_LANG and --lang override; affects the interface only, text sent to the model is always English",
  "ui.replyLanguage":
    "Reply language for the model (e.g. Chinese): one English rule is appended to the end of the rules section at session start; zero-byte change when unset; user level only (effective from wave 6)",
  "ui.agentBar":
    "Agent bar (sub-agent list above the status line): auto shows it while tasks exist, off hides it; press ↓ on an empty input to enter it",
  memory:
    "Cross-session memory (docs/memory.md): off by default, requests are byte-identical while off; project level can only set enabled: false (effective from wave 6 W6-M)",
  "memory.enabled": "Master switch; --memory / --no-memory and AMA_MEMORY=0|1 override",
  "memory.scopes":
    "Enabled scopes: user (data directory, across projects), project (keyed by a hash of the repository path)",
  "memory.indexMaxBytes":
    "Per-scope limit for the index in the system prompt (bytes); truncated by update time beyond it",
  "memory.fileMaxBytes": "Limit for one memory entry (bytes); writes beyond it are refused",
  "memory.maxFiles": "Maximum entries per scope",
  "memory.subagents":
    "Sub-agents: read is read-only (write commands refused), off refuses even view",
  auth: "Subscription login settings (no secrets; credentials live in auth.json); user level / profile only (effective from wave 6 W6-O)",
  "auth.chatgpt": "ChatGPT login (ama auth login chatgpt)",
  "auth.chatgpt.flavor":
    "siwc: official OpenAI Sign in with ChatGPT (default); codex: borrows the public Codex client (unofficial, must be enabled explicitly)",
  "auth.chatgpt.clientId": "OAuth client id",
  "auth.chatgpt.issuer": "Authorization server (override with AMA_CHATGPT_ISSUER for tests)",
  "auth.chatgpt.originator": "originator request header for the codex flavor",
  "auth.chatgpt.codexClientVersion":
    "Codex CLI version sent as client_version when listing codex-flavor models (the backend hides models newer than it); AMA_CHATGPT_CODEX_CLIENT_VERSION overrides",
  "auth.chatgpt.redirectPorts": "Local callback ports, tried in order; 0 = any free port",
  skills: "Skills",
  "skills.dirs": "Extra skill directories; accumulated across levels",
  cache: "Prompt caching; the whole section is user level only",
  request: "Model requests; the whole section is user level / profile only",
  "request.idleTimeoutMs":
    "Response idle timeout (ms): waiting longer than this for the response headers counts as stuck and is retried as a retryable error (gaps inside the stream use request.streamIdleTimeoutMs); 0 disables; AMA_IDLE_TIMEOUT_MS overrides",
  "request.streamIdleTimeoutMs":
    "Idle limit between two chunks once the stream has started (ms); longer than the header wait because reasoning endpoints can stay silent while thinking; 0 disables; AMA_STREAM_IDLE_TIMEOUT_MS overrides",
  "cache.warming":
    "Warming: off disables, streaming warms while generating, idle also warms while idle",
  "cache.retention": "Cache retention tier: none, short, long (when the provider supports it)",
  "cache.minSavingsUsd": "Minimum expected savings (USD) for warming",
  "cache.missNotices": "Show cache misses and remaining context in the message area",
  "cache.warmSubagents": "Also warm sub-sessions (task)",
  checkpoints:
    'Checkpoints: file backups used to roll back code (docs/sessions.md "Checkpoints and file backups")',
  "checkpoints.mode":
    "tools: track files changed by edit / write; shadow-git: also snapshot the whole working directory with a shadow git so direct changes (bash etc.) can be rolled back too (needs git; large directories fall back to tools); off: disabled; AMA_CHECKPOINTS overrides; project level only accepts off",
  "checkpoints.maxFileBytes":
    "Backup limit for a single file (bytes); larger files are not backed up and rollback reports them as unrecoverable; project level can only lower it",
  "checkpoints.keep":
    "Number of recent checkpoints available for rollback; older ones are no longer listed; user level / profile only",
  sandbox:
    'OS-level sandbox (docs/sandbox.md); user level / profile only, project level only accepts network: "deny"',
  "sandbox.enabled":
    "auto: use macOS sandbox-exec / Linux bwrap or unshare when available (codemode child processes are denied network and writes; this isolates codemode's network on Node 22 / 24); off: not used; AMA_SANDBOX=off overrides",
  "sandbox.bash":
    "auto: run bash through sandbox-exec / bwrap (unshare does not count), writes limited to the workspace, temp dir, output dir and sandbox.writable, and sandboxed commands need no approval in default mode; off: not used; user level / profile only",
  "sandbox.network":
    "Network inside the bash sandbox: deny blocks it (required for approval-free sandboxed commands); allow permits network but writes stay limited and approval works as usual; project level can only set deny",
  "sandbox.writable":
    "Extra writable directories for the bash sandbox (absolute paths or ~/…); user level / profile only",
  images: "Image input; user level only (effective from wave 5 W5-I)",
  "images.resize":
    "auto: resize images above the endpoint limit with system tools (sips / magick), refusing as before when none is found; off: never resize",
  plan: "Plan mode (effective from wave 5 W5-F)",
  "plan.bash":
    "bash in plan mode: readonly allows read-only commands and refuses the rest, ask asks for the rest, deny refuses everything; project level can only make it stricter",
  "plan.directory":
    "Directory for plan files (must be inside the project root, otherwise the default is used); user level only",
  "plan.unattended":
    "When unattended (-p, or RPC without the plans capability): stop writes the plan and waits for approval, approve approves and executes automatically; user level only",
  "plan.model":
    "Planning model provider/model[@channel]: switched to on entering plan, switched back on approval; user level only",
  "plan.thinkingLevel": "Thinking level while planning; user level only",
  agents:
    "External agents (claude / codex / ACP) and sub-agent types; agents.<id> sets maxConcurrent / maxMode / model / env.passthrough for a single agent; user level only (effective from wave 5 W5-E / W5-G)",
  "agents.maxConcurrent": "Total concurrency of external agents",
  "agents.sessionBudgetUsd": "USD budget for external agents in this session",
  "agents.dirs": "Extra sub-agent definition directories (*.md); accumulated across levels",
  subagents:
    "ama's own task sub-sessions; user level only except background / autoBackgroundAfterMs (effective from wave 5 W5-G)",
  "subagents.maxConcurrent": "Sub-sessions running at the same time",
  "subagents.maxPending": "Queue limit; task fails beyond it",
  "subagents.retainSessions":
    "Finished sub-sessions kept in memory (least recently used first out); others reopen from their session file when continued",
  "subagents.defaultModel": "Default sub-session model provider/model[@channel]",
  "subagents.background":
    "Whether task runs in the background by default: auto = background in the TUI / RPC / ACP and foreground with -p; always / never are fixed. The call argument and the agent type's background: override it; user, project and host level",
  "subagents.autoBackgroundAfterMs":
    "Move a foreground task to the background after it has run this many milliseconds; 0 disables; user and project level",
  models: "Model aliases and the model picker list; user level only (effective from wave 5 W5-G)",
  "models.aliases": "Models that model: fast / strong in sub-agent definitions point to",
  "models.aliases.fast": "Model for the fast alias provider/model[@channel]",
  "models.aliases.strong": "Model for the strong alias provider/model[@channel]",
  "models.enabled":
    "Models shown by /model (provider/model[@channel], provider/* for a whole provider); unset: every model of providers with a key, a sign-in or a local server",
  fallbackModel:
    "Fallback model provider/model[@channel]: switch and retry once when retryable errors are exhausted or the model is overloaded; the next turn returns to the main model; user level only (effective from wave 5 W5-H2)",
  limits:
    "Session budget; the run ends when reached (-p exit code 8); --max-turns / --max-cost override; user level only (effective from wave 5 W5-H2)",
  "limits.maxTurns": "Maximum turns per run",
  "limits.maxCostUsd": "USD limit per run",
  reminders:
    "Reminders attached to the end of the conversation (cache prefix untouched); settable at project level (effective from wave 5 W5-H2)",
  "reminders.todo":
    "Restate todo when it has open items and has not been updated for several turns",
  "reminders.fileChanges": "List files that were read and then changed externally",
  "reminders.contextPressure": "Remind once each at 70% / 85% context usage",
  "reminders.budget": "Remind when less than 20% of the budget is left",
  todo: "todo tool; user level only (effective from wave 5 W5-F / W5-H2)",
  "todo.reminder":
    "Remind to restate after N consecutive turns without an update while items are open; 0 disables",
};

const keysZh = {
  $schema: "编辑器用的 JSON Schema 路径",
  version: "配置文件格式版本，固定为 1",
  defaultModel:
    "缺省模型 provider/model 或 provider/model@channel；不写时零配置自动选择（ama config show 显示选了谁、为什么）",
  thinkingLevel: "思考强度",
  providers: "自定义供应商与对内置供应商的覆盖（docs/providers.md）",
  permission: "权限（docs/permissions.md）",
  "permission.mode": "权限模式；项目级只能更严",
  "permission.allow": "放行规则，如 bash(npm test)；项目级不能加",
  "permission.deny": "拒绝规则，如 write(**/.env)；各层累加",
  "permission.builtinDeny":
    "内置 deny 表（.git/** 写、.ssh/** 读写）：true 全部启用，false 全部移除，数组 = 要移除的规则原文；只认用户级",
  "permission.autoModel": "auto 模式分类器的模型 provider/model；不写时用当前会话模型；只认用户级",
  "permission.autoSafeCommands": "auto 模式安全名单追加（词前缀或含 * 的通配）；只认用户级",
  compaction: "自动压缩",
  "compaction.enabled": "上下文接近上限时自动压缩",
  "compaction.reserveTokens": "为回复预留的 token；剩余不足时触发压缩",
  "compaction.keepRecentTokens": "压缩时原样保留的最近消息 token",
  "compaction.contextBudget":
    "软窗口（token，至少 32768）：裁剪、压缩与上下文余量提示按 min(模型窗口, 它) 计算；大窗口模型调低它可让长会话更省钱",
  "compaction.prune": "档一裁剪（旧工具结果换成占位）；只认用户级（第五波 W5-H1 起生效）",
  "compaction.prune.keepResults": "保留最近 N 个工具结果不裁",
  "compaction.prune.clearAtLeast":
    "一次至少能省这么多 token 才裁（避免频繁打断缓存）；auto = max(20000, 0.1 × 上下文预算)",
  "compaction.pruneExclude": "不被档一裁剪的工具名；只认用户级（第五波 W5-H1 起生效）",
  retry: "请求失败重试",
  "retry.enabled": "可重试的错误（限流、服务端错误、连接中断等）自动重试",
  "retry.maxRetries": "最多重试次数",
  "retry.baseDelayMs": "首次重试等待（毫秒，指数退避；有 Retry-After 时按它）",
  "retry.maxDelayMs": "单次等待上限（毫秒）",
  tools: "内置工具",
  "tools.preset":
    "工具预设：default（六个工具；网络隔离时另加 codemode，todo 需在 tools.default 加 +todo）、minimal、codemode-only、coordinator；codemode 是 codemode-only 的旧名；项目级只能更严",
  "tools.default":
    "在预设上微调：+name 加、-name 去，不带前缀的名字整组替换预设的内置工具；只认用户级",
  "tools.maxToolResultChars": "单条工具结果进上下文的字符上限，超出保留首尾",
  "tools.bashTimeoutMs": "bash 缺省超时（毫秒，单次调用可覆盖，最大 600000）",
  "tools.disabled": "禁用的工具名；各层累加",
  codemode: "codemode：模型写脚本批量调用工具（docs/codemode.md）",
  "codemode.mode":
    "off | on | only；不写时跟随预设：default → on（Node ≥ 25；Node 22 / 24 → off）、codemode-only → only、minimal / coordinator → off；项目级只接受 off",
  "codemode.inlineBudget": "only 模式在描述里内联工具声明的预算（估算 token），超出只列名字",
  "codemode.requireStrict": "true：运行时 Node 不隔离网络（Node 22 / 24）时直接禁用 codemode",
  "codemode.maxHeapMb": "脚本子进程的 V8 堆上限（MB），超出时脚本以错误结束；0 不设上限",
  hooks: "Hook 设置（Hook 本身写在 hooks.json）",
  "hooks.timeoutMs": "单个 Hook 命令的缺省超时（毫秒）",
  ui: "终端界面",
  "ui.theme": "配色主题：dark、light，或 auto（按 COLORFGBG 猜，不发终端查询，猜不出用 dark）",
  "ui.markdown": "按 Markdown 渲染回复",
  "ui.showThinking": "思考内容的显示方式",
  "ui.tuiMode": "终端界面形态（目前只有 regular）",
  "ui.quietStartup": "启动画面详略",
  "ui.ascii":
    "ASCII 字形（> * L、+ - |）；不写时自动检测：区域设置不含 UTF-8、TERM=linux、旧 conhost 时开启；AMA_ASCII=1/0 覆盖",
  "ui.compact": "消息区块间不空行、启动头不画 AMA 字符画",
  "ui.logo": "启动头的 AMA 字符画：auto 在终端宽 48 列以上时画，off 只显示信息行",
  "ui.animation": "false：运行中 spinner 静止，只在秒数变化时重绘；启动字符画不播放动画",
  "ui.restoreOnCancel":
    "运行中 Esc 中断、本回合还没有任何回复或工具调用时，撤回该回合并把原消息放回输入框",
  "ui.enterWhileRunning":
    "运行中按 Enter：queue（缺省）排队插话，等下一个投递点送达；interrupt 打断当前回合并立即发送。app.message.interrupt 键（缺省 Ctrl+X）做另一种",
  "ui.programStatus":
    "用 OSC 7501 把运行状态报告给终端（idle / working / blocked / done / error）：auto（缺省）终端回应检测查询后才发（tmux 里不发），on 不检测直接发（tmux 里经 passthrough 包裹，需要 allow-passthrough on），off 不发。只用于交互界面",
  "ui.statusLine":
    "底部信息行：full 两行（速率行 + 状态行），compact 一行；运行时 Ctrl+G 或 /statusline 切换（第五波 W5-A 起生效）",
  "ui.language":
    "界面语言：auto 按 LC_ALL / LC_MESSAGES / LANG 判断（zh* 为中文，其余英文），zh，en；AMA_LANG、--lang 覆盖；只影响界面，发给模型的文本固定英文",
  "ui.replyLanguage":
    "模型回复语言（如 Chinese）：会话开始在 rules 节末尾追加一句英文规则；不设时零字节变化；只认用户级（第六波起生效）",
  "ui.agentBar":
    "Agent 栏（状态行上方的子 Agent 列表）：auto 有任务时显示，off 不显示；空输入时按 ↓ 进入",
  memory:
    "跨会话记忆（docs/memory.md）：缺省关闭，关闭时请求逐字节不变；项目级只能设 enabled: false（第六波 W6-M 起生效）",
  "memory.enabled": "总开关；--memory / --no-memory、AMA_MEMORY=0|1 覆盖",
  "memory.scopes": "启用的作用域：user（数据目录，跨项目）、project（按仓库路径哈希）",
  "memory.indexMaxBytes": "每作用域索引进系统提示的上限（字节），超出按更新时间截断",
  "memory.fileMaxBytes": "单条记忆上限（字节），超出拒写",
  "memory.maxFiles": "每作用域条目上限",
  "memory.subagents": "子 Agent：read 只读（写命令拒绝），off 连 view 也拒绝",
  auth: "订阅登录设置（不含密钥，凭据在 auth.json）；只认用户级 / profile（第六波 W6-O 起生效）",
  "auth.chatgpt": "ChatGPT 登录（ama auth login chatgpt）",
  "auth.chatgpt.flavor":
    "siwc：OpenAI 官方 Sign in with ChatGPT（缺省）；codex：借用 Codex 公开客户端（非官方、需显式开启）",
  "auth.chatgpt.clientId": "OAuth 客户端 id",
  "auth.chatgpt.issuer": "授权服务器（测试用 AMA_CHATGPT_ISSUER 覆盖）",
  "auth.chatgpt.originator": "codex flavor 的 originator 请求头",
  "auth.chatgpt.codexClientVersion":
    "codex flavor 列模型时作为 client_version 发送的 Codex CLI 版本号（后端不给比它新的模型）；AMA_CHATGPT_CODEX_CLIENT_VERSION 优先",
  "auth.chatgpt.redirectPorts": "本地回调端口，依次尝试；0 = 任意空闲端口",
  skills: "Skill",
  "skills.dirs": "追加的 Skill 目录；各层累加",
  cache: "提示缓存；整段只认用户级",
  request: "模型请求；整段只认用户级 / profile",
  "request.idleTimeoutMs":
    "响应头等待超时（毫秒）：等响应头超过即判卡住并按可重试错误重试（流中两块数据之间由 request.streamIdleTimeoutMs 管）；0 关闭；AMA_IDLE_TIMEOUT_MS 覆盖",
  "request.streamIdleTimeoutMs":
    "流开始后两块数据之间的空闲上限（毫秒）；比等响应头宽，因为推理端点思考时可能长时间没有字节；0 关闭；AMA_STREAM_IDLE_TIMEOUT_MS 覆盖",
  "cache.warming": "保温：off 关闭，streaming 生成期间保温，idle 空闲时也保温",
  "cache.retention": "缓存时长档：none、short、long（供应商支持时）",
  "cache.minSavingsUsd": "保温的最低期望节省（美元）",
  "cache.missNotices": "在消息区提示缓存未命中与上下文余量",
  "cache.warmSubagents": "子会话（task）也保温",
  checkpoints: "检查点：回滚代码用的文件备份（docs/sessions.md「检查点与文件备份」）",
  "checkpoints.mode":
    "tools：跟踪 edit / write 改过的文件；shadow-git：另用影子 git 快照整个工作目录，bash 等直接改动也能回滚（需要 git，大目录自动降级为 tools）；off：关闭；AMA_CHECKPOINTS 覆盖；项目级只接受 off",
  "checkpoints.maxFileBytes":
    "单个文件的备份上限（字节），超出不备份、回滚时报告无法恢复；项目级只能调小",
  "checkpoints.keep": "可回滚的最近检查点数，更早的不再列为回滚点；只认用户级 / profile",
  sandbox: '操作系统级沙箱（docs/sandbox.md）；只认用户级 / profile，项目级只接受 network: "deny"',
  "sandbox.enabled":
    "auto：探测到可用的 macOS sandbox-exec / Linux bwrap、unshare 就用（codemode 子进程拒绝网络与写入；Node 22 / 24 上 codemode 因此网络隔离）；off：不用；AMA_SANDBOX=off 覆盖",
  "sandbox.bash":
    "auto：bash 经 sandbox-exec / bwrap 运行（unshare 不算），写入只限工作区、临时目录、输出目录与 sandbox.writable，default 模式下沙箱内命令免审批；off：不用；只认用户级 / profile",
  "sandbox.network":
    "bash 沙箱里的网络：deny 拒绝（沙箱内免审批的前提）；allow 允许联网但写入仍受限、照常审批；项目级只能设 deny",
  "sandbox.writable": "bash 沙箱追加的可写目录（绝对路径或 ~/…）；只认用户级 / profile",
  images: "图像输入；只认用户级（第五波 W5-I 起生效）",
  "images.resize":
    "auto：图片超过端点上限时用系统工具（sips / magick）缩放，找不到工具按原规则拒绝；off：从不缩放",
  plan: "Plan 模式（第五波 W5-F 起生效）",
  "plan.bash":
    "plan 模式下的 bash：readonly 只读命令放行其余拒绝，ask 其余询问，deny 全拒；项目级只能更严",
  "plan.directory": "计划文件目录（必须在项目根之内，否则回落缺省）；只认用户级",
  "plan.unattended":
    "无人值守（-p、RPC 未声明 plans 能力）时：stop 落盘计划后停下等人审批，approve 自动批准执行；只认用户级",
  "plan.model": "规划用模型 provider/model[@channel]：进入 plan 时切换、批准时切回；只认用户级",
  "plan.thinkingLevel": "规划时的思考强度；只认用户级",
  agents:
    "外部 Agent（claude / codex / ACP）与子 Agent 类型；agents.<id> 设单个 Agent 的 maxConcurrent / maxMode / model / env.passthrough；只认用户级（第五波 W5-E / W5-G 起生效）",
  "agents.maxConcurrent": "外部 Agent 的总并发",
  "agents.sessionBudgetUsd": "本会话外部 Agent 的美元预算",
  "agents.dirs": "追加的子 Agent 定义目录（*.md）；各层累加",
  subagents:
    "ama 自己的 task 子会话；除 background / autoBackgroundAfterMs 外只认用户级（第五波 W5-G 起生效）",
  "subagents.maxConcurrent": "同时运行的子会话数",
  "subagents.maxPending": "排队上限，超出时 task 报错",
  "subagents.retainSessions":
    "内存中保留的已结束子会话数（最久未用的先释放），其余续聊时从会话文件重开",
  "subagents.defaultModel": "子会话缺省模型 provider/model[@channel]",
  "subagents.background":
    "task 缺省是否后台：auto = TUI / RPC / ACP 下后台、-p 下前台；always / never 固定。调用参数与类型定义的 background: 优先；用户、项目、宿主级都认",
  "subagents.autoBackgroundAfterMs": "前台任务运行超过该毫秒数自动转后台；0 关闭；用户、项目级都认",
  models: "模型别名与模型选择器清单；只认用户级（第五波 W5-G 起生效）",
  "models.aliases": "子 Agent 定义里 model: fast / strong 指向的模型",
  "models.aliases.fast": "fast 别名的模型 provider/model[@channel]",
  "models.aliases.strong": "strong 别名的模型 provider/model[@channel]",
  "models.enabled":
    "/model 显示的模型（provider/model[@channel]，provider/* 表示整个供应商）；不设：已配置 key、已登录或本地可达的供应商的全部模型",
  fallbackModel:
    "回退模型 provider/model[@channel]：可重试错误用尽或过载时切换重试一次，下一回合回主模型；只认用户级（第五波 W5-H2 起生效）",
  limits:
    "会话预算，到限结束本次运行（-p 退出码 8）；--max-turns / --max-cost 覆盖；只认用户级（第五波 W5-H2 起生效）",
  "limits.maxTurns": "一次运行最多回合数",
  "limits.maxCostUsd": "一次运行的美元上限",
  reminders: "附在对话尾部的提醒（不改缓存前缀）；项目级可设（第五波 W5-H2 起生效）",
  "reminders.todo": "todo 有未完成项且多回合未更新时复述",
  "reminders.fileChanges": "读过的文件被外部改动时列出",
  "reminders.contextPressure": "上下文用量到 70% / 85% 时各提醒一次",
  "reminders.budget": "预算剩余不足 20% 时提醒",
  todo: "todo 工具；只认用户级（第五波 W5-F / W5-H2 起生效）",
  "todo.reminder": "连续 N 回合未更新且有未完成项时提醒复述；0 关闭",
} satisfies Messages<typeof keysEn>;

export const en = { keys: keysEn, dynamicDefaults: dynamicDefaultsEn };

export const zh = {
  keys: keysZh,
  dynamicDefaults: dynamicDefaultsZh,
} satisfies Messages<typeof en>;
