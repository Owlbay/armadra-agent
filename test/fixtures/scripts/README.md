# fake 供应商脚本

`--provider fake` / `AMA_FAKE_SCRIPT=<file>` 或测试里 `new FakeProvider(loadFakeScript(path))` 使用。
格式见 `src/ai/fake/fake-script.ts` 文件头；第 n 次调用取 `responses[n]`，用完按 `whenExhausted`
（缺省 echo）。

| 文件 | 用途 |
| --- | --- |
| tool-then-text.json | 思考 + 文本 + 工具调用，下一轮给最终文本 |
| retry-429.json | 429 → 529 → 成功（会话层重试） |
| overflow-then-ok.json | 溢出 → 摘要 → 重试成功（压缩后重试一次） |
| disconnect-then-ok.json | 断流 → 成功（失败尝试用 context_edit 剔除） |
| parallel-tools.json | 一轮三个工具调用（并行 / 串行传染） |
| slow-stream.json | 慢流（abort 落在块中间） |
| codemode-parallel.json | 一次 codemode 调用：脚本里 Promise.all 并行 read / grep / glob，只回脚本输出 |
| cache-stability-20.json | 20 回合（每三回合一次 read），bundle 级缓存测试配 `AMA_FAKE_RECORD` 断言前缀逐字节不变 |
| cache-miss.json | 三次请求：写入 → 命中 → 第 3 次 cacheRead 0，stream-json 出现 `cache_miss{evicted}` |
| cache-warm.json | 一次 3.5 s 的 bash 工具运行；配 `promptCache.short: 12` 的模型时运行期间保温一次（`cache_warm{sent}`） |
