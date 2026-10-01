# SSE 样本

**手工构造，待用 `scripts/record-sse.mjs` 以真 key 替换。**

这些样本按各家官方文档描述的流格式手写（字段名、事件顺序、usage 位置、错误体形状），
用于协议解析的黄金测试（`src/ai/apis/*.test.ts`）。CI 不联网、没有真 key，所以入库的是
构造样本；开发者在本地用真 key 录制后覆盖同名文件，再用 `UPDATE_GOLDEN=1` 重新生成
`*.golden.json` 并逐条审阅差异。

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

## 用例清单

| 协议 | 用例 |
| --- | --- |
| anthropic-messages | text、thinking、redacted-thinking、tool-single、tool-multi、length、usage-cache（1h 缓存写）、rate-limit-429、overflow-400、stream-error（流内 overloaded）、disconnect |
| openai-completions | text、reasoning-deepseek（reasoning_content + prompt_cache_hit_tokens）、tool-single、tool-multi（按 index 交错）、tool-noindex（按 id）、stop-with-tools（finish=stop 但有工具调用）、length、usage-moonshot（choices[0].usage + 顶层 cached_tokens）、usage-groq（x_groq.usage）、rate-limit-429、overflow-400、stream-error（流内 error 对象）、disconnect |
| google-generative-ai | text、thinking（thought part + 末尾空文本 part 的 thoughtSignature + thoughtsTokenCount）、tool-single（缺 id、签名在 functionCall 上）、tool-multi（文本后并行两调用，一个带 id）、length（MAX_TOKENS）、usage-cache（cachedContentTokenCount）、rate-limit-429（RESOURCE_EXHAUSTED）、overflow-400（INVALID_ARGUMENT）、disconnect（无 finishReason）、safety（finishReason SAFETY）、stream-error（流内 error 对象）；request-replay.golden.json 是回放请求体快照 |
