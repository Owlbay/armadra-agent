# 供应商与模型

B1 草稿（B9 统稿）。设计依据见 [design.md](design.md) §3。

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
候选。模型表为空的供应商（ollama、lmstudio、没写 `models` 的自定义供应商）接受任意 model id。

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

> 草稿（第三波 W3-C1a，协议层）。会话层的未命中检测、三态与保温见第三波设计 §1.5–§1.7。

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
