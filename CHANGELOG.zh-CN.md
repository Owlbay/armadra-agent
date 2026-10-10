# 更新记录

[English](CHANGELOG.md) · 简体中文

> 从 0.6.0 起 [CHANGELOG.md](CHANGELOG.md) 为英文，本文件保留中文记录（0.1–0.5.1 的完整历史在此）。新条目两份都要加。

## 0.7.5（2026-10-10）

### 内存占用

- **`read` 读大文件不再阻塞事件循环**：超过 1 MiB 的文本走的字节窗口改为异步按 64 KiB 分块读，每块一次 `await`，扫描 256 MB 文件期间 TUI / RPC / ACP 仍能响应（事件循环最长停顿约 170–320 ms → 20 ms 以内）。输出逐字节不变（同步与异步共用同一个行解析器），峰值内存不变（仍只有一块缓冲）。
- **带图请求体不再复制每张图**：图片数据从转录直接写入请求体，不再每个请求先拼出一份新的 data URL 字符串；转义检查每张图只做一次；请求体按每块最多 256 Ki 码元编码，不再一次编码一整张图。mock 300 步带 15 张图：峰值 RSS 约 630–690 → 390–400 MB，heapUsed 峰值约 270 → 85 MB。请求字节不变；SDK 的 `onPayload` 回调里大图变为带 `toJSON` 的对象（`JSON.stringify` 结果相同）。
- **降级后释放旧图**：活动分支上的消息被 `context_edit`（如 `image_budget`）改写后，图片 base64 不再常驻内存，只记该行在会话文件中的位置，需要时按位置读回：`get_entries` 与 fork 返回原文，换叶子回到编辑之前（`/tree`、rewind）时恢复图片。续会话读文件时随读随剥，这些旧图不再计入峰值（55 MB、含 10 张被降级的 3 MB 图的会话：峰值 RSS 约 254 → 210 MB）。JSONL 格式不变；`entries()` / `branch()` / SDK `session.entries` 里这类图片块的 `data` 为空串。
- **ACP 关掉的启动会话也能回收**：`Runtime.session` 与 `Runtime.sessionManager` 改为跟随当前会话（原先固定指向启动时建的会话），`session/close` 之后它的转录与图片和其它会话一样被回收（8 会话 × 4 轮全部关闭后 external 16.3 → 7.0 MB）。SDK 代码在切换会话后读 `runtime.session` 得到的是新会话。
- **ACP `session/prompt` 的 usage 只算本回合**：等过后台子 Agent 通知回合的提示，`usage` 不再计入那一回合的 token。
- **通知回合在跑时 `session/close`**：原先以 -32603 失败且会话留在内存；现在先停在跑的后台子 Agent、中断在跑的回合（含通知回合）、已排着的通知不再开回合，然后释放会话，之后不再有 `session/update`。stdin 关闭时同样这样收尾。

## 0.7.4（2026-10-10）

- **并行 worktree 隔离**：两个隔离任务同时开始时，可能报 `无法读取 .git/worktrees/<id>/commondir`——`git worktree add` 读到了另一个任务建了一半的管理目录。现在同一仓库的 worktree 增删与删分支按顺序执行，另一个 ama 进程造成的同类瞬时错误短暂重试。

### 模型调用效率

少按全价重读提示前缀、少一些失败请求（docs/model-efficiency-plan.md；实测见 docs/benchmarks/efficiency-2026-10.md）。按子 Agent、提示前缀与压缩、请求层、目录与工具的顺序排列。

- **fork 式子 Agent**（`task.context: "fork"`，或类型定义里写 `context: fork`；缺省仍是 `fresh`）：子会话继承父会话到这次 `task` 调用之前的对话，系统提示与工具表与父相同，首个请求直接复用父的缓存前缀（中转实测：Kimi 命中 97.5%，DeepSeek 与父自己的下一回合相同）。类型限制的工具改为在执行层拒绝，不再改工具表。指定了不同的模型或思考级别、父还没发过请求、或父上下文超过可用窗口一半时回落为 `fresh`（记日志，`details.context` 与 `TaskInfo.context` 标实际模式）。轮数用尽的收尾一轮不再发 `toolChoice: "none"`（它会断开缓存前缀），只靠报告提示要求不调用工具。
- **提示开头在会话内只写一次**：压缩不再把会话中途的 system 补丁折回开头——检查点只重放对话开始前发过的内容，之后的补丁以 `<system-reminder>` 跟在摘要后面，压缩后首个请求的 system + tools 与压缩前逐字节相同。会话中途移除工具时工具表保留其声明、尾部提醒「已不可用」，调用一律以 `Tool "X" is not available in this session.` 拒绝（未知工具也改用这句，原为 `Tool X not found`）；再加回只提醒「又可用」。提醒的收尾句同时说明工具可用性。
- **压缩改为续写摘要而不是先裁剪**：裁掉工具结果后仍超预算、且缓存未冷时，不再裁剪，直接续写上一次请求的缓存前缀生成摘要（裁剪会断开这段前缀、变成一次全价的独立摘要请求）；缓存已冷时照旧先裁，也不再尝试续写。开着思考时，续写的输出上限 = 摘要上限 + 思考预算。
- **软窗口与按节指纹**：`compaction.contextBudget` 生效——档一裁剪、档二摘要、熔断与 `context_pressure` 都按 min(模型窗口, 它) 计算。`cache_miss.detail` 写出变化的 system 节（`system:hooks,memory`），`/cache fingerprint` 逐节列出哈希。`openai-responses` 上的保温请求 `maxTokens` 用协议下限 16 而不是 1。
- **Anthropic 第 4 个缓存断点**：除最后一条 user、system 末与最后一个工具外，倒数第二条 user（上一次请求的写入点）也打断点，一个回合里并行工具结果很多、超出回看窗口时不再整段重写。`maxCacheBreakpoints` 不足 4 时先舍去最后一个工具。
- **重试遵守 Retry-After，限流单独计**：退避取 `max(指数退避, Retry-After)`、上限 `retry.maxDelayMs`，再加 ±20% 抖动；429 / 529 / rate limit 比 `retry.maxRetries` 多重试 2 次（`auto_retry_start.maxAttempts` 随之）。5xx 只认文案开头的状态码或 `status` / `HTTP` 之后的，错误文案里的「500 tokens」不再当作服务端错误。配了 `fallbackModel` 时，overloaded 先快速重试一次（1 s）再切模型。
- **max_tokens 不再让首个请求失败**：上下文窗口已知时把 `max_tokens` 收紧到窗口剩余量以内（Anthropic 预算型思考除外）；端点以 400 说出上限（`Range of max_tokens should be [1, N]` 等）时以该上限重发一次，同一进程里之后的请求直接用它。Anthropic 的 `input length and max_tokens exceed context limit` 按剩余量重发，不足 1024 token 时按上下文溢出处理。
- **工具调用参数逐字节回放**：Completions 与 Responses 请求把模型输出的参数串原样发回，不再重新序列化，空格差异不再打断前缀缓存；旧会话回落为序列化。
- **流中空闲超时单独设置**：`request.idleTimeoutMs`（300 s）现在只管等响应头；流开始后两块数据之间改由新的 `request.streamIdleTimeoutMs`（缺省 180 s，`AMA_STREAM_IDLE_TIMEOUT_MS`，0 关闭）管。之前 `idleTimeoutMs` 两段都管，如果你为慢端点调大或关掉了它，请同时设置 `streamIdleTimeoutMs`。
- **中转模型继承官方目录**：中转 / 自定义模型的 id 唯一命中内置目录条目时（小写、去一层厂商前缀与 `:latest`，也认目录的 `aliases`），继承 `reasoning`、`input`、`thinkingLevelMap`、`promptCache.minTokens` 与 `compat.requiresReasoningContentOnAssistantMessages`，models.dev 改为匹配该条目的快照；不继承价格、TTL 与 `thinkingFormat`。带思考档后缀的 id（`gemini-3.8-flash-low`）去掉后缀再匹配，继承图片与窗口、不打开思考——中转上的 Gemini Flash 不再因「不支持图片」被拒。`models[].catalog: false` 关闭，`"provider/id"` 显式指定；`ama models list` 标「目录（按 id 匹配）」并列出条目。`deepseek-v4-flash` 是 `deepseek-flash` 的别名。
- **工具结果一次截到位**：`read`、`grep`、`bash` 按会话的 `tools.maxToolResultChars`（不超过 50 KB）自己截断，说明里写实际上限与续读位置，不再被会话层二次截中段；描述不再写死大小（前缀更短）。`glob` 缺省最多返回 200 个文件（原 1000）。
- **auto 模式用小模型分类**：没配 `permission.autoModel` 时，分类器用会话供应商目录里的小模型（目录的 `small`：deepseek-flash、claude-haiku-4-5、gpt-6-luna、gemini-3.5-flash-lite、kimi-k2.6 等），找得到且有 key 才用，否则用会话模型。
- **兼容性**：以上只加可选字段——工具调用块的 `rawArguments`、失败助手消息的 `retryAfterMs`（会话文件与 RPC），`ama.task` 的 data 与 `TaskInfo` 的 `context`，`cache_miss.detail` 的 `system:<节名>` 取值，内置模型目录的 `aliases` / `small`，以及配置键 `compaction.contextBudget`、`request.streamIdleTimeoutMs`、`models[].catalog`。会话格式与 RPC / ACP 协议版本不变。

### 内存占用

大输入与长会话的峰值降下来，ACP 关掉的会话能释放（docs/memory-plan.md；测量报告见 docs/research/memory-2026-10.md，前后实测见 docs/benchmarks/memory-2026-10.md）。按大文件与会话、请求与图片、协议模式、分发与上限分组。会话文件、请求字节与工具输出都不变。

- **`read` 读大文件不再整文件进内存**：超过 1 MiB 的文本按 64 KiB 块扫描，只解码要显示的行；读 256 MB 文件的 100 行峰值约 103 MB（原来 775 MB）。输出（行号、总行数、截断说明）与之前逐字节相同。
- **会话列表与恢复不再整读文件**：会话文件按块逐行读取。`ama sessions list`（恢复选择器与 ACP `session/list` 走同一条路径）只解析每个文件的头、首条条目、改名与首条提示——4 个 55 MB 会话：约 540 → 88 MB；`--resume` 逐行解析，不再生成整份字符串与 split 数组——55 MB 会话：约 300 → 218 MB。列表各字段不变。
- **带图请求体不再拼成一整个大字符串**：请求里有 64 KiB 以上的字符串（图片 base64）时按片段组装，以准确的 `content-length` 流式发出（不用 chunked）；小请求与以前完全一样。线上字节不变（逐字节比对 `JSON.stringify` 的测试守护），提示缓存不受影响。本地 300 步、读图 15 次的场景峰值从约 1.03 GB 降到约 0.7 GB。
- **图片按内容去重**：`read` 反复读同一张图、`--image` / `@路径` 附图后又读同一张、恢复的会话里重复出现的图片，内存里只留一份 base64。连同上一条，真实模型的 TUI 会话（3 张 2.4 MB 图）峰值从 276 MB 降到 218 MB。
- **ACP：关闭的会话可被回收**：关掉的会话连同转录与图片一直留在内存里——每次 `session/prompt` 的取消监听没有摘掉，新开的兄弟会话会引用开它时的前台会话，进程级的缓存上报表还整条保留每个端点的上一条请求。三处都已修正；8 个会话 × 4 轮全部关闭后，堆与堆外内存各回到约 16 MB。进程启动时建的那个会话（被第一个 `session/new` 认领）仍由进程持有到退出。
- **ACP：后台子 Agent 通知回合进行中的 `session/prompt`**（#139）：通知回合不经 ACP 的提示队列，此时发提示会报「a run is in progress」（-32603）。现在等通知回合结束再开始；等待中 `session/cancel` 回 `cancelled`，这条提示之后也不会再发出。
- **RPC `compact_events`**：客户端用 `set_client_capabilities` 声明后，`turn_end`、`message_start`、`entry_appended` 不再重复携带工具结果（以及带图用户消息）的正文，改标 `contentOmitted: true`，正文仍在 `message_end` 与 `tool_execution_end` 里。fake 100 步的 stdout 由 91.6 MB 降到 37.0 MB。`hello.capabilities` 列出这一项；不声明时与 `stream-json` 的事件不变。
- **全局 `ama` 命令走单文件 bundle**：`bin.ama` 从 ESM 入口改为 `dist/bundle/ama.cjs`，npm 安装后的 `ama --version` 启动从约 0.18 s 降到约 0.10 s，峰值 RSS 少约 25 MB；库导入（`@armadra/agent`、`/host`、`/rpc`、`/tui`、`/acp`）不变。`pnpm link` 之后先 `pnpm build` 生成 bundle。
- **子 Agent 会话少保留**：为 `taskId` 续聊留在内存里的已结束子会话从 16 个降到 4 个（最久未用的先释放；JSONL 一直在，被释放的任务续聊时从它重开）。用 `subagents.retainSessions` 调整（只认用户级，0 = 结束即释放）。
- **codemode 堆上限**：脚本子进程以 `--max-old-space-size=256` 启动，超出时以脚本错误 `Script exceeded the codemode memory limit (256 MB)` 结束，不再一路涨到超时。用 `codemode.maxHeapMb` 调整（只认用户级，0 不设上限）。

## 0.7.3（2026-10-09）

- **首次请求前的 `/context`**：状态栏已显示启动基线时，它仍是 `0 / <窗口>`、不计系统提示与工具声明；现在按首次请求将要发送的内容估算这两类（与状态栏基线共用同一份装配），「已用」始终与状态栏和 `getStats()` 一致。

## 0.7.2（2026-10-09）

- **会话中途上下文变化不再打断提示缓存**：resume 时 AGENTS.md、Skills 或 SessionStart Hook 输出变了、宿主 instructions 刷新、压缩后记忆节
  重新渲染，在不支持对话中途 system 消息的端点上原先会把变化的节并回开头的 system，整段上下文从第 0 个 token 起按全价重读。现在改为在
  尾部追加一条 `<system-reminder>` 包裹的 user 消息，上一次请求仍是逐字节前缀；只有移除工具的补丁仍改写开头。DeepSeek 接受对话中途的
  system 消息，但实测模型仍按开头那条回答，所以不为它打开（docs/benchmarks/cache-midconvo-2026-10-09.md）。
- **不按猜测的缓存寿命提前裁剪**：目录没有承诺 TTL 时，档一裁剪不再按隐式 10 分钟判冷（隐式缓存可能存活数小时）；10 分钟只用于未命中归因。
- **DeepSeek 目录补缓存信息**：`promptCache: { short: 3600, minTokens: 2048 }`（官方说未使用的缓存「几小时到几天」后清除；缓存读实测按
  2048 token 一块计）。
- **`ama models cache-probe` 建议**：目录没有寿命时不再建议自填 `short: 300`，改为说明此时 ama 不保温、不提前裁剪，只有上游文档写明寿命时才填。
- **终端程序状态（OSC 7501）**：交互界面用 [程序状态协议](https://www.superlogical.com/rex/docs/build/program-status) 把
  idle / working / blocked（permission、question、auth）/ done / error 报告给终端，子 Agent 任务为子记录 `task/<id>`，退出时清掉记录。
  `ui.programStatus`：`auto`（缺省，终端回应检测查询后才发；tmux 里不发）、`on`（不检测；tmux 里经 passthrough）、`off`。检测回复不会
  进输入框。print / RPC / ACP 模式不发。
- **ACP 立即有上下文用量**：`ama --mode acp` 在 `session/new`、`session/load`（回放之后）、`session/resume` 答复之后、换模型时与每条助手
  消息结束时都发 `usage_update`（多工具回合中途也更新），不再只在回合结束时发；与上次同值不重发。窗口未知时仍不发（schema 里 `size` 必填）。
- **`-p --output-format json` 带上下文**：结果对象加 `context: { tokens, window, percent }`，未知项省略。
- **外部 Agent 的上下文**：外部 Agent 报告了上下文占用与窗口（ACP `usage_update`、Codex app-server `tokenUsage`）时，数字记进任务记录与
  `ama.agent-usage`，`getStats().external.byAgent` 取最近一次，`/tasks` 与 Agent 栏显示 `ctx 34%`。
- **`/context`**：新命令，把上下文按类别拆开——系统提示（按节）、工具声明（按工具）、用户消息、助手文本、推理、工具调用参数、
  工具结果（按工具名汇总）、附件图片、摘要、自定义消息——每类给 token 估算、占比与条形；顶部是已用 / 窗口、剩余、来源（「usage
  实测 X + 估算 Y」或「全量估算」）与自动压缩触发点，底部只按序号、工具名与大小列出最大的工具结果，不显示正文。交互模式是面板，
  line 模式是纯文本。统计只读，不改请求体与缓存前缀。
- **上下文一开始就有数**：第一次请求前，`contextTokens` 改为按即将发送的系统提示 + 工具声明估算的基线（只统计，不写会话、不改请求体），
  新会话不再显示 `Ctx 0.0%`。`SessionStats.context`（`getStats()`、RPC `get_session_stats`）标明数字来源（`usage` / `estimate` /
  `prefix`）并给出自动压缩阈值 `autoCompactAt` / `pruneAt`；字段缺省表示「不知道」（docs/sessions.md）。
- **状态栏**：`full` 显示 `Ctx 3.0% 8.2k/272k auto`（已用量 / 窗口，自动压缩开着时有 `auto`；窄屏先丢 `auto`，再丢 `/窗口`，最后丢已用量）；
  估算值前加 `≈`；黄色从档一裁剪阈值开始；`compact` 占用 < 1% 时保留一位小数。提交消息后立刻刷新 Ctx，流式中按回复带回的 usage 更新
  （每秒至多 2 次）。速率行用 `Σ↑ ↓` 标明是会话累计计费量，缓存读写另列 `R` / `W`。模型没有上下文窗口时提示一次怎么补。
- **`/session`**：用量行注明「累计」；上下文行加上距自动压缩的余量（或「自动压缩关闭」），估算值带 `≈`。
- **参与贡献**：仓库新增 issue 表单（缺陷报告、功能建议、供应商 / 模型兼容问题、文档问题）、PR 模板、`CONTRIBUTING.md`、
  `SECURITY.md`，以及写明硬约束与评审规则的 `AGENTS.md`；这些文件都不进 npm 包。
- **文档**：设计、计划与调研文档不再点名作为参照的第三方项目，改为不具名表述或代号；ama 实际驱动或兼容的外部 Agent、供应商与协议照常写名字。

## 0.7.1（2026-10-05）

- **Windows：并发刷新 OAuth**：一个 ama 进程刚释放 `auth.json.lock` 时，另一个进程打开它会报 EPERM（NTFS 上文件处于删除挂起），刷新
  直接失败；现在当作锁被占用继续等。别的进程正打开 `auth.json` 时的覆盖 / 读取遇到 EPERM / EACCES / EBUSY 短暂重试（只在 Windows）。
- **检查点（影子 git）**：3 秒的快照耗时上限不再算上第一次建影子仓库（十来个 `git` 子进程，Windows 上要好几秒），以前可能第一回合就把
  会话降级为 `tools`。

## 0.7.0（2026-10-04）

ACP 补全：`ama --mode acp` 作为编辑器（Zed 等 ACP 客户端）的 Agent，`AcpClient` / `AcpDriver` 作为客户端，仓库内对照官方 ACP v1
schema 1.24.1 逐条校验。文档：docs/acp.md（英文：docs/en/acp.md）。

- **没有模型不退出**：`ama --mode acp` 没有模型时不再以退出码 4 结束，照常回 `initialize`（客户端声明
  `clientCapabilities.auth.terminal` 时给两条 terminal 型认证方法：按规范其 `args`（`--acp-terminal-auth chatgpt` / `api-key`）
  追加在配置好的启动命令后面，ama 见到后不进 ACP 模式、改跑 `ama auth login chatgpt` / `ama auth set`；启动时的
  `--auth-file` / profile 的 `authFile` 一并带上），会话方法回 -32000（无模型引导，`data.authMethods`）并以至多每秒一次重试启动；
  有了模型就把同一条连接交给正常的 ACP 服务端（不必重新 `initialize`）。`authenticate` 回 -32602；stdin 关闭退出 0。
  ACP 模式在启动前就接管 stdout。`ama auth set` 不给供应商且在 TTY 下时可用方向键选择（非 TTY 仍是用法错误）。
- **多会话**：每个 ACP 会话常驻内存（空会话切走再切回也在）；同一时刻只跑一个回合，对别的会话的 `session/prompt` 进先进先出队列，
  不再报 busy；`session/new` / `load` / `resume` / `list` / `set_mode` / `set_config_option` / `close` 在运行中也可调。权限模式按会话记，
  轮到它跑时再应用。排队中的提示收到 `session/cancel` 回 `cancelled`。`session/list` 按 `cwd` 过滤、每页 50 条带 `nextCursor`
  （非法 cursor 为 invalid params），标题去掉嵌入资源块；每回合结束发 `session_info_update`（标题、`updatedAt`）。拒答（Anthropic
  `stop_reason: "refusal"`，`StopReason` 新值）回 `refusal`，其它地方消息仍按出错收尾（以 `stopReasonOf()` 区分；假供应商脚本支持
  `stopReason: "refusal"`）。`mcpServers` / `additionalDirectories` 忽略并在 stderr 记一行。**行为变化**：`session/close` 之后对该 id
  的请求回 -32002（以前会重新打开），要再用先 `session/load` / `session/resume`。
- **工具调用可视化**：`tool_call` 带 `name`；codemode 脚本里的每次内层调用单列为一条 `tool_call`（标题前缀 `codemode › `，
  `_meta.ama.parentToolCallId` 指向外层调用）并各自收口，权限请求用发起调用的 id，不再指向未公布的 id。权限询问期间调用回到
  `pending`，允许后再 `in_progress`。`edit` / `write` 填新的 `ToolResult.fileChange`（改前 / 改后的磁盘原文，BOM 与 CRLF 原样，
  新文件 `oldText: null`，单侧超过 256 KiB 不填；不落盘，RPC / stream-json 事件里去掉），完成更新带 `diff` 与前 4 KB 文本，
  `locations[].line` 为首个改动行。`session/load` 回放的工具结果带前 4 KB 文本（无 diff）。权限模式带显示名与随界面语言的说明。
- **配置项与命令表**：开会话答复带 `configOptions`——`mode`（权限模式，与 `modes` 同一状态；有配置项的客户端如 Zed 不再看 `modes`）、`model`（按供应商分组，值 `provider/model-id`，与 TUI `/model` 的「已配置」
  视图同一口径：只列有 key、OAuth 已登录或本地的供应商，遵守 `models.enabled`，`fake` 按既有规则藏起）与 `thinking`（category
  `thought_level`，只列当前模型支持的级别）；没有 boolean 项。`session/set_config_option` 切换（未知 id / 值回
  -32602），模型 / 思考级别变化发 `config_option_update`。会话打开后发 `available_commands_update`：Skill 列为 `skill:<名字>`，提示模板
  列为 `<名字>`（`argument-hint` 作 `input.hint`），不列内置斜杠命令。`LoadedResources.prompts` 的提示模板多带 `description` /
  `argumentHint`。
- **双向 `$/cancel_request`**：`JsonRpcPeer` 新选项 `cancelRequests`（ACP 两侧开，缺省关闭，Codex app-server 线路逐字节不变）：本端
  abort 的出站请求会通知对端，对端撤回的入站请求 abort 其 `ctx.signal` 并回 -32800。以 `$/cancel_request` 撤回的 prompt 停止回合并答
  -32800；不再需要的权限请求由 Agent 撤回，客户端可以关掉对话框。
- **客户端侧（`task(agent="acp:…")`）**：`AcpClient` 声明 `clientCapabilities.session.configOptions: {}`；Agent 撤回挂起的权限请求时
  审批关掉、答 `cancelled`。`AcpDriver` 在 Agent 没有 `modes` 时退到 category `mode` 的配置项，-32000 报 `agent_auth_required` 并列出
  Agent 的认证方法（terminal 型附命令），取消后的 -32800 视为 `cancelled`，`diff` 的路径计入 `filesTouched`。文档：docs/agents.md。
- **类型与测试**：ACP 类型补 `authenticate`、`$/cancel_request`、-32800、terminal 型认证方法、客户端 `session` / `auth` 能力、
  tool call 的 `name` / `_meta`、`config_option_update` 与 `ACP_META_KEY`（`@armadra/agent/acp` 导出）；回合 `usage` 注明 UNSTABLE；
  select 配置项的选项须全部平铺或全部分组（假 Agent 的 `model` 项改为分组）。假 ACP Agent 加 `--config-only`、`--auth-required` 与
  `[cancel-request]`。测试与黄金记录里的每条 ACP 线路都按随仓库的 schema 校验。
- **Zed 实测修正**：terminal 认证的 `args` 改为 `--acp-terminal-auth chatgpt|api-key`（客户端是追加到启动命令后面）；配置项补 `mode`（有
  `configOptions` 时 Zed 不看 `modes`）；会话自己换的模式记进排队重放；`session/load` / `resume` 找不到的 UUID（重启前从未落盘的空会话）按原 id
  新建空会话，不再 -32002；上游在后续回合复用的工具调用 id 在线上加 `#n` 后缀，保持会话内唯一（Zed 曾把它们合成一条）。

## 0.6.8（2026-10-04）

- **ACP 客户端：elicitation 与会话配置项**：`AcpClient` 可选构造参数 `onElicitation(params, signal)`，给了才在 `initialize`
  声明 `clientCapabilities.elicitation` 并把 `elicitation/create` 交给它（答复收成 `accept` / `decline` / `cancel`；
  `cancel(sessionId)` 或连接关闭时挂起的回 `cancel`）。新增 `setConfigOption(sessionId, configId, value)`，开会话答复带
  `configOptions`。`AcpClient.features` 多 `elicitation` 与 `configOptions`。不给处理器时线路不变。假 ACP Agent 加
  `[elicit]`、`[model]`、`[env NAME]` 标记与 `--config-options`。文档：docs/acp.md。

## 0.6.7（2026-10-03）

- **宿主注入的 `ama` runner 生效**：宿主经 `HostApi.runners.provide` 注入 id 为 `ama` 的 runner（如 Armadra 画布上另一个
  ama 节点）时，`task(agent="ama")` 交给它；没注入时行为不变，内置类型（`general` / `explore` / `plan`）始终是 ama 子会话。
  文档：docs/agents.md。

## 0.6.6（2026-10-03）

- **本地检索提示**：`grep` 与 `glob` 都直接可用时，系统提示的规则节多一句「先 grep / glob 定位再 read，不要猜路径」；`grep` /
  `glob` 的描述写明何时用；`grep` 新增 `filesOnly: true`，只列命中文件（去重、按路径排序，`limit` 按文件数计）。`read` 收到目录时
  指向模型当前真能调用的工具：有 `ls` 说用 ls，否则有 `glob` 说用 glob（例如 `pattern "src/*"`），都没有则说读目录里的文件。`-p`
  下 `minimal` / `coordinator` 预设里 bash 的 `grep` / `rg` / `find` 被拒时，stderr 补一行怎么加回
  （`tools.default: ["+grep","+glob"]`）。工具经可选、只读的 `ToolContext.activeTools` 拿到会话活动集。`default` 前缀因此
  变化（约 +35 token），升级后首个请求缓存未命中一次。文档：docs/design.md §5.6、docs/codemode.md。

## 0.6.5（2026-10-03）

- **`AcpClient` 开会话可传 MCP 服务器**：`newSession`、`resumeSession`、`loadSession` 新增可选的第三个参数
  `{ mcpServers }`，原样随 `session/new|resume|load` 发出（缺省仍是 `[]`，不传时线路不变）；宿主用
  `AcpClient.features.mcpServers` 检测是否支持。ama 自己仍不传。文档：docs/acp.md「作为客户端」。

## 0.6.4（2026-10-03）

- **打断并立即发送**：运行中按 Enter 仍是排队插话（等下一个投递点送达），新增 `Ctrl+X`（键位动作 `app.message.interrupt`）立即中止
  当前回合（模型流与正在跑的工具，每个工具调用仍恰有一个结果 `aborted by user`），并马上以输入框的文字开新回合，已排队的插话拼在
  前面（会话里 `origin: "interrupt"`，消息区标 `↳ 打断`）；输入为空时把排队的插话立即送出。Esc 语义不变。配置
  `ui.enterWhileRunning: "queue" | "interrupt"`（缺省 queue，`/config` 可改）互换 Enter 与 `Ctrl+X`。输入框有字时运行提示行显示
  `Enter 排队 · Ctrl+X 打断并发送`。子 Agent 视图同样可用：ama 子 Agent 中止本轮后立即以这条消息开新一轮；外部 Agent 的驱动能中断
  单个回合（ACP、Claude stream-json、Codex）时中断后发送，否则退回排队并提示。line 模式认 `/interrupt <文本>`；RPC `prompt` /
  `steer` 与 SDK 增 `interrupt: true`。新请求以被打断的那次请求为前缀，缓存照常命中。文档：docs/tui.md、docs/rpc.md。
- **状态栏左右分区与配额标签修正**：`full` 布局改为左列「状态 / 开关」、右列「度量与模型」——速率行左区是 `codemode on`（含
  `net!`）· 沙箱 · 预设 · `→ 回退模型` · 排队数 · 宿主状态，右区是 `tps … (avg · ttft) · ↑ ↓ · cache · 重计费 · [-]`；状态栏
  左区仍是权限模式与 `shift+tab` 提示；配额行右对齐。窄屏先丢右区度量、再丢左区开关，权限模式、`tps` 与 `[-]` 不丢；`compact`
  单行的记号顺序不变。配额标签按窗口时长认：周窗口放在 primary 时显示「本周 / Weekly」而不是 `7d:`，5 小时窗口排在前面；
  服务端用全 0 表示的空窗口不再渲染成 `0d: 0.0%`（解析与显示两层都过滤）。文档：docs/tui.md。

## 0.6.3（2026-10-03）

- **TUI：`Ctrl+B` 前台任务转后台，后台任务审批停靠在 Agent 栏**：主回合在等前台子 Agent 任务（或 `task_ctl wait`）时按
  `Ctrl+B` 把它转后台，不看输入框有没有字：工具行变成 `⎿ 已转后台 · 12s` 加跟随行，主回合接着走、可以继续对话，任务结束后以
  `<task-notification>` 回合报告。没有可转的任务时 `Ctrl+B` 仍是光标左移。运行提示行带 `Ctrl+B 转后台`；tmux 里按 `C-b C-b`。
  Agent 栏内 `b` 转后台选中的任务、`x` 连按两次停止；命令 `/tasks bg [id]` 同样可用（line 模式也认）。Esc 只中断前台，提示
  里写明哪些后台任务仍在运行。后台任务的审批在主会话忙或输入框有草稿时不再弹框，停靠在 Agent 栏（「等待审批」，运行提示行
  `↓ 处理审批`），主会话空闲且输入为空时自动弹出，打开该任务的视图时立即弹出；主会话与前台任务的审批不变。文档：docs/tui.md。
- **后台子 Agent 的配置、`-p` 与 RPC**：新增 `subagents.background: "auto" | "always" | "never"`（缺省 auto：交互界面 / RPC / ACP
  下 task 缺省后台，`-p` 下前台；调用参数与类型定义的 `background:` 优先）与 `subagents.autoBackgroundAfterMs`（前台任务运行超过
  该毫秒数自动转后台，缺省 0 关闭），两键项目级也认、`/config` 面板可改。`-p` 主回合结束后若还有后台任务在跑，stderr 一行提示并
  等它们结束、跑完通知回合再输出（受 `--max-turns` / `--max-cost` 约束，到限退出 8；Ctrl+C 照常中止），json 结果带 `tasks`。
  RPC 新增 `background_task { taskId? }` → `{ backgrounded }` 与事件 `subagent_background`（共 44 条命令），SDK 为
  `session.backgroundTask(taskId?)`。文档：docs/agents.md「前台与后台」、docs/rpc.md。
- **Agent 栏重新可达**：空输入时的 `↓` 成为唯一缺省进栏键，本会话有任务即可进栏，栏收起后也行（以前要求栏可见）。`Ctrl+B`
  不再进栏（tmux 缺省前缀会吃掉它），留给「前台任务转后台」，目前仍是光标左移（想要原来的键位写
  `"app.agents.focus": ["down", "ctrl+b"]`）。输入框有字、`ui.agentBar: "off"` 或没有任务时按 `↓` 给一行提示，不再无声落空；
  浏览输入历史时 `↓` 照旧翻历史。Agent 栏有任务时运行提示行末尾带 `↓ Agent 栏`（窄屏整项丢掉）。嵌入宿主（有 profile）
  不再缺省关闭 Agent 栏，不要栏的宿主在 profile 的配置文件里写 `ui.agentBar: "off"`。
- **子 Agent 缺省后台、前台任务可转后台**：TUI、RPC 与 ACP 下不写 `background` 的 `task` 立即返回 taskId，结果随后以
  `<task-notification>` 到达；`-p` 仍缺省前台等待（配置 `subagents.background`：`auto`（缺省）/ `always` / `never`；类型
  定义的 `background:` 与调用参数仍优先，内置类型不再固定 `background: false`）。阻塞中的前台 `task` 或 `task_ctl wait`
  可以转后台（`session.backgroundTask(taskId?)`，事件 `subagent_background`）：工具立即返回固定文案「Moved to the
  background …; it was not interrupted」，任务与父回合解绑（Esc 不再连带停止），完成后照常通知；
  `subagents.autoBackgroundAfterMs`（缺省 0 关闭）到时自动转后台。`task` 描述与规则句按缺省后台改写（会话内不变；TUI 与
  `-p` 的工具表因此不同）。

- **ChatGPT 订阅模型的上下文窗口取后端值**：ChatGPT 后端模型列表给的上下文窗口（codex 的 `context_window`，siwc 条目带了也取）
  现在优先于 models.dev——后者记的是 API 版窗口（部分模型 1.1M），订阅后端实际只收 272k，自动压缩按大窗口规划，长会话超过
  272k 后请求被拒。models.dev 仍补后端没给的字段（输出上限等），但不再覆盖后端给的输入模态与推理强度；两边都没有上下文窗口时，
  `chatgpt` 模型按保守缺省 128k，不再关闭自动压缩。`ama models discover chatgpt` 显示后端窗口并标「（后端）」，列出后端没给窗口
  的模型。旧版本写的缓存不含窗口时照旧用 models.dev，重新 `ama models discover chatgpt` 即刷新。

- **状态栏订阅配额行与配色**：当前模型走 ChatGPT 订阅时，`full` 布局在状态栏下方多一行
  `5 小时：10.0% | 重置：2h 18m | 本周：31.0% | 本周重置：6d 5h`（来自 `quota_update`，每分钟刷新；窄于 80 列压缩为
  `5h 10% ↻2h18m · 周 31% ↻6d5h`；codex 方式首次请求前显示占位，siwc 无数据与非订阅模型不显示）。`compact` 只在行尾追加短项
  `5h 10% 周 31%`，既有顺序不变。`full` 三行按参考配色（标签暗灰；速率、时长与重置时间紫；模型、思考级别与输出量蓝；目录与分支绿；
  费用黄；百分比按阈值），分支后显示领先 / 落后上游 `↑N` / `↓N`。文档：docs/tui.md「布局」。
- **启动头换成 AMA 字符画与简短的点亮动画**：原来带框的信息块改为 5 行「AMA」字符画（块字符，按字母取主题的 accent → user → tool
  三色；ASCII 模式用 `_ / \ |` 拼的字形），版本、模型、目录、模式与按键提示放在右侧（≥ 72 列）或下方（48–71 列）；窄于 48 列
  退回两行简洁头。启动时播放一次约 1 秒的扫描点亮，原地定格、不在回滚里留帧；按任意键立即定格，按键照常进入输入框。
  `ui.animation: false`、无色、非 TTY、嵌入宿主、`CI`、命令行带提示、终端过矮时不播放。新增 `ui.logo: "auto" | "off"`（off 只显示
  信息行）。文档：docs/tui.md「启动画面」。

## 0.6.2（2026-10-03）

- **ChatGPT codex 方式能列出模型，渠道跟随登录方式**：codex 模型列表（`GET /models?client_version=…`）原来发 ama 自己的版本号，
  后端按每个模型的最低 Codex 客户端版本过滤，于是一个模型都不返回；现在发 Codex CLI 版本号（缺省 `0.160.0`，新增用户级
  `auth.chatgpt.codexClientVersion` 与环境变量 `AMA_CHATGPT_CODEX_CLIENT_VERSION`），仍为 0 个时提示调高。codex 响应里的上下文
  窗口、输入模态、推理强度写进发现缓存，models.dev 补不到时用它。`chatgpt` 的请求在请求时按当前登录方式选渠道：没写 `@渠道` 的
  模型跟随登录，运行中的会话在 siwc 与 codex 之间换登录后照常继续，恢复会话时也不沿用记录的渠道；只有显式写了不符的 `@渠道`
  才报 `chatgpt_flavor_mismatch`，文案更清楚。登录先删旧发现缓存再重写（0 个也写空表），缓存 flavor 与当前登录不符视为过期。
  `not_eligible` 改为列出可能原因（套餐、工作空间账户、地区受限或预览期未开放——Pro 账户最可能是这一条）并提示
  `--flavor codex`；siwc 登录成功后说明能否共享额度要到首次请求才能确认。另修复：表外 slug 显式写 `@渠道`
  （`chatgpt/<slug>@siwc`）时仍用缺省渠道的地址。文档：docs/providers.md「ChatGPT 登录」。

## 0.6.1（2026-10-03）

- **模型选择器只显示已配置的模型，ChatGPT 模型可选**：`/model`（以及启动选择器、`/config` 的模型项）只列有 key、OAuth 已登录或
  本地服务的供应商；多渠道供应商每个模型一行（其它渠道写在说明里，筛选文本输入 `@` 列出 `模型@渠道` 行）；当前模型不在列表里时
  置顶。`Tab` 切到「全部」（没配置的供应商标「未配置 key」，选中时提示 `ama auth set`），`Space` 把高亮的模型加入 / 移出新的
  用户级清单 `models.enabled`（`provider/model[@channel]`、`provider/*`），设置后选择器只列清单内的模型；`ama models enable |
disable` 与 `ama models list --enabled` 在命令行编辑和查看。`ama auth login chatgpt` 成功后拉取账户可用的模型（只读、不消耗
  额度）缓存到 `<dataDir>/models/discovered/chatgpt.json`，`ama models discover chatgpt` 重写、logout 删除；注册表把缓存并入模型
  表为空的供应商，ChatGPT 模型因此出现在 `/model` 与 `ama models list` 里。注意：只登录了 ChatGPT、没设 `defaultModel` 时，
  缺省模型现在可能选中缓存里的第一个 ChatGPT 模型。文档：docs/tui.md、docs/providers.md「ChatGPT 登录」。

- **`ama auth login chatgpt` 授权被拒时说明原因**：OAuth 回调带 `error=access_denied`（或其它 error）时，提示改为列出可能原因
  （在授权页取消或没勾选使用 ChatGPT 套餐额度；账户 / 套餐不符合——额度共享只对 Plus / Pro 开放，Team / Enterprise 工作空间可能
  未开放，浏览器可能登录了别的账户；所在地区受限），siwc 下另提示可改用备用 `ama auth login chatgpt --flavor codex`。不自动重试、
  不自动换 flavor。

- **`ama config set` 被更高优先级来源覆盖时，回执显示刚写入的值**：如 `AMA_LANG=zh` 下 `ama config set ui.language en`，原来
  第一行显示覆盖后的生效值 `zh` 却标「（用户级）」。现在第一行是刚写入的值与写入层（`ui.language = en（已写入用户级）`），第二行
  提示覆盖来源与生效值（`当前仍被 AMA_LANG（zh）覆盖，生效值为 zh`）。`ama config get` 仍显示生效值与真实来源。

## 0.6.0（2026-10-03）

第六波：Agent 栏与子 Agent 视图、轨迹、记忆（Memory）、ChatGPT 登录、`/config` 设置面板、中英双语界面。设计依据与决定表见
docs/wave6-plan.md，各主题的现状文档见下文链接。

### 破坏性变更与升级注意

- **界面语言可能变成英文**：新的缺省 `ui.language: "auto"` 按 `LC_ALL` / `LC_MESSAGES` / `LANG` 判断，`zh*` 为中文，其余（包括
  判断不出）都是英文。macOS 上常见的 `LANG=en_US.UTF-8` 会让中文用户升级后看到英文界面，固定中文：`ama config set ui.language zh`
  （或 `--lang zh`、`AMA_LANG=zh`）。
- **README 与 CHANGELOG 改为英文**：`README.md` / `CHANGELOG.md` 是英文（npm 包页显示），中文在 `README.zh-CN.md` /
  `CHANGELOG.zh-CN.md`（0.1–0.5.1 的记录整体在此）；中文文档原路径不动，`docs/en/` 有六篇英文版。
- **发给模型的标记改为英文**（与界面语言无关，两种语言下请求逐字节相同）：工具结果截断 `[… N chars omitted …]`、压缩裁剪占位
  `[pruned: …]`、摘要序列化截断、外部 Agent 报告的 `Tool calls:` / `Files changed:` 与失败说明、Hook 阻止理由、allowlist 拒绝说明、
  进 `task` 工具结果的错误（未知外部 Agent、宿主独占、排队时中断）与「… N more tool calls」摘要行。只影响升级后新产生的工具结果，
  不碰缓存前缀；**按旧中文标记解析工具结果的脚本需要更新**。
- **会话文件多了 `custom{customType:"ama.trace"}` 条目**（每次模型请求一条，另有重试等待、回退、压缩、辅助请求、外部 Agent
  回合骨架；只有 id、时间与计数，不进上下文、不改请求）：RPC 客户端会多收到这些条目的 `entry_appended`，按条目遍历会话文件的
  脚本需要跳过它们。
- **`/tasks` 改为聚焦 Agent 栏**，`/tasks <id>` 直接打开子 Agent 视图；`ui.agentBar: "off"`（嵌入宿主缺省）时仍是原来的选择器。
- **`ama --help` 变化**：两种语言都补上 `--lang`、`--memory` / `--no-memory`、`ama auth login | logout | status`、
  `ama config get | set | unset | list`、`ama memory`、`ama sessions trace`；解析帮助文本的脚本需要更新。
- **`ama sessions list` 缺省隐藏子 Agent（task）会话**，`--all` 列出并标 `↳ 子 Agent`；`ama -c` 与 `--resume` / `/resume`
  选择器不再选中它们（见「其它修复与改进」）。
- **`ama stats` 统计索引版本升级**：首次运行自动重扫全部会话（之后照常增量）。
- **`PresetResolution.warnings` 改为结构化**：`resolvePreset()` 的警告从中文字符串改为 `{ kind: "codemode_only_fallback" |
"codemode_unavailable" | "unknown_tool", … }`，由调用方渲染。
- **内置供应商 18 家**（新增 `chatgpt`）：列举内置供应商的脚本会多一项。
- **缓存未命中一次的情形**（只在开启相应功能时）：开启记忆后的首个请求（多出 `memory` 系统节与 `memory` 工具）；设置
  `ui.replyLanguage` 后的首个会话（`rules` 节末尾多一句）。两者都不开时，`default` / `minimal` 预设发给模型的 system 与工具表与 0.5.1
  逐字节相同。
- 协议版本常量（`RPC_PROTOCOL_VERSION`、`HOST_API_VERSION`、会话格式版本）不变；新增的事件、命令、字段全部可选；退出码不变。

### Agent 栏与子 Agent 视图

- **Agent 栏**（[docs/tui.md](docs/tui.md)「Agent 栏」）：状态行上方列出子 Agent 任务（排队 / 运行中 · 用时 · 轮数 · 最近工具 /
  等待审批 / 完成 / 失败 / 已停止），最多 3 行 +「另 N 个」；结束后保留到在视图里看过为止，最多 10 分钟。输入为空时 `Ctrl+B` 或 `↓`
  进入（键位动作 `app.agents.focus`；有字时 `Ctrl+B` 仍是光标左移，tmux 里用 `↓`），↑↓ 选、Enter 打开。嵌入宿主缺省不显示
  （`ui.agentBar: "off"`）。
- **子 Agent 视图**：主屏上的全屏覆盖层（行数 − 1），实时跟随子会话的消息与工具调用；外部 Agent 显示内存里的实时输出（≤ 2000 条 /
  1 MB，不落盘）。输入框直接发给子 Agent：运行中排到本轮结束、外部 Agent 等本次运行结束、已结束则后台续聊；子会话里记为
  `origin: "direct"`。Esc 返回（不中断）；子 Agent 的审批在视图上弹出并标来源；`/tasks stop <id>` 在视图里也能用。

### 轨迹

- **计时落盘**：每次模型请求记一条 `ama.trace`（首 token 延迟、解码、工具、重试等待、回退、压缩、辅助请求），子会话同样测量首
  token 延迟与速率；只有 id、时间与计数，不含正文。
- **`/trace`**（[docs/tui.md](docs/tui.md)「轨迹」）：回合 → 请求 → 工具 → 子调用 / 子 Agent，每行耗时、TTFT / 解码 / 工具条形、
  token 与缓存命中，Enter 看详情，子 Agent 可展开到子会话，长会话尾部先加载、运行中自动跟随；`/trace <任务 id>` 看单个任务；
  line 模式打印文本树。老会话没有计时记录时按条目时间推算并标 `≈`，不改会话文件。
- **`ama sessions trace <id|文件>`**（[docs/sessions.md](docs/sessions.md)「轨迹」）：导出自包含单文件 HTML（树 + 瀑布图、
  TTFT / 解码 / 工具分色、子 Agent 与外部 Agent 嵌套、搜索、按回合跳转、缩放、详情、虚拟列表、深浅色；内联样式与脚本，CSP
  禁外联；数据与正文双重脱敏、数据块转义防注入）。`--json` 输出与 `get_trace` 同形，`--no-content` 只留结构与数字，`--children`
  内嵌子会话预览，`--open` 用浏览器打开，`--now` 固定生成时间（输出逐字节确定）。
- **RPC `get_trace`**（[docs/rpc.md](docs/rpc.md)「轨迹」）：尾部分页（`turnLimit` / `before`）、按 `since` 增量（配合
  `entry_appended`）、`taskId` 子轨迹、`content: "preview"` 附脱敏预览；RPC 合计 43 条命令。SDK `session.trace()`，纯函数
  `buildTrace()` 与 `Trace` 类型从包入口导出。

### 记忆（Memory）

- 跨会话记忆（[docs/memory.md](docs/memory.md)），**缺省关闭**：`ama memory enable` / `--memory` / `AMA_MEMORY=1` 开启。条目是
  `<数据目录>/memory/{user,projects/<目录名>-<sha8>}/` 下带 frontmatter 的 Markdown，`MEMORY.md` 索引自动重建；项目作用域需项目已受信任；
  关闭时请求体逐字节不变。
- 新工具 `memory`（`view` / `create` / `str_replace` / `delete`，路径限定 `/memories/<作用域>/`）与权限类 `memory`：default 下写入首次询问、
  可本会话允许；内容像凭据即拒写；子 Agent 只读；规则 `memory(...)` 按命令名或逻辑路径匹配。项目级只能把 `memory.enabled` 设为 `false`。
- 系统提示新增 `memory` 节（`skills` 之后，只放索引）：会话开始定稿，会话内写入下次会话生效，`/memory reload` 与压缩后刷新；压缩回注
  列出读写过的记忆路径。
- `/memory`（面板、show、edit、rm、on|off、reload）与 `ama memory list|show|edit|rm|path|enable|disable`。嵌入宿主与 SDK 缺省禁用，
  `memory: { enabled, dir }` 开启，只有 `workspace` 作用域、不读用户级。

### ChatGPT 登录

- `ama auth login chatgpt` 用自己的 ChatGPT Plus / Pro 订阅驱动 ama（[docs/providers.md](docs/providers.md)「ChatGPT 登录」）。缺省走
  OpenAI 官方 Sign in with ChatGPT（动态注册、JWKS 验签 id_token）；`--flavor codex` 是显式开启的备用路径（借用 Codex CLI 公开客户端，
  首次确认「非官方、仅个人使用」）。`--paste` 粘贴回调 URL（SSH / 宿主），`--device` 设备码（只 codex）；`ama auth status` /
  `logout chatgpt`；`ama auth list` 显示 `oauth · <flavor> · <计划>`。
- 新内置供应商 `chatgpt`（渠道 `siwc` / `codex`，缺省按登录 flavor），模型用 `ama models discover chatgpt` 查看。
- 凭据存 `auth.json` 的 OAuth 条目（`type: "oauth"`，0600），自动刷新，多进程经 `auth.json.lock` 串行刷新，失效报 `auth_expired`；
  token 不进日志、会话、事件与错误；RPC `keySource` 可为 `oauth`。
- 订阅请求 `cost = 0` 并标 `billing: "subscription"`；`/session` 单列「订阅用量」与配额，`ama stats` 单列「订阅」一行（不进费用、不算无价）；
  新事件 `quota_update`（RPC 与宿主事件）；配额耗尽报 `quota_exceeded`、不重试。

### `/config` 与 `ama config`

- **`/config` 设置面板**（[docs/tui.md](docs/tui.md)「`/config` 设置面板与 `ama config`」）：分组列出标量设置与生效值、来源（default /
  user / profile / project / cli / env）和生效档（即时 / 新会话 / 重启），↑↓ Enter / 空格修改、`/` 搜索、Tab 切写入层（项目级只许收紧）、
  被覆盖的项标锁定；改动立即写盘（写前重读、只改一项、留 `.bak`），即时项当场作用于本会话，关闭时汇总。`/config key=value` 直接改一项
  （line 模式也可用）。
- **`ama config get | set | unset | list`**：`--project` 写项目级、`--json-value` 传列表 / 对象；未知键、非法值、项目级放宽退出码 3；
  持久化 `permission.mode full-auto` 在终端里先确认，非终端需 `--yes`。
- **`ui.replyLanguage`**：设置后会话开始在系统提示 `rules` 节末尾追加 `Reply to the user in <语言>.`；不设时请求零字节变化（只认用户级）。

### 中英双语

- **界面语言**：`AMA_LANG`、`--lang zh|en`、配置 `ui.language`（`auto` / `zh` / `en`）、profile 与 SDK 的 `language`。CLI（`--help`、启动画面、
  报错、各子命令输出）、TUI 与行式界面（启动头、状态行、审批框与预览、Plan 审批、回滚、各面板与选择器、提示与按键说明）、`-p` 的 stderr、
  RPC 人读 `error` 与 ACP 错误 / 审批选项名、`permission_request` 的审批预览、斜杠命令说明与回执、`ama doctor`（新增「界面语言」一行）、
  会话 Markdown 导出、配置键说明与校验诊断、`ama init` 输出都随界面语言；中文输出逐字不变，compact 状态行记号（`ctx`、`cache`、`$`、
  `↑ ↓`）不译，RPC 与 `-p --output-format json` 的 JSON 字段不变。`config.schema.json` 的说明按当前语言写，切换后再跑 `ama init` 重写。
- **宿主按 `code` 判断**，不要解析人读的 `error` / `message`（[docs/rpc.md](docs/rpc.md)）。
- **双语文档**：`docs/en/` 新增 `tui`、`permissions`、`providers`、`rpc`、`host-api`、`sessions` 六篇英文版（头部记着对应的中文版提交）；
  开发约定见 [docs/i18n.md](docs/i18n.md)。

### 其它修复与改进

- **继续 / 恢复会话跳过子 Agent 会话**：`ama -c`、`--resume` 选择器、交互 `/resume` 选择器与 ACP `session/list` 不再选中或列出
  子 Agent（task）会话——头有 `parentSession` 且第一条条目是 `custom{ama.task}` 的会话（fork 出来的照常算）；`-c` 每个文件只读头两行。
  显式 `--resume <子会话 id>` 仍可打开；`prune`、`stats`、`sessions search` 不变。
- bundle 改用 UTF-8 输出（中文不再转成 `\uXXXX`），体积约减 40 KB。
- RPC `permission_request.context` 可带 `toolCallId`（本会话工具调用的审批现在也有 `context`）。
- `ama memory enable / disable` 改走与 `/config` 相同的写盘路径（写前重读、只改一项、留 `.bak`）。
- `/trace` 详情的键列宽按最长的键对齐（英文不再错位）；`/config` 面板英文底部提示在 80 列不再截断。

### 接口、测试与发布

- 第六波契约（docs/wave6-plan.md §7，全部可选、向后兼容）：`Trace` 类型与 `buildTrace()`、SDK `session.trace()` 与 `memory` 选项、RPC
  `get_trace`（结果可选字段 `task`、`previews`）、事件 `quota_update`、`KeySource` 的 `oauth`、`auth.json` 的 OAuth 条目、配置键
  `ui.language` / `ui.replyLanguage` / `ui.agentBar` / `memory.*` / `auth.chatgpt.*`（已写进 `config.schema.json`）。
- `pnpm check:i18n` 进 CI 且为严格模式：`src/**` 出现中文行即失败，保留的几处（输入别名、粘贴标记、价格数据的 `_reason`）逐条写明理由；
  测试缺省钉 zh，另有 en 帧黄金与 CLI 英文抽样。
- `release-check` 认双语 CHANGELOG（两份都要有当前版本段），并在中文文档比 `docs/en/` 译本的基准提交多改 5 次以上时提示（不失败）。
- bundle 级 e2e 新增：`ama auth status` 无条目、`ama sessions trace --html` 确定且无外链、`AMA_LANG=en -p` 请求与 zh 逐字节相同、
  `ama config set / get / unset` 往返、`--memory` 写入后 `ama memory list` 可见。
- npm 包增带 `docs/memory.md` 与 `docs/en/*.md`。

### 已知限制

- **ChatGPT 登录尚未用真账户验证**：两种 flavor 都只对本地模拟服务测过。待 Plus / Pro 真账户确认三项：官方（siwc）路径的工具
  `namespace` 形状（`toolsInNamespace` 保持关闭）、codex 设备码是否需在 ChatGPT 安全设置里开启、codex `wham/usage` 配额返回体的字段。
  真账户检查本地用 `AMA_E2E_CHATGPT=1` 跑（CI 不跑）。
- Linux 沙箱（bubblewrap）仍未在真机上验证，只经单元测试与 Ubuntu CI。
- 记忆不做自动提取（只在模型调用 `memory` 工具或用户命令时写入）；Agent 栏在 tmux 里的 `↓` 进入与 HTML 轨迹的深浅色只经自动化测试，
  待人工确认。

## 0.5.1（2026-10-03）

- **Tab 切换权限模式**：输入为空、补全未打开时按 Tab 与 Shift+Tab 一样循环权限模式；有输入时 Tab 仍是补全。可在 `keybindings.json` 的 `app.permission.cycle` 改回只用 `shift+tab`。
- **进入 Bypass 前确认**：Tab / Shift+Tab 循环到 Bypass permissions、`/permission` 选择器选它或 `/permission full-auto` 时，先弹确认框
  （说明所有工具调用免审批，缺省选中「取消」，↑↓ Enter / 1 2 / y n / Esc）。循环时取消会跳过 Bypass 回到 Manual，选择器与命令取消
  保持原模式；本次运行确认过一次后不再问。`--permission-mode full-auto`、配置与 profile 指定的不弹；line 模式问 `确认进入 Bypass？[y/N]`。
- **选择统一用 ↑↓ / Enter**：`ama providers add` / `refresh`（含 `--probe`）、`ama models cache-probe` 的计费 / 写入确认在 TTY 下
  改为方向键选择「继续 / 取消」（缺省取消，y / n、数字直选，Esc / Ctrl+C 取消，结束后恢复终端）；stdin 非 TTY 时仍是文本
  `[y/N]`，`--yes` 照旧跳过。启动时的信任目录确认与 `/thinking` 选择器加数字直选。

## 0.5.0（2026-10-03）

第五波：回滚与检查点、操作系统沙箱、子 Agent、外部 Agent 与 ACP、Plan 模式、压缩与 harness 修订、模型元数据快照与内置渠道、
图像、状态行与界面集成。设计依据见 docs/wave5-plan.md，各主题的现状文档见下文链接。

### 破坏性变更与升级注意

- **退出码**：`-p` 到达 `--max-turns` 由 **1 改为 8**（`--max-cost`、`limits.*` 同为 8，`json` 结果带 `limitReached`）；
  新增 **9** = Plan 模式下计划已落盘、待审批（`plan.unattended: stop`，缺省）。7 仍是「工具调用被拒」。按退出码判断的脚本需要更新。
- **Node 22 / 24 在有操作系统沙箱时（macOS、多数 Linux）`default` 预设缺省带上 `codemode`**（原来只有 Node ≥ 25），工具表因此
  变化。`todo` 仍不在 `default` 里（D20 复测未过门，见下文「基准」）。
- **升级后每个会话的首个请求缓存未命中一次**：系统提示规则节新增两条、Skill 索引改为每条一行、edit / bash 工具描述与 bash 参数变化、
  上一条的 codemode；xAI、Mistral、Kimi 官方端点与腾讯 TokenHub 请求体多了 `prompt_cache_key`；开启 `sandbox.bash: auto`
  时 bash 多一个参数。恢复的旧会话追加一条 system 补丁，之后照常命中。
- **缺省协议变化**：OpenAI、xAI 全部模型改走 Responses（`@chat` 换回 Chat），通义改走 Messages（`/apps/anthropic`）。改了
  供应商级 `baseUrl` 的中转不受影响（按单渠道回落，OpenAI / xAI 目录模型在中转上仍走 Responses）。
- **模型元数据**：`ama models refresh-catalog` 改名 `ama models refresh`（旧名仍可用）；不再读取旧版的全量缓存
  `models-dev.json`（version 1），`ama providers add|refresh`、`ama models discover` 不再拉 models.dev。
- **图像上限**改按 base64 后计算并按端点分档（中转与未知主机 5 MB，原来按原始字节 5 MB），超 8000 px 拒绝。
- **压缩**：token 估算中文按字计，中文会话的自动压缩比以前早触发；会话层通用截断改为头 70% + 尾 30%。
- **交互界面**：Plan 审批不再是「回复 1 / 2 / 3」的文本（TUI 改为对话框；line 模式保留并新增 `/plan approve|reject`）；独立终端的
  底部信息行缺省两行（`ui.statusLine: "full"`），有 profile 的嵌入宿主仍是一行、`·` 分隔与模式最左不变；审批框标题带来源前缀。
- **外部 Agent 子进程**剥离 `ARMADRA_*`（`ARMADRA_ASKPASS_*` 除外）、供应商 key、`*_BASE_URL`、`AMA_*`。
- 协议版本常量（`RPC_PROTOCOL_VERSION`、`HOST_API_VERSION`、会话格式版本）不变；新增的事件、命令、字段全部可选。

### 回滚与检查点

- **检查点**（docs/rewind-plan.md、docs/sessions.md）：edit / write 第一次写文件前备份，每个新回合重拍已跟踪文件；备份按内容 sha256
  存 `<数据目录>/file-history/blobs/`。`checkpoints.mode: "shadow-git"` 把工作目录快照进独立的影子仓库，bash 与手动改动也能回滚（尊重
  `.gitignore`，不碰用户仓库；git 不在 PATH、超过 20 000 个文件或快照超过 3 秒时本会话降级为 `tools`）。新配置 `checkpoints.mode`
  （`AMA_CHECKPOINTS`）、`checkpoints.maxFileBytes`、`checkpoints.keep`；`ama sessions prune` 清理未引用备份，`ama doctor` 显示占用。
- **恢复**做冲突检测（回合外被改过的文件缺省跳过，可覆盖）与安全检查（符号链接、硬链接、非普通文件、父目录移动；非 Windows 用
  `O_NOFOLLOW`），可预览行级增删。
- **回滚**：`/rewind` 与空闲时双击 Esc 打开回滚列表，确认面板给出恢复代码和对话 / 恢复对话 / 恢复代码 / 从这里摘要 / 摘要到这里，
  每项带预览，git HEAD 变化时给出两条命令（不执行）；输入框有字时双击 Esc 清空并存进历史；运行中 Esc 中断且本回合还没有输出时
  自动撤回并回填（`ui.restoreOnCancel`）。line 模式 `/rewind <n> [both|conversation|code] [overwrite]`。新键位动作 `app.rewind`。
- 接口：`AgentSession.rewindPoints()` / `rewind()` / `summarizeFrom()` / `summarizeUpTo()` / `undoAbortedTurn()`；RPC
  `get_rewind_points`、`rewind`、`summarize_from`、`summarize_up_to` 与事件 `session_rewound`；Hook 事件 `PostRewind`；SDK 导出回滚
  类型。仅对话或仅代码时下一次提示前追加 `ama.rewind-note`，前缀不变。

### 操作系统沙箱

- docs/sandbox.md。新模块探测 macOS `sandbox-exec`、Linux bubblewrap（退而 `unshare -r -n`），用目标配置跑最小探针确认可用。
- **codemode** 子进程经沙箱启动，内核拒绝网络（含 DNS）与一切写入：Node 22 / 24 有沙箱时与 Node ≥ 25 一样按只读类处理、
  `default` 预设缺省开启、状态栏不再标 `net!`。新配置 `sandbox.enabled`（`AMA_SANDBOX=off`）。
- **bash 沙箱**（缺省关闭）：`sandbox.bash: "auto"`、`sandbox.network`、`sandbox.writable`。bash（含后台 bash）只能写工作区、临时目录
  与追加目录，`.ama/`、`.git/hooks`、`.git/config` 只读，凭据目录不可读；`default` / `auto-edit` 下沙箱内且拒绝网络的命令免审批
  （危险命令、deny 规则、Hook ask 照旧），被拒时可请求 `sandbox: false` 不经沙箱重跑（照常审批）。`ama doctor` / `config show` 显示状态，
  状态栏多一个 `沙箱` 标记。

### 子 Agent

- docs/agents.md「子 Agent」。定义文件 `~/.config/ama/agents/*.md`、`.ama/agents/*.md`（需信任）、`--agent-dir` / profile `agentDirs` /
  `agents.dirs`；内置 `general`、`explore`、`plan`（后两者强制只读、不弹审批）。
- `task` 新增 `agent`、`background`、`taskId`（续聊）、`isolation: "worktree"`、`budgetUsd`；同一回复里的多个 task 并行
  （`subagents.maxConcurrent` / `maxPending`）；结果超过 50 KB 保留头尾、全文落 `outputs/`；轮数用尽以 `toolChoice:"none"` 收尾一轮。
  后台任务完成后以 `<task-notification>` 通知父会话；新工具 `task_ctl`（list / wait / stop / output / send）与 `task` 同进退。
- 子会话工具表与父逐字节相同，首个请求复用父的缓存前缀；角色说明是系统提示末位的 `role` 节。事件 `subagent_start / update / end`，
  `getStats().tasks`，`custom{ama.task}` 记任务快照、resume 时重建。
- 界面：task 工具行折叠显示 `类型 · 状态 · 轮数 · 最近 3 个工具 · ↑↓`，后台任务有跟随状态，`<task-notification>` 只显示一行；
  `/tasks`（查看输出、停止）、`/agents`；`/session` 增「子 Agent」行。

### 外部 Agent 与 ACP

- docs/agents.md「外部 Agent」、docs/acp.md。`task(agent="claude" | "codex" | "acp:<程序>")` 经各 CLI 自己的登录运行：Claude Code
  （stream-json 原生协议）、Codex（`app-server`）、任意 ACP Agent（零依赖客户端）与一次性打印模式（只读兜底）；前台 / 后台通知 /
  `taskId` 续聊（被停止过的以外部会话 id `resume` 重开）/ `task_ctl` 与 ama 子会话一致；PATH 上的 claude / codex 写进 task 描述。
- **审批只交给人**（宿主 → 界面 → 无人值守拒绝，分类器与模型不参与，提问类请求不代答）；每个会话首次以某个外部 Agent 运行时确认
  一次（allow 规则 `task(<id>)` 或 full-auto 放行），Manual 模式下与 task 调用的审批合并为一次。模式不比 ama 当前模式宽；子进程缺省
  剥离供应商 key 等（`agents.<id>.env.passthrough` 放回），只在已信任目录里启动；并发池、美元预算、看门狗、空闲关闭与孤儿进程清理；
  每回合写 `custom{ama.agent-usage}`，`get_session_stats` 新增 `external`。
- 嵌入宿主时不自启外部 CLI，只用 `HostApi.runners.provide` 注入的 runner。RPC `permission_request` 新增可选 `context`（`depth`、
  `taskId`、`origin`）；`get_agents` 带外部 Agent 的安装与版本。
- **`ama --mode acp`**：ama 作为 ACP Agent（会话新开 / 回放 / 续接 / 列表 / 关闭、事件映射、`session/request_permission`、
  `session/cancel`、`session/set_mode`）。`@armadra/agent/acp` 导出 ACP 类型、JSON-RPC 对等端、`AcpClient`、`AcpDriver` 与假 ACP Agent。
- ACP Agent 用探测到的完整路径启动：Windows 上 npm 装的 ACP Agent（`.cmd` 垫片）不再报 `spawn … ENOENT`（bundle 级 e2e 发现）。
- 界面：审批框标注来源（`[task:<类型>]`、`[claude · 会话 abc12345]`、「首次运行外部 Agent」）；外部 Agent 的提示显示在消息区；
  `/agents` 列出安装状态与版本，`/session` 增「外部 Agent」段。

### Plan 模式

- docs/plan.md。plan 下模式说明以 `custom_message{ama.plan_mode}` 追加在尾部（前缀不变），`ama.plan_state` 让 resume 回到 plan。
  模型输出 `<proposed_plan>` 块，ama 提取步骤、落 `ama.plan` 与 `<数据目录>/plans/<会话>-v<N>.md`（`plan.directory`），发 `plan_proposed`。
- **审批**：交互界面是底部对话框——批准并执行 / 批准后在新上下文执行（新建会话，以计划全文开场）/ 继续修改（框内或外部编辑器写意见）/
  放弃并退出 Plan；批准时选执行模式（回到进入前的模式 / Accept edits / Auto），`e` 在 `$VISUAL` / `$EDITOR` 里改计划，Esc 放弃但留在
  Plan。批准后步骤转待办（`ama.todo`；todo 工具新增 `update` 与条目字段 `planStep`，事件 `todo_updated`）、切模式、以 `ama.plan_approved` 交接。line 模式
  `/plan`、`/plan approve [模式|fresh]`、`/plan reject`（也接受回复 1 / 2 / 3）；`/plan <目标>` 进入 Plan。
- 无人值守缺省 `plan.unattended: stop`（落盘后停下，`-p` 退出 9，`json` 带 `planPending`），`approve` 自动批准执行。可选
  `plan.model` / `plan.thinkingLevel` 分模型规划。
- **权限细化**（docs/permissions.md）：plan 放行只读命令子集（`ls`、`cat`、`rg`、`git log / diff / show` 等，`plan.bash`）与 `task`；
  `todo set / update` 在 plan 下拒绝；`allowlist` 同步放行同一子集与 `task`，`plan ⊆ allowlist ⊆ default` 不变。模式选择器里 Plan 的
  说明改为「只读调研，只跑只读命令，出计划后审批执行」。
- RPC `plan_response` / `get_plan` / `get_todos` / `get_tasks` / `get_agents` 与能力 `plans`（`hello.capabilities` 列出；声明后计划审批
  交客户端）；SDK `createAgentSession({ plan: { onProposed } })` 与 `session.plan.current() / respond() / todos()`，包入口导出
  `SessionPlanOptions`、`SessionPlanApi`、`PlanDecision`、`PlanResponse`、`PlanResponseResult`、`SdkAgentSession`。
- **进度记法**：活动工具集里有 `todo` 时交接请模型 `todo update`；没有时（`default` 预设缺省不含 todo）请模型每完成一步单独一行写
  `[DONE:<步骤>]`，ama 读标记推进计划待办（照常落 `ama.todo`、发 `todo_updated`）。`tools.default: ["+todo"]` 可加回 todo。

### 压缩与 harness

- **自动压缩修订**（docs/design.md §9）：档一按工具结果新旧计边界（保留最近 `compaction.prune.keepResults` 个与最近
  min(40k, 0.2×预算) token 的工具输出），修好「只有一条用户消息的长任务永不裁剪」；可省不足 `compaction.prune.clearAtLeast`
  不动，动就一次清到 0.5×预算；缓存已冷时提前裁；Skill 文件、AGENTS.md、todo、`keepInContext` 工具与 `compaction.pruneExclude`
  的结果不裁。熔断改为连续 3 次失败或连续 3 次快速回填才停。摘要模板补用户原话、错误与修复、文件与代码三节，压缩后不变小判失败；
  split turn 两份摘要并行；压缩后在摘要末尾回注 todo、计划、已加载 Skill、最近文件与转录路径。新 Hook 事件 `PostCompact`。
- **harness**：通用截断头 70% + 尾 30%（中间写省略字符数与全文路径）；重复调用检测（同名同参第 3、4 次提醒，第 5 次结束 run，
  `agent_settled{warning:"repeated_tool_call"}`）；预算 `limits.maxTurns / maxCostUsd` 与 `--max-turns`、`--max-cost`（事件
  `limit_reached`）；提醒通道 `ama.reminder`（todo 复述、读过的文件被外部改动、上下文 70% / 85%、预算剩余 < 20%、后台命令退出，
  `reminders.*` 逐项可关）；后台 bash（`bash{command, background:true}` 返回 jobId，`bash{job, action: wait | output | stop}`，会话结束
  回收进程树）；模型回退 `fallbackModel`（overloaded 或重试用尽时切过去重试一次，事件 `model_fallback`）。周期收尾阶段入队的
  steer / followUp 不再滞留到下一次提示。
- **系统提示维护**：规则节加两条（破坏性命令先问；独立的只读工具调用放在同一轮）；edit 描述写明多处修改用一次调用的 `edits[]`；
  新增内置 Skill `ama-docs`（配置速查）；Skill 索引改为每条一行；新增提示长度预算测试。

### 模型元数据与渠道

- **models.dev 快照入库**（docs/providers.md「模型元数据」）：22 家主流厂商的裁剪快照随包携带（内联约 180 KB，MIT 声明见
  `THIRD_PARTY_NOTICES.md`），**启动与运行都不联网**；`ama models refresh [--provider <id>]` 显式联网刷新到数据目录（晚于快照才叠加）。
  内置目录改为「快照 ⊕ 覆盖」，与快照相同的值由测试报冗余；dashscope、gemini 2.5 / 3.1 pro、openrouter 部分模型补上价格 / 阶梯价；
  模型新增 `family` / `knowledge` / `releaseDate` / `inputLimit` / `status`。每周的 `.github/workflows/models-dev.yml` 刷新快照并开 PR，
  CI 在每个 PR 上校验这个 workflow 并以 fixture 跑刷新脚本的 dry-run。
- **内置渠道与缺省协议**（docs/providers.md「内置供应商」）：多协议的内置供应商带内置渠道，`provider/model@channel` 直接可选；缺省
  Messages / Responses 优先、Chat 回落（OpenAI、xAI、火山方舟 Responses；通义、MiniMax、阶跃、腾讯 Messages；DeepSeek、智谱、Kimi 暂
  维持 Chat）。用户 `channels` 同名字段级覆盖、新名追加；改了供应商级 `baseUrl` 时内置渠道作废、按单渠道回落。新增内置供应商
  MiniMax、阶跃、火山方舟、腾讯 TokenHub（共 17 家）；Coding Plan 类订阅端点只给配置示例。
- Anthropic 兼容端点按主机推断 compat（交错思考 beta 头只发给官方端点与中转上的 Claude 模型，DeepSeek 不再打 `cache_control`），
  新开关 `sendInterleavedThinkingBeta`、`sendCacheControl`；缓存能力按主机（xAI、Mistral、Kimi 官方端点发 `prompt_cache_key`，
  腾讯 TokenHub 另支持 1h 保留）。价格核对：OpenRouter 的 kimi-k3、glm-5.3 改用现价。
- `scripts/channel-probe.mjs`：渠道实测门（每模型 ≤ 8 请求），中转上五家对比见 docs/providers.md「渠道实测」。

### 图像

- docs/providers.md「图像输入」。单图上限按 base64 后计算并按端点分档（官方 Anthropic 10 MB、Gemini / OpenAI 20 MB、中转与未知 5 MB），
  任一边超 8000 px 拒绝；超限时按 `images.resize`（缺省 `auto`）用 `sips` / ImageMagick 缩放（`--image`、`@图片`、粘贴的图片都适用）。
  请求图片总量超预算（Anthropic 32 MB、其它 20 MB）时把最旧的图换成占位文本（`context_edit{reason:"image_budget"}`），提示一次。
- 剪贴板图片：`Ctrl+V` / `/paste` 存进 `<数据目录>/clipboard/` 并插入 `@<路径>`（新键位动作 `app.paste.image`）；
  `ama sessions prune` 清理超过 7 天的剪贴板文件。

### 状态行与界面

- **底部信息行**（docs/tui.md「状态栏」）：独立终端缺省两行——上方速率行 `tps: 100 tok/s • 546 tok / 5.5s (avg 100 · ttft 1.4s)`
  与用量项，下方 `模式 | 模型 思考 | Ctx 3.0% | 目录 ⎇ 分支 短提交 (+a,-d) | $费用 | 会话时长`（git 直接读 `.git/HEAD`，增删行在
  回合边界后台跑 `git diff --numstat`，≥ 10 s 一次、2 s 超时即停用，`AMA_STATUS_GIT=0` 关闭）。嵌入宿主缺省一行
  （`ui.statusLine: "compact"`）。`Ctrl+G` 或 `/statusline [full|compact]` 本会话内切换。费用计入外部 Agent 的美元用量。RPC 新增
  `telemetry_tick` 事件（≤ 2 Hz）与 `get_session_stats` 的 `telemetry`。
- 模型回退时状态栏显示 `主模型 → 回退模型`；预算到限、模型回退、后台命令启动 / 退出各给一行中文提示；「compaction did not shrink」
  显示中文说明。

### 接口、测试与发布

- 第五波契约（docs/wave5-plan.md §9–§10，全部可选、向后兼容）：会话扩展点 `SessionExtension`（`cli/compose-extensions.ts` 组装表）；
  RPC 命令表 42 条；`HostApi.runners` 可选面；子路径 `@armadra/agent/acp`；第五波配置键的校验、说明与 JSON Schema。
- bundle 级 e2e 新增 ACP（ama 经 `task(agent="acp:ama")` 驱动另一个 ama）、Plan（`-p` 退出 9 与 `unattended: approve`）、子 Agent
  （前台与后台通知）、回滚（RPC 与跨进程）。
- npm 包增带 `docs/plan.md`、`docs/agents.md`、`docs/acp.md`、`docs/rewind-plan.md`、`docs/tui-design.md`；README 里其余设计文档改用
  GitHub 链接。
- `scripts/bench-presets.mjs` 新增三个多步长任务（`--tasks long`）；对照组名 `default+todo` 改为显式 `tools.default: ["+todo"]`
  （原来是 `default` 的别名），`default-todo` 不变。

### 基准

- **D20：todo 不进 `default` 预设**。开发期间曾把 `todo` 加进 `default`，以 `bench-presets` 复测为门（估价涨幅 ≤ 5% 且成功数
  不降）。W5-H2 的小任务首测（docs/benchmarks/presets-todo-2026-10-02.md，5 对、模型从未调用 todo）按门保留；本版用三个多步长任务
  （`--tasks long`）、kimi-k2.5 与 deepseek-v4-flash、每组 3 次复测（docs/benchmarks/presets-todo-2026-10-03.md，18 对）：含 todo 组成功
  17/18、对照 18/18，统一估价 +4.6%、输入 token +15.8%、保守计价 +11.3%，36 次运行里只有 1 次调用了 todo → **按门撤出**，计划交接改用
  `[DONE:n]`。复测 212 次请求，约 $0.27。

### 已知限制

- Linux 沙箱未在真机上验证（bubblewrap 的策略只经单元测试与 Ubuntu CI 验证；没有 bwrap 时退到 `unshare`，不能用于 bash 沙箱）。
- 外部 Agent 的真实 CLI 端到端只在本地跑：本机已登录 `claude` / `codex` 时 `AMA_E2E_AGENTS=1`（会用订阅额度）；CI 只跑录制回放与
  ama 驱动 ama。
- DeepSeek、智谱、Kimi 缺省仍走 Chat，等官方直连过了实测门再切 Messages。
- models.dev 每周刷新的 PR 需要仓库 secret `MODELS_DEV_PR_TOKEN` 才会触发 CI（没有时 workflow 自跑 `pnpm run ci` 并写进 PR 描述）。

## 0.4.0（2026-10-02）

- **终端界面重做**（视觉规格见 docs/tui-design.md）：带框启动头（模型 / 目录 / 模式 / 已加载资源，窄屏去框）；
  工具调用改 `⏺ 工具名 摘要` + `⎿ 一行结果摘要` + 缩进正文三级层级，相邻调用不空行，运行中摘要行带 spinner 与秒数，
  diff 带行号；思考块 `✻ 思考 · N token`，`Ctrl+O` 同时展开思考；运行中动词（思考中 / 回复中 · ↓≈N / 运行 bash /
  等待确认 / 重试 / 压缩上下文）；输入框 `›` 提示符与占位；状态栏两区（左模式 + `shift+tab 切换`，右用量，
  模型名按宽度缩写）；审批对话框编号选项（1–3 / ↑↓ Enter，危险命令缺省选中拒绝，边框随严重度着色）；
  `/session` `/cache` `/permissions` 改为左竖条面板；退出时留一行会话摘要与 `ama --resume <id>`。
  新配置 `ui.theme: "auto"`、`ui.ascii`（`AMA_ASCII=1`）、`ui.compact`、`ui.animation`。
- **破坏性变更（`@armadra/agent/tui` 与界面文本）**：`SemanticColor` 增加 `muted` / `link` / `selection`，`Theme`
  增加必填的 `glyphs`——自己实现 `Theme` 的宿主需补这 3 个颜色与字形表（可用 `UNICODE_GLYPHS`）；`Loader` 渲染从
  `⠋ 消息 (12s)` 改为 `⠋ 动词 · 12s · 附加项`；粘贴折叠标记从 `[paste #N +M lines]` 改为 `[粘贴 #N · M 行]`；
  状态栏不再有 `mode:` / `think:` / `preset:` 前缀（模式移到最左，`preset` 只在非 default 时出现），按 `mode:` 解析
  状态栏的脚本需改为取最左一项；排队消息标签 `↳ steer` / `↳ followUp` / `↳ host` 改为 `↳ 插话` / `↳ 之后` / `↳ 宿主`
  （会话文件里的 `origin` 不变）；`/permission` 选择器标题 `Mode` 改为「权限模式」。
- **codemode 缺省开放**：`codemode.mode` 不写时跟随预设——`default` 预设在沙箱网络隔离（Node ≥ 25）时带上
  `codemode`（六个工具 + codemode），Node 22 / 24 缺省不开并在启动时提示一次（每个配置目录一次，记在数据目录
  `notices.json`），`--codemode on` 或 config 显式开启；`minimal` / `coordinator` 不开。缺省配置不写这个键。
- **修复：coordinator 经 codemode 绕过**：`coordinator` 预设显式开了 codemode 时，脚本里只能调活动集里的工具
  （read 与宿主工具），`tools.bash` / `tools.write` 不再可达。
- **on 模式去重**：`codemode` 描述不再内联已直接暴露的工具声明，其它工具描述也不再追加提示，只列「参数同直接
  工具」与「仅脚本可调用」的名字；系统提示 + 工具表比 off 只多约 390 token（原约 1356）。`--codemode on` 的旧会话
  续接时描述字节变化，会有一次缓存未命中。
- **预设改名**：`codemode` 预设更名 `codemode-only`；旧名作别名继续可用（配置、`--tools-preset`、RPC、SDK、schema），
  `ama config show` 显示规范名并提示。
- **`ama init` 不写死缺省值**：新生成的 `config.json` 只有 `$schema`、`version` 与空 `providers`，以后缺省值调整对老
  用户同样生效；init 结束打印下一步。已存在的文件不动（之前生成的文件里的 `thinkingLevel` / `permission.mode` /
  `tools.preset` 仍会按 user 层生效，想跟随缺省可以删掉）。
- **`ama config show`**：补全 `cache`、`codemode` 等段与每项来源，codemode 写明生效模式与原因；接受
  `--tools-preset` / `--codemode`；`ama doctor` 同样显示 codemode。`config.schema.json` 的每个键都带说明与缺省值。
- **不再展示 fake**：零配置的模型选择器、`doctor`、`models list`、`providers list`、`config show` 缺省不列测试供应商
  `fake`（`AMA_SHOW_FAKE=1` 或 `AMA_FAKE_SCRIPT` 时照列，`--model fake/…` 照常可用）；没有可用模型时提示 key 环境变量、
  `ama auth set` 与 `ama providers add`。
- **缺省模型**：自定义供应商（中转站）不再取列表首条，而是在 models.dev 有价格、支持工具调用、上下文 ≥ 64k 的模型里
  取输入价最低的；`ama providers add` 在还没有 `defaultModel` 时按同一规则写入并说明原因。内置供应商仍取目录首条。

- **auto 权限模式**：`--permission-mode auto`（界面显示名 Auto）由 ama 判断每一步——规则层不调模型，危险命令、
  网络命令、删除类命令、机密文件与项目外写入一律询问；静态判定放行只读工具、项目内写入与安全名单里的命令
  （`ls`、`grep`、`git status/diff/log`、`npm test`、`tsc --noEmit`、`cargo test` 等，`permission.autoSafeCommands` 追加）；
  其余交给一次独立的模型分类器（`permission.autoModel`，不影响主会话缓存，用量记 `permission_classify`）。
  事件带 `autoDecision`，`/permissions` 显示最近判定。见 docs/permissions.md。
- **allowlist 模式**：只放行只读工具与 allow 规则命中的调用，其余直接拒绝、从不询问，适合 CI。
- **模式选择器**：`/permission` 打开 Mode 列表（显示名 + 说明、数字 1–6、当前打勾、Default / Recommended），
  `Shift+Tab` 循环 Manual → Accept edits → Plan → Auto → Bypass permissions，状态栏显示显示名。
  项目级配置不能设 `auto` / `full-auto`。
- **测试隔离**：组装测试不再把会话写进真实数据目录，测试结束检查真实 `~/.local/share/ama` / `~/.config/ama` 有无新增。

- **探测提速**：`ama providers add|refresh --probe` 与 `ama models discover --probe` 并发探测（`--concurrency`，缺省 6），
  流里出现首个内容事件即判可用并断开，单次超时缩到 15 s（`--probe-timeout`）；429 时降并发并重试一次，
  连续 429 才停止。实测 22 个模型、60 次探测从预计 20–30 分钟降到约 85 s。
  降并发之后连续 4 次没被限流就并发 +1，回到初始并发为止。

- **流空闲超时**：模型请求等响应头、以及流里两块数据之间缺省 300 s 没有任何字节即判卡住，按可重试错误重试；
  `request.idleTimeoutMs`（用户级）或 `AMA_IDLE_TIMEOUT_MS` 调整，0 关闭。服务端发一块就停住不再让 `-p` 永久挂起。
- **`-p` 与 stdin**：`git diff | ama -p "审阅"` 照旧把管道内容拼在提示后面；有提示参数时只等管道首字节 2 秒
  （`AMA_STDIN_WAIT_MS` 可调，0 = 不等），一个字节都没有就忽略 stdin 并在 stderr 提示，父进程留着不关的管道不再让
  `-p` 挂起；收到首字节后读到 EOF。末尾加 `-` 一直等到 EOF（上游要先跑很久才输出时用），`< 文件` 照常读取；没有提示
  参数时等 stdin 超过 3 s 提示一次；`--no-stdin` 完全不读。
- **`-p` 无人值守的拒绝可见**：被拒的工具调用在 stderr 汇总（工具、原因、放行办法），`json` 结果带 `deniedTools`，
  `tool_execution_end` 带 `denied: true`，退出码 7（新增）。重试期间 stderr 每次一行 `↻`。
- **新参数**：`-p --max-turns N`（到上限仍在调工具时退出 1，`json` 带 `maxTurnsReached`）、
  `--system-prompt <文本|@文件>` 与 `--system-prompt-mode append|replace`（缺省作为最后一条规则追加，缓存前缀不变）、
  `--no-session`（会话不落盘）。
- **报错准确**：`provider/model@渠道` 渠道不存在时报「渠道不存在」并列出该模型的可用渠道（中转供应商不再把 `@后缀`
  当成模型 id 发出去）；供应商写错报「供应商不存在」并给编辑距离最近的候选；模型写错列出最接近的几个。
- **代理**：设了 `HTTPS_PROXY` / `HTTP_PROXY` 时启动即启用 Node 内置的环境变量代理（`NO_PROXY` 生效），Node 22.21 以前
  提示一次并直连；`ama doctor` 新增「代理」一节。
- **行式管道模式**：模型错误只在运行结束时打印一次，有运行失败时退出码 1（以前 0）。
- **只读命令不写盘**：`config show` / `path`、`doctor`、`models list` 等不再创建配置目录，首次自动初始化只在进入对话的
  命令与 `providers add` 里触发。

- **会话统计**：`ama stats` 只读扫描会话，汇总请求（对话、保温、权限分类、压缩分开计）、回合与平均耗时、
  token、缓存命中率（只算报告缓存的端点）、费用（只加有价请求）、错误与重试、工具调用 Top N；
  `--since` / `--until` / `--by day|week|month|provider|channel|model|project` / `--json`；
  增量索引 `<数据目录>/stats-index.json`，1000 个会话冷扫描约 160 ms。
- **会话检索与导出**：`ama sessions search <关键词|/正则/>`（`--role`、`--since`、`--limit`，TTY 高亮）；
  `ama sessions export <id> --format md|json|jsonl [--branch leaf|all] [--output]`，导出前脱敏 key / token。
- **复用**：`ama sessions show` 列出用户消息编号；`--from <id>[#编号]` 用那条消息作新提示（`-p` 时连图片），
  可配合 `--model` 换模型重问。见 docs/sessions.md。
- **发布**：release job 优先用 npm 可信发布（OIDC，npm ≥ 11.5.1），`NPM_TOKEN` 只作回退；需要在 npmjs.com
  为 `@armadra/agent` 添加 Trusted Publisher（Owlbay / armadra-agent / ci.yml）。

## 0.3.0（2026-10-02）

自定义供应商与多渠道、models.dev 模型元数据、图像输入、默认配置目录。

- **一键接入**：`ama providers add <id> --base-url <url>` 只要 baseUrl 与 key——列出中转的模型、按提示或 `--probe` 逐渠道
  探测、写进配置；`list` / `channels` / `remove` / `refresh`。
- **渠道**：一个供应商可挂多个渠道（协议 + 地址 + 可选 key / headers / compat），模型声明 `channels`，
  `provider/model@channel` 指定渠道；旧配置按隐式 `default` 渠道处理，不用改。
- **models.dev 元数据**：上下文、输出上限、图像输入、推理、价格缺省从 models.dev 补（数据目录缓存，启动不联网），
  `ama models refresh-catalog` 刷新；`models list` / `config show` 标出每个字段的来源。
- **图像输入**：`-p --image`、界面里 `@图片路径`；与 read 工具共用 MIME 检测与 5 MB 上限；模型不收图片时拒绝。
- **配置目录**：首次运行自动建 `~/.config/ama/` 与最小 `config.json`、`config.schema.json`；`ama init`、
  `ama config path`、`ama config edit`。
- **修复**：Responses 的 `incomplete_details.reason: "length"` 按输出截断处理（中转转发 DeepSeek 时出现）。

## 0.2.1（2026-10-02）

npm 首发：`npm i -g @armadra/agent`。功能与 0.2.0 相同。

- **npm 发布**：包名 `@armadra/agent`；打 `v*` tag 时 CI 在生成 GitHub Release 之后执行 `npm publish --provenance`（仓库未配置 `NPM_TOKEN` 时跳过）。
- **包元数据**：仓库地址改为 `Owlbay/armadra-agent`，补 keywords、homepage、bugs、author、`sideEffects`；包里带用户文档（providers / tui / codemode / hooks / host-api / rpc / session-format）与 CHANGELOG，不再带源映射与测试辅助，解包体积约 2.9 MB。
- **README**：重写为完整介绍——定位、特性、安装、配置、中转站、工具预设、缓存、安全、各入口与 SDK、嵌入 Armadra。

## 0.2.0（2026-10-02）

首个可用版本。

- **模型接入**：协议与供应商数据分离，四条协议线（Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Google Generative AI），13 家内置供应商与自定义供应商、模型级协议；只用 API Key；`ama models discover` 从中转站 `/v1/models` 探测协议并写入配置，`OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` 零配置接入。
- **调用**：内置工具与工具预设（`default` / `minimal` / `codemode` / `coordinator`），codemode（`node --permission` 子进程 + vm 沙箱，脚本内调用照样走权限管线），`task` 子 Agent，Skill（`/skill:`），不接 MCP。
- **安全**：权限管线（拒绝 → 危险命令 → 模式 → 允许）、危险命令识别穿透 `sh -c` / `eval` / `xargs` / `find -exec` 与 git 全局选项、项目级配置只能收紧、项目信任、审批时的执行前预览。
- **Hook**：命令式 Hook（9 个事件）与进程内宿主适配器 HostApi。
- **缓存**：前缀逐字节稳定、各协议缓存字段与兼容开关（400 自动剥离）、前缀指纹与未命中归因、不报缓存的三态与分块粒度推断、`off / streaming / idle` 保温、压缩摘要按会话前缀续写、状态栏 / `/session` / `/cache` / `ama models cache-probe`。
- **会话**：JSONL 条目树、分叉与 `/tree`、两档压缩与熔断。
- **入口**：差分渲染终端界面（主屏模式）、`--no-tui` 行式、`-p`（text / json / stream-json）、`--mode rpc`、SDK。
- **发布物**：`ama.cjs` 与 `ama-sandbox.cjs` 两个单文件 bundle、`package.tgz`、`SHA256SUMS`；暂不发布 npm。
