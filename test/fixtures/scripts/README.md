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
