# 模型调用效率实测（2026-10）

> 依据 [model-efficiency-plan.md](../model-efficiency-plan.md) 各批次的真实测量，由收尾批次 `[ME-Z]` 汇总。
> key 由 ama 自己的供应商注册表解析后只传给协议层，没有读取、打印或记录；会话与数据目录都在 `/tmp` 下的临时目录（`AMA_DATA_DIR`），脚本放在仓库外。

## 总览

| 节  | 批次     | 端点                                                         | HTTP 请求 | 结论                                                                                             |
| --- | -------- | ------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------ |
| F   | `[ME-A]` | packy deepseek-v4-flash、kimi-k2.5；本机中转 astr gpt-6-luna | 16        | fork 子会话首请求的命中与父自己的下一回合相同                                                    |
| P   | `[ME-B]` | packy deepseek-v4-flash（新旧版本对照）                      | 4         | 对话中移除工具后：0.7.3 读数 0，本版 6144 / 7112（86%）                                          |
| M   | `[ME-C]` | packy kimi-k2.5                                              | 2         | 「max_tokens 范围」400 后以 98304 重发成功                                                       |
| I   | `[ME-D]` | 本机中转 astr gemini-3.8-flash-low                           | 2         | 中转 gemini 继承官方目录的图片输入，0.7.x 拒发的图片请求现在正常回答                             |
| —   | 整体验收 | fake 供应商                                                  | 0         | 「20 回合 + 加删工具 + resume 改 AGENTS.md + /compact + 10 回合」system 全程逐字节相同（见末节） |

读数口径：`ratio = cacheRead / (input + cacheRead + cacheWrite)`；packy 的 DeepSeek 缓存读按 2048 token 一块计（见 [cache-2026-10-02](cache-2026-10-02.md) E1），8k 规模时上限约 77%–86%。

## F：fork 式子 Agent（`[ME-A]`，2026-10-10）

### 环境

- `[ME-A]` 分支 `pnpm build:lib` 的构建，经 SDK `createRuntime` 运行（`--tools read,task`、`full-auto`、无人值守）。
- 父会话一条 user 消息：`docs/design.md` 前 24 000 字符作参考资料（约 7.3k–7.9k token）+ 指令「用 `context` 调一次 `task`，子任务只回 OK，返回后回 DONE」。每次运行 = 父请求 1（发出 `task`）→ 子会话首请求 → 父请求 2（收尾）。
- 端点：packy 中转 `deepseek-v4-flash@chat`、`kimi-k2.5@chat`（openai-completions）；本机中转 `astr/gpt-6-luna`（openai-responses，自定义供应商缺省不发 `prompt_cache_key` 与亲和头）。
- 读数：`ratio = cacheRead / (input + cacheRead + cacheWrite)`。packy 的 DeepSeek 缓存读按 2048 token 一块计（见 [cache-2026-10-02](cache-2026-10-02.md) E1）。

### 数据

| #   | 模型 / 模式               | 父请求 1 读 / 前缀     | 子会话首请求 读 / 前缀   | 父请求 2 读 / 前缀   | 说明                                                               |
| --- | ------------------------- | ---------------------- | ------------------------ | -------------------- | ------------------------------------------------------------------ |
| F1  | deepseek-v4-flash · fork  | 0 / 7872（冷）         | **6144 / 7967（77%）**   | 6144 / 8014（77%）   | 子会话与父自己的下一回合命中相同（2048 块粒度的上限）              |
| F2  | kimi-k2.5 · fork          | 0 / 7253（冷）         | **7168 / 7352（97.5%）** | 7168 / 7314（98%）   | 与父的下一回合相同                                                 |
| F3  | gpt-6-luna · fork         | 0 / 7733（冷）         | **0 / 7832（0%）**       | 6656 / 7785（85.5%） | 子会话请求落到没有这段缓存的上游                                   |
| F4  | deepseek-v4-flash · fresh | 7680 / 7872（F1 余温） | **0 / 1295**             | 6144 / 7992（77%）   | 对照：fresh 子会话只带系统提示 + 工具 + 任务，前缀不足一块，读数 0 |
| F5  | gpt-6-luna · fork（重跑） | 0 / 7733（冷）         | **6656 / 7832（85%）**   | 0 / 7785（0%）       | 这次轮到父请求 2 落空；子会话还多跑了 1 次请求（见局限）           |

合计 16 次 HTTP 请求（F1–F4 各 3 次，F5 4 次），比共同规则的 15 次上限多 1 次：F5 的子会话多出一轮，事先无法预知。

### 结论

- **前缀成立**：DeepSeek 与 Kimi 上 fork 子会话的首请求命中与父自己的下一回合完全相同（F1、F2），与 fake 测试里「system + tools 逐字节相同、消息是父请求前缀 + `<task>`」一致。设计预期的 ≥ 95% 在 Kimi 上达到；DeepSeek 受 2048 块粒度限制，8k 规模时上限约 77%，前缀越长越接近 100%。
- **经济性**（DeepSeek 命中价约为未命中的 1/50）：F1 的子会话折合约 1823 + 6144 / 50 ≈ 1.9k 全价 token，F4 的 fresh 子会话 1.3k——fork 多花约 0.6k，换来子 Agent 拿到 8k 父上下文；子任务若要重读其中任何一份文件，fork 就更便宜。
- **OpenAI 系经中转**：F3 / F5 两次都有一个请求落空，与 fork 无关——这个自定义供应商不发路由键，中转在多个上游之间分配请求。官方端点缺省发 `prompt_cache_key`，fork 子会话沿用父链根 id，路由一致。
- **指令串台**：F5 的子会话把父消息里「调用 `task`」的指令当成自己的，调了一次 `task`（按深度被拒）才回答。实现随后在 `<task>` 开头加了一句「上面的请求属于主 Agent、只做这项任务」（未再实测，请求次数已用完）。

### 局限

- 每种组合只跑 1–2 次，粒度与中转路由的波动没有统计意义；Anthropic 协议未实测。
- 子会话只回一个词，没有覆盖「子会话多回合」时的命中（之后的回合是子会话自己的前缀，与 fresh 相同）。

## P：对话中移除工具不再折回开头（`[ME-B]`，2026-10-10）

### 环境

- 同一组命令分别用已安装的 0.7.3（ME-B 之前）与本分支 `pnpm build` 的 `dist/bundle/ama.cjs` 各跑一遍，各自独立的临时 cwd 与 `AMA_DATA_DIR`。
- 请求 1：`ama -p "<reference>docs/design.md 前 24 000 字符</reference> … Reply with exactly: OK" --model packy/deepseek-v4-flash`（约 7k token，冷）。
- 请求 2：`ama -c --exclude-tools bash -p "Reply with exactly: OK2"`——resume 时少了 `bash`，即「对话开始后移除工具」，转录多一条 `toolsRemoved: [bash]` 的 system 补丁。

### 数据

| 版本         | 请求 1 input / cacheRead | 请求 2 input / cacheRead | 请求 2 比例 | 请求 2 的 system 补丁                         |
| ------------ | ------------------------ | ------------------------ | ----------- | --------------------------------------------- |
| 0.7.3        | 7067 / 0（冷）           | 6848 / **0**             | 0%          | 改写 `tools` 节，移除折回开头，工具表重发     |
| 本版（ME-B） | 7051 / 0（冷）           | 968 / **6144**           | **86%**     | 只有 `toolsRemoved`；开头不变，尾部提醒不可用 |

### 结论

- 0.7.3 移除工具会重写开头的 `tools` 节与工具表，之后整段按全价重读；本版保留声明、尾部提醒，前缀命中与相邻回合相同（受 2048 块粒度限制）。
- 压缩后首请求的前缀（D4）与摘要续写边界（D6）没有做真实测量：fake 用例按 Anthropic / OpenAI 两种请求构造函数逐字节比对了 `{system, tools}` 与消息前缀（`src/cli/cache-stability.test.ts`「开头只写一次」「档一 / 档二边界」、`src/cli/cache-acceptance.test.ts`），真实端点对同一前缀只会复现上表的命中。

## M：max_tokens 范围 400 的被动修正（`[ME-C]`，2026-10-10）

packy `kimi-k2.5`（openai-completions，目录窗口 262 144），SDK 脚本以 `maxTokens: 262144` 发最小请求：

| #   | 发出的 max_tokens                         | 结果                                                             |
| --- | ----------------------------------------- | ---------------------------------------------------------------- |
| M1  | 260 054（主动收紧：262 144 − 42 − 2 048） | 400 `InvalidParameter: Range of max_tokens should be [1, 98304]` |
| M2  | 98 304（被动修正，记入 `maxTokensCaps`）  | 200，回复 `ok`，usage input 16 / output 2                        |

- 主动收紧只按「窗口 − 输入估算 − 2048」算，中转自己的输出上限只能靠 400 得知；修正在流开始之前完成，调用方看不到错误。`maxTokensCaps` 是进程级的，重启后第一次仍会被拒一次，长期使用建议在 `modelOverrides` 写真实 `maxTokens`。
- 429 `Retry-After` 与限流重试上限无法在中转上可控地触发，只有 fake 用例（`src/agent/fallback.test.ts`「429 带 Retry-After」：`delayMs ∈ [16000, 24000]`、`maxAttempts 5`）。Anthropic 第 4 断点与「`input length and max_tokens exceed context limit`」文案未经官方端点取样。
- 跨进程（#152，2026-10-10）：同一隔离 `AMA_DATA_DIR`、`modelOverrides` 写 `maxTokens: 262144`，`ama -p` 跑两个进程。进程 1：400（发出 258 544）→ 98 304 重发 200，写出 `models/max-tokens-caps.json`（`packy/kimi-k2.5: 98304`）。
- 进程 2：启动时载回，首个请求直接发 98 304，200，**0 次 400**。条目 30 天过期，删文件即重测。

## I：中转模型继承官方目录（`[ME-D]`，2026-10-10）

| #   | 命令                                                         | 0.7.x                                                 | 本版                                                                                               |
| --- | ------------------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| I1  | `ama -p --image red.png --model astr/gemini-3.8-flash-low …` | 拒发：`does not accept image input`（没有 HTTP 请求） | 回答 `Red`                                                                                         |
| I2  | 同上，`green.jpg`                                            | —                                                     | 回答 `Green`                                                                                       |
| —   | `ama models list --provider astr`（不发请求）                | 无图片、无窗口                                        | `ctx 1M · out 66k · images`，`catalog google/gemini-3.8-flash`                                     |
| —   | `ama models list --provider packy`（不发请求）               | —                                                     | `deepseek-v4-flash` → `catalog deepseek/deepseek-flash`，thinking / images 来源 `catalog (via id)` |

- 中转的 `gemini-3.8-flash-low` 在 models.dev 没有条目，靠「去掉思考档后缀后唯一命中」继承图片输入与 1M 窗口；思考档后缀命中时不发思考参数（中转按 id 定档）。

## 整体验收（fake，`[ME-Z]`）

| 设计 §4 | 内容                                                                                                | 证据                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | 20 回合 + 中途加工具 + 中途删工具 + resume 改 AGENTS.md + `/compact` + 再 10 回合                   | `src/cli/cache-acceptance.test.ts`：36 个回合请求的 system 逐字节相同；工具表只在加工具那次末尾多一项、之后不变；system 条目 1 条全量 + 补丁 |
| 2       | fork 子会话首请求前缀 = 父上一次请求；首条 `ama.task{context:"fork"}`；不进 `ama sessions` 缺省列表 | `src/agent/subagent-fork.test.ts`「system + tools 与父上一次请求逐字节相同…」（含 `isSubagentSessionFile`）                                  |
| 3       | 429 `retryAfterMs: 20000` → `delayMs ∈ [16000, 24000]`，5 次用尽才回退                              | `src/agent/fallback.test.ts`「[ME-C] 429 带 Retry-After…」                                                                                   |
| 4       | 400 `Range of max_tokens should be [1, 98304]` → 第二次请求 98304                                   | `src/ai/apis/max-tokens.test.ts`「400 范围文案 → 以上限重发一次…」；真实见 M 节                                                              |
| 5       | `packy/deepseek-v4-flash` 来源字段                                                                  | `src/cli/subcommands/model-meta.test.ts`「[ME-D] 中转模型按 id 继承目录…」、`src/ai/providers/enrich.test.ts`；真实见 I 节                   |
| 6       | 真实测量                                                                                            | F 16 + P 4 + M 2 + I 2 = 24 次 HTTP 请求（设计预算 8，分批放宽到每批 ≤ 15）                                                                  |

## 局限

- 每种组合只跑 1–2 次，块粒度与中转路由的波动没有统计意义；全部经中转，Anthropic 协议与官方端点都没有实测。
- P 节只覆盖「resume 时移除工具」；对话中由宿主移除工具走同一条补丁路径，没有单独实测。
