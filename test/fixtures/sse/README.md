# SSE 样本

用于协议解析的黄金测试（`src/ai/apis/*.test.ts`）。两种来源：

- **实录**：2026-10-02 用 `scripts/record-sse.mjs` 经测试中转站（OpenAI 兼容 `/v1`、Responses、
  Anthropic Messages 同主机）录制的原始响应，只保留状态码与白名单响应头，不含请求与 key；
- **手工**：按各家官方文档描述的流格式手写（字段名、事件顺序、usage 位置、错误体形状）。
  中转站无法触发的（429、断流、流内错误、溢出文案）以及官方端点特有、中转不透传的字段
  （DeepSeek 的 `prompt_cache_hit_tokens`、Moonshot 的 `choices[0].usage`、Anthropic 1h 缓存写
  的分档）保留手工样本。

实录与手工语义相同（同一解析路径）的同名覆盖；语义不同的实录另存为 `proxy-*`，手工样本保留
（第三波 §4 R10）。重录后用 `UPDATE_GOLDEN=1` 重新生成 `*.golden.json` 并逐条审阅差异。
CI 不联网、没有真 key。

## 文件格式

文件头部连续的 `#` 开头行是元信息，其后原样作为响应体：

```text
#status 429
#header retry-after: 7
#header content-type: application/json
{"type":"error", ...}
```

- `#status`：HTTP 状态码（缺省 200）；
- `#header name: value`：响应头，可多行；
- `#error-after-body`：响应体发完后让底层流以网络错误结束（模拟连接被重置）。

测试对每个样本跑三遍：整块、7 字节一块（跨 UTF-8 与跨行切分）、行尾改为 CRLF；
三遍的事件序列必须一致。

## 来源

| 协议 | 实录（模型） | 手工 |
| --- | --- | --- |
| anthropic-messages | text、tool-single、length、proxy-thinking、proxy-tool-multi、proxy-usage-cache（MiniMax-M2.7；usage-cache 为同一前缀第二次请求） | thinking（带签名）、redacted-thinking、tool-multi（空参数与转义）、usage-cache（1h 写入分档）、rate-limit-429、overflow-400、stream-error、disconnect |
| openai-responses | text（grok-4.7）、tool-single、length、proxy-tool-multi（qwen3.8-flash） | reasoning-summary、reasoning-encrypted、tool-multi（output_index 交错 + done 补尾巴）、usage-cache、rate-limit-429、overflow-400、failed-overflow、content-filter、stream-error、disconnect |
| google-generative-ai | —（测试中转不提供 Gemini 协议） | 全部 |
| openai-completions | text、tool-single、proxy-reasoning-deepseek、proxy-tool-multi、proxy-length（deepseek-v4-flash）；proxy-usage-kimi（kimi-k2.5，同一前缀第二次请求） | reasoning-deepseek、tool-multi（index 交错到达）、tool-noindex、stop-with-tools、length（Moonshot usage 位置）、usage-moonshot、usage-groq、rate-limit-429、overflow-400、stream-error、disconnect |

中转实录里观察到、手工样本没有的形状。Chat Completions：每个 delta 都带 `"content":""` 与 `role`（不能因此开空
文本块）；usage 在 `finish_reason` 块与其后空 `choices` 块各出现一次；DeepSeek 的缓存读被改写成
`prompt_tokens_details.cached_tokens`；`max_tokens` 只限正文，思考 token 另计（proxy-length 的
output 521 / reasoning 504）。Anthropic 形状的中转实录：思考块 `signature` 恒为空串（解析为
`thinkingSignature: ""`，不当成 redacted）；`message_start` 的 `input_tokens` 与 `message_delta`
不同，以后者为准；`message_delta.usage` 里多一个 OpenAI 形状的 `prompt_tokens_details`。
Responses 形状的中转实录：Qwen 用 `response.reasoning_text.delta`（不是 summary 事件）流出思考，
reasoning item 的 id 以 `msg_` 开头、无 `encrypted_content`；Grok 不理会 `max_output_tokens: 16`
（所以 length 改用 Qwen 录），usage 里另有 `cost_in_usd_ticks` 等私有字段。

## 用例清单

| 协议 | 用例 |
| --- | --- |
| anthropic-messages | text、thinking、redacted-thinking、tool-single、tool-multi、length、usage-cache（1h 缓存写）、rate-limit-429、overflow-400、stream-error（流内 overloaded）、disconnect |
| openai-completions | text、reasoning-deepseek（reasoning_content + prompt_cache_hit_tokens）、tool-single、tool-multi（按 index 交错）、tool-noindex（按 id）、stop-with-tools（finish=stop 但有工具调用）、length、usage-moonshot（choices[0].usage + 顶层 cached_tokens）、usage-groq（x_groq.usage）、rate-limit-429、overflow-400、stream-error（流内 error 对象）、disconnect |
| google-generative-ai | text、thinking（thought part + 末尾空文本 part 的 thoughtSignature + thoughtsTokenCount）、tool-single（缺 id、签名在 functionCall 上）、tool-multi（文本后并行两调用，一个带 id）、length（MAX_TOKENS）、usage-cache（cachedContentTokenCount）、rate-limit-429（RESOURCE_EXHAUSTED）、overflow-400（INVALID_ARGUMENT）、disconnect（无 finishReason）、safety（finishReason SAFETY）、stream-error（流内 error 对象）；request-replay.golden.json 是回放请求体快照 |
| openai-responses | text、reasoning-summary（两段 summary + encrypted_content + cached_tokens / reasoning_tokens）、reasoning-encrypted（无 summary 的加密 reasoning item 后接工具调用）、tool-single、tool-multi（按 output_index 交错，done 补尾巴）、length（incomplete max_output_tokens）、usage-cache（input_tokens_details.cached_tokens）、rate-limit-429、overflow-400（context_length_exceeded）、failed-overflow（流内 response.failed）、content-filter（其它 incomplete 原因）、stream-error（error 事件）、disconnect；request-replay.golden.json 是回放请求体快照 |
