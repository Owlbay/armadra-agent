# 三预设基准任务（第三波 §2.4）

`scripts/bench-presets.mjs` 把每个任务的 `repo/` 复制到临时目录，用 `prompt.md` 作为 `-p` 等价
的一次 prompt，跑完由 `check.mjs`（默认导出 `(dir) => { ok, detail }`）断言文件内容。任务小而
确定：成功与否只看结果文件，不看模型措辞。

| 任务 | 内容 | 判定 |
| --- | --- | --- |
| fix-bug | `src/stats.js` 的 `median` 偶数长度分支取错下标；`node test.js` 失败 | `node test.js` 退出 0 且 `test.js` 未改 |
| search-summarize | 6 个文件里散落 5 处 `process.env.X` 读取 | `SUMMARY.md` 恰好列出 5 个 `路径: 变量`，不多不少 |
| multi-file-refactor | `fetchUser` 跨 4 个文件定义、导出、导入与调用 | 不再出现 `fetchUser`、`node main.js` 输出不变 |

多步长任务（第五波 W5-Z，D20 复测；`--tasks long` 选全部，不在缺省任务里）：

| 任务 | 内容 | 判定 |
| --- | --- | --- |
| multi-bug-hunt | 6 个模块各一个 bug（区间端点、月份、数量、大小写、LRU 刷新、分块尾巴）；`node test.js` 列出失败项 | `node test.js` 输出 ok 且 `test.js` 未改 |
| string-kit | 按 `SPEC.md` 实现 6 个字符串函数并在 README 加 `## API` | 隐藏用例全过、README 列出 6 个函数名 |
| inventory-feature | 7 步：3 个新函数、导出、报告两行、`main.js` 调整、CHANGELOG | 函数行为、`node main.js` 输出与 CHANGELOG 条目 |
