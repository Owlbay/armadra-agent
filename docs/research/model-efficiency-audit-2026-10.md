# ama 模型调用效率审计（2026-10-10，main 6f4b4b7 / 0.7.3）

> 范围：缓存命中、token 用量、请求次数与延迟、失败与重试。只读调研：仓库没有改动；构建产物与实验脚本都放在仓库外的临时目录，不随仓库保存。
> 实测共 **12 次**真实请求，都经中转 `packy`，单次输出 ≤ 64 token，合计按目录价或保守价估算 < $0.02。key 由 ama 的注册表在内部解析，没有读取或打印。其中 2 次是 `ama models check` 发出的可用性请求：本想只看元数据，没注意到它会发请求，也计在内。另外用 fake 供应商录制了 3 种预设的请求体和一次「中途加工具」，这部分不花钱。
> 本文是 [model-efficiency-plan.md](../history/model-efficiency-plan.md) 的依据，只用于追溯；代码行号对应写作时的 `main`，现状以代码与 `docs/` 其余文档为准。

## 结论

1. **相邻回合的字节稳定已经做得很好**。三种预设录制的请求体，system 和 tools 在回合之间逐字节相同；中途加工具只在工具表末尾追加；#128 之后，中途的系统节补丁改为尾部 reminder，不再改写开头。**剩下的损失集中在「换序列」的时刻**：
   - 子 Agent 启动，每次都从 system 开始重建；
   - 压缩后的首个请求，system 段也不命中；
   - 移除工具；
   - 「先裁剪、后摘要」时，摘要续写失效；
   - Anthropic 一个回合里并行调用很多工具时，超出 20 块回看窗口。
2. **收益最大的单项是 fork 式子 Agent（P1-1）**。实测：父会话前缀 16.4k，DeepSeek 上 fork 子会话首个请求命中 **16384 / 16421（≈100%）**，Kimi 上 **15616 / 15754（99%）**。现行子会话（system + role）在 DeepSeek 上是 0 / 1967（前缀不足 2048 粒度），在 Kimi 上是 1280 / 1365。前提是子任务确实需要父会话的上下文，否则 fork 每个回合都要多读一段缓存（见方案里的经济性一段）。
3. **把「开头的 system + tools 会话内只写一次」定为不变量（P1-2）**，可以一并解决未落地项 2（压缩时补丁折回开头）和未落地项 3（移除工具改写开头）。实测「保留工具声明 + 尾部提醒该工具不可用」：DeepSeek 和 Kimi 都改用其它工具（glob），缓存命中 100% / 99%。执行层本来就会拒绝不在活动集里的工具（`src/agent/session-tools.ts:155`），只需要改请求投影这一层。
4. **摘要续写有一处会让它整次失效（P1-3）**：`checkThreshold` 先裁剪、裁完仍然超预算再摘要。裁剪写入的 `context_edit` 使当前转录不再以上一次请求为前缀，续写因此判定不成立，回落为全价的独立请求。另外两个边界也要处理：开思考时续写的 `maxTokens` 只有 4096；缓存已冷时续写反而比独立请求贵。
5. **失败与重试（P1-5、P1-6）**：
   - 解析出的 `Retry-After` 没有传到会话层，退避固定为 2 / 4 / 8 s；
   - `max_tokens` 每次都发模型上限；
   - 端点报「max_tokens 超出范围」时不会收紧后重试。实测 packy/kimi-k2.5 的 max_tokens 上限是 98304，而官方目录给 Kimi 的上限是 262k；
   - Anthropic 的 4 个断点只用了 3 个，并行工具调用多时可能整段重写（P1-4）。
6. **中转模型继承官方目录（P1-7）**：只继承模型固有的属性（`thinkingLevelMap`、`promptCache.minTokens`、推理回传这类特征）。TTL、价格、端点能力都不继承。另外中转模型的 id 和官方 id 不一致（`deepseek-v4-flash` 对 `deepseek-flash`），需要别名表。
7. **价值低、不建议做的**：
   - 继续精简前缀：default 约 1.45k token，大部分在缓存里；DeepSeek 前几个回合前缀不足 2048，读数本来就是 0。
   - Responses 的 `previous_response_id`：需要 `store: true`，计费不变。
   - Gemini 显式缓存：要付存储费，起步门槛高，ama 的前缀太小。
   - 改动缺省预设：已有基准支撑现状。

## 改进清单（按收益排序）

规模：S ≤ 1 天，M 2–4 天，L ≥ 1 周（含测试与双语文档）。

### P1-1 fork 式子 Agent：继承父会话的平衡前缀（未落地项 1）

- **问题**：子会话的 system 是「父会话的静态节 + `role` 节」，历史为空（`src/agent/session-subagent.ts:236`）。子会话只能和父会话共享 system + tools 这一段，大约 1–2k；在 2048 粒度的端点上读数恒为 0。子任务要了解父会话已经知道的内容，只能重新读文件，按全价计费，还要多跑几个回合。
- **证据**：
  - `docs/guides/agents.md:168`：「不支持 fork 模式」；
  - `src/agent/session-cache.ts:92`：task 子会话不沿用父会话的 `prompt_cache_key`；
  - 实测数据见文末表格中的 F1–F3。
- **方案**：
  1. `task` 增加 `context: "fork" | "fresh"`，智能体类型的 frontmatter 也可以声明，缺省 `fresh`。先作为显式选项，用基准数据决定以后是否自动选择。
  2. fork 点取「父会话上一次真实请求的消息序列」，也就是不含正在执行 task 调用的那条 assistant。复用 `SessionManager.fork(entryId)`（`src/session/manager.ts:270`，`/fork` 已经在用），把父会话分支复制成子会话文件，再追加 `custom{ama.task, mode:"fork"}`。
  3. **子会话不写 `role` 节**。角色说明和任务合成一条 user 消息，放在继承历史之后：`<task>` 包裹，写明「你是从上面的对话 fork 出来的子 Agent，父会话看不到你的过程……」。这样子会话的 system 和 tools 就是父会话已经发出的那一份，补丁和 reminder 都随历史一起复制，与父会话逐字节相同。
  4. **工具表保持和父会话一致**。智能体类型声明的 `tools` / `disallowed-tools` 改由执行层拒绝，再在任务消息里写一句可用工具清单，与 P1-2 的「保留声明 + 提醒」同一做法。只读类型沿用 `readOnlyPermission`（权限层）。
  5. **模型和思考级别必须与父会话相同**，否则回落为 `fresh`。Anthropic 上思考参数一变，消息段缓存就失效。`prompt_cache_key` 沿用父会话的 key（`cacheKeyOf` 对 `mode:"fork"` 不再排除）。
  6. **worktree 隔离**：system 的 `cwd` 节保持父会话的值，不改前缀；任务消息写明「你的工作目录是 <worktree>，历史里的相对路径以父目录为准」，工具按子会话的 cwd 执行。`readFiles` 集合从空开始，在 worktree 里编辑前必须先读，安全性不变。
  7. **体积闸门**：父会话上下文超过子模型预算的 50%（可配置）时改用 `fresh`，避免子会话一开始就触发压缩。
  8. **经济性**：fork 子会话的每个回合都要多读 P 个缓存 token（P 为父会话前缀）。
     - DeepSeek：命中价约为未命中价的 1/50，16k 缓存约等于 330 个全价 token，基本总是划算；
     - Kimi / Anthropic：比值约 1/4–1/10，只有子任务真的依赖父会话上下文（否则要重读文件或重问）时才划算。所以 `explore` 缺省用 `fresh`，`general` 是否缺省用 `fork` 由基准决定。
- **涉及文件**：`src/agent/session-subagent.ts`、`subagent-registry.ts`（`rebuildRecords` 目前按首条条目识别 task，fork 后 task 条目不再是首条，需要调整）、`src/agents/builtin.ts`、`src/agents/parse.ts`（frontmatter 的 `context`）、`src/tools/task.ts`（参数与描述）、`src/agent/session-cache.ts`（`cacheKeyOf`）、`docs/guides/agents.md`、`docs/design/design.md` §5.2 / §9.1、`docs/reference/session-format.md`（`ama.task` 的 data 增加可选字段，不涉及版本号）。
- **规模**：L。
- **预期收益**：子任务首个请求从「0 读 + 后续重读文件」变为「≈100% 读」。在 DeepSeek 上，需要父会话上下文的子任务，输入费用可降一个数量级。另外能少几个「重新定位」的回合。
- **风险**：
  - 子会话上下文变大，压缩会更早触发；
  - 父会话历史里的 reminder 和计划消息会被子会话看到，任务消息里要写明以哪条为准；
  - `task` 的工具描述要加一个参数，default 前缀约多 15 token，`prompt-budget` default 还剩约 550 token 余量，可以接受；
  - 不影响父会话前缀。

### P1-2 不变量：开头的 system + tools 会话内只写一次（未落地项 2、3）

**(a) 压缩时，补丁不再折回开头**

- **问题**：投影在有压缩时，把压缩点之前的**所有** system 消息（包括中途补丁）折成一条完整的检查点放在最前（`src/session/projection.ts:185-195`）。只要压缩前出现过节补丁，压缩后的首个请求连 system 段也不命中。下面这些都会产生补丁：
  - resume 时 AGENTS.md 变了；
  - Hook 或宿主 instructions 刷新；
  - **开启记忆后，每次压缩结束都会重新渲染 `memory` 节**（`src/cli/compose-memory.ts:134`），所以下一次压缩前几乎必然有补丁。

  另有一处细节：重放时，同名工具被重定义，`replaySystem` 用 delete + set 把它移到末尾（`projection.ts:159`），而请求组装 `context.ts:50` 用 set，保留原位置。压缩前后的工具顺序因此可能不同。

- **方案**：
  - 检查点只取「开头」，即首条非 system 条目之前的 system 消息重放结果。此后的补丁按「最终值与开头不同的节」合并成一条 system 补丁，放在 compaction 摘要之后，由 `normalizeContext` 渲染成一条 `<system-reminder>`。
  - 工具表按完整状态输出，顺序与压缩前的请求一致：两处重放统一为「保留原位、只换内容」。
  - 多次压缩时，开头不会再变，递归下去也成立。
- **(b) 移除工具改为「保留声明 + 尾部提醒 + 执行时拒绝」**
  - 现状：`removesToolsMidway` 一旦为真，**所有**补丁都折回开头（`src/ai/context.ts:94, 108, 120`）。连之前已经以 reminder 送达的补丁也会消失，整段前缀失效。
  - 方案：
    - `diffSystem` 仍然记录 `toolsRemoved`（会话事实不变）。
    - 请求投影改为：被移除的工具保留在请求工具表里，同时在尾部 reminder 写一句「Tool X is no longer available in this session; calls to it are rejected」。
    - 执行层已经按活动集拒绝（`src/agent/session-tools.ts:155`，报 `Tool X not found`），把文案改成「not available in this session」，模型理解得更准确。
    - 被重新加回的工具同样只发 reminder。
    - `removesToolsMidway` 和折回分支可以删除。
- **(c) 新增工具的现状**：在请求转录层面已经是增量。实测中途 `addTool` 之后，前 7 个工具声明逐字节相同，新工具追加在末尾，system 文本不变。**但在缓存层面不是增量**：
  - Anthropic 的顺序是 tools → system → messages；
  - OpenAI 系模板通常把工具渲染在 system 段里；

  所以追加一个工具会让它之后的所有内容失效。E4 在 Kimi 上实测读到 0（`docs/benchmarks/cache-2026-10-02.md:19`）。真正的增量做法：
  - 宿主在 `create()` 阶段注册完工具（§9.1 已有这条要求）；
  - 或者在 codemode 开启时，把晚到的工具作为「仅脚本可调用」：工具表不变，用一条 reminder 给出 TypeScript 声明，`describeTool()` 照常可用。

- **涉及文件**：`src/session/projection.ts`、`src/ai/context.ts`、`src/agent/session-sync.ts`（`keepSectionsOnToolAppend` 可以同时保留被移除工具的 tools / rules 节）、`src/agent/session-tools.ts`（拒绝文案）、`src/cli/cache-stability.test.ts`（增加两条：压缩前有补丁时，压缩后首个请求的 system + tools 与压缩前逐字节相同；移除工具后 system + tools 不变，上一次请求的消息是前缀）、`docs/design/design.md` §9.1（把「只有移除工具的补丁折回开头」改为「开头永不改写」）、`docs/guides/providers.md`「缓存」。
- **规模**：M。
- **预期收益**：
  - 每次压缩少全价重读一次 S（S = system + tools，1.5k–10k+，带 AGENTS.md、Skills 和记忆时更大）；
  - 每次移除工具从「全量失效」（整个上下文全价重读，30k 上下文在 DeepSeek 上约等于 50 次正常回合）降为 0；
  - 后续 P1-4 的工具断点也可以腾出来。
- **风险**：
  - 被移除工具的声明仍然占 token，单个工具约 120–150 token，在缓存里；
  - 模型偶尔仍会调用被移除的工具，执行层会拒绝，多一个回合。实测两种模型都遵守了提醒；
  - 不影响 `prompt-budget`。

### P1-3 摘要续写的命中边界（未落地项 2 的后半）

- **现状**：续写确实复用上一次请求的前缀，Kimi 上 98.8%（`docs/benchmarks/cache-2026-10-02.md` E3 复测）。条件在 `src/agent/session-cache.ts:364-406`：模型相同、上一次请求逐条是前缀、窗口放得下。
- **问题与方案**：
  1. **先裁剪、后摘要，续写必然失效**：`checkThreshold`（`src/agent/session-compaction.ts:221-229`）先 `prune`，写入 `context_edit` 并 `reloadMessages`；仍然超预算才摘要。这时 `summaryContinuation()` 逐条比较（`session-cache.ts:381`），被裁剪的结果对不上，于是回落为独立请求：全价，工具结果截到 2000 字符。
     - 方案：先用 `planPrune` 估算裁剪后的量，**裁完仍然 > budget 就跳过裁剪，直接续写摘要**（被裁剪的内容本来就会进摘要）。
     - 规模 S。收益：每次「裁剪不够、需要摘要」的压缩，从全价独立请求变成按缓存价续写。DeepSeek 上约便宜 25–50 倍，Anthropic 上约 10 倍。
  2. **开思考时的输出上限**：续写沿用回合的 `thinkingLevel`，但 `maxTokens` 只取 4096（`src/compaction/summarize-tier.ts:387-388`）。在 max_tokens 把推理也算进去的端点上，可能因 `length` 回落，等于花了两次钱。
     - 方案：思考开启并且是非预算型协议时，续写的 `maxTokens` 取 `4096 + 该级别的推理预算`（例如 16k）。在 OpenAI 系端点上，改 max_tokens 不影响前缀；预算型 Anthropic 已经沿用回合的值。
  3. **缓存已冷**（目录承诺了 TTL 且已经超时，`isCold()` 为真）时，续写要按全价付整段上下文；独立请求因为截断了工具结果反而更小。方案：冷的时候直接走独立请求。
  4. 溢出恢复不走续写，这是合理的，保持不变。
- **涉及文件**：`src/agent/session-compaction.ts`、`src/agent/session-cache.ts`、`src/compaction/summarize-tier.ts`、`src/compaction/continuation.test.ts`、`session-compaction.test.ts`。
- **风险**：(1) 改变的是「裁剪和摘要」的先后，测试断言要相应修改，PR 需要说明理由（原断言是先裁剪）。不影响前缀。

### P1-4 Anthropic 第 4 个断点：上一次请求的末条 user

- **问题**：现在用 3 个断点：最后一条 user、system 末尾、最后一个工具（`src/ai/apis/anthropic-request.ts:283-292`），上限是 4 个。Anthropic 命中时只在断点前回看 20 个内容块。一个回合如果并行 N 个工具调用，两次请求的断点之间大约有 2N + 3 个块（thinking、text、N 个 tool_use，再加 N 个 tool_result）。N ≥ 9 时超出回看范围，整段上下文按 1.25 倍重写。规则里有「把独立的只读调用合并到一个回合」，codemode 的场景下这种情况并不少见。
- **方案**：第 4 个断点打在**上一次请求最后一条 user 消息的末块**，也就是上一次的写入点，保证一定能接上。P1-2 完成后，开头不再变化，工具断点就是多余的（system 末尾的断点已经覆盖 tools → system），可以腾给它。
- **涉及文件**：`src/ai/apis/anthropic-request.ts`（`markLastUser` 增加「倒数第二个 user 回合」）、请求体快照测试、`docs/design/design.md` §3.6 和 §9.1「Anthropic 显式断点」一行。
- **规模**：S。**收益**：消除大批并行调用之后的整段重写，每次省约 1.25 × 上下文 的写入费。**风险**：只能在官方端点上实测；中转缺省也发 `cache_control`，行为相同。不影响前缀。

### P1-5 重试与退避

- **问题**：
  1. `HttpError.retryAfterMs` 已经从 `Retry-After` 解析出来（`src/ai/http.ts:182, 242`），但没有传到 `AssistantMessage`。会话层固定按 2 / 4 / 8 s 退避，3 次合计约 14 s 就放弃（`src/agent/retry.ts:86-89`，`session-run.ts:285`）。Anthropic 和 OpenAI 的 429 常常要求等 20–60 s，于是重试用尽，接着切到回退模型，整段上下文按全价重读。
  2. `/\b5\d\d\b/`（`retry.ts:42`）会把错误文案里的「500 tokens」之类的数字也判为可重试。
  3. 遇到 overloaded 时**第一次就直接切回退模型**（`session-run.ts:105`），不先重试一次。回退模型没有缓存，大上下文时代价很高。
- **方案**：
  - 失败的 assistant 消息带上 `retryAfterMs`（协议层的 finishError 写入，属于内部字段，不进协议面）。会话层取 `max(退避, retryAfter)`，加 ±20% 抖动，不超过 `maxDelayMs`。
  - 429 / 529 的重试次数单独放宽到 5 次。
  - 5xx 只匹配 `status` 或开头的状态码。
  - overloaded 先快速重试一次（1–2 s 抖动）。只有当估算的回退代价 `promptTokens × 回退模型输入价` 低于阈值，或者已经重试过，才切换。
- **涉及文件**：`src/ai/apis/shared.ts`、`src/ai/types.ts`（AssistantMessage 加可选字段，需要确认不进 RPC 形状，或者在 docs/reference/rpc.md 里注明）、`src/agent/retry.ts`、`src/agent/session-run.ts`、`src/agent/fallback.test.ts`。
- **规模**：S–M。**收益**：限流时失败和回退更少；回退一次（100k 上下文）在 Anthropic 级别的价格下约 $0.3–1.5。**风险**：重试的总等待变长，TUI 已经有 `auto_retry_start{delayMs}` 展示。

### P1-6 `max_tokens`：按端点范围与窗口收紧，越界自动修正

- **问题**：每次请求都发 `options.maxTokens ?? model.maxTokens`（`openai-request.ts:343`，`anthropic-request.ts:273`）。
  - 目录和 models.dev 给的上限经常等于窗口：kimi-k2.7-code 是 out 262k / ctx 262k，kimi-k3 是 out 1M / ctx 1M，deepseek 是 out 384k。
  - **实测**：packy/kimi-k2.5 发 262144 时返回 400 `Range of max_tokens should be [1, 98304]`。这类错误不算溢出、也不可重试，直接以失败结束。
  - packy/deepseek-v4-flash 发 1,000,000 时被接受（这个中转不校验「输入 + 输出 ≤ 窗口」）。
  - 有些官方端点会校验「输入 + max_tokens ≤ 窗口」（Anthropic 较新的模型有这种严格校验，OpenAI 也有类似的历史行为，需按文档核实）。在 `窗口 − maxTokens` 到 `窗口 − reserveTokens(16k)` 这个区间里，每个请求都会 400；如果文案不在溢出表里，就直接失败。即使被识别为溢出，走的也是溢出恢复，而溢出恢复**不用续写**，是全价独立摘要。
- **方案**：
  1. 请求时 `max_tokens = min(model.maxTokens, 窗口 − 估算输入 − 安全边际)`，下限 4096。Anthropic 预算型思考时预算由 max_tokens 推导，改它会让消息缓存失效，所以只在越界时才收紧，平时保持不变。
  2. 识别「max_tokens 范围」类 400（`Range of max_tokens`、`max_tokens.*(must be|should be|less than or equal)`），解析出上限，在进程内记到 `provider/model`，立即用收紧后的值重发一次（与 400 剥离缓存参数的 `postWithCacheFallback` 同一模式）。
  3. 溢出表补上 Anthropic「input length and `max_tokens` exceed context limit」一类的文案（需要真实样本）。
- **涉及文件**：`src/ai/apis/openai-request.ts`、`anthropic-request.ts`、`openai-responses-request.ts`、`src/ai/apis/cache-params.ts`（剥离重发的模式可以复用）、`src/ai/overflow.ts`。
- **规模**：M。**收益**：消除一类「模型选上就全失败」和「接近窗口时连续 400」的问题，避免全价的溢出摘要。**风险**：Anthropic 预算思考要谨慎处理（见上）；不影响前缀。

### P1-7 中转模型继承官方目录元数据（未落地项 4）

- **现状**：
  - 自定义或中转模型只从 models.dev 补 5 个字段：`contextWindow`、`maxTokens`、`input`、`reasoning`、`cost`（`src/ai/providers/models-dev.ts:478`）。`promptCache`、`thinkingLevelMap`、compat 都没有。
  - OpenAI 兼容的 compat 推断只看 provider id 和 baseUrl（`src/ai/apis/openai-compat.ts:132`），所以 packy 上的 deepseek 走保守缺省：不发 `reasoning_effort` / `thinking`，不强制回传 `reasoning_content`。
  - 实测 `ama models list --provider packy`：`packy/deepseek-v4-flash` 匹配到的是 `alibaba-cn/deepseek-v4-flash`（别的厂商的价格与元数据）。官方目录的 id 是 `deepseek-flash`，**同名精确匹配找不到**。
- **方案**：
  1. 官方目录条目增加 `aliases`，例如 `deepseek-flash` 加上 `["deepseek-v4-flash"]`。匹配时去掉常见的厂商前缀（`deepseek/`、`deepseek-ai/`、`moonshotai/` 等），小写后精确匹配，只接受「唯一命中」。
  2. **只继承模型固有的属性**：
     - `thinkingLevelMap`、`reasoning`、`input`；
     - `promptCache.minTokens`（上游的缓存单元，packy 上实测 2048，与官方一致）；
     - 推理回传这类模型特征：`requiresReasoningContentOnAssistantMessages`。DeepSeek 思考模式下带工具调用时要回传，这是模型要求，与端点无关。
  3. **不继承**：
     - `cost`：中转价格不同；
     - `promptCache.short/long`：TTL 是端点属性。中转可能把请求分到多个上游账号，继承之后会让冷缓存裁剪和保温在 1 小时后提前动作；
     - `sendPromptCacheKey`、长保留这类主机能力；
     - `thinkingFormat`：这是请求形状，中转是否透传 `thinking` 字段要实测，可以经 `ama models discover --probe` 确认后写进 `modelOverrides`。
  4. 来源标为 `catalog (via id)`，`models list` 中显示；可以用 `inherit: false` 关闭。用户写的 `modelOverrides` 优先级最高。
- **涉及文件**：`src/ai/providers/enrich.ts`、`catalog.ts`、`catalog/*.json`（aliases）、`registry.ts`、`docs/guides/providers.md`、`i18n/messages/*`（来源文案，中英文）。
- **规模**：M。
- **收益**：
  - 中转 DeepSeek 首批请求的未命中噪声下限一开始就正确，不必等粒度推断攒够两个样本；
  - 思考级别映射正确；
  - 推理回传的要求不再依赖主机名。

  缓存命中本身的改善主要来自 P1-2 和 P1-3；这一项是正确性与观测上的改进。

- **风险**：别名匹配可能误配。只做唯一精确匹配，并显示来源，可以缓解。

### P2（依次较小或需要先核实）

| #     | 问题                                                                                                                                                                                    | 证据                                                                                   | 方案                                                                                                                                                                                     | 规模 / 收益 / 风险                                                                                                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1  | 工具自身上限 50 KB 和会话层 30 000 字符不一致：30k–50k 的 read / grep / bash 结果被二次截断。read 已经说了「Showing lines 1–N」，中间却被删掉，模型以为自己读全了，接着会再读或判断出错 | `src/tools/truncate.ts:15`、`src/agent/tool-runner.ts:48, 203-236`、`read.ts:146, 173` | 把 `maxToolResultChars` 经 ToolContext 交给工具，由工具一次截断到位；描述里的「50 KB」改为实际上限                                                                                       | S；减少重读，修正误导；描述变化会让前缀多或少几个 token（需要过 prompt-budget）                                                                                                                            |
| P2-2  | `glob` 缺省 1000 条（约 30–50k 字符），必然撞上 30k 截断；grep 100 条，每条最长 500 字符                                                                                                | `src/tools/glob.ts:167`、`grep.ts:31`                                                  | glob 缺省 200，超出时提示收窄范围；grep 保持不变，或超过阈值时自动建议 `filesOnly`                                                                                                       | S；单次结果最多省约 5k token；描述里的 Default 数字变化，影响很小                                                                                                                                          |
| P2-3  | 同一文件反复读：没有「未变化」短回执                                                                                                                                                    | `src/tools/read.ts`（只有 `markRead`）                                                 | 记录 `(path, mtime, size, offset, limit)`。命中并且上一次结果仍在上下文里（没有被裁剪或压缩，订阅 `context_edit` / compaction 失效）时，返回「unchanged since your last read at <turn>」 | M；收益取决于任务，建议先用 trace 统计重复读的占比再做；风险是判断失误时模型拿不到内容，所以必须严格按「仍在上下文」判断                                                                                   |
| P2-4  | auto 模式分类器缺省用会话模型（可能是旗舰模型），每个未决调用都要一次 10 s 级别的请求                                                                                                   | `src/agent/session-classifier.ts:30-41`                                                | 目录为每家供应商标一个 `smallModel`（例如 deepseek-flash、haiku 级、gpt-mini 级），分类器缺省用它，`permission.autoModel` 仍然优先；同一批并行调用合成一次分类请求                       | S–M；auto 模式下延迟和费用下降；分类质量要回归测试                                                                                                                                                         |
| P2-5  | 子会话最后一轮发 `toolChoice: "none"`：E3 已经证明，中转和 Kimi 上这样渲染不带工具定义，整段前缀断开                                                                                    | `src/agent/session-subagent.ts:230`                                                    | 与摘要续写相同：不发 toolChoice，只在指令里写，如果还是调用了工具就拒绝                                                                                                                  | S；只在轮数用尽时触发                                                                                                                                                                                      |
| P2-6  | 工具参数每次用 `JSON.stringify` 重新序列化，与模型原样输出的字节不同，DeepSeek 上「输出结尾」那个单元用不上（上一轮的 #6）                                                              | `src/ai/apis/openai-request.ts:122`                                                    | toolCall 块保存原始 `arguments` 字符串，同模型回放时原样发回；旧会话没有就回落                                                                                                           | S–M；每回合几十到几百 token；不影响会话格式（可选字段）                                                                                                                                                    |
| P2-7  | 未命中归因只能说到 system / tools，说不出是哪一节变了（上一轮的 #7）                                                                                                                    | `src/ai/cache/miss.ts:106`、`fingerprint.ts`                                           | 指纹按节分别记录，`prefix_changed:system` 附上节名                                                                                                                                       | S；只改可观测性                                                                                                                                                                                            |
| P2-8  | 1M 窗口的模型要到约 690k 才裁剪、约 984k 才压缩。每个回合的费用和上下文大小成正比，长会话后期单回合读取量很大，质量也会下降                                                             | `src/compaction/prune-tier.ts:23-24`、`session-compaction.ts:56-60`                    | 增加 `compaction.contextBudget`（软窗口），缺省仍取窗口；在文档里给出按价格选择的建议，例如旗舰模型 200–300k                                                                             | S；对贵模型的长会话效果明显；只是新增选项                                                                                                                                                                  |
| P2-9  | 保温重放发 `maxTokens: 1`；OpenAI 官方（缺省 Responses）的 `max_output_tokens` 下限按文档是 16（需核实），保温可能 400，一直「零命中即停」                                              | `src/agent/session-cache.ts:550`、`openai-responses-request.ts:301`                    | 保温的 maxTokens 取端点下限（Responses 取 16）                                                                                                                                           | S；需要官方 key 实测                                                                                                                                                                                       |
| P2-10 | OpenAI 官方的 `prompt_cache_retention: "24h"` 只在 retention 为 long 时才发，缺省是 short                                                                                               | `src/ai/apis/cache-params.ts:41`、`openai-request.ts:354`                              | 如果核实长保留不额外收费，官方端点缺省用 long；Anthropic 的 1h（写入 2 倍）仍然缺省关                                                                                                    | S；需要先核实价格                                                                                                                                                                                          |
| P2-11 | 流式空闲超时 300 s 同时管首包和包间，断流后要等 5 分钟才开始重试                                                                                                                        | `src/ai/http.ts:97`、`sse.ts:129-141`                                                  | 拆成两个：首包超时（推理模型给长一些）和包间超时（例如 90 s）                                                                                                                            | S；只影响延迟                                                                                                                                                                                              |
| P2-12 | 前缀精简：`Available tools:` 列表和工具描述重复（约 95 token），codemode 描述约 372 token，其中示例约 80                                                                                | 录制：default 约 1446 token（system 1096 字符 + 工具 4689 字符）                       | 可以去掉 `tools` 节，只保留 rules，或者压缩 codemode 示例                                                                                                                                | S；**收益低**：这部分都在缓存里，DeepSeek 前几个回合前缀不足 2048，读数本来就是 0。注意 `minimal` 预算只剩约 60 token，`codemode-only` 只剩约 8 token（按录制的字符数 ÷ 4 估算），以后新增规则要先挪出空间 |

## 系统性排查要点（现状确认，无需改动的写在这里）

- **请求体组装**：节顺序、工具按名排序、键序都固定。三种预设录制的请求在回合之间逐字节相同（default / minimal / codemode-only 分别约 1446 / 740 / 1767 token，上限 2000 / 800 / 1775）。中途加工具只在末尾追加（录制确认）。缺省预设有 presets-2026-10-02 基准支撑，不建议改。
- **每个回合的额外请求**：
  - 没有标题生成（标题取自首条消息）；
  - 记忆和计划都不额外调用模型：计划用尾部 `custom_message`，不改工具表；
  - 额外请求只有四种：摘要、保温（只在 TTL 已知、端点 reported、经济性划算时，缺省 streaming）、分类器（只在 auto 模式下处理未决调用，会话内有缓存）、probe。
- **输出侧**：
  - 思考缺省 medium（`src/config/merge.ts:42`）。
  - 思考内容同模型原样回传：Responses 回传 reasoning item，DeepSeek 回传 `reasoning_content`；跨模型时降级为文本。
  - 断流后会话层重放同一请求，前缀不变所以输入按命中价计；已经生成的输出重新计费，这是固有的。失败的那次尝试用 `context_edit` 剔除，不进上下文。
- **压缩与 TTL**：
  - 档一的 0.7 / 0.5 回差加 `clearAtLeast`，一次改写，摊薄成本；
  - TTL 未知时不做冷缓存提前裁剪（#128）；
  - 唯一的问题是 P1-3(1)。
- **保温**：经济性公式合理，`p·missCost − warmCost ≥ $0.05`。缺省只在工具运行期间保温，子会话不保温，中转（没有 TTL）不保温。除 P2-9 外无需改动。
- **各协议的缓存标记**：
  - Anthropic 见 P1-4；
  - `prompt_cache_key` 只在官方主机上发，task 子会话不沿用（P1-1 的 fork 模式应改为沿用）；
  - Responses 用 `store: false` 加 `include: reasoning.encrypted_content`，不用 `previous_response_id`：后者需要服务端存储，并且不省输入计费，不建议采用；
  - Gemini 只用隐式缓存，显式缓存不划算。
- **并行与 codemode**：工具执行有并行模式，rules 里有「合并只读调用」。codemode 在小任务上不减少回合（基准 5.3 对 5.0），只在批量检索场景省一轮，缺省 `on` 而不是 `only` 是合理的。
- **上一轮报告的落地情况**：
  - 已落地：#1（尾部 reminder）、#3（TTL 未知不判冷）、#4（DeepSeek 目录与 cache-probe）、#7 的一部分（§9.1 增加「只追加」一行）；
  - #2（中途 system）实测不可用，已关闭；
  - 未落地：#5（fork，即 P1-1）、#6（原始参数，即 P2-6）、#7 的节名归因（P2-7）。

## 实测记录

脚本放在仓库外，加载当时 `main` 的构建产物（`dist`）。请求直接经 `ApiRegistry.stream` 发出，`maxTokens: 64`、思考关闭、相邻两次间隔 4 s。system 和 tools 取 ama default 预设的真实录制。父会话历史是 3 次 read 加 3 段确定性文本，约 16k token。

| #   | 模型（packy，chat） | 请求                                                       | input | cacheRead | 读 / 前缀        | 行为                                               |
| --- | ------------------- | ---------------------------------------------------------- | ----- | --------- | ---------------- | -------------------------------------------------- |
| F1  | deepseek-v4-flash   | 父会话回合                                                 | 16397 | 0         | 0%               | —                                                  |
| F2  | deepseek-v4-flash   | fork 子会话：同一前缀 + 任务消息                           | 37    | **16384** | **100%**         | 调用 glob                                          |
| F3  | deepseek-v4-flash   | 现行子会话：system + role + 任务                           | 1967  | 0         | 0%               | —                                                  |
| F1  | kimi-k2.5           | 父会话回合                                                 | 15731 | 0         | 0%               | —                                                  |
| F2  | kimi-k2.5           | fork 子会话                                                | 138   | **15616** | **99%**          | 调用 glob                                          |
| F3  | kimi-k2.5           | 现行子会话                                                 | 85    | 1280      | 94%（只有 1.3k） | —                                                  |
| T1  | deepseek-v4-flash   | 保留 bash 声明 + 尾部「bash 不可用」，再要求「列出根目录」 | 48    | 16384     | 100%             | **改用 glob，没有调用 bash**                       |
| T1  | kimi-k2.5           | 同上                                                       | 148   | 15616     | 99%              | **改用 glob**                                      |
| M1  | kimi-k2.5           | `max_tokens = 262144`（= 窗口）                            | —     | —         | —                | **400 `Range of max_tokens should be [1, 98304]`** |
| M2  | deepseek-v4-flash   | `max_tokens = 1,000,000`（= 窗口）                         | 90    | 0         | —                | 正常返回（中转不校验输入 + 输出）                  |

再加 `models check` 的 2 次（packy/deepseek-v4-flash、packy/kimi-k2.5 各 1 次，可用），合计 12 次。fake 录制（不花钱）：三种预设各 3 个回合 system + tools 逐字节相同；中途 `addTool` 之后，前 7 个工具声明不变，新工具追加在末尾。

局限：

- 每种情况只测一次，只取方向一致的结论；
- 中转的上游和粒度无法与官方区分；
- Anthropic 的 20 块回看（P1-4）、OpenAI 保温下限（P2-9）、24h 保留的价格（P2-10）、Anthropic 严格的 max_tokens 校验（P1-6），都需要官方 key 才能实测，这次没有测。
