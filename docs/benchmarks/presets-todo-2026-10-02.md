# D20 基准：todo 进 default 预设（2026-10-02）

> 第五波 W5-H2。对照组 `default-todo` = config `tools.default: ["-todo"]`（第三波报告里的六工具 default）；`default` 自第五波起含 `todo`。原始数据 `presets-todo-2026-10-02.json`，`node scripts/bench-presets.mjs --render <json>` 可重出下方表格。

## 环境

- 本分支构建（W5-H2 全部改动：头尾截断、重复调用检测、提醒通道等都在；两组只差 `todo` 是否在工具表）；SDK `createRuntime`，权限 `full-auto`，保温关闭，任务仓库在临时目录。
- 测试中转站 `packy`（chat 渠道），模型 `kimi-k2.5`、`deepseek-v4-flash`；三个任务各 1 次；单次运行上限 8 请求，全局上限 60 请求、$2。
- 实际：60 次请求（触发上限，最后一组 deepseek · default-todo · multi-file-refactor 中止，不进判定），保守计价 $0.049。

## 结论

1. **按门保留 todo 在 default**：5 对完整配对里两组都是 5/5 成功；统一估价（与缓存同口径，第三波预设报告也用这一列）todo 组 **−3.6%**，在 5% 门内。
2. **差异主要是噪声**：这些小任务里模型一次也没调用 `todo`，两组行为差别只有工具表多一项（约 140 token，在缓存前缀里）。输入 token 合计 +17.9%、保守计价（缓存读按全价）+5.2%，主要来自 deepseek 两组轮数不同（fix-bug 6 对 5、search-summarize 4 对 3）；固定开销按每请求约 140 token 计，在 2k token 量级的小上下文里约 +7% 输入、几乎全部是缓存读。
3. **置信度低**：只有 5 对、每组 1 次。门的读数接近边界的一侧取决于计价口径（统一估价 −3.6%，保守计价 +5.2%）。建议后续用更长的多步任务（todo 真正被调用的场景）、每组 ≥ 3 次复测；在那之前按门的定义保留。

> 由 `scripts/bench-presets.mjs` 生成。模型：packy/kimi-k2.5、packy/deepseek-v4-flash；预设：default、default-todo；任务：fix-bug、search-summarize、multi-file-refactor；每组 1 次。
> 请求 60 次（上限 60），预算计价 $0.049（上限 $2）；**提前停止：请求数达到上限 60**。
> 「估价」按统一价 input / cacheWrite 1、cacheRead 0.1、output 4 美元每 M 计，跨模型可比，不是真实账单；「输入」= input + cacheRead + cacheWrite（模型实际读入的 token）。保温关闭。达到全局上限而中止的运行标「中止」，不进汇总。

## 按预设 × 任务

| 预设         | 任务                | 成功 | 平均轮数 | 平均输入 | 平均估价 | 平均墙钟 |
| ------------ | ------------------- | ---- | -------- | -------- | -------- | -------- |
| default      | fix-bug             | 2/2  | 6.0      | 15.3k    | $0.0084  | 23.7s    |
| default-todo | fix-bug             | 2/2  | 5.5      | 13.1k    | $0.0100  | 13.7s    |
| default      | search-summarize    | 2/2  | 3.5      | 7845     | $0.0047  | 7.2s     |
| default-todo | search-summarize    | 2/2  | 3.0      | 5476     | $0.0043  | 7.1s     |
| default      | multi-file-refactor | 2/2  | 5.5      | 14.3k    | $0.0092  | 17.8s    |
| default-todo | multi-file-refactor | 1/1  | 7.0      | 13.6k    | $0.0054  | 16.8s    |

## 按预设合计

| 预设         | 成功 | 轮数合计 | 输入合计 | 估价合计 | 墙钟合计 |
| ------------ | ---- | -------- | -------- | -------- | -------- |
| default      | 6/6  | 30       | 74.9k    | $0.0447  | 97.5s    |
| default-todo | 5/5  | 24       | 50.8k    | $0.0341  | 58.4s    |

## D20 判定（todo 是否留在 default）

> 只比两组都跑完的 5 对（同模型 × 任务 × 次）。门：todo 组估价涨幅 ≤ 5% 且成功数不降。

| 组                   | 成功 | 请求 | 输入  | 估价    | 预算计价 | todo 调用 |
| -------------------- | ---- | ---- | ----- | ------- | -------- | --------- |
| default（含 todo）   | 5/5  | 25   | 59.9k | $0.0329 | $0.024   | 0         |
| default-todo（对照） | 5/5  | 24   | 50.8k | $0.0341 | $0.022   | 0         |

估价涨幅 -3.6%（门用这一列：与缓存同口径）；输入 token +17.9%、保守计价（缓存读也按全价）+5.2%；成功数未降 → **保留 todo 在 default**。

## 明细

| 模型                    | 预设         | 任务                | 成功 | 轮数 | 工具（内层） | 输入  | 其中缓存读 | 写入 | 输出 | 估价    | 墙钟  | 说明                               |
| ----------------------- | ------------ | ------------------- | ---- | ---- | ------------ | ----- | ---------- | ---- | ---- | ------- | ----- | ---------------------------------- |
| packy/kimi-k2.5         | default      | fix-bug             | ✓    | 6    | 7            | 13.0k | 9984       | 0    | 419  | $0.0057 | 13.3s | node test.js → ok                  |
| packy/kimi-k2.5         | default-todo | fix-bug             | ✓    | 6    | 7            | 12.3k | 6528       | 0    | 473  | $0.0083 | 14.0s | node test.js → ok                  |
| packy/deepseek-v4-flash | default      | fix-bug             | ✓    | 6    | 7            | 17.6k | 10.2k      | 0    | 682  | $0.0111 | 34.1s | node test.js → ok                  |
| packy/deepseek-v4-flash | default-todo | fix-bug             | ✓    | 5    | 5            | 14.0k | 6144       | 0    | 844  | $0.0118 | 13.5s | node test.js → ok                  |
| packy/kimi-k2.5         | default      | search-summarize    | ✓    | 3    | 2            | 4876  | 4224       | 0    | 120  | $0.0016 | 4.2s  | 5 / 5                              |
| packy/kimi-k2.5         | default-todo | search-summarize    | ✓    | 3    | 2            | 4519  | 3584       | 0    | 118  | $0.0018 | 4.4s  | 5 / 5                              |
| packy/deepseek-v4-flash | default      | search-summarize    | ✓    | 4    | 4            | 10.8k | 6144       | 0    | 661  | $0.0079 | 10.2s | 5 / 5                              |
| packy/deepseek-v4-flash | default-todo | search-summarize    | ✓    | 3    | 2            | 6432  | 2048       | 0    | 570  | $0.0069 | 9.8s  | 5 / 5                              |
| packy/kimi-k2.5         | default      | multi-file-refactor | ✓    | 6    | 11           | 13.7k | 11.6k      | 0    | 866  | $0.0066 | 20.7s | 4 个文件、输出不变                 |
| packy/kimi-k2.5         | default-todo | multi-file-refactor | ✓    | 7    | 12           | 13.6k | 11.8k      | 0    | 588  | $0.0054 | 16.8s | 4 个文件、输出不变                 |
| packy/deepseek-v4-flash | default      | multi-file-refactor | ✓    | 5    | 12           | 15.0k | 8192       | 0    | 1045 | $0.0118 | 15.0s | 4 个文件、输出不变                 |
| packy/deepseek-v4-flash | default-todo | multi-file-refactor | 中止 | 6    | 13           | 16.9k | 8192       | 0    | 1030 | $0.0136 | 16.3s | budget_exceeded: 请求数达到上限 60 |
