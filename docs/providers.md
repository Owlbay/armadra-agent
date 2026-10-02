# 供应商与模型

内置供应商、模型引用、API Key、自定义供应商与中转站、各协议的 compat 开关，以及缓存。设计依据见 [design.md](design.md) §3、§9.1。

## 内置供应商

| id           | 协议                                            | baseUrl                                             | API Key 环境变量（顺序）                                     |
| ------------ | ----------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| `anthropic`  | anthropic-messages                              | `https://api.anthropic.com`                         | `ANTHROPIC_API_KEY`、`AMA_API_KEY_ANTHROPIC`                 |
| `openai`     | openai-completions（推理模型 openai-responses） | `https://api.openai.com/v1`                         | `OPENAI_API_KEY`、`AMA_API_KEY_OPENAI`                       |
| `google`     | google-generative-ai                            | `https://generativelanguage.googleapis.com/v1beta`  | `GEMINI_API_KEY`、`GOOGLE_API_KEY`、`AMA_API_KEY_GOOGLE`     |
| `deepseek`   | openai-completions                              | `https://api.deepseek.com`                          | `DEEPSEEK_API_KEY`、`AMA_API_KEY_DEEPSEEK`                   |
| `moonshot`   | openai-completions                              | `https://api.moonshot.cn/v1`                        | `MOONSHOT_API_KEY`、`KIMI_API_KEY`、`AMA_API_KEY_MOONSHOT`   |
| `zhipu`      | openai-completions                              | `https://open.bigmodel.cn/api/paas/v4`              | `ZHIPU_API_KEY`、`ZAI_API_KEY`、`AMA_API_KEY_ZHIPU`          |
| `dashscope`  | openai-completions                              | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY`、`QWEN_API_KEY`、`AMA_API_KEY_DASHSCOPE` |
| `openrouter` | openai-completions                              | `https://openrouter.ai/api/v1`                      | `OPENROUTER_API_KEY`、`AMA_API_KEY_OPENROUTER`               |
| `groq`       | openai-completions                              | `https://api.groq.com/openai/v1`                    | `GROQ_API_KEY`、`AMA_API_KEY_GROQ`                           |
| `xai`        | openai-completions（目录模型 openai-responses） | `https://api.x.ai/v1`                               | `XAI_API_KEY`、`AMA_API_KEY_XAI`                             |
| `mistral`    | openai-completions                              | `https://api.mistral.ai/v1`                         | `MISTRAL_API_KEY`、`AMA_API_KEY_MISTRAL`                     |
| `ollama`     | openai-completions                              | `http://127.0.0.1:11434/v1`                         | 可无（`OLLAMA_API_KEY`）                                     |
| `lmstudio`   | openai-completions                              | `http://127.0.0.1:1234/v1`                          | 可无                                                         |

另有测试用供应商 `fake`（模型 `fake/echo`、`fake/reasoning`），见下文。

协议列是供应商级缺省；目录条目可以用 `api` 覆盖（openai 的推理模型与 xai 的目录模型走
`openai-responses`，非推理的 `gpt-4.1`、`gpt-4o*` 仍走 Completions）。

## 模型引用

`provider/model-id`，例如 `deepseek/deepseek-v4-pro`、`openrouter/anthropic/claude-sonnet-5.5`。
不带供应商前缀时在全部目录里唯一匹配；多家同名时只看已配置 key 的供应商，仍不唯一则报错并列出
候选。模型表为空的供应商（ollama、lmstudio、没写 `models` 的自定义供应商）与 baseUrl 指向非官方
主机的内置供应商（见「接入中转站」）接受任意 model id。

## API Key 发现顺序

1. `--api-key`（只对 `--model` 指定的供应商）
2. `--auth-file` / profile 的 `authFile`
3. `~/.config/ama/auth.json`（权限不是 0600 时警告但照用）
4. `config.json` 的 `providers.<id>.apiKey`：支持 `$ENV`、`${ENV}`、`!command`，`$$` 表示字面 `$`
5. 环境变量（上表顺序；profile `authEnv: false` 时跳过）
6. 本地服务（`requiresApiKey: false`）无 key 也能用

`auth.json` 的 `apiKey` 以 `!` 开头表示执行命令取值（10 秒超时；空输出或非零退出视为未配置）。

## 自定义供应商

```json
{
  "providers": {
    "my-proxy": {
      "baseUrl": "https://proxy.example/v1",
      "apiKey": "$MY_PROXY_KEY",
      "models": [{ "id": "gpt-x", "contextWindow": 128000, "maxTokens": 16384, "reasoning": true }],
      "compat": { "maxTokensField": "max_tokens" }
    },
    "deepseek": { "modelOverrides": [{ "id": "deepseek-flash", "contextWindow": 131072 }] }
  }
}
```

- `api` 缺省 `openai-completions`；自定义模型缺省 `maxTokens: 8192`、`reasoning: false`、
  `input: ["text"]`；不猜 `contextWindow`（缺省关自动压缩）。
- `models[]` 同 id 整条替换、新 id 追加；`modelOverrides[]` 只改已有模型的元数据。

## 接入中转站

同一个中转站下，不同模型支持的协议常常不同（有的三种都行，有的只有 Chat 与 Messages，有的只有
Responses）。一个供应商就够：协议写在模型上。

```sh
export PACKY_API_KEY=sk-...
```

```json
{
  "providers": {
    "packy": {
      "baseUrl": "https://proxy.example/v1",
      "apiKey": "$PACKY_API_KEY",
      "models": [
        { "id": "deepseek-v4-flash" },
        { "id": "grok-4.7", "api": "openai-responses" },
        { "id": "MiniMax-M2.7", "api": "anthropic-messages" }
      ]
    }
  }
}
```

- 模型的 `api` 缺省沿用供应商的（这里是 `openai-completions`）；`modelOverrides[]` 也可以改 `api`。
- 三种协议共用一个 `baseUrl`：Completions / Responses 拼 `/chat/completions`、`/responses`；
  Messages 在 baseUrl 以 `/v1` 结尾时拼 `/messages`，否则 `/v1/messages`。
- 不想手写 `models`：`ama models discover packy` 列出中转站的模型（`GET {baseUrl}/models`）；
  `--probe` 对每个模型依次试供应商协议、completions、responses、messages 的最小请求，记第一个成功
  的（每模型最多 3 次，`--limit` 限制探测的模型数，缺省 30，执行前打印预估，401 / 403 / 429 即停）；
  `--write` 把结果合并进用户级 `config.json`（已有同 id 不覆盖，只写 `id` 与和供应商不同的 `api`，
  原文件备份为 `config.json.bak`）。写入的条目没有 `contextWindow`，自动压缩随之关闭，需要时手动补。

```sh
ama models discover packy --probe --write --limit 8
ama -p "hi" --model packy/grok-4.7
```

零配置：内置 `openai` / `anthropic` 识别 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`（OpenAI SDK 与
Claude Code 的通行约定），优先级低于 config 与 auth.json 的 `baseUrl`，profile `authEnv: false` 时
不读。baseUrl 不在官方主机时，目录外的 model id 也接受，compat 按保守缺省（不发
`prompt_cache_key`）。`ama config show` 的「供应商」节与 `ama doctor` 标出 baseUrl 来自哪个变量；
零配置挑的缺省模型来自官方目录，中转站未必有，用 `--model` 或 `defaultModel` 指定。

```sh
OPENAI_BASE_URL=https://proxy.example/v1 OPENAI_API_KEY=$PACKY_API_KEY ama -p "hi" --model openai/qwen3.8-flash
```

接好之后：`ama models check packy/<id>` 发一次最小请求确认连通；`ama models cache-probe packy/<id>` 看这个端点报不报缓存（见下节「缓存」），中转上不报缓存的模型按建议设 `compat.cacheReporting: "silent"`，状态栏就显示「未报告」而不是 0%。

## OpenAI 兼容线的 compat

推断顺序：保守缺省 ← 推断表（provider id，其次 baseUrl 子串）← `provider.compat` ← `model.compat`。

| 开关                                          | 作用                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `maxTokensField`                              | `max_tokens` 或 `max_completion_tokens`                                                                                  |
| `supportsDeveloperRole`                       | 推理模型的系统提示用 `developer` 角色                                                                                    |
| `supportsUsageInStreaming`                    | 发 `stream_options.include_usage`                                                                                        |
| `supportsFinishReason`                        | false 时忽略 finish_reason，按内容推断停止原因                                                                           |
| `supportsReasoningEffort`                     | 发 `reasoning_effort`                                                                                                    |
| `thinkingFormat`                              | `openai` / `openrouter`（`reasoning.effort`）/ `deepseek`、`zai`（`thinking.type`）/ `qwen`（`enable_thinking`）/ `none` |
| `thinkingTokenBudgetField`                    | 预算字段名（DashScope：`thinking_budget`）                                                                               |
| `requiresReasoningContentOnAssistantMessages` | 推理模型的历史助手消息带 `reasoning_content`（DeepSeek）                                                                 |
| `requiresToolResultName`                      | 工具结果消息带 `name`（Mistral）                                                                                         |
| `requiresAssistantAfterToolResult`            | 工具结果后紧跟用户消息时插入一条助手消息                                                                                 |
| `supportsMidConvoSystemMessages`              | 后续系统提示补丁按位置作为 system 消息插回                                                                               |
| `cacheControlFormat`                          | `anthropic`：在 system、最后一个工具、最后一条 user/tool 消息上打 `cache_control`                                        |
| `supportsStrictTools`                         | 对严格兼容的工具 schema 发 `strict: true`                                                                                |
| `supportsStore`                               | 发 `store: false`                                                                                                        |

compat 只记录**已验证**的差异；新增条目请附文档链接或真实样本。

## Responses 与 Gemini 的 compat

| 协议                   | 开关                            | 作用                                                                                                      | 缺省                                         |
| ---------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `openai-responses`     | `supportsReasoningSummary`      | `reasoning.summary: "auto"`（思考块有文字）                                                               | OpenAI 官方开；xAI 与其它关                  |
| `openai-responses`     | `supportsStore`                 | 发 `store: false`；推理模型同时要 `include: ["reasoning.encrypted_content"]`，多轮回放加密 reasoning item | OpenAI 官方、xAI 开；其它关                  |
| `google-generative-ai` | `supportsThoughtSignature`      | 同模型回放 `thoughtSignature`（思考、文本、functionCall part）                                            | 开                                           |
| `google-generative-ai` | `supportsFunctionResponseParts` | 工具结果图片放进 `functionResponse.parts`；关时另起一个 user 回合                                         | Gemini 3 起开；Gemini 2.x 与非 Gemini 命名关 |

- Responses：系统提示放 `instructions`；缓存字段见下节「缓存」；思考 off 只在映射表给了 off 的字串（如 `"none"`）时发
  `reasoning.effort`，否则交给服务端缺省。
- Gemini：映射值是字串（或 Gemini 3 族且未映射）→ 离散 `thinkingLevel`（`LOW` / `HIGH`…）；映射值是
  数字或其它模型 → `thinkingBudget`（`-1` 动态）；off → `thinkingBudget: 0`。隐式缓存自动生效，
  `cachedContentTokenCount` 计入 `cacheRead`。

## 缓存

长任务的主要用量是缓存读取：前缀一旦变化，此后每次请求都要按全价重读。ama 分三层处理缓存：**协议层**按各家写法打断点、发缓存键与保留层级，并标记响应里有没有缓存字段；**会话层**记录每次请求的前缀指纹，检测未命中、判定端点报不报缓存、在长工具运行期间保温；**展示层**是状态栏、`/session`、RPC 统计与 `ama models cache-probe`（界面怎么读见 [tui.md](tui.md)「缓存与上下文」）。

前缀稳定由组装保证：系统提示节顺序固定、不含时间戳，工具按名排序，会话中途的变化只以 system 补丁追加在末尾（[session-format.md](session-format.md)「消息」）。

### 请求字段

| 协议                                     | 字段                                                                                     | 条件                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `anthropic-messages`                     | 三断点 `cache_control`（最后一条 user、system 末、最后一个工具）                         | `cacheRetention` 不是 `none`                                                             |
| `anthropic-messages`                     | `ttl: "1h"`                                                                              | `long` 且 `supportsLongCacheRetention`；否则按 5m                                        |
| `openai-completions`                     | `prompt_cache_key = sessionId`（截 64 字符）                                             | `sendPromptCacheKey` 且不是 `none`                                                       |
| `openai-completions`                     | `prompt_cache_retention: "24h"`                                                          | `long` 且 `supportsLongCacheRetention`                                                   |
| `openai-completions`（`anthropic/*` 等） | `cache_control`（`cacheControlFormat: "anthropic"`），`long` 时带 `ttl: "1h"`            | 同 Anthropic                                                                             |
| `openai-responses`                       | `prompt_cache_key`                                                                       | 同 Completions                                                                           |
| `openai-responses`                       | `prompt_cache_options: { ttl: "30m" }`，否则 `prompt_cache_retention: "24h"`             | `long` 且 `supportsExplicitPromptCacheMode`；否则 `long` 且 `supportsLongCacheRetention` |
| OpenAI 两条                              | 亲和头 `x-session-affinity` + 每请求 `x-client-request-id`（OpenRouter：`x-session-id`） | `sendSessionAffinityHeaders` 且有 sessionId                                              |
| `google-generative-ai`                   | 无（隐式缓存）                                                                           | —                                                                                        |
| 全部                                     | `toolChoice: "none"` → 各家的「禁止调用工具」写法                                        | 请求带工具时（压缩摘要的前缀续写用）                                                     |

保留层级：`StreamOptions.cacheRetention` 优先；未指定时读 `AMA_CACHE_RETENTION=none|short|long`；都没有为
`short`。Anthropic 请求体最后做 TTL 顺序校验（tools → system → messages 里 5m 之后出现 1h 则全部降为 5m）。
Anthropic 的 `baseUrl` 以 `/v1` 结尾时请求 `{baseUrl}/messages`，不会拼成 `/v1/v1/messages`。

### 兼容开关（`providers.<id>.compat` 或模型级 `compat`）

| 开关                              | 作用                                                    | 缺省                                      |
| --------------------------------- | ------------------------------------------------------- | ----------------------------------------- |
| `sendPromptCacheKey`              | 发 `prompt_cache_key`                                   | 请求主机是 `api.openai.com` 时开，其余关  |
| `sendSessionAffinityHeaders`      | 发亲和头                                                | 关（含 OpenRouter，未实测）               |
| `supportsLongCacheRetention`      | `long` 可用（Anthropic 1h、OpenAI 24h）；否则降为 short | `api.openai.com` / `api.anthropic.com` 开 |
| `supportsExplicitPromptCacheMode` | Responses 的 `prompt_cache_options`（30m）              | 关                                        |
| `cacheReporting`                  | `auto` / `silent` / `reported`：强制「是否报缓存」三态  | `auto`                                    |

推断只看最终请求的主机名，不看 provider id：用 `OPENAI_BASE_URL` 或自定义 `baseUrl` 把 `openai` 指到中转时
按中转处理。缺省只对官方端点开，是因为中转上实测「接受但未见收益」或「收下但不生效」（下表）。

**400 自动剥离**：端点以 400 拒收并在错误体里点名 `prompt_cache_key` / `prompt_cache_retention` /
`prompt_cache_options` / `cache_control` 时，ama 把 `provider/model` 记入进程内的剥离表，去掉这些字段重发一次
（仍只有一个终止事件），提示一次建议写哪个开关；同一进程里之后的请求直接不带。

### usage 与 `cacheReported`

原始 usage 里出现任一缓存字段（即使为 0）→ `Usage.cacheReported = true`，都没有 → `false`：Completions 认
`prompt_tokens_details.cached_tokens` / `cache_write_tokens`、`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`、
顶层 `cached_tokens`；Responses 认 `input_tokens_details.cached_tokens`；Anthropic 认
`cache_read_input_tokens` / `cache_creation_input_tokens`；Google 认 `cachedContentTokenCount`（隐式缓存未命中时
常常不给）。字段存在但一直为 0 的端点由会话层按连续 3 次判 `silent`。

### 模型目录 `promptCache`

只写有公开依据的值（秒 / token）：Anthropic 全部 `short 300 / long 3600`，`minTokens` 按模型 512–4096；OpenAI
全部 `short 300 / long 86400 / minTokens 1024`；Kimi 全部 `short 300`。DeepSeek、智谱、通义、Groq、xAI、Mistral、
OpenRouter、Google 没有承诺的 TTL，留空（不保温，归因按隐式缓存 10 分钟估）。可在 `models[]` /
`modelOverrides[]` 里自填。

### 会话层：指纹、未命中与三态

每次真实请求在内存里记一条记录：前缀指纹（system 与工具表各取 sha256 前 16 位 hex，加 `provider/model`）、`promptTokens`（input + cacheRead + cacheWrite）、用量与发出时刻。下一次请求与上一条比对：

- **未命中**：`missed = min(上次前缀, 本次前缀) − 本次 cacheRead`，低于噪声下限（`max(1024, promptCache.minTokens)`）不计；相对比例超过随规模自适应的门槛（约 `0.10 × √(100k / 前缀)`，夹在 2%–30%），或绝对值 ≥ 20 000 才记一次。重计费金额按本条实付单价与读价之差估算，模型无价格时只有 token。
- **原因**（按顺序判定）：system / 工具表指纹变了 → `prefix_changed`（`detail` 说明哪段，多半是宿主中途注册工具或 Hook 上下文变化）；模型变了 → `model_changed`；间隔超过 TTL → `idle`（目录没有 TTL 的隐式缓存按 10 分钟估）；两次请求之间 `task` 子任务占了间隔的 80% 以上 → `subtask`；其余 → `evicted`（服务端淘汰）。
- **不算未命中**：压缩、分支摘要、档一裁剪之后的首个请求（上下文合法地变了）；前缀低于最小可缓存长度。切换模型**不**豁免。
- **三态**：按 `(provider, baseUrl 主机名, model)` 在进程内维护。`unknown`：还没有足够长的可比请求；`reported`：出现过 cacheRead 或 cacheWrite > 0；`silent`：连续 3 个可比请求（前缀 ≥ minTokens、指纹未变、间隔 < TTL）读写都是 0，或 `compat.cacheReporting: "silent"`。只有 `reported` 时显示命中率、检测未命中并保温；`unknown` / `silent` 的请求不进命中率分母，界面显示 `—` / `未报告` 而不是 0%。

`task` 子会话有自己的记录链与统计，`/session` 的「子任务」行汇总；fork 出的会话沿用根会话 id 作 `prompt_cache_key`（只是路由提示）。

### 保温

工具长时间运行（长测试、`task` 子任务、codemode 脚本）时，前缀可能在下一次请求前过期。保温在 TTL 到期前重放上一次真实请求（同模型、同上下文，`maxTokens: 1`），只买一次读价，把缓存续上。

| 项     | 规则                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 模式   | `off`；`streaming`（缺省，只在运行中、也就是工具执行期间）；`idle`（运行结束后的空闲期也保温，适合贵模型）                                                                                 |
| 前提   | 端点为 `reported`；模型目录有 `promptCache.short`（TTL > 10 秒）；请求的 `cacheRetention` 不是 `none`；请求体没被 `onPayload` 替换；Anthropic 开思考且思考预算随 `max_tokens` 推导的不保温 |
| 时机   | 从上一次请求**发出**时刻起算，`max(1s, min(0.9·TTL, TTL − 10s))` 后发；计时器迟到超过截止（睡眠、事件循环阻塞）直接停                                                                      |
| 经济性 | `p · missCost − warmCost ≥ cache.minSavingsUsd`（缺省 $0.05）才发，`p` 在 streaming 为 1、idle 为 0.15；缺价格不发                                                                         |
| 上限   | streaming 60 分钟、idle 30 分钟；连续 2 次保温零命中即停                                                                                                                                   |
| 取消   | 换模型、换思考级别、压缩、`/tree`、退出时取消，下一次真实请求再开始                                                                                                                        |
| 记账   | 成功的保温追加 `usage{kind:"cache_warm"}` 条目（不进上下文），计入 `/session` 费用与 RPC 统计；事件 `cache_warm{scheduled｜sent｜stopped}`                                                 |

宿主可以经 `api.cache.onWarmingDecision` 否决或强制每一次保温（[host-api.md](host-api.md)「缓存保温」）。子会话缺省不保温（`cache.warmSubagents: true` 打开）。按目录价格估算，长工具运行期间几乎总是划算；空闲保温只对贵模型、长前缀划算。

### 压缩摘要续写

档二压缩的摘要请求不再另起一段新对话，而是在与上一次真实请求逐字节相同的前缀后面追加一条摘要指令（`toolChoice: "none"`、`cacheRetention: "short"`），所以整段历史按读价计费。响应为空、被截断、含工具调用或请求出错时，回落为独立的摘要请求（`cacheRetention: "none"`）并记 warning。

### 配置

```json
{
  "cache": {
    "warming": "streaming",
    "retention": "short",
    "minSavingsUsd": 0.05,
    "missNotices": true,
    "warmSubagents": false
  }
}
```

| 键              | 缺省        | 说明                                                                                          |
| --------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `warming`       | `streaming` | `off` / `streaming` / `idle`；环境变量 `AMA_CACHE_WARMING` 覆盖；`/cache warm …` 本会话内切换 |
| `retention`     | `short`     | `none` / `short` / `long`；环境变量 `AMA_CACHE_RETENTION` 覆盖                                |
| `minSavingsUsd` | `0.05`      | 保温的最低期望节省（美元）                                                                    |
| `missNotices`   | `true`      | 消息区的未命中与上下文余量提示（统计不受影响）                                                |
| `warmSubagents` | `false`     | `task` 子会话也保温                                                                           |

整段只认用户级与 profile 的 `config.json`，项目级忽略并 warning。供应商级开关在 `providers.<id>.compat`（上文「兼容开关」），TTL 在模型的 `promptCache`。

### `ama models cache-probe`

```sh
ama models cache-probe <provider/id> [--tokens 2048] [--gap-ms 3000] [--json] [--yes]
```

用一个确定性的固定前缀（约 `--tokens` token）+ `Reply with: ok`，`maxTokens: 16`，相隔 `--gap-ms` 发两次，判定：

- `reported`：第二次 cacheRead ≥ 前缀的 50%；目录没有 `promptCache` 时建议自填 `promptCache.short` 以启用保温；
- `silent`：两次读写都是 0；建议设 `compat.cacheReporting: "silent"`。响应里有缓存字段但恒为 0 时另提示可能是写入延迟（同一中转的 kimi-k2.5 间隔 3 秒两次都是 0、间隔 8 秒第二次读满前缀），可加大 `--gap-ms` 重试；
- `inconclusive`：读到一点或只有写入，多半是缓存粒度或 TTL 问题。

输出两次请求的 input / cacheRead / cacheWrite 与该协议读取的 usage 字段名。这是计费动作：执行前打印预估（无价格显示 `$?`），交互终端问一次 y/N，非交互环境必须带 `--yes`（否则退出 2）；`--json` 时预估写 stderr，stdout 只有结果对象。

### 中转实测（2026-10-02）

一家同时提供 Chat / Responses / Messages 三种接口的测试中转，固定前缀约 8.6k–10.9k token，同一前缀相隔 2–3 秒
发两次（共 38 次请求）。

| 接口 / 模型                                       | 发送的缓存参数                                    | 结果                    | 第二次 cacheRead / 前缀    | usage 里的缓存字段（原始形状）                                                |
| ------------------------------------------------- | ------------------------------------------------- | ----------------------- | -------------------------- | ----------------------------------------------------------------------------- |
| Chat · kimi-k2.5                                  | 无                                                | 200                     | 8576 / 8597                | `prompt_tokens_details.cached_tokens`（首个请求为 0）                         |
| Chat · kimi-k2.5                                  | `prompt_cache_key`；再加亲和头                    | 200，接受               | 8576 / 8597（无提升）      | 同上                                                                          |
| Chat · deepseek-v4-flash                          | `prompt_cache_key` + `x-session-affinity`         | 200，接受               | 9472 / 9767                | `prompt_tokens_details.cached_tokens`                                         |
| Chat · qwen3.8-flash                              | 同上                                              | 200，接受               | 10240 / 10400              | 同上                                                                          |
| Chat · glm-5                                      | 同上                                              | 200，接受               | 8704 / 9040                | 同上                                                                          |
| Chat · MiniMax-M2.7                               | 同上                                              | 200，接受               | 9389 / 9700                | 同上                                                                          |
| Responses · qwen3.8-flash                         | `prompt_cache_key` + `prompt_cache_retention`     | 200，接受               | 10240 / 10432              | `input_tokens_details.cached_tokens`                                          |
| Responses · qwen3.8-flash                         | `prompt_cache_options: {ttl:"30m"}`               | 200，接受               | 同上                       | 同上                                                                          |
| Responses · grok-4.7                              | 同上两组                                          | 200，接受               | 1152 / 10929               | 同上                                                                          |
| Responses · deepseek-v4-flash                     | `prompt_cache_retention` / `prompt_cache_options` | **400** `unknown field` | —                          | 去掉后 200；`input_tokens_details.cached_tokens`                              |
| Messages · kimi-k2.5、qwen3.8-flash               | `cache_control` + `ttl:"1h"`                      | 200，接受               | 9464 / 9476、10385 / 10400 | `cache_creation.ephemeral_5m_input_tokens` 有值、无 1h 字段：**1h 被当作 5m** |
| Messages · MiniMax-M2.7、deepseek-v4-flash、glm-5 | 同上                                              | 200，接受               | 9403、8192、8704           | `cache_creation_input_tokens` 恒 0，读命中照常（端点自管的隐式缓存）          |

结论与缺省值：

- `prompt_cache_key`、亲和头在中转上都被接受，但未见命中提升 → `sendPromptCacheKey`、
  `sendSessionAffinityHeaders` 对非官方端点缺省关；需要时自行打开（400 剥离兜底）。
- 1h 保留在中转的 Messages 接口上被收下但按 5m 写入，Responses 的长保留字段在部分上游 400 →
  `supportsLongCacheRetention` 只对官方端点缺省开，`supportsExplicitPromptCacheMode` 缺省关。
- 实测的五家在 Chat 接口上都报缓存字段（前一版调研里 DeepSeek / GLM 报 0 的现象本次未复现），它们首个
  请求的 `cached_tokens: 0` 正是「字段存在但为 0」，`cacheReported` 为 true。
- `/v1` 去重与 `toolChoice: "none"` 经 ama 协议层实发验证：Messages 请求落在 `/v1/messages`，三种接口都接受
  `tool_choice: none` 且未产生工具调用。

## 测试用 fake 供应商

`--provider fake --model fake/echo`：回显最后一条用户消息。设 `AMA_FAKE_SCRIPT=<file.json>` 后
按脚本第 n 次调用产出文本、思考、工具调用、429、溢出、断流、延迟，脚本格式见
`src/ai/fake/fake-script.ts`，示例在 `test/fixtures/scripts/`。
