# D20 复测：多步长任务下 todo 是否留在 default（2026-10-03）

> 第五波 W5-Z。W5-H2 的首测（[presets-todo-2026-10-02.md](presets-todo-2026-10-02.md)）只用了三个小任务、每组 1 次，模型一次也没调用 todo，置信度低；本次换成需要 5 步以上、适合 todo 跟踪的多步长任务，每组 3 次。原始数据 `presets-todo-2026-10-03.json`，`node scripts/bench-presets.mjs --render <json>` 可重出下方表格。

## 环境

- 分支 `batch/w5-z-release`（main d52f23b 之上，第五波全部批次已合入）；SDK `createRuntime`，权限 `full-auto`，保温关闭，任务仓库在临时目录。Node 26.10（操作系统沙箱可用，两组的 `default` 都带 codemode，todo 在 codemode 脚本里两组都可调用；差别只在模型**直接**看到的工具表里有没有 `todo`）。
- 测试中转站 `packy`（chat 渠道），模型 `kimi-k2.5`、`deepseek-v4-flash`。
- 任务（`--tasks long`，见 `test/fixtures/bench/README.md`）：`multi-bug-hunt`（6 个模块各一个 bug）、`string-kit`（按规格实现 6 个函数 + README）、`inventory-feature`（7 步功能扩展）。
- 每组 3 次，2 模型 × 2 组 × 3 任务 × 3 次 = 36 次运行；单次运行上限 25 请求，全局上限 600 请求、$2.5。
- 实际：203 次请求、预算计价 $0.259；另有 1 次 9 请求的试跑（$0.011）。合计 212 次请求、约 $0.27（预算计价按缓存读全价的保守口径，真实账单不高于此）。
- 运行时 `default` 预设仍含 todo，所以原始数据里 `default` = 含 todo，`default-todo` = 对照（`meta.defaultHasTodo` 缺省按含 todo 渲染）；撤回后的脚本里对照组写作 `default`、含 todo 组写作 `default+todo`。

## 结论

1. **按门撤出 default**：18 对完整配对里，含 todo 组成功 17/18、对照 18/18（成功数下降）；统一估价 **+4.6%**（门内），但输入 token +15.8%、保守计价 +11.3%。门的定义是「估价涨幅 ≤ 5% 且成功数不降」，成功数一项未过。
2. **todo 很少被用**：36 次运行里只有 1 次（kimi · string-kit 第 1 次）调用了 todo（4 次调用），那一次用了 10 轮，同组其余两次是 5–8 轮；deepseek 一次也没用。唯一的失败（kimi · string-kit 第 3 次，`padCenter` 未通过）发生在没有调用 todo 的运行里，更像任务本身的波动；但 todo 在工具表里的固定开销（每请求约 140 token）与偶尔多出来的轮数是实打实的，收益没有显出来。
3. **撤回后的做法**：`default` 预设回到六个工具；计划批准后的进度改用 `[DONE:<步骤>]` 文本标记（docs/plan.md「进度记法」），ama 读标记推进计划待办，界面与 RPC 的进度显示不变。需要 todo 的用户用 `tools.default: ["+todo"]`。

> 由 `scripts/bench-presets.mjs` 生成的表格如下（标题行略）。
> 由 `scripts/bench-presets.mjs` 生成。模型：packy/kimi-k2.5、packy/deepseek-v4-flash；预设：default、default-todo；任务：multi-bug-hunt、string-kit、inventory-feature；每组 3 次。
> 请求 203 次（上限 600），预算计价 $0.259（上限 $2.5）。
> 「估价」按统一价 input / cacheWrite 1、cacheRead 0.1、output 4 美元每 M 计，跨模型可比，不是真实账单；「输入」= input + cacheRead + cacheWrite（模型实际读入的 token）。保温关闭。达到全局上限而中止的运行标「中止」，不进汇总。

## 按预设 × 任务

| 预设         | 任务              | 成功 | 平均轮数 | 平均输入 | 平均估价 | 平均墙钟 |
| ------------ | ----------------- | ---- | -------- | -------- | -------- | -------- |
| default      | multi-bug-hunt    | 6/6  | 5.3      | 18.9k    | $0.0139  | 22.8s    |
| default-todo | multi-bug-hunt    | 6/6  | 5.7      | 20.4k    | $0.0161  | 23.9s    |
| default      | string-kit        | 5/6  | 6.7      | 22.7k    | $0.0159  | 32.1s    |
| default-todo | string-kit        | 6/6  | 5.8      | 18.7k    | $0.0165  | 31.3s    |
| default      | inventory-feature | 6/6  | 5.5      | 23.3k    | $0.0188  | 31.0s    |
| default-todo | inventory-feature | 6/6  | 4.8      | 16.9k    | $0.0138  | 27.3s    |

## 按预设合计

| 预设         | 成功  | 轮数合计 | 输入合计 | 估价合计 | 墙钟合计 |
| ------------ | ----- | -------- | -------- | -------- | -------- |
| default      | 17/18 | 105      | 389.3k   | $0.2911  | 515.0s   |
| default-todo | 18/18 | 98       | 336.2k   | $0.2784  | 495.4s   |

## D20 判定（todo 是否留在 default）

> 只比两组都跑完的 18 对（同模型 × 任务 × 次）。门：todo 组估价涨幅 ≤ 5% 且成功数不降。

| 组                | 成功  | 请求 | 输入   | 估价    | 预算计价 | todo 调用 |
| ----------------- | ----- | ---- | ------ | ------- | -------- | --------- |
| 含 todo           | 17/18 | 105  | 389.3k | $0.2911 | $0.136   | 4         |
| 不含 todo（对照） | 18/18 | 98   | 336.2k | $0.2784 | $0.122   | 0         |

估价涨幅 +4.6%（门用这一列：与缓存同口径）；输入 token +15.8%、保守计价（缓存读也按全价）+11.3%；成功数下降 → **撤出 default（退回 [DONE:n] 文本交接）**。

## 明细

| 模型                    | 预设         | 任务              | 成功 | 轮数 | 工具（内层） | 输入  | 其中缓存读 | 写入 | 输出 | 估价    | 墙钟  | 说明                   |
| ----------------------- | ------------ | ----------------- | ---- | ---- | ------------ | ----- | ---------- | ---- | ---- | ------- | ----- | ---------------------- |
| packy/kimi-k2.5         | default      | multi-bug-hunt    | ✓    | 5    | 15           | 14.3k | 9984       | 0    | 1037 | $0.0095 | 22.7s | node test.js → ok      |
| packy/kimi-k2.5         | default-todo | multi-bug-hunt    | ✓    | 5    | 16           | 13.6k | 5376       | 0    | 1058 | $0.0129 | 23.7s | node test.js → ok      |
| packy/deepseek-v4-flash | default      | multi-bug-hunt    | ✓    | 5    | 15           | 19.1k | 10.2k      | 0    | 1730 | $0.0168 | 19.8s | node test.js → ok      |
| packy/deepseek-v4-flash | default-todo | multi-bug-hunt    | ✓    | 5    | 15           | 17.8k | 8192       | 0    | 1554 | $0.0167 | 18.8s | node test.js → ok      |
| packy/kimi-k2.5         | default      | multi-bug-hunt    | ✓    | 5    | 15           | 14.3k | 11.4k      | 0    | 1014 | $0.0081 | 22.0s | node test.js → ok      |
| packy/kimi-k2.5         | default-todo | multi-bug-hunt    | ✓    | 5    | 15           | 13.6k | 10.6k      | 0    | 963  | $0.0079 | 21.2s | node test.js → ok      |
| packy/deepseek-v4-flash | default      | multi-bug-hunt    | ✓    | 7    | 22           | 32.3k | 21.0k      | 0    | 2549 | $0.0236 | 28.8s | node test.js → ok      |
| packy/deepseek-v4-flash | default-todo | multi-bug-hunt    | ✓    | 7    | 22           | 30.8k | 18.7k      | 0    | 2461 | $0.0238 | 27.2s | node test.js → ok      |
| packy/kimi-k2.5         | default      | multi-bug-hunt    | ✓    | 5    | 15           | 14.3k | 11.4k      | 0    | 1070 | $0.0083 | 23.0s | node test.js → ok      |
| packy/kimi-k2.5         | default-todo | multi-bug-hunt    | ✓    | 5    | 15           | 13.6k | 10.6k      | 0    | 987  | $0.0080 | 21.1s | node test.js → ok      |
| packy/deepseek-v4-flash | default      | multi-bug-hunt    | ✓    | 5    | 15           | 19.1k | 10.2k      | 0    | 1739 | $0.0169 | 20.1s | node test.js → ok      |
| packy/deepseek-v4-flash | default-todo | multi-bug-hunt    | ✓    | 7    | 22           | 33.1k | 19.2k      | 0    | 2894 | $0.0274 | 31.5s | node test.js → ok      |
| packy/kimi-k2.5         | default      | string-kit        | ✓    | 10   | 11           | 32.9k | 28.9k      | 0    | 1979 | $0.0147 | 43.1s | 6 个函数与 README      |
| packy/kimi-k2.5         | default-todo | string-kit        | ✓    | 7    | 9            | 22.0k | 18.2k      | 0    | 2267 | $0.0147 | 47.9s | 6 个函数与 README      |
| packy/deepseek-v4-flash | default      | string-kit        | ✓    | 6    | 10           | 25.2k | 14.3k      | 0    | 2867 | $0.0238 | 29.7s | 6 个函数与 README      |
| packy/deepseek-v4-flash | default-todo | string-kit        | ✓    | 5    | 7            | 16.6k | 6144       | 0    | 1820 | $0.0184 | 21.6s | 6 个函数与 README      |
| packy/kimi-k2.5         | default      | string-kit        | ✓    | 5    | 7            | 13.5k | 10.9k      | 0    | 1412 | $0.0094 | 30.7s | 6 个函数与 README      |
| packy/kimi-k2.5         | default-todo | string-kit        | ✓    | 6    | 8            | 16.4k | 13.1k      | 0    | 1449 | $0.0105 | 31.3s | 6 个函数与 README      |
| packy/deepseek-v4-flash | default      | string-kit        | ✓    | 6    | 8            | 19.5k | 10.8k      | 0    | 1383 | $0.0154 | 17.5s | 6 个函数与 README      |
| packy/deepseek-v4-flash | default-todo | string-kit        | ✓    | 6    | 9            | 24.9k | 12.3k      | 0    | 3385 | $0.0274 | 37.2s | 6 个函数与 README      |
| packy/kimi-k2.5         | default      | string-kit        | ✗    | 8    | 10           | 27.3k | 23.4k      | 0    | 2339 | $0.0156 | 48.9s | 未通过：padCenter      |
| packy/kimi-k2.5         | default-todo | string-kit        | ✓    | 5    | 7            | 13.2k | 10.4k      | 0    | 1424 | $0.0095 | 29.9s | 6 个函数与 README      |
| packy/deepseek-v4-flash | default      | string-kit        | ✓    | 5    | 8            | 17.6k | 10.8k      | 0    | 2145 | $0.0165 | 22.8s | 6 个函数与 README      |
| packy/deepseek-v4-flash | default-todo | string-kit        | ✓    | 6    | 9            | 19.1k | 8192       | 0    | 1611 | $0.0182 | 19.9s | 6 个函数与 README      |
| packy/kimi-k2.5         | default      | inventory-feature | ✓    | 4    | 9            | 11.1k | 8704       | 0    | 1267 | $0.0083 | 26.8s | 函数、报告与 CHANGELOG |
| packy/kimi-k2.5         | default-todo | inventory-feature | ✓    | 4    | 9            | 10.5k | 7680       | 0    | 1233 | $0.0085 | 27.0s | 函数、报告与 CHANGELOG |
| packy/deepseek-v4-flash | default      | inventory-feature | ✓    | 8    | 16           | 44.5k | 31.5k      | 0    | 4194 | $0.0329 | 40.6s | 函数、报告与 CHANGELOG |
| packy/deepseek-v4-flash | default-todo | inventory-feature | ✓    | 5    | 13           | 17.7k | 10.2k      | 0    | 2078 | $0.0168 | 23.3s | 函数、报告与 CHANGELOG |
| packy/kimi-k2.5         | default      | inventory-feature | ✓    | 4    | 9            | 11.1k | 8704       | 0    | 1260 | $0.0083 | 26.4s | 函数、报告与 CHANGELOG |
| packy/kimi-k2.5         | default-todo | inventory-feature | ✓    | 5    | 13           | 15.0k | 11.5k      | 0    | 1537 | $0.0108 | 32.7s | 函数、报告与 CHANGELOG |
| packy/deepseek-v4-flash | default      | inventory-feature | ✓    | 5    | 11           | 21.4k | 12.3k      | 0    | 2825 | $0.0216 | 27.1s | 函数、报告与 CHANGELOG |
| packy/deepseek-v4-flash | default-todo | inventory-feature | ✓    | 7    | 15           | 34.1k | 25.3k      | 0    | 3344 | $0.0246 | 33.4s | 函数、报告与 CHANGELOG |
| packy/kimi-k2.5         | default      | inventory-feature | ✓    | 4    | 9            | 11.0k | 8192       | 0    | 1246 | $0.0086 | 26.2s | 函数、报告与 CHANGELOG |
| packy/kimi-k2.5         | default-todo | inventory-feature | ✓    | 4    | 9            | 10.6k | 7808       | 0    | 1377 | $0.0091 | 28.8s | 函数、报告与 CHANGELOG |
| packy/deepseek-v4-flash | default      | inventory-feature | ✓    | 8    | 16           | 40.8k | 26.6k      | 0    | 4000 | $0.0329 | 38.8s | 函数、报告与 CHANGELOG |
| packy/deepseek-v4-flash | default-todo | inventory-feature | ✓    | 4    | 10           | 13.5k | 8192       | 0    | 1745 | $0.0131 | 18.9s | 函数、报告与 CHANGELOG |
