# 第三波设计与实施计划

> 状态：实施设计（2026-10-02）。基线：`main` = `68c2beb`（B1–B6、B8、B10 已合入，`pnpm run ci` 约 1250 测试绿）；B7 交互模式已合入 main（PR #12）。
> 设计依据：`docs/design/design.md`（§5.5 codemode、§5.6 预设、§9 压缩、§9.1 缓存保证、§10.0 精简配置、§13 SDK / RPC）、`docs/history/implementation-plan.md`（§6 B9、§7 表 A / 表 B、§9 增补）、生态调研（只吸收设计，不复制代码；文中不点名第三方，以「同类工具」「生态里的某类插件」指代）、真实中转实测。
> 路径相对仓库根；`[W3-xx]` 为本波批次编号（§3）。

## §0 结论

| #   | 决定                                                                                                                                                                                                                                                                                                      | 理由 / 证据                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 缓存子系统分三层：**协议层**（断点 / 保留 / 缓存键 / 兼容开关 / usage 解析标记）、**会话层**（请求记录 + 前缀指纹 + 未命中检测 + 可观测性三态 + 保温状态机，新目录 `src/ai/cache/` 放纯函数，`src/agent/session-cache.ts` 做接线）、**展示层**（状态栏 / `/session` / RPC / stream-json / `cache-probe`） | 现状只有三断点 + 命中率一个数（`src/agent/session-state.ts:120`），`prompt_cache_key` 只发官方端点（`src/ai/apis/openai-request.ts:342`）；实测两家中转报 0 会被显示成 0%                                                                             |
| D2  | 未命中检测、三态、指纹是**纯计算零请求**，缺省开；保温缺省 `streaming`（只在工具运行期间）、`idle` 需 opt-in；两者都只认用户级 / profile 配置                                                                                                                                                             | 调研 §0.2D 盈亏表：空闲保温只对贵模型大前缀划算；国内模型 cacheWrite 价为 0 时经济性公式自然给出 stop                                                                                                                                                 |
| D3  | 压缩摘要改为**会话前缀续写**：同 system、同 tools、同消息前缀 + 一条摘要指令，不发 `toolChoice`（实测改动它会断开缓存前缀）、`cacheRetention: "short"`；失败回落现行独立请求                                                                                                                              | 现行 `completeText` 把整段转录序列化后按全价发（`src/compaction/summarize-tier.ts:145-185`）；前缀续写按读价计费，Sonnet 5.5 下 100k 段约 $0.20 → $0.02                                                                                               |
| D4  | 不做通用 UI mod；上下文余量提示与执行前预览做成内置；本地扩展（HostApi + `~/.config/ama/extensions`）只写设计（§2.6）                                                                                                                                                                                     | 已定决策                                                                                                                                                                                                                                              |
| D5  | codemode：Node ≥ 25（strict）权限类 `read`，22 / 24 保持 `execute`；描述改写为「只能 `tools.x()`，无 require / import」并附示例；`only` 模式下直接猜工具名的调用返回带提示的错误                                                                                                                          | 实测 Kimi 7 轮 / MiniMax 14 轮都浪费在 `require` 与猜名上；`src/codemode/tool.ts:206` 固定 `permission: "execute"`                                                                                                                                    |
| D6  | 中转站：模型级 `api`、`ama models discover` 从 `/v1/models` 生成条目、`OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` 零配置覆盖、anthropic 路径去重 `/v1`                                                                                                                                                       | 真实配置为同一中转写了三个 provider（`/tmp/ama-real/config/config.json`）；`ModelConfig` 排除了 `api`（`src/config/types.ts:16`）；`joinUrl(baseUrl, "/v1/messages")` 遇到 `…/v1` 会拼成 `/v1/v1/messages`（`src/ai/apis/anthropic-messages.ts:201`） |
| D7  | 契约改动集中为前置 PR「contracts-wave3」（§3.1），全部可选字段；之后 5 个批次并行                                                                                                                                                                                                                         | 第二波同一做法有效                                                                                                                                                                                                                                    |
| D8  | 真实模型测试只在本地（`PACKY_API_KEY` 等），CI 不跑；每个脚本带请求数上限与预估花费                                                                                                                                                                                                                       | 零依赖 + CI 无 key                                                                                                                                                                                                                                    |

## §1 缓存设计

### §1.1 现状与目标

| 项                       | 现状（证据）                                                                                                                                                        | 目标                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 前缀稳定                 | 节序固定、工具按名排序、补丁只追加（`src/agent/system-prompt.ts:17-26`、`src/agent/session-sync.ts:83-95`）；20 回合逐字节测试（`src/cli/cache-stability.test.ts`） | 保持；增加指纹记录，未命中时能说出「变了什么」           |
| Anthropic 断点           | 最后 user / system 末 / 最后工具（`src/ai/apis/anthropic-request.ts:267-277`），`long` → `ttl: "1h"`                                                                | 增加 `supportsLongCacheRetention` 降级与 TTL 顺序校验    |
| OpenAI 系缓存键          | 只发 `api.openai.com`（`openai-request.ts:342`、`openai-responses-request.ts:299-305`）                                                                             | 兼容端点 opt-in；24h / 30m 长保留；400 自动剥离          |
| usage 解析               | 三种命中字段位置（`openai-completions.ts:64-84`）；值缺失与值为 0 不可区分                                                                                          | `Usage.cacheReported` 标记原始响应是否出现过任何缓存字段 |
| 统计                     | 会话总命中率（`session-state.ts:120-125`），分母含不报缓存的请求                                                                                                    | 三态；未报告不进分母；最近一次命中率；重计费金额         |
| 保温 / 未命中 / 原因归因 | 无                                                                                                                                                                  | §1.4–§1.6                                                |
| 摘要请求                 | 独立请求、`cacheRetention: "none"`（`summarize-tier.ts:165`、`models.ts:86`）                                                                                       | 前缀续写（§1.7）                                         |

### §1.2 前缀指纹与请求记录

每次真实请求在会话层记一条 `RequestRecord`（内存，不落盘）：

```ts
// src/ai/cache/fingerprint.ts（纯函数）
export interface PrefixFingerprint {
  system: string;
  tools: string;
  model: string;
} // 各 16 位 hex（sha256 前 64 bit）
export function fingerprintContext(context: TranscriptContext, model: Model): PrefixFingerprint;
// system = sha256(normalizeContext().systemPrompt)；tools = sha256(JSON.stringify(tools 按名排序))；model = `${provider}/${id}`

// src/ai/cache/types.ts
export interface RequestRecord {
  at: number; // 请求发出时刻（保温计时从这里算，不是响应结束）
  purpose: "turn" | "summary" | "warm" | "probe";
  model: ModelRef;
  api: Api;
  baseUrl: string;
  fingerprint: PrefixFingerprint;
  promptTokens: number; // input + cacheRead + cacheWrite
  usage: Usage; // 含 cost 与 cacheReported
  contextRef: TranscriptContext; // 保温重放用（同一引用）
  options: Omit<StreamOptions, "signal">;
}
```

- 计算点：`AgentSessionImpl.stream` 包一层（`src/agent/session.ts:104-113` 目前直接转发 `api.stream`），改为经 `SessionCacheController.wrapStream()`；成本是每请求一次 sha256（system + tools 通常 < 20 KB），可忽略。
- 归因：下一条记录与上一条比对，`system` 或 `tools` 哈希变 → `prefix_changed:{system|tools}`；模型变 → `model_changed`；都没变而命中骤降 → `evicted`（服务端淘汰）。这就是生态里「指纹 + 归因」类插件的做法，但 ama 不写条目、不加请求。
- 子 Agent 与摘要请求各有自己的记录链（§1.8），不与主链比对。

### §1.3 各协议的缓存请求字段与兼容开关

| 协议 / 端点                            | 断点 / 字段                                                | 保留层级（`cacheRetention`）                                                                       | 缓存键 / 亲和                                                        | 兼容开关（`compat.*`）                                                                                                                                   | 验证状态                                        |
| -------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| anthropic-messages（官方）             | 三断点（已有）                                             | `short` 5m；`long` `ttl:"1h"`（写 2×，已计价 `src/ai/cost.ts:42`）                                 | 无                                                                   | `supportsCacheControlOnTools`（已有）、**新增** `supportsLongCacheRetention`（缺省官方 true）；TTL 顺序校验：若同一请求里出现 5m 之后的 1h → 全部降为 5m | 已有机制；顺序校验单测即可                      |
| anthropic-messages（中转，如 MiniMax） | 同上；`cache_control` 多数透传                             | `long` 需开关，否则按 short                                                                        | 无                                                                   | 自定义供应商缺省 `supportsLongCacheRetention: false`                                                                                                     | **需实测**（MiniMax 报命中 1339，断点生效）     |
| openai-completions（官方）             | 自动前缀 ≥ 1024                                            | `long` → `prompt_cache_retention: "24h"`                                                           | `prompt_cache_key = sessionId.slice(0,64)`（已有）                   | `sendPromptCacheKey`（官方缺省 true）、`supportsLongCacheRetention`（官方 true）                                                                         | 24h 字段**需实测**                              |
| openai-completions（中转 / 国产）      | 自动前缀（DeepSeek 64 token 块、Kimi / Qwen 128 / 256 块） | 不发保留字段                                                                                       | 缺省不发键；`sendPromptCacheKey: true` 时发（Kimi 据生态包说法接受） | `sendPromptCacheKey`（缺省 false）、`sendSessionAffinityHeaders`（缺省 false：`x-session-affinity: <sessionId>`、`x-client-request-id: <uuid>`）         | **需实测**：Kimi 开键后命中率是否从 59–89% 提升 |
| openai-completions（OpenRouter）       | `anthropic/*` 用 cache_control（已有）                     | 同官方 Anthropic                                                                                   | `x-session-id: <sessionId>` 亲和头                                   | `sendSessionAffinityHeaders` 对 openrouter 推断为 true                                                                                                   | **需实测**                                      |
| openai-responses（官方）               | 自动前缀；`instructions` 不进 input（已有）                | `long` → `prompt_cache_options: { ttl: "30m" }`（仅声明 `supportsExplicitPromptCacheMode` 的模型） | `prompt_cache_key`（已有）                                           | `sendPromptCacheKey`、`supportsExplicitPromptCacheMode`（缺省 false）                                                                                    | 30m / `prewarm` **需实测**，本波不做 prewarm    |
| google-generative-ai                   | 隐式缓存，无字段                                           | 无                                                                                                 | 无                                                                   | 无                                                                                                                                                       | —                                               |

**400 自动剥离**：协议 `run()` 捕获 `HttpError{status:400}` 且 body 命中 `/prompt_cache_key|prompt_cache_retention|prompt_cache_options|cache_control/i` → 把 `${provider}/${model}` 记入进程级 `strippedCacheParams: Set<string>`，去掉这些字段**在 `start` 之前**重发一次（流契约仍是恰好一个终止事件），并 `log("warn")` 一次提示「该端点不支持 X，已自动去掉；可在 config 里设 compat.sendPromptCacheKey:false」。落点 `src/ai/apis/openai-completions.ts` / `openai-responses.ts` 的 `run()`，判定函数放 `src/ai/apis/cache-params.ts`（≤ 80 行，两协议共用）。

**环境变量**：`AMA_CACHE_RETENTION=none|short|long` 全局切换（等价 `cache.retention`）。

### §1.4 模型目录 `promptCache`

字段：`promptCache?: { short?: number; long?: number; minTokens?: number }`（秒；`minTokens` 为最小可缓存长度）。只写有公开依据的值：

| 供应商 / 模型                                                      | short | long  | minTokens                                                                                                                                | 依据                                                  |
| ------------------------------------------------------------------ | ----- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| anthropic 全部（已有 300 / 3600）                                  | 300   | 3600  | Fable 5.x / Opus 5.x / Sonnet 5.5：512；Opus 4.8、Sonnet 5 / 4.6 / 4.5：1024；Opus 4.7、Haiku 3.5：2048；Opus 4.6 / 4.5、Haiku 4.5：4096 | 官方文档（调研 §0.2C 整理）                           |
| openai 全部                                                        | 300   | 86400 | 1024                                                                                                                                     | 官方文档：5–10 分钟活跃、`prompt_cache_retention` 24h |
| moonshot（kimi-*）                                                 | 300   | —     | —                                                                                                                                        | 名义 5 分钟（生态包实测 8 分钟仍命中，取保守端）      |
| deepseek、zhipu、dashscope、groq、xai、mistral、openrouter、google | —     | —     | —                                                                                                                                        | 无承诺 TTL，留空（归因时隐式缓存按 10 分钟估）        |

留空的后果：不保温（经济性不可算）、未命中归因「空闲」用 10 分钟启发值、噪声下限用 1024。用户可在 `config.json` 的 `models[]` / `modelOverrides[]` 里自填。

### §1.5 未命中检测、噪声下限、成本与原因归因

```ts
// src/ai/cache/miss.ts（纯函数，输入是 RequestRecord 链）
export interface CacheMiss {
  missedTokens: number;
  missedCost: number; // 重计费 token 与金额
  reason: "prefix_changed" | "model_changed" | "idle" | "subtask" | "evicted";
  detail?: "system" | "tools";
  idleMs: number;
}
export function detectMiss(
  prev: RequestRecord | undefined,
  cur: RequestRecord,
  ttlMs: number | undefined,
): CacheMiss | undefined;
```

算法（业界常见做法 + 两点改进）：

1. 不计的情形：没有 `prev`；`cur.promptTokens === 0`；`cur.cacheRead + cur.cacheWrite === 0` 且该端点状态不是 `reported`（§1.6）；`prev.promptTokens < minTokens`（低于最小可缓存长度判 unknown 不判 miss，这是「低于门槛不判未命中」的生态做法）。
2. `missed = min(prev.promptTokens, cur.promptTokens) − cur.cacheRead`；`missed ≤ noiseFloor` 不计，`noiseFloor = max(1024, promptCache.minTokens ?? 1024, 端点推断的缓存粒度)`（粒度见 §1.6；实测 DeepSeek 经中转按 2048 一块报 cacheRead，不足一块的尾部会被算成假未命中，`docs/benchmarks/cache-2026-10-02.md` E1 / E5）。
3. 规模自适应判据（改进）：`missed / prev.promptTokens > clamp(0.10 × √(100k / prev.promptTokens), 0.02, 0.30)` 或 `missed ≥ 20 000` 才记为一次 miss（长会话里 95% 命中率也可能是一次 5k 的真未命中）。
4. 成本：`paidPerToken = (cost.input + cost.cacheWrite) / (input + cacheWrite)`（含写入溢价，用本条实付反推），`readPerToken = cost.cacheRead / cacheRead`（无读则目录价 / 1e6）；`missedCost = missed × max(0, paidPerToken − readPerToken)`；模型无价格 → `missedCost` 为 undefined，统计显示 `$?`。
5. 重置点：`compaction` / `branch_summary` / 档一 `context_edit{reason:"prune"}` 之后的首个请求把 `prev` 清空（上下文合法地变了，不算重计费）；**模型切换不豁免**（确实全价重读）。
6. 归因顺序：指纹 `system` / `tools` 变 → `prefix_changed`（可修：多半是宿主中途注册工具或 Hook 上下文变化）；模型变 → `model_changed`；`idleMs > ttl`（ttl = 目录 `promptCache.short`，隐式缓存端点取 600 s）→ `idle`；两次请求之间有 `task` 工具且其运行时间占 `idleMs` 的 ≥ 80% → `subtask`（MiniMax 实测里 task 之后 cacheRead 归零的回合就是这类）；其余 → `evicted`。
7. 保温成功的 `warm` 记录也更新 `prev`（之后的请求以保温为参照）。

展示门槛：`/session` 与 RPC 统计计入全部 miss；转录 / 消息区只提示 `missed ≥ 20 000` 或 `missedCost ≥ $0.10` 的那次，一行：`缓存未命中（空闲 7 分钟后）：重计费 38.2k token（约 $0.11）`。

### §1.6 「供应商不报缓存」三态

按 `(provider, baseUrl 主机名, model)` 维护 `CacheReporting`：

| 状态       | 判定                                                                                         | 命中率显示 | 进分母 | 未命中检测 | 保温 |
| ---------- | -------------------------------------------------------------------------------------------- | ---------- | ------ | ---------- | ---- |
| `unknown`  | 还没有 ≥ `minTokens` 的可比请求                                                              | `—`        | 否     | 否         | 否   |
| `reported` | 出现过 `cacheRead > 0` 或 `cacheWrite > 0`                                                   | 正常       | 是     | 是         | 是   |
| `silent`   | 连续 3 个可比请求（前缀 ≥ minTokens、指纹未变、间隔 < ttl）都是 `cacheRead = cacheWrite = 0` | `未报告`   | 否     | 否         | 否   |

- 协议层新增 `Usage.cacheReported?: boolean`：原始响应里**出现过**任何缓存字段（即使值为 0）。字段缺失直接记 `silent` 的一票；字段存在但恒为 0 仍走连续 3 次规则（有些中转总塞 `cached_tokens: 0`）。落点：`parseOpenAIUsage`、`applyAnthropicUsage`、`parseResponsesUsage`、Google 的 usageMetadata 解析。
- `compat.cacheReporting: "auto" | "silent" | "reported"` 可强制（`cache-probe` 建议写法）。
- 状态只在内存与 `get_session_stats` 里，不写会话文件；进程内跨会话复用（同一端点换会话不必再探 3 次）。
- 同一键下还记**缓存读粒度**：观察到的非零 `cacheRead` 的最大公约数，至少 2 个样本且落在 [128, 8192] 才采信（只有相同的大值时公约数超上限，不采信）；用于 §1.5 的噪声下限，`get_session_stats.cache.granularity` 给出。实测 Kimi 经中转为 128（不改变 1024 下限），DeepSeek 为 2048，MiniMax / Anthropic 逐 token 报、不采信。
- 实测对照：DeepSeek / GLM 在该中转报 0 → `silent`（官方端点两家都报，所以是中转没透传）；Kimi / Qwen / MiniMax → `reported`。

### §1.7 缓存保温（`off | streaming | idle`）

```ts
// src/ai/cache/warmer.ts（状态机，注入 now / setTimeout / 发送函数，便于 fake 时钟测试）
export type WarmingMode = "off" | "streaming" | "idle";
export interface WarmerDeps {
  mode(): WarmingMode;
  now(): number;
  send(record: RequestRecord, signal: AbortSignal): Promise<AssistantMessage>; // 重放：同 model / context / options，maxTokens: 1，purpose: "warm"
  isCurrent(record: RequestRecord): boolean; // 模型未变 && 记录的 context.messages 是当前 agent.messages 的逐元素同一引用前缀 && system 状态未变
  decide?(input: WarmDecision): Promise<"warm" | "stop"> | "warm" | "stop"; // 宿主 / 扩展否决钩子
  onWarmed(record: RequestRecord): void;
  onStopped(reason: string): void;
}
export class CacheWarmer {
  start(record, ttlMs): void;
  onAgentSettled(): void;
  cancel(): void;
  get status(): WarmerStatus;
}
```

| 项       | 规则                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 触发     | 每个 `purpose: "turn"` 的真实请求发出时 `start()`（替换上一轮）；`agent_settled` 时 `streaming` 模式停止、`idle` 模式转空闲相；`setModel` / `setThinkingLevel` / 压缩 / `/tree` / `dispose` 时 `cancel()`，等下一次真实请求再开始                                                                                                                                       |
| 延迟     | `delay = max(1s, floor(min(0.9·TTL, TTL − 10s)))`；TTL ≤ 10 s 不保温；**计时从请求发出算**（生成 3 分钟的回答只剩 2 分钟）                                                                                                                                                                                                                                              |
| 截止     | `deadline = nextWarmAt + (TTL − delay) / 2`；计时器迟到超过截止（睡眠、事件循环阻塞）直接停止——迟到的刷新大概率是一次全价写入                                                                                                                                                                                                                                           |
| 上限     | streaming 相 60 min、idle 相 30 min（从起始真实请求算）；连续 2 次保温响应 `cacheRead + cacheWrite === 0` 即停（常见实现没有这条，对用户自填 `promptCache` 的端点很重要）                                                                                                                                                                                               |
| 经济性   | `promptTokens` = 上一次真实请求的 input + cacheRead + cacheWrite；`hitCost = price({cacheRead: P})`；`missCost = price(cacheWrite > 0 ? {cacheWrite: P} : {input: P}) − hitCost`；`warmCost = price({cacheRead: P, output: 1})`；`p = 1`（streaming）/ `0.15`（idle）；`p·missCost − warmCost ≥ cache.minSavingsUsd（0.05）` 才发；价格为 0 或缺 → 「经济性不可算」不发 |
| 不可重放 | anthropic-messages 且 `reasoning` 开且 `!compat.adaptiveThinking`：预算从 `max_tokens` 推导（`anthropic-request.ts:237-239`），`max_tokens: 1` 会去掉 thinking 块，改变缓存键 → 不保温；`cacheRetention: "none"` 的请求不保温；被 `onPayload` 替换过请求体的不保温                                                                                                      |
| 发送     | `api.stream(model, record.contextRef, { ...record.options, maxTokens: 1, purpose: "warm", signal })`，不经重试，失败静默；计时器 `unref()`                                                                                                                                                                                                                              |
| 落盘     | 成功 → 追加会话条目 `usage{ kind: "cache_warm", provider, model, usage }`，计入 `/session` 费用与 RPC 统计，**不进上下文**（`projection.ts:48-80` 的 `entryToMessage` 对未知类型返回 undefined，天然跳过）；事件 `cache_warm{ phase: "sent", usage, cost }`                                                                                                             |
| 否决钩子 | 每次刷新前调 `decide({ warmCost, missCost, probability, action })`；宿主经 HostApi 新增 `api.cache.onWarmingDecision(handler)`（§2.6 扩展也用它）；出错回落内置决策                                                                                                                                                                                                     |
| 配置来源 | `cache.warming` 只认用户级 / profile（项目级忽略并 warning，同 `permission.allow` 的处理，`src/config/merge.ts:134-198`）；`AMA_CACHE_WARMING` 环境变量覆盖；`/cache warm off                                                                                                                                                                                           | streaming | idle` 会话内临时切换 |

按目录价格的盈亏点（P 为前缀 token）：Fable 5.1 streaming ≥ 4.1k / idle ≥ 31.5k；Sonnet 5.5 23.8k / 345k；Kimi K3 20.8k / 476k；DeepSeek Flash 174k / 永不。结论与业界常见判断一致：长工具运行期间几乎总划算（这正是 `bash` 长测试与 `task` 子任务的场景），空闲保温留给贵模型。

### §1.8 压缩摘要走会话前缀续写

现行：`runCompaction` → `completeText()` 新建 `[system: 摘要提示, user: 序列化转录]`（`summarize-tier.ts:149-157`），整段按全价。改为：

```ts
// src/compaction/summarize-tier.ts 新增
export interface ContinuationInput {
  /** 与上一次真实请求逐字节相同的转录（system 补丁 + 全部消息，直到最后一条真实请求为止）。 */
  prefix: TranscriptContext;
  /** 要摘要到哪条消息为止（firstKeptEntryId 之前）；指令里用「第 N 条消息之后的内容请勿摘要」+ 首行引文描述。 */
  keepFrom: { index: number; excerpt: string };
  instruction: string; // SUMMARY_TEMPLATE / TURN_PREFIX_PROMPT
}
export async function completeByContinuation(
  options: SummarizerOptions,
  input: ContinuationInput,
): Promise<{ text: string; usage: Usage }>;
```

- 请求 = `prefix.messages` + 一条 user 消息（摘要指令 + 「只摘要到第 N 条消息，之后的保留原文」+ 「不要调用任何工具，只输出摘要」）；`cacheRetention: "short"`（按读价）；`purpose: "summary"`。**不发 `toolChoice`**：实测（`docs/benchmarks/cache-2026-10-02.md` E3）中转与 Kimi 在 `tool_choice: "none"` 时渲染的提示不带工具定义，前缀在工具段断开、cacheRead 为 0，续写反而比独立请求贵；Anthropic 文档也写明改动 tool_choice 会让消息缓存失效。所以 system + tools + 消息前缀与上一次真实请求逐字节相同，禁止调用工具只靠末尾指令，模型仍调用时按下面的回落处理。`StreamOptions.toolChoice?: "none"` 契约与各协议映射（Anthropic `tool_choice:{type:"none"}`、Completions / Responses `tool_choice:"none"`、Google `toolConfig.functionCallingConfig.mode:"NONE"`）保留，供不在缓存前缀上的请求使用。
- 为什么用**全前缀**而不是只到被丢弃段：Anthropic 只在打过断点的位置有缓存条目，被丢弃段末尾未必是断点；全前缀（直到上一条真实请求）一定命中三断点 + 自动前缀。OpenAI 系两种都命中，全前缀多读 ≤ keepRecentTokens（20k）的缓存 token，可接受。「只发被丢弃段」作为隐式缓存端点的优化留待实测（§1.12 E3）。
- 回落：响应为空 / `stopReason === "length"` / 含工具调用 / 请求错误 → 走现行 `completeText`（独立请求，`cacheRetention: "none"`），并记 warning。split turn 的回合前缀摘要同样走续写。
- 对两档压缩与缓存的影响：档一（`context_edit` 裁剪旧工具结果，`src/agent/session-compaction.ts:85-98`）会让裁剪点之后的前缀全部失效，这是**有意的一次性成本**——仍只在 70% 阈值触发；未命中检测把 prune / compaction 之后的首个请求记为重置而不是未命中；状态栏在压缩后显示一次「前缀已重建」。档二之后新会话前缀 = 检查点 system + 摘要 + 保留尾部，首个请求必然是写入，同样不计未命中。
- 分支摘要（`branch-summary.ts`）与 `/handoff` 类生成请求同一做法。

### §1.9 子 Agent（task）与 codemode

| 场景                        | 影响                                                                                                                               | 对策                                                                                                                                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 子会话有自己的 `manager.id` | OpenAI 官方端点上缓存键不同（`session.ts:140`），各自独立命中；父会话在 task 运行期间空转，超过 TTL 后下一回合全价（MiniMax 实测） | 子会话自己的 `SessionCacheController`（`new AgentSessionImpl` 时随 options 创建），统计独立、未命中检测不进父链；父会话在 task 运行期间处于 `streaming` 保温相 → 自动续命；`SubagentResult` 增加 `cache?: { hitRate, reBilledTokens }` 供 task 结果 details 与 `/session` 的「子任务」行显示 |
| fork 出的会话               | 新文件新 id，但前缀与父相同                                                                                                        | `cacheKeyOf(manager)`：`header.parentSession` 存在且来源是 fork → 沿用根会话 id 作 `prompt_cache_key`（只是路由提示，不是安全边界）；task 子会话不沿用                                                                                                                                       |
| codemode                    | 描述冻结（`codemode/tool.ts:195-197`），内层调用不进转录 → 不影响前缀；一段脚本跑几分钟，仍是 streaming 保温覆盖的场景             | 保温不区分 codemode；`only` 模式下宿主晚注册的工具不改描述（已有）                                                                                                                                                                                                                           |
| 子会话的保温                | 子会话也会 `start()`，并发 4 个子会话 → 最多 4 个保温计时器                                                                        | 子会话（`depth > 0`）缺省 `warming: "off"`（子任务短、前缀小），`cache.warmSubagents: true` 打开——这是 §1.11 配置里唯一一个非主干项，归入 `cache.warming` 的取值 `"streaming+subagents"` 更难理解，故单列                                                                                    |

### §1.10 展示

| 面                                      | 内容                                                                                                                                                                                                                                                                                                                                                             | 落点                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 状态栏（TUI）                           | `cache 83%`（**最近一次**命中率；`unknown` → `cache —`，`silent` → `cache 未报告`）；`rebill $0.11`（会话重计费 > 0 才显示，优先级低）；保温中显示 `♨`；`ctx 72%` ≥ 70% 黄、≥ 90% 红（B7 已做，`status-bar.ts:82-92`）；跨越 70% / 90% 时消息区各提示一次「上下文已用 72%，约剩 N 回合（按最近 5 回合均值）」                                                    | `src/modes/interactive/status-bar.ts`、`interactive-mode.ts` 的 `onEvent`                                            |
| line 模式                               | 同一行提示文本写 stderr（未命中、70% / 90%、保温成功仅 `AMA_LOG=info`）                                                                                                                                                                                                                                                                                          | `src/modes/interactive/line/line-render.ts`                                                                          |
| `/session`                              | 新增「缓存」段：`输入 1.2M = 缓存读 1.05M（87%）+ 未缓存 150k（其中写入 90k）`；`报告状态：reported / 未报告 / 未知`；`未命中 3 次，重计费 61k token ≈ $0.18`（按原因分列）；`保温：streaming · 下次 2m 10s · 期望节省 $0.18 ≥ $0.05` 或停止原因；`上下文：72%，余量 ≈ 280k token ≈ 9 回合`；`子任务：2 个会话，命中率 71%`                                      | `src/modes/commands-core.ts` 的 `describeSession`（拆出 `src/modes/session-report.ts` 以免超 600 行；现 194 行尚可） |
| `/cache`                                | `/cache` = 只显示缓存段；`/cache warm off                                                                                                                                                                                                                                                                                                                        | streaming                                                                                                            | idle` 会话内切换；`/cache fingerprint` 打印当前 system / tools 哈希                          | 同上                                           |
| RPC / SDK                               | `SessionStats.cache: { reporting, lastHitRate?, hitRate?, reBilledTokens, reBilledUsd?, misses: { count, byReason }, warming: { mode, state, nextWarmAt?, reason? }, contextRemainingTokens?, estimatedTurnsLeft? }`（`get_session_stats` 自动带出）；新事件 `cache_miss{ missedTokens, missedCost?, reason, detail?, idleMs }`、`cache_warm{ phase: "scheduled" | "sent"                                                                                                               | "stopped", nextWarmAt?, usage?, cost?, reason? }`、`context_pressure{ percent, threshold: 70 | 90 }`；`RpcEvent`由`SessionEvent` 派生自动包含 | `src/agent/types.ts`、`src/rpc.ts`（无需改）、`docs/reference/rpc.md` |
| stream-json / `-p --output-format json` | 同事件；`json` 结果对象增加 `cache` 字段                                                                                                                                                                                                                                                                                                                         | `src/modes/print/print-mode.ts:63-81`                                                                                |
| 宿主                                    | `AgentEvents` 增加 `cache_miss`、`context_pressure`（Armadra 可据此提示）                                                                                                                                                                                                                                                                                        | `src/host/types.ts`、`src/cli/compose-session.ts:168-221` 桥接表各加一行                                             |

### §1.11 `ama models cache-probe`

```text
ama models cache-probe <provider/model> [--tokens 2048] [--gap-ms 3000] [--json] [--yes]
```

- 构造固定前缀：system 一段确定性文本（重复的编号句子，按字符 / 4 估算到 `--tokens`，缺省 2048 ≥ 全部已知最小可缓存长度）+ user `Reply with: ok`；`maxTokens: 16`、`cacheRetention: "short"`、`purpose: "probe"`；相隔 `--gap-ms` 发两次。
- 输出：两次请求的 `input / cacheRead / cacheWrite / cacheReported` 与原始 usage 字段名（如 `prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`、`cache_read_input_tokens`）；判定 `reported`（第二次 cacheRead > 0）/ `silent`（两次都 0 且字段缺失或恒 0）/ `inconclusive`（第二次 < 第一次长度的 50%，可能是粒度或 TTL 问题）；建议文本：`silent` → 「可在 config 里设 providers.<id>.compat.cacheReporting: "silent"，状态栏将显示未报告」；`reported` 且目录无 `promptCache` → 「可自填 promptCache.short 以启用保温」。
- 计费动作：执行前打印预估花费（两次 × `--tokens` × 目录价，无价则 `$?`），非 TTY 需 `--yes`。
- 落点：`src/cli/subcommands/models-cache-probe.ts`（新，≤ 150 行）；`models.ts` 分派表加一项（§3.1 契约 PR 把 `models.ts` 改成动作表，避免两个批次同时改它）。

### §1.12 配置项（精简）

```json
{
  "cache": {
    "warming": "streaming", // off | streaming | idle；只认用户级 / profile；AMA_CACHE_WARMING 覆盖
    "retention": "short", // none | short | long；AMA_CACHE_RETENTION 覆盖
    "minSavingsUsd": 0.05, // 保温的最低期望节省
    "missNotices": true, // 转录 / 消息区的未命中与上下文余量提示（统计面板不受影响）
    "warmSubagents": false
  }
}
```

供应商级在 `providers.<id>.compat`：`sendPromptCacheKey`、`sendSessionAffinityHeaders`、`supportsLongCacheRetention`、`supportsExplicitPromptCacheMode`、`cacheReporting`。模型级在 `models[] / modelOverrides[]`：`promptCache{short,long,minTokens}`。`CONFIG_KEYS` 加 `cache`（`src/config/schema.ts:141-155`）；`restrictProjectConfig` 对 `cache` 整段忽略并 warning。

### §1.13 验收实验（真实中转，本地）

脚本 `scripts/cache-experiment.mjs --config /path/config.json --model packy/kimi-k2.5 --case E1..E5 --max-requests 15`，用 SDK `createRuntime` + `onPayload` 记录请求体与 usage，结果写 `docs/benchmarks/cache-<date>.md`。

| 实验 | 目的               | 做法                                                                                                  | 改进前预期                               | 改进后预期                                                                   | 请求上限 |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| E1   | 基线命中率不退化   | 5 轮修 bug 任务（read→read→edit→bash）×3 模型（Kimi / MiniMax / DeepSeek），记每轮 cacheRead / prompt | Kimi 768–1010/832–1010、MiniMax 891–1523 | 不低于基线；DeepSeek 显示「未报告」而不是 0%，`misses.count = 0`             | 15/模型  |
| E2   | 长工具运行期间保温 | 一轮 `bash sleep 420`（Kimi 名义 TTL 5 min）后再提一个问题                                            | 下一轮 cacheRead ≈ 0                     | 中途出现 1 条 `cache_warm{sent}`；下一轮 cacheRead ≈ 前缀长度                | 6        |
| E3   | 摘要走前缀续写     | 累积到 ≥ 60k token 后 `/compact`，比较摘要请求的 usage                                                | 摘要请求 cacheRead = 0、input ≈ 60k      | cacheRead ≥ 80% 的前缀；费用下降一个量级；摘要内容与现行等价（人工核对一次） | 12       |
| E4   | 归因正确           | 第 3 轮后 `/model` 切到同中转另一模型；再切回；中途让宿主测试适配器注册一个工具                       | 只有命中率下降                           | 依次出现 `model_changed`、`prefix_changed:tools` 的 `cache_miss` 事件        | 10       |
| E5   | 不报缓存端点       | DeepSeek / GLM 跑 4 轮 + `cache-probe`                                                                | 显示 0%                                  | 第 3 轮后 `reporting = silent`、状态栏「未报告」；probe 给出 `silent` 判定   | 8        |

成本：合计 ≤ 100 请求、前缀 ≤ 60k，按中转价估算 < $2；脚本在超过 `--max-requests` 或 `--budget-usd` 时中止并输出已得数据。

## §2 其余批次

### §2.1 B9a 集成修复

| #   | 问题（证据）                                                                                                                                                                                                                                                                                                | 修复                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 文件                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 启动期迷你 UI 未接线：`createStartupUi` 只在 `startup-ui.ts` 自身出现，`createRuntimeDeps` 的 `ui` 没人传（B7 分支 `compose.ts` 无引用，`main.ts:120-123` 只传 env）→ `--resume` 无 id、无 key、cwd 缺失、信任询问在真终端里仍走非交互分支                                                                  | `compose.ts` 缺省 `ui`：懒代理——每个回调先判 `io.stdinIsTTY && io.stdoutIsTTY && TERM !== "dumb" && !args.noTui`，是则 `await import("../modes/interactive/startup-ui.js")` 调用，否则 line 模式的文本问答（`promptTrust` y/n、`pickModel` 列候选后读一行）；`ComposeOptions.ui` 仍可覆盖；`createRuntimeDeps` 需要拿到 io → 签名加 `io?: Pick<CliIo, "stdinIsTTY"                                                                                                                                                  | "stdoutIsTTY"                                                                                                                                                                                                                         | "env">`，`main.ts` 传入                                                                                | `src/cli/compose.ts`、`src/cli/main.ts`、新 `src/modes/startup-ui-text.ts`（≤ 120 行） |
| A2  | codemode 权限类与描述：固定 `execute`（`codemode/tool.ts:206`）；描述没说「不能 require / import」，模型在 `only` 下直接调 `read` 被拒为 `Tool read not found`                                                                                                                                              | `permission: capability.strict ? "read" : "execute"`（`default` 模式下 Node ≥ 25 免审批）；描述首段改为「Only `tools.<name>(args)` is available. There is no require, import, process, fetch or timers; do not call tools directly as functions.」+ 一段 6 行示例脚本（`Promise.all` 两个 read、过滤、`return`）；`tool-runner.ts:122-124` 的找不到工具分支：若 `getNestedTool(name)` 存在且活动集含 `codemode` → 错误文本改为 `Tool X is only callable inside a codemode script: tools.X({...})`；描述快照测试更新 | `src/codemode/tool.ts`、`src/agent/tool-runner.ts`、`src/codemode/declarations.test.ts` 快照、`docs/guides/codemode.md`                                                                                                               |
| A3  | `-p` 文本输出开头多两个空行（MiniMax）                                                                                                                                                                                                                                                                      | `print-mode.ts:60-62` 输出前 `text.replace(/^\s*\n/, "")`（只去前导空行，保留首行缩进）；`json` / `stream-json` 不动                                                                                                                                                                                                                                                                                                                                                                                                | `src/modes/print/print-mode.ts`                                                                                                                                                                                                       |
| A4  | TUI 内层调用折叠已有（`tool-view.ts:279-297`），但 codemode 的标题摘要为空（`toolSummary` 不认 `script`），`ToolDefinition.renderCall / renderResult`（`tools/types.ts:47-48`）从未被调用；状态栏没有「网络未隔离」标注（实施计划 §5.2 要求 B7 直接判）                                                     | `ToolView.header` 优先用 `tool.renderCall(input, width)[0]`（`ToolTracker` 构造时接收 `getTool(name)`）；`body` 在 `renderResult` 存在时用它；状态栏新增 `codemode:only`（或 `on`）项，`!detectSandboxCapability().strict` 时追加红色 `net!`，优先级 3                                                                                                                                                                                                                                                              | `src/modes/interactive/tool-view.ts`、`status-bar.ts`（归 W3-C2，见 §3）                                                                                                                                                              |
| A5  | 表 B 剩余项：B3 溢出正则重复（`agent/retry.ts:23-34` vs `ai/overflow.ts`）；B14 重复实现（`executionModeOf` 两处、`escapeXml` 两处、`isStricterOrEqual` vs `isAtLeastAsStrict`、`DEFAULT_APPROVAL_TIMEOUT_MS` 三处、`Semaphore` vs `SubagentPool`）；B13 `tools.create` 入参无 skills（compose 用闭包绕过） | `retry.ts` 直接 `import { isOverflowErrorText }`，删表；`tool-runner.ts` 从 `tools/registry.ts` 导入 `executionModeOf`；`system-prompt.ts` 导入 `skills/index-prompt.ts` 的 `escapeXml`；`merge.ts` 改用 `rules.ts` 的 `isAtLeastAsStrict`；超时常量只留 `permissions/broker.ts`；`SubagentPool` 保留（B2 单测依赖），`task.ts` 的 `Semaphore` 改为透传 `maxConcurrency` 给 pool（删一层）；B13 保持闭包、文档注明                                                                                                  | 对应文件                                                                                                                                                                                                                              |
| A6  | Markdown 流式每个 delta 全量重解析（`markdown.ts:395-397` `append` = `setText`，`parseMarkdown` 全文）                                                                                                                                                                                                      | 增量解析：`MarkdownBlock` 记 `start`（源文本偏移）；`append` 只从最后一个块的 `start` 重新解析尾部（围栏未闭合时从围栏起点），前面的块复用；渲染缓存已按块（`render` 的 `blockCache`）无需改；性能测试：100 KB 文本按 20 字符追加，解析耗时 O(n) 而非 O(n²)                                                                                                                                                                                                                                                         | `src/tui/components/markdown.ts`（现 430+ 行，若超 600 把 `parseMarkdown` 拆到 `markdown-parse.ts`）                                                                                                                                  |
| A7  | `/tree` 位置不落盘：`setLeaf` 只改内存（`session/manager.ts:220-225`），`open()` 叶子 = 文件最后一条，`/resume` 后回到旧叶子                                                                                                                                                                                | 文件存储时 `setLeaf` 追加一行非条目 `{ "type": "leaf", "id": "<entryId>                                                                                                                                                                                                                                                                                                                                                                                                                                             | null", "timestamp }`；`readSessionLines`/`migrate.ts`认识该行：最后一条`leaf` 行若晚于最后一条条目则作为叶子；`getEntries` 不返回它；`docs/reference/session-format.md` 记为 v1 可选行（格式版本不升）；fork 复制分支时不复制 leaf 行 | `src/session/manager.ts`、`store.ts`、`migrate.ts`、`types.ts`（`SessionLine` 加 `LeafLine`，契约 PR） |
| A8  | B4 组件库缺口（B7 实现时自造的）：状态栏手工拼接丢弃逻辑；`/session` 多列文本无对齐组件；上下文余量无图形表示                                                                                                                                                                                               | 补两个小组件：`KeyValue`（两列对齐，宽度不够时值截断，供 `/session` 面板）、`Meter`（一行 `ctx ▮▮▮▮▮▯▯ 72%`，阈值着色；状态栏可选）；各 ≤ 80 行 + 帧测试                                                                                                                                                                                                                                                                                                                                                            | `src/tui/components/{key-value,meter}.ts`、`src/tui.ts` 再导出                                                                                                                                                                        |
| A9  | 执行前预览（§2.2）                                                                                                                                                                                                                                                                                          | 见 §2.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                                                                                                                                                                                                     |

### §2.2 执行前预览（审批对话框）

目标：审批时看到「这一步会碰到什么」，类似生态里「影响范围」类插件，但只做本地、只读、有上限的预览。

```ts
// src/permissions/preview.ts（纯函数 + 受限 fs 读取，≤ 250 行）
export interface ActionPreview {
  kind: "bash" | "write" | "edit" | "other";
  lines: string[]; // 已排好的人读文本（不含颜色）
  severity: "info" | "warn" | "danger";
  affected?: { path: string; exists: boolean; bytes?: number; files?: number }[];
}
export function previewAction(
  request: ApprovalRequest,
  options: { cwd: string; maxEntries?: number; now?: () => number },
): ActionPreview;
```

| 工具  | 预览内容                                                                                                                                                                                                                                                                                                                                                                                        | 上限 / 安全                                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| bash  | 用 `collectNestedCommands` + `shellWords`（`src/permissions/dangerous.ts:34, 326`）取每段 argv；`rm` / `rmdir` / `mv` / `git clean` / `git checkout --` / `git reset --hard` 的路径参数 → `statSync`，目录递归统计文件数与字节数（跟随 `.gitignore` 不必要，直接计数，上限 `maxEntries` 2000 则显示「> 2000 项」）；重定向目标 `>`、`>>` 的文件 → 存在与大小；命中的危险规则 `description` 一行 | 只读 fs；路径以会话 cwd 解析；通配符不展开（显示原样 + 「含通配符，实际范围可能更大」） |
| write | 目标是否存在、现有大小 / 行数 → 新内容大小 / 行数；覆盖未 `read` 过的文件标 warn（`ctx.readFiles` 不在 request 里 → `ApprovalRequest.context` 增加 `readFiles?: ReadonlySet<string>` 由 `gateToolCall` 填入）                                                                                                                                                                                   | 不读超过 2 MiB 的文件内容，只报大小                                                     |
| edit  | 读原文、`planEdits(content, edits, replaceAll)`（`src/tools/edit.ts:59`）干跑：成功 → 每处 `−n/+m` 行与总变化；失败 → 「匹配不唯一 / 未找到」提前告知                                                                                                                                                                                                                                           | 同上                                                                                    |
| 其它  | 一行摘要（现有 `toolSummary`）                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                       |

接线：`approval-dialog.ts` 的 `describeRequest` 在输入摘要之后插入预览行（danger 红、warn 黄）；line 模式 `approvalQuestion` 在问句前多打印预览行；RPC `permission_request` 事件带 `preview?: ActionPreview`（Armadra 可直接显示）。预览耗时 > 200 ms 时放弃（`statSync` 计数用预算循环），不阻塞审批。

### §2.3 B12 转发服务体验

| 项                    | 设计                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 文件                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 模型级 `api`          | `ModelConfig` / `ModelOverride` 允许 `api?: Api`（`config/types.ts:16-19`）；`registry.applyConfig` 用 `withCustomDefaults(entry, id, entry.api ?? provider.api)`（`registry.ts:150`），`modelOverrides` 同理；`schema.checkModels` 接受 `api` 字串并校验属于 `KnownApi` 或自定义；`ama config show` 列出模型协议；`compose-session.ts:283` 的协议预检按模型 `api`（已按模型）                                                                                                                                                                                                                                                                                                                                                                          | `src/config/types.ts`、`schema.ts`、`src/ai/providers/registry.ts`、`subcommands/config.ts`、`docs/guides/providers.md` |
| 一个 baseUrl 三协议   | anthropic-messages 的路径拼接：`baseUrl` 以 `/v1` 结尾时拼 `/messages`，否则 `/v1/messages`（`anthropic-messages.ts:200-201`）；Responses / Completions 已是 `/v1` 基底；文档示例统一 `"baseUrl": "https://proxy.example/v1"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `src/ai/apis/anthropic-messages.ts` + 请求快照测试                                                                      |
| `ama models discover` | `ama models discover <provider> [--probe] [--write] [--limit 30]`：GET `{baseUrl}/models`（复用 `discoverLocalModels` 推广为 `discoverModels(provider, apiKey)`，`registry.ts:281-304`），打印 id 列表；`--probe` 对每个 id 依次用 completions → responses → messages 发 `maxTokens: 1` 的最小请求（`ama models check` 同款，`subcommands/models.ts:59-99`），记第一个成功的协议为该模型 `api`（上限 3 请求 / 模型，总数 `--limit`，执行前打印预估）；`--write` 把条目合并进用户级 `config.json` 的 `providers.<id>.models`（已有同 id 不覆盖，新条目只写 `id` 与探到的 `api`，不猜 `contextWindow`，输出 warning「未设 contextWindow，自动压缩关闭」）；写文件走 `writeConfigFile`（新，`config/load.ts` 旁；格式化 2 空格；先备份 `config.json.bak`） | 新 `src/cli/subcommands/models-discover.ts`（≤ 220 行）、`src/config/write.ts`（≤ 80 行）                               |
| 零配置对中转          | 内置 `openai` / `anthropic` 供应商识别 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`（Claude Code / OpenAI SDK 的通行约定）覆盖 baseUrl（优先级低于 config / auth.json 的 baseUrl）；baseUrl 不是官方主机时：接受目录外的任意 model id（`findModel` 的 synthesize 分支放宽为「供应商 baseUrl 被覆盖到非官方主机」，`registry.ts:223-225`），compat 推断回到保守缺省（已按 baseUrl 子串），`sendPromptCacheKey` 自动 false；`ama config show` 与 `doctor` 标出「baseUrl 来自环境变量」                                                                                                                                                                                                                                                                        | `src/ai/providers/builtin.ts`（`baseUrlEnv` 字段）、`registry.ts`、`compose-providers.ts`、`doctor.ts`                  |
| README「接入中转站」  | 三步：`export PACKY_API_KEY=…`；`config.json` 一个 provider + 模型级 `api`；`ama models discover packy --probe --write`；再写 `ama models cache-probe packy/kimi-k2.5` 看缓存是否可观测                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `README.md`、`docs/guides/providers.md`                                                                                 |

### §2.4 B9b 测试与发布

| 项                | 做法                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 文件                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| e2e               | 现有 `test/e2e/{print,rpc,codemode}.e2e.test.ts`（`AMA_E2E=1`、bundle 缺失跳过）补：ESM 宿主适配器（`test/fixtures/host/echo-host.mjs`）、`ELECTRON_RUN_AS_NODE=1`（用 `process.execPath` 模拟）、TUI 在 `MemoryTerminal`（进程内，B7 已有帧黄金）、`cache_miss` / `cache_warm` 在 stream-json 中出现（fake 脚本 `cache-miss.json`：第 3 次响应 cacheRead 0）                                                                                                                                                                                                                       | `test/e2e/*.e2e.test.ts`、`test/fixtures/scripts/cache-miss.json`                          |
| CI 跑 e2e         | `ci.yml` 在 `pnpm run ci` 之后加 `pnpm test:e2e`（三平台，bundle 已由 ci 构建）；打开 Windows 冒烟（去掉 `if: false`）并加 codemode：`node dist/bundle/ama.cjs -p "summarize" --model fake/echo --tools-preset codemode`（`AMA_FAKE_SCRIPT=test/fixtures/scripts/codemode-parallel.json`）                                                                                                                                                                                                                                                                                          | `.github/workflows/ci.yml`                                                                 |
| Windows 收尾      | `shell.ts` PowerShell 回退的 `exit_code`、Hook `cmd /d /s /c`、`taskkill /T /F` 已在单测覆盖（实施计划 §6.2）；本波只补 e2e 层验证与 `docs/guides/tui.md` 的 Windows Terminal 手测记录                                                                                                                                                                                                                                                                                                                                                                                              | —                                                                                          |
| bundle 级缓存测试 | `FakeProvider` 支持 `AMA_FAKE_RECORD=<file>`：每次请求把 `{ system, tools, messagesCount }` 追加一行；e2e 用 bundle 跑 20 回合（fake 脚本 `cache-stability-20.json`），断言全部行的 `system` / `tools` 相同（与 `src/cli/cache-stability.test.ts` 同口径，但走 bundle）                                                                                                                                                                                                                                                                                                             | `src/ai/fake/fake-provider.ts`、`test/e2e/cache.e2e.test.ts`                               |
| 真实 SSE 样本     | `scripts/record-sse.mjs` 已支持 `--base-url`；用中转录制：openai-completions（DeepSeek：text / reasoning-deepseek / tool-single / tool-multi / length；Kimi：usage-moonshot）、anthropic-messages（MiniMax：text / thinking / tool-single / tool-multi / length / usage-cache）、openai-responses（Grok / Qwen：text / tool-single / tool-multi / length）；同名覆盖手工样本并 `UPDATE_GOLDEN=1` 重生成，逐条审阅差异；无法触发的（429、disconnect、stream-error、overflow-400 若中转不返回标准文案）保留手工样本并在 `test/fixtures/sse/README.md` 标「手工」；Google 全部保留手工 | `test/fixtures/sse/**`、`scripts/record-sse.mjs`（加 `--header k=v` 以便中转需要的额外头） |
| 三预设基准        | `scripts/bench-presets.mjs --config <json> --models packy/kimi-k2.5,packy-msg/MiniMax-M2.7,packy/deepseek-v4-flash --presets default,minimal,codemode --tasks fix-bug,search-summarize,multi-file-refactor --runs 2 --max-requests 60 --budget-usd 3`：每个任务在临时目录准备 fixture 仓库，经 SDK `createRuntime` 跑 `-p` 等价流程，记录轮数、累计 input + cacheRead、cacheWrite、费用、墙钟、成功（脚本断言文件内容）；报告 `docs/benchmarks/presets-<date>.md`，结论回写 `design.md` §5.6 末段                                                                                   | `scripts/bench-presets.mjs`、`test/fixtures/bench/**`                                      |
| Release 双 bundle | `ci.yml` pack 步骤加 `dist/bundle/ama-sandbox.cjs`，`SHA256SUMS` 三项；`scripts/release-check.mjs`：`package.json.version` 与上一个 tag 比较，若 `HOST_API_VERSION` / `RPC_PROTOCOL_VERSION` / `SESSION_FORMAT_VERSION` 变化则要求主版本号变化；`pnpm run release:check` 加进 `ci`                                                                                                                                                                                                                                                                                                  | `.github/workflows/ci.yml`、`scripts/release-check.mjs`、`package.json`                    |

### §2.5 B9c 文档终稿与 README

| 文件                               | 来源             | 要点                                                                                                                                                                                                           |
| ---------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/reference/rpc.md`            | 3 行桩 → 终稿    | hello、33 条命令参数 / 响应、事件表（含 `cache_miss` / `cache_warm` / `context_pressure`、`permission_request.preview`）、`message_update` 重建、审批超时、退出语义、`test/fixtures/rpc/prompt.out.jsonl` 引用 |
| `docs/reference/session-format.md` | 桩 → 终稿        | 头、条目类型（含新增 `usage{kind:"cache_warm"}`、`leaf` 行）、投影规则、custom 类型表                                                                                                                          |
| `docs/reference/host-api.md`       | 桩 → 终稿        | HostApi 全接口、事件表（新增两事件）、`cache.onWarmingDecision`、`setBroker` 时机、ESM / CJS 加载、退出码 6 / 78                                                                                               |
| `docs/guides/hooks.md`             | 桩 → 终稿        | 9 事件、退出码语义、`viaCodemode / parentToolCallId`、matcher、信任、顺序图                                                                                                                                    |
| `docs/guides/providers.md`         | 草稿 → 终稿      | 新增「缓存」节（各家 usage 字段、`promptCache`、compat 开关、`cache-probe`）与「接入中转站」节（模型级 api、discover、环境变量 baseUrl）                                                                       |
| `docs/guides/tui.md`               | B7 草稿 → 终稿   | 状态栏新字段、`/session` / `/cache`、审批预览、组件库 API（`@armadra/agent/tui`）                                                                                                                              |
| `docs/guides/codemode.md`          | 草稿 → 终稿      | 权限类随 Node 版本、描述与示例、`only` 下误调用的提示、缓存一节补保温                                                                                                                                          |
| `docs/design/design.md`            | 增补             | §9.1 加「指纹 / 未命中 / 三态 / 保温 / 续写」五行；§5.6 写入基准结论；§10.2 加 `cache` 段；§17 加本波风险                                                                                                      |
| `docs/design/extensions.md`（新）  | §2.6 设计草案    | 不实现                                                                                                                                                                                                         |
| `README.md`                        | 去掉「设计阶段」 | 安装（Release 产物 / `npm i -g ./package.tgz` / `node ama.cjs`）、快速开始（零配置 + `ama auth set`）、接入中转站、缓存一节（状态栏怎么读）、SDK 示例、嵌入 Armadra 指向文档 B                                 |

### §2.6 未来本地扩展（设计草案，本波不实现）

- 位置：`~/.config/ama/extensions/*.{mjs,cjs}`（用户级）与 profile `extensions: [paths]`；项目级不支持。
- 契约：复用 `HostModule`（`hostApi`、`create(api)`），即扩展就是一个本地宿主适配器；允许多个（`activateHost` 推广为列表；`approvals.setBroker` 只允许第一个设置者，其余 warning；工具名冲突按加载顺序先到先得）。
- 新增 HostApi 面：`api.cache.onWarmingDecision(handler)`（返回 `"warm" | "stop"`，最后一个处理器胜出）、`api.commands.register({ name, description, run(args, ctx) })`（斜杠命令，`commands-core` 查表后调用，返回 `CommandResult`）、`api.ui.setStatus`（已有）。不开放渲染层（不做 UI mod）。
- 信任：首次发现扩展目录非空时列出文件名与 sha256 询问（交互）或拒绝（非交互）；决定写 `trust.json` 的 `extensions` 段（按文件哈希，改动后重新询问）；`ama doctor` 列出已启用扩展与哈希。
- 典型用例：Next steps 类建议（在 `agent_settled` 后 `ui.notify`）、通知（OSC 777）、git checkpoint（`turn_start` 时 `git stash create`）。

## §3 实施编排

### §3.1 批次与文件所有权

| 批次                    | 内容                                                                                                                         | 独占文件（到文件）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 依赖                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **W3-C0** 契约          | 前置 PR「contracts-wave3」                                                                                                   | `src/ai/types.ts`（`Usage.cacheReported`、`StreamOptions.purpose/toolChoice`、`Model.promptCache.minTokens`、compat 五字段）；`src/agent/types.ts`（`SessionEvent` 三事件、`SessionStats.cache`、`SubagentResult.cache` 在 `tools/types.ts`）；`src/session/types.ts`（`UsageEntry`、`LeafLine`）；`src/config/types.ts`（`CacheConfig`、`ModelConfig.api`）+ `schema.ts` 键表；`src/permissions/types.ts`（`ApprovalRequest.context.readFiles`、`preview`）；`src/host/types.ts`（两事件、`cache.onWarmingDecision` 可选）；`src/cli/subcommands/models.ts` 改为动作表 `MODELS_ACTIONS` | B7 合入                                            |
| **W3-C1a** 协议层缓存   | §1.3 字段与开关、§1.4 目录、400 剥离、TTL 顺序校验、`cacheReported` 解析、`toolChoice` 映射、anthropic `/v1` 去重            | `src/ai/apis/{anthropic-request,anthropic-messages,openai-request,openai-completions,openai-responses-request,openai-responses,google-request,google-generative-ai,openai-compat}.ts`、新 `src/ai/apis/cache-params.ts`、`src/ai/providers/catalog/*.json` + `catalog-data.ts`、`src/ai/cost.ts`（`priceTokens`）、`test/fixtures/sse/**/request-replay.golden.json`                                                                                                                                                                                                                     | C0                                                 |
| **W3-C1b** 会话层缓存   | §1.2 指纹、§1.5 未命中、§1.6 三态、§1.7 保温、§1.8 续写、§1.9 子会话、统计                                                   | 新 `src/ai/cache/{types,fingerprint,miss,reporting,warmer,economics}.ts`、新 `src/agent/session-cache.ts`、`src/agent/session.ts`（≤ 15 行接线）、`session-state.ts`、`session-subagent.ts`、`src/compaction/{summarize-tier,branch-summary}.ts`、`src/session/{projection,manager,store,migrate}.ts`（usage 条目 + leaf 行）、`src/cli/compose-session.ts`（桥接两事件、读 `cache` 配置）                                                                                                                                                                                               | C0                                                 |
| **W3-C2** 展示与命令    | §1.10 全部、§1.11 cache-probe、A4 状态栏项、70% / 90% 提示                                                                   | `src/modes/interactive/status-bar.ts`、`interactive-mode.ts`（onEvent 分支）、`line/line-render.ts`、`src/modes/commands-core.ts`、新 `src/modes/session-report.ts`、`src/modes/print/print-mode.ts`（json 字段）、`src/modes/rpc/commands.ts`（stats）、新 `src/cli/subcommands/models-cache-probe.ts`、`src/sdk.ts`（导出 stats 类型）                                                                                                                                                                                                                                                 | C0；运行时依赖 C1b（开发期用契约形状与 fake 数据） |
| **W3-B9a-1** 集成修复   | A1 启动 UI、A2 codemode、A3 `-p`、A5 表 B、A6 Markdown、A7 `/tree`（manager 侧由 C1b 改，这里只做 `commands.ts` 调用与测试） | `src/cli/compose.ts`、`src/cli/main.ts`、新 `src/modes/startup-ui-text.ts`、`src/codemode/*`、`src/agent/{tool-runner,retry,system-prompt}.ts`、`src/tools/task.ts`、`src/config/merge.ts`（去重）、`src/tui/components/markdown*.ts`、`docs/guides/codemode.md`                                                                                                                                                                                                                                                                                                                         | C0                                                 |
| **W3-B9a-2** 预览与组件 | §2.2 预览、A4 工具视图、A8 组件                                                                                              | 新 `src/permissions/preview.ts`、`src/agent/session-tools.ts`（`readFiles` 进 request）、`src/modes/interactive/{approval-dialog,tool-view}.ts`、`src/tui/components/{key-value,meter}.ts`、`src/tui.ts`、`test/fixtures/tui/approval-*.txt`                                                                                                                                                                                                                                                                                                                                             | C0                                                 |
| **W3-B12** 中转         | §2.3                                                                                                                         | `src/ai/providers/{registry,builtin}.ts`、`src/cli/compose-providers.ts`、新 `src/cli/subcommands/models-discover.ts`、新 `src/config/write.ts`、`src/cli/subcommands/{config,doctor}.ts`、`docs/guides/providers.md` 中转节                                                                                                                                                                                                                                                                                                                                                             | C0                                                 |
| **W3-B9b** 测试与发布   | §2.4                                                                                                                         | `test/e2e/**`、`test/fixtures/{scripts,sse,bench,host}/**`、`scripts/{record-sse,bench-presets,cache-experiment,release-check}.mjs`、`src/ai/fake/fake-provider.ts`（录制开关）、`.github/workflows/ci.yml`、`package.json` scripts                                                                                                                                                                                                                                                                                                                                                      | 全部合入后                                         |
| **W3-B9c** 文档         | §2.5                                                                                                                         | `docs/**`、`README.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | B9b                                                |

冲突回避：`status-bar.ts` / `commands-core.ts` / `line-render.ts` 只归 C2（B9a 需要的状态栏项列在 C2）；`session.ts` / `manager.ts` 只归 C1b（`/tree` 落盘的调用方 `interactive/commands.ts` 不必改，`navigate` → `setLeaf` 自动落盘）；`models.ts` 分派表在 C0 定型后 C2 与 B12 各加一行自己的文件；`src/ai/apis/*` 只归 C1a（B12 的 anthropic `/v1` 去重交给 C1a 做）；`compose-session.ts` 归 C1b，`compose.ts` 归 B9a-1。

### §3.2 关键接口签名

```ts
// src/agent/session-cache.ts [C1b]
export class SessionCacheController {
  constructor(
    core: SessionCore,
    settings: CacheSettings,
    deps?: { now?(): number; schedule?: typeof setTimeout },
  );
  wrapStream(stream: StreamFn): StreamFn; // 记录 RequestRecord、算指纹、检测未命中、更新三态、触发保温
  onAgentSettled(): void;
  onContextChanged(): void; // 压缩 / context_edit / setModel / navigate 后调用
  stats(): SessionStats["cache"];
  dispose(): void;
  setWarming(mode: WarmingMode): void;
}
// src/ai/cache/reporting.ts [C1b]
export class CacheReportingTracker {
  observe(record: RequestRecord, minTokens: number, ttlMs?: number): CacheReporting;
  get(key: string): CacheReporting;
}
// src/ai/cache/economics.ts [C1b]
export function evaluateWarm(
  model: Model,
  promptTokens: number,
  phase: "streaming" | "idle",
  minSavingsUsd: number,
): WarmDecision;
// src/ai/cost.ts [C1a]
export function priceTokens(
  model: Pick<Model, "cost">,
  tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>,
): number | undefined;
// src/ai/apis/cache-params.ts [C1a]
export function isCacheParamRejection(error: unknown): string | undefined; // 返回被拒字段名
export function stripCacheParams(body: Json): Json;
export const strippedCacheParams: Set<string>;
// src/compaction/summarize-tier.ts [C1b]
export async function completeByContinuation(
  options: SummarizerOptions,
  input: ContinuationInput,
): Promise<{ text: string; usage: Usage }>;
// src/permissions/preview.ts [B9a-2]
export function previewAction(
  request: ApprovalRequest,
  options: { cwd: string; maxEntries?: number },
): ActionPreview;
// src/cli/subcommands/models-discover.ts [B12]
export async function discoverModels(
  provider: ProviderData,
  apiKey: string | undefined,
  options?: { timeoutMs?: number },
): Promise<Model[]>;
export async function probeModelApis(
  registry: ProviderRegistryApi,
  provider: ProviderData,
  ids: string[],
  limit: number,
): Promise<Map<string, Api | undefined>>;
// src/config/write.ts [B12]
export function writeConfigFile(
  path: string,
  config: AmaConfig,
  options?: { backup?: boolean },
): void;
// src/cli/compose.ts [B9a-1]
export function createRuntimeDeps(
  options?: ComposeOptions & { io?: Pick<CliIo, "stdinIsTTY" | "stdoutIsTTY" | "env"> },
): RuntimeDeps;
```

### §3.3 测试清单

| 批次  | 测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1a   | 请求体快照：`prompt_cache_key` 只在 `sendPromptCacheKey` 时发；`prompt_cache_retention: "24h"` / `prompt_cache_options` 随 `long` 与开关；亲和头；`toolChoice: "none"` 四协议映射；Anthropic `long` 在 `supportsLongCacheRetention: false` 时降 short、TTL 顺序；`/v1` 去重；400 剥离（fake HTTP 400 体 → 第二次请求无该字段、仍只一个终止事件、`strippedCacheParams` 命中）；usage 解析 `cacheReported` 真值表（字段缺失 / 为 0 / > 0，四协议）；目录 `promptCache` 校验（`catalog.test.ts`）                                                                                                 |
| C1b   | `fingerprint`：同一上下文稳定、改一个工具描述只变 `tools`；`miss`：噪声下限、自适应阈值、重置点、五种归因、成本反推、模型无价；`reporting`：三态转移与 K=3；`warmer`（fake 时钟）：delay / deadline / 60 min / 30 min / 连续 2 次零命中停止 / 不可重放 / `isCurrent` 失败停止 / 否决钩子 / `unref`；`economics` 盈亏表 6 行；`session-cache`：fake 脚本 20 回合里第 7 回合 cacheRead 0 → 一次 `cache_miss{evicted}`；`/compact` 的续写请求体前缀与上一次真实请求逐字节一致、`tool_choice` 为 none、失败回落独立请求；`usage` 条目不进投影但进统计；子会话独立统计；`leaf` 行写读与 fork 不复制 |
| C2    | 状态栏三态文本与 `rebill` / `♨` / `net!` 项与窄屏丢弃顺序（帧黄金）；70% / 90% 跨越各提示一次；`/session` 面板黄金文本；`/cache warm idle` 切换；RPC `get_session_stats.cache` 形状；stream-json 含三事件；`cache-probe` 用 fake 供应商（脚本两次响应）三种判定与 `--json`、非 TTY 无 `--yes` 退出 2                                                                                                                                                                                                                                                                                           |
| B9a-1 | 启动 UI：TTY 下 `--resume` 无 id 走迷你 TUI（MemoryTerminal 注入）、管道下走文本问答；codemode 权限类随 capability、描述快照、`only` 下直接调 `read` 的错误文本；`-p` 前导空行；Markdown 增量：追加 1000 次后块数组与全量解析一致、仅末块重解析（计数）；表 B 删重后 `pnpm typecheck` 与现有测试全绿                                                                                                                                                                                                                                                                                           |
| B9a-2 | `preview`：`rm -rf dir`（fixture 树计数）、带通配符、重定向、`write` 覆盖未读文件 warn、`edit` 干跑成功 / 不唯一；对话框帧黄金含预览行；line 模式问句含预览；RPC 事件带 `preview`；`KeyValue` / `Meter` 帧测试；工具视图用 `renderCall`（codemode 标题显示脚本首行）                                                                                                                                                                                                                                                                                                                           |
| B12   | 模型级 `api` 合并与 `config show`；`discover` 对 fake HTTP `/models` 解析、`--probe` 协议顺序与上限、`--write` 合并不覆盖并备份；`OPENAI_BASE_URL` 覆盖 + 非官方主机接受任意 id + `sendPromptCacheKey` 为 false；`doctor` 标注                                                                                                                                                                                                                                                                                                                                                                 |
| B9b   | §2.4 各项；`release-check` 对版本规则的正反例                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### §3.4 验收命令

```sh
pnpm run ci                                   # 三平台；含 release:check
AMA_E2E=1 pnpm test:e2e                       # bundle 级：print / rpc / codemode / cache / host / electron
node dist/bundle/ama.cjs -p "hi" --model fake/echo --output-format json | jq .cache
printf '{"type":"get_session_stats"}\n' | node dist/bundle/ama.cjs --mode rpc --model fake/echo | jq 'select(.command=="get_session_stats").data.cache'
node dist/bundle/ama.cjs models cache-probe fake/echo --yes
node dist/bundle/ama.cjs models discover packy --probe --limit 6     # 本地，需 PACKY_API_KEY
node scripts/cache-experiment.mjs --config /path/config.json --model packy/kimi-k2.5 --case E2 --max-requests 6
node scripts/bench-presets.mjs --config /path/config.json --models packy/kimi-k2.5 --presets default,codemode --tasks fix-bug --runs 1
```

### §3.5 提交序列（每条 = 模块 + 测试）

- **C0**：① `feat(contracts): 第三波契约——Usage.cacheReported、StreamOptions.purpose/toolChoice、promptCache.minTokens、缓存 compat 开关`；② `feat(contracts): SessionEvent cache_miss / cache_warm / context_pressure 与 SessionStats.cache、SubagentResult.cache`；③ `feat(contracts): 会话 usage 条目与 leaf 行、CacheConfig、ModelConfig.api、ApprovalRequest.preview/readFiles、HostApi 两事件`；④ `refactor(cli): models 子命令改为动作表`。
- **C1a**：① `priceTokens`；② 兼容开关与请求字段（三协议）+ 快照；③ `toolChoice` 映射；④ `cacheReported` 解析（四协议）；⑤ 400 自动剥离；⑥ Anthropic 长保留降级与 TTL 顺序、`/v1` 去重；⑦ 目录 `promptCache` 取值 + catalog-data 重生成；⑧ `docs/guides/providers.md` 缓存节草稿。
- **C1b**：① `fingerprint`；② `miss`；③ `reporting`；④ `economics` + `warmer`（fake 时钟）；⑤ `session-cache` 接线（wrapStream、事件、stats）；⑥ `usage` 条目与投影 / 统计；⑦ 压缩续写 + 回落；⑧ 子会话独立统计与 `warmSubagents`；⑨ `leaf` 行落盘；⑩ `compose-session` 桥接与配置读取；⑪ `cache-stability.test.ts` 扩为含未命中与续写的 25 回合。
- **C2**：① `session-report` + `/session` / `/cache`；② 状态栏项与帧黄金；③ 70% / 90% 提示（TUI + line）；④ RPC stats 与 stream-json；⑤ `cache-probe`；⑥ `docs/guides/tui.md` / `docs/reference/rpc.md` 草稿段。
- **B9a-1**：① 启动 UI 接线（TUI + 文本回退）；② codemode 权限类与描述；③ `-p` 前导空行；④ 表 B 删重（每项一提交）；⑤ Markdown 增量解析；⑥ `docs/guides/codemode.md`。
- **B9a-2**：① `preview` 纯函数；② 对话框与 line 接线 + 帧黄金；③ RPC `preview` 字段；④ `KeyValue` / `Meter`；⑤ 工具视图 `renderCall`。
- **B12**：① 模型级 `api`；② `discoverModels` + `discover` 子命令；③ `--probe`；④ `writeConfigFile` + `--write`；⑤ 环境变量 baseUrl 与非官方主机放宽；⑥ `doctor` / `config show` 标注；⑦ 文档中转节。
- **B9b**：① fake 录制开关 + bundle 缓存 e2e；② 其余 e2e；③ CI e2e 与 Windows 冒烟；④ 真实 SSE 样本替换（每协议一提交，附审阅记录）；⑤ `bench-presets` 与报告；⑥ `cache-experiment` 与报告；⑦ Release 双 bundle + `release-check`。
- **B9c**：各文档一提交；README 最后。

### §3.6 并行分组

```text
G1  C0 契约（1 代理，半天）—— 前提：B7 PR 合入 main
G2  并行 5：C1a ｜ C1b ｜ B9a-1 ｜ B9a-2 ｜ B12
G3  并行 3：C2（C1b 合入后 rebase）｜ B9b 的脚本与 fixture 部分（record-sse、bench、cache-experiment 可先写，用 fake 验证）｜ B9c 文档草稿
G4  串行：B9b 集成（e2e、CI、真实样本、基准与实验）→ B9c 终稿 → Release v0.2.0
```

### §3.7 真实模型测试的环境变量与成本控制

| 变量                    | 用途                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| `PACKY_API_KEY`         | 中转 key（config 里 `"apiKey": "$PACKY_API_KEY"`，文档与报告不出现 key）    |
| `AMA_REAL_CONFIG`       | 真实实验用的 `config.json` 路径（缺省 `~/.config/ama/config.json`）         |
| `AMA_REAL_MODELS`       | 逗号分隔的 `provider/id`，脚本只跑这些                                      |
| `AMA_REAL_MAX_REQUESTS` | 单次脚本请求数硬上限（缺省 60；脚本内每个用例另有上限）                     |
| `AMA_REAL_BUDGET_USD`   | 按目录价累计的预算上限（缺省 3；无价模型按 input 1 / output 4 美元每 M 估） |
| `AMA_E2E=1`             | 启用 bundle e2e（fake 供应商，不花钱）                                      |

计数实现：脚本经 `ComposeOptions` 注入一层 `ApiRegistry` 包装，在 `stream()` 调用处计数并累计 usage 费用，超限抛 `AmaError("budget_exceeded")` 让当前运行以错误结束并输出已有数据。CI 永不设置这些变量。

## §4 风险与待定项

| #    | 风险 / 待定                                                                                                                                                                                                      | 处置                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| R1   | `session.ts` 已 577 行，再加接线会破 600 行上限                                                                                                                                                                  | 接线只 ≤ 15 行；若仍超，把 `childBase / spawnSubagent / fork` 移入 `session-subagent.ts` 的辅助函数（B2 文件归 C1b 一并改） |
| R2   | 保温重放对中转可能是**全价**而不是读价（中转改写请求、或缓存按连接亲和）                                                                                                                                         | 连续 2 次保温零命中即停；`/session` 显示保温费用；E2 实测前缺省 `streaming` 只在 `reported` 状态下生效                      |
| R3   | 压缩续写在 Anthropic 上「全前缀」断点能否命中到最后一条 user（上一轮断点位置）                                                                                                                                   | 请求体快照保证前缀逐字节一致；E3 实测 cacheRead 占比；不达 80% 则回落为现行独立请求并记 issue                               |
| R4   | 24h / 30m 长保留、亲和头、Kimi 的 `prompt_cache_key` 全部「需实测」                                                                                                                                              | 全部缺省关闭（官方端点的 24h 除外），文档标注验证状态；`cache-probe` 加 `--with-key` 变体便于用户自测                       |
| R5   | 自适应阈值在小前缀（< 4k）上过敏感                                                                                                                                                                               | 噪声下限 1024 + `minTokens` 兜底；提示门槛另有 20k / $0.10                                                                  |
| R6   | `leaf` 行与 `usage` 条目是会话格式的追加；旧版本读取会把它们当未知行                                                                                                                                             | 格式版本 1 尚无对外发布；`migrate.ts` 对未知 `type` 跳过并 warning；`docs/reference/session-format.md` 记为 v1 可选行       |
| R7   | `--probe` 对每个模型发最小请求，中转按次计费或限流                                                                                                                                                               | 缺省 `--limit 30`、执行前打印预估、429 即停                                                                                 |
| R8   | `OPENAI_BASE_URL` 覆盖后 compat 推断失效导致请求字段不被接受                                                                                                                                                     | 保守缺省 + 400 自动剥离兜底；`doctor` 提示「baseUrl 来自环境变量，compat 按保守缺省」                                       |
| R9   | 预览递归统计 `rm -rf /` 之类大目录耗时                                                                                                                                                                           | `maxEntries` 2000 与 200 ms 预算，超出显示「> 2000 项 / 超时」且仍标 danger                                                 |
| R10  | 真实 SSE 样本与手工样本在边角字段上不同（中转改写 usage 位置等），黄金大改                                                                                                                                       | 逐协议一提交、逐条审阅；语义不同的另存 `proxy-*` 用例而不是覆盖                                                             |
| 待定 | 状态栏命中率显示最近一次还是会话累计（本文选最近一次，累计在 `/session`）；`cache.missNotices` 缺省 true 是否过于吵（门槛 20k / $0.10 下应很少）；fork 沿用根会话缓存键是否需要开关；B4 `Meter` 是否进缺省状态栏 | C2 开工前在 `docs/guides/tui.md` 定稿                                                                                       |
