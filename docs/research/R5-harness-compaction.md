# R5：ama 的 Agent Harness 与自动压缩调研

> 调研对象：`/Users/yovinchen/Projects/Rust/Tauri/armadra-agent`（main，2026-10-02）。只读调研，未改任何仓库代码。
> 证据标注：`文件:行号` 指 ama 仓库；「工具 A 包」指本机 工具 A 2.1.285 打包文本 `本机材料`（只学行为，引用均 ≤ 15 词）；「工具 B 包」指本机 工具 B 0.160.0 二进制的字符串（`strings` 抽取到 `本机材料`）；其余为公开网页（文末列来源）。标「二手」的数字来自第三方转述，未在一手资料核实。

---

## 0. 结论

1. **社会上哪种自动压缩更好：「先遮蔽旧工具结果，LLM 摘要兜底」的分层方案最好，而且两层都要按缓存经济学来触发。**
   - 论文「The Complexity Trap」（SWE-bench Verified，5 种模型配置）：只把旧观察（工具结果）换成占位符，成本约减半，解题率与 LLM 摘要持平或略高；LLM 摘要让轨迹变长 13–15%；两者混合再比纯遮蔽省 7%、比纯摘要省 11%。
   - Anthropic 把「清理旧工具结果」称为最安全、最轻的压缩方式，并在 API 上做成 `clear_tool_uses`；工具 A 自己也有「microcompact」（只留最近 5 个工具结果、省 ≥ 20k token 才动）。
   - 摘要这一层，**结构化 + 增量合并**（anchored iterative summarization）在探针评测上好于每次重写的整份摘要和 OpenAI 的不透明压缩。ama 现有模板和「合并上一份摘要」的做法已经属于这一类。
   - 只看完成率会低估压缩代价：2026-08 的对照实验显示，压缩丢掉的状态会让 agent 多做大量「重新检索」，完成率却看不出来。所以**压缩后要把关键状态（todo、最近文件、计划、已加载 Skill）重新注入**（工具 A、工具 H Focus Chain、工具 R 的 todo.md 复述都这样做）。
2. **ama 现状是同一套路线（档一裁剪 + 档二摘要 + 前缀续写保缓存），方向正确，但有 4 个实质缺口：**
   - **G1（P0 级）档一在单提示长任务里永远不触发。** `planPrune` 以「最近两个 user 回合」为界，只有一条 user 消息时 `seen < 2` 直接返回空（`src/compaction/prune-tier.ts:61-71`）。而最需要裁剪的恰恰是「一条指令跑上百次工具」的场景，Armadra 嵌入时也是这种形态。工具 E 有完全相同的缺陷（issue #47485）。
   - **G2** 档一一次性裁掉全部 > 2 KiB 的旧结果，没有「至少省多少才动」的门槛，也不看缓存冷热（`prune-tier.ts:73-104`、`session-compaction.ts:130-138`）。每次触发都会让裁剪点之后的缓存前缀全部失效。
   - **G3** 压缩后**不重新注入任何状态**：摘要只带 `<read-files>/<modified-files>` 路径（`summarize-tier.ts:434-440`）。todo 存成不进上下文的 custom 条目（`src/tools/todo.ts:4-6`），已加载 Skill 的正文（模型用 `read` 读入，`src/skills/index-prompt.ts:35`）会被档一裁掉，也不会被保护。
   - **G4** 熔断按「每 run 档二 ≤ 1 次」（`src/compaction/breaker.ts:10,41-56`），单提示长任务最多「一次阈值摘要 + 一次溢出恢复」，之后就失败。工具 A 用的是「快速回填熔断」（连续 3 次在 < 3 回合内重新填满才跳闸），更适合长任务。
3. **推荐组合（详见 §4）**：
   - 档 0：工具结果入转录时做头 + 尾截断并落盘（已有，补头尾）。
   - 档一（遮蔽）：按工具结果的新旧排序，不按 user 回合；保留最近 K 个结果和最近 T token 的工具输出；省不到 `clearAtLeast` 不动；缓存已冷时提前做。
   - 档二（摘要）：保留现有的前缀续写和增量合并，模板补齐「全部用户消息」「错误与修复」「原话引用的下一步」三节；熔断改成快速回填式。
   - 压缩后：以 append-only 的 custom 消息重新注入 todo、最近修改文件、已加载 Skill 和完整转录路径。
   - 供应商原生压缩（Anthropic `compact` / `clear_tool_uses`，OpenAI `/responses/compact`）**只作为官方端点上的可选加速**，不做默认：ama 的价值在于跨供应商、转录自有、缓存可控。
4. **Harness 其它改进**，按价值和成本排序：
   - 重复调用检测（loop guard）
   - headless 的 `--max-turns / --max-cost`
   - 统一的「提醒通道」（todo、外部文件改动、上下文用量、预算），只追加在尾部，不碰系统前缀
   - todo 进默认预设并做复述
   - 通用截断改成头 + 尾
   - 后台 bash
   - 模型回退

   这些都能做到不动 §9.1 的前缀。

---

## 1. ama 现状摸底（带证据）

### 1.1 循环与 harness

| 能力             | 现状                                                                                                                                                                       | 证据                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 循环形态         | 原生工具调用（非文本 ReAct）；内层 while：有工具调用或有 steer 就继续；外层收 followUp                                                                                     | `src/agent/loop.ts:152-231`                                                                                                 |
| 并行工具         | 准备阶段串行（schema → PreToolUse → 权限）；执行阶段并行，含 sequential 工具则整批串行                                                                                     | `src/agent/tool-runner.ts:330-358`；design §4.4                                                                             |
| `length` 截断    | 有工具调用时整批判失败（提示参数可能被截断）；无工具调用时走溢出恢复                                                                                                       | `loop.ts:209-222`、`tool-runner.ts:369`                                                                                     |
| steer / followUp | 两条队列，`one-at-a-time` 或 `all`；投递点在本轮工具全部结束、下次模型调用前；abort 不清队列                                                                               | `src/agent/queue.ts:1-58`、`loop.ts:166-228`                                                                                |
| 重试             | 会话层指数退避（3 次，2 s 起，×2，上限 60 s）；先判不可重试；失败尝试用 `context_edit{replacement:null}` 剔除                                                              | `src/agent/session-run.ts:44-98,154-182`；design §3.6                                                                       |
| 溢出恢复         | 剔除失败尝试 → PreCompact Hook → 档二 → 压缩后 ≤ 0.8 窗口才重试一次                                                                                                        | `session-run.ts:185-197`、`session-compaction.ts:141-171`                                                                   |
| 停止条件         | 无工具调用且 steer 为空；`finishTurn` 返回 end；Stop Hook 可 block 续跑（上限 3 次）                                                                                       | `loop.ts:218-229`、`session-run.ts:210-229`                                                                                 |
| 最大轮数         | 只有 SDK / 子 Agent / print 模式有 `maxTurns`；交互会话无上限，也没有费用上限                                                                                              | `src/agent/session.ts:136-141`、`src/modes/print/print-mode.ts:170-214`；gap-audit「headless 选项」                         |
| 思考             | Anthropic 签名与 redacted 回放、interleaved thinking beta；Responses 用 `store:false` + `include: reasoning.encrypted_content`，同模型才回放；跨模型时思考降级成文本       | `src/ai/apis/anthropic-request.ts:160-164,278`、`openai-responses-request.ts:6-13,298-299`、`src/agent/transform.ts:96-123` |
| 回放修复         | 跳过 error/aborted、tool id 归一、孤儿调用补结果、孤儿结果丢弃                                                                                                             | `transform.ts:1-14,125-173`                                                                                                 |
| 工具结果截断     | 通用上限 30 000 字符，**只保留头部**，全文落 `outputs/`；bash 自身尾截断，read/grep 头截断                                                                                 | `tool-runner.ts:35,188-215`、`src/tools/truncate.ts:1-6`                                                                    |
| Hooks            | SessionStart / UserPromptSubmit / Pre/PostToolUse / Stop / SubagentStop / PreCompact / Notification / SessionEnd；**没有 PostCompact，SessionStart 也没有 `compact` 来源** | `src/hooks/types.ts:13-35,77`                                                                                               |
| 上下文注入       | 系统提示节固定顺序；UserPromptSubmit 的 additionalContext 作为 custom 消息随提示进入；**没有逐回合提醒通道**（todo、文件变化、用量）                                       | `src/agent/system-prompt.ts:1-27`、`session-run.ts:284-293`                                                                 |
| todo             | 有 `todo` 工具，但状态存为不进上下文的 custom 条目，不在 default 预设里                                                                                                    | `src/tools/todo.ts:1-11`；gap-audit「TodoWrite」                                                                            |
| loop 检测        | **无**（grep 不到重复调用检测）                                                                                                                                            | —                                                                                                                           |
| 后台任务         | 无后台 bash；子 Agent `task` 有 `maxTurns`                                                                                                                                 | `src/tools/task.ts:34-55`                                                                                                   |
| 记忆             | 读 AGENTS.md；无 `/memory`，无 memory 工具                                                                                                                                 | gap-audit「/memory」                                                                                                        |
| 模型回退         | 无 fallback model                                                                                                                                                          | grep `fallbackModel` 无结果                                                                                                 |

### 1.2 压缩与缓存

| 项           | 现状                                                                                                                                                   | 证据                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 估算         | 上一条有效 assistant 的 usage 加上其后各条的「字符 / 4」；出现过 context_edit 或压缩则全量重估                                                         | `src/compaction/estimate.ts:1-40`                                                  |
| 档一触发     | `tokens > 0.7 × (window − reserve)`；新提示前和 `prepareNextTurn` 里检查                                                                               | `prune-tier.ts:15,34-40`、`session-compaction.ts:130-138`、`session.ts:132-135`    |
| 档一范围     | 「最近两个 user 回合」之前、> 2 KiB 的 toolResult，**一次全部裁掉**；全文写入 `outputs/<id>.txt`                                                       | `prune-tier.ts:54-105`                                                             |
| 档二触发     | 裁剪后仍 > `window − reserve`（reserve 16 384），或溢出                                                                                                | `session-compaction.ts:29-33,136-137`                                              |
| 切点         | 保留最近 20 000 token（≤ 预算的 40%）；不切在 toolResult 上；split turn 写两份摘要                                                                     | `session-compaction.ts:35-36,81-88`、`src/compaction/cut-point.ts:1-30`            |
| 摘要         | 6 节模板；先试**会话前缀续写**（与上一次真实请求逐字节同前缀、不发 toolChoice、`cacheRetention:"short"`），失败回落独立请求（`cacheRetention:"none"`） | `src/compaction/summarize-tier.ts:49-76,314-365`；wave3 §1.8                       |
| 增量         | 独立请求路径带 `<previous-summary>` 合并；续写路径中上一份摘要本身就是第 1 条消息，指令要求合并                                                        | `summarize-tier.ts:291-295,367-386`                                                |
| 熔断         | 每 run 档二 ≤ 1 次；连续两次失败跳闸；无 contextWindow 时关闭                                                                                          | `src/compaction/breaker.ts:1-74`                                                   |
| 压缩后上下文 | system 检查点 + 摘要（转成 user 消息）+ 保留区；只附文件路径清单                                                                                       | `src/session/projection.ts:4-8`、`transform.ts:34-36`、`summarize-tier.ts:434-441` |
| 缓存         | 指纹、未命中归因、三态、保温，压缩或裁剪后的首个请求记为重置；控制器知道 TTL 和上次请求时间                                                            | `src/agent/session-cache.ts:67,347,425-514`；design §9.1                           |

**发现的问题（按严重度）**

- **G1 单提示长任务不裁剪**：见 §0。`prune-tier.ts:63-71` 只数 `role === "user"`，toolResult 和 custom 都不计。
- **G2 裁剪不看收益和缓存冷热**：只要过 70% 就把边界前所有大结果全部替换；没有 `clearAtLeast`，也没有「缓存已冷就提前做、缓存热就推迟」的判断。由于边界按回合计算，过 70% 以后每个新回合都会再推进边界、再裁一批，可能每个回合都打断一次缓存（实际频率取决于每回合新增的大结果数量）。
- **G3 压缩后不复述状态**：todo、计划、已加载 Skill、最近读过的文件内容都没有回注；摘要也没有指向完整转录的指针。工具 A 会在摘要里给出完整转录路径，供模型按需读取。
- **G4 熔断不适合长任务**：见 §0。另外，阈值档二失败和「nothing to compact」都计入失败（`session-compaction.ts:258-260`）。
- **G5 摘要模板偏简**：缺少 工具 A 摘要里的「全部用户消息」「错误与修复」「原话引用的下一步」「安全约束原文保留」，多次压缩后容易漂移（工具 B 也内置了「多次压缩会降低准确度」的提示）。
- **G6 估算对中文偏低**：「字符 / 4」对 CJK 文本会严重低估（中文大约 1–1.5 字符一个 token）。只影响 usage 之后的尾部，但档一的大小判断用的是字节数（`PRUNE_MIN_BYTES`），两者口径不一致。
- **G7 split turn 的两份摘要串行**（`summarize-tier.ts:395-433`），可以并行，因为两份都基于同一前缀续写。

---

## 2. Agent Loop / Harness 能力对照

图例：● 有，◐ 部分，○ 无，? 未核实。数据来自 工具 A 包、工具 B 包、工具 C 源码包和公开文档；工具 K、工具 J、工具 S、框架甲、框架乙 一栏按其官方文档或源码的公开描述整理，本次未逐条复核。

### 2.1 循环结构与控制

| 维度            | 工具 A                                                                                                                                      | 工具 B                   | 工具 D                                                       | 工具 E    | 工具 C           | 工具 H / 工具 I              | 工具 J                                     | 工具 M                 | 工具 S                                    | 框架甲                     | 框架乙                 | 框架丙                                    | **ama**                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------ | --------- | ---------------- | ---------------------------- | ------------------------------------------ | ---------------------- | ----------------------------------------- | -------------------------- | ---------------------- | ----------------------------------------- | --------------------------------------- |
| 形态            | 原生工具调用                                                                                                                                | 原生（Responses items）  | 原生                                                         | 原生      | 原生             | 早期 XML 文本工具，后转原生  | 无工具循环：编辑格式 + 自动 lint/test 反馈 | 原生 + CodeAct         | 文本 ReAct（思考 + 命令），带格式校验重问 | CodeAgent：动作写成 Python | 原生                   | 原生（图式运行时）                        | 原生                                    |
| 并行工具        | ●                                                                                                                                           | ●                        | ●                                                            | ●         | ●                | ◐                            | —                                          | ◐                      | ○                                         | ◐                          | ●                      | ●                                         | ●（含 sequential 则整批串行）           |
| 最大轮数 / 预算 | SDK 有 `max_turns`、`max_budget_usd`，结果子类型 `error_max_turns / error_max_budget_usd`（工具 A 包）                                      | ?                        | `maxSessionTurns`                                            | ?         | ○                | 连续错误上限                 | —                                          | `max_iterations`、预算 | 每实例 `cost_limit`                       | `max_steps`（缺省 20）     | `max_turns`（缺省 10） | `ModelCallLimit` / `ToolCallLimit` 中间件 | 只有 SDK / print / 子 Agent；无费用上限 |
| steer / 插话    | 运行中排队，工具结束后投递                                                                                                                  | 运行中可插入输入         | ◐                                                            | ◐         | steer + followUp | ◐                            | —                                          | ◐                      | ○                                         | ○                          | ○                      | ○                                         | ●（工具 C 同构）                        |
| 重试            | 流式回退非流式、529、模型回退（`fallbackModel`）                                                                                            | ●                        | ●                                                            | ●         | ●                | ●                            | ●                                          | ●                      | ●                                         | ◐                          | ◐                      | 中间件                                    | ●（无模型回退）                         |
| loop 检测       | 「快速回填」熔断仅针对压缩                                                                                                                  | ?                        | **●**：相同调用 5 次、重复内容块、30 回合后 LLM 复核（二手） | ○         | ○                | ◐ 连续错误                   | —                                          | ● StuckDetector        | ○                                         | ○                          | ○                      | 调用上限中间件                            | ○                                       |
| 自我验证        | Stop Hook、子 Agent 审查                                                                                                                    | review 模式              | next-speaker 检查（已缺省关闭）                              | ○         | ○                | ○                            | 自动 lint/test                             | ◐                      | 提交前复核                                | final_answer 校验          | 输出 guardrail         | 中间件                                    | Stop Hook（≤ 3 次）                     |
| todo 驱动       | TodoWrite + `todo_reminder` 逐回合提醒（工具 A 包）                                                                                         | update_plan              | write_todos                                                  | todowrite | ○（扩展）        | Focus Chain：todo 跨摘要保留 | —                                          | task tracker           | ○                                         | planning_interval          | ○                      | 中间件                                    | ◐ 工具在，不进上下文                    |
| 提醒注入        | attachment 系统：`edited_text_file`、`todo_reminder`、`plan_mode`、`total_tokens_reminder`、`budget_usd`、`output_token_usage`（工具 A 包） | 环境上下文项             | IDE 上下文                                                   | ◐         | ◐ 扩展           | 环境详情块                   | —                                          | ◐                      | ○                                         | ○                          | ○                      | 中间件                                    | ○                                       |
| 文件变化通知    | 读过的文件被外部改动时附上 diff 片段（`edited_text_file`）                                                                                  | ◐                        | ◐                                                            | ◐         | ○                | ●                            | git 感知                                   | ○                      | ○                                         | ○                          | ○                      | ○                                         | ○                                       |
| Hooks           | 全套，含 PreCompact、SessionStart(compact)                                                                                                  | hooks                    | hooks                                                        | 插件      | 扩展事件         | hooks                        | —                                          | ◐                      | ○                                         | 回调                       | 生命周期钩子           | 中间件                                    | 9 种，无 PostCompact                    |
| 记忆            | 项目说明文件、自动记忆、memory 工具                                                                                                         | AGENTS.md、memories      | 工具 D 的说明文件、save_memory                               | AGENTS.md | AGENTS.md        | rules、memory bank           | 约定文件                                   | microagents            | ○                                         | ○                          | sessions               | store                                     | AGENTS.md                               |
| 后台任务        | 后台 bash、后台子 Agent                                                                                                                     | unified exec 后台终端    | ●                                                            | ◐         | ○                | ◐                            | —                                          | ●                      | ○                                         | ○                          | ○                      | ○                                         | ○                                       |
| 思考回传        | interleaved thinking；签名回放                                                                                                              | 回放 encrypted reasoning | thought signature                                            | ◐         | ●                | ◐                            | —                                          | ◐                      | ○                                         | ○                          | 回放 reasoning items   | ◐                                         | ●（同模型回放，跨模型降级）             |

**解读：**

- ama 的循环骨架（原生工具调用、并行、steer/followUp、重试、溢出恢复、思考回放、回放修复）已经达到 工具 C 和 工具 A 的水平，比多数开源 harness 完整。
- 缺的是「运行期护栏」和「注意力管理」两类：
  - loop 检测、费用和轮数上限、提醒通道、todo 复述、文件变化通知、压缩后状态回注。
  - 这些功能在 工具 A 里都以 append-only 的 attachment 实现，不改系统前缀。这和 ama 的 §9.1 是同一思路，可以直接借用。

### 2.2 文本 ReAct 与原生工具调用

- 框架甲、工具 S 这类文本或代码动作 ReAct，好处是不依赖供应商的工具接口，代价是要做格式解析和重问（工具 S 有格式错误重问上限）。
- ama 已有 codemode（脚本编排多次调用，design §5.5）。它覆盖了 CodeAct 的主要收益（一次请求做多步），同时保留原生工具调用的结构化与缓存优势，因此**不建议再加一个文本 ReAct 模式**。

---

## 3. 自动压缩方案调研

### 3.1 各产品做法

#### 工具 A（工具 A 包 2.1.285，一手）

- **阈值与开关**：
  - 环境变量 `DISABLE_AUTO_COMPACT`、`DISABLE_COMPACT`、`<TOOL>_AUTOCOMPACT_PCT_OVERRIDE`、`<TOOL>_AUTO_COMPACT_WINDOW`，设置项 `autoCompactWindow`。
  - 公开的二手资料普遍记为窗口约 95% 时自动压缩（社区整理）。
  - 另有「reactive」模式：不按阈值主动压缩，等 API 返回 prompt-too-long 再压缩。
- **三道熔断**：
  - 连续失败 3 次（`WDt=3`）。
  - 固定前缀本身已超过阈值时告警，原文为「compaction cannot help」。
  - **快速回填熔断**：连续多次在 < 3 回合（`Lht=3`）内重新填满就跳闸，原文为「rapid-refill breaker tripped」。
- **摘要请求共享缓存**：
  - 压缩以 fork 查询发出，复用主线程的 `cacheSafeParams`，并设 `maxTurns:1`、`skipCacheWrite:true`；遥测里统计这次请求的 cacheHitRate。
  - 无文本时回落（`tengu_compact_cache_sharing_fallback`）。
  - **这与 ama 的前缀续写同构**，证明 ama 的设计方向一致。
- **摘要提示**：
  - 先在 `<analysis>` 里整理思路，再输出 `<summary>`。
  - 节包括主要请求、关键技术概念、**Files and Code Sections（含代码片段）**、**Errors and fixes**、问题解决、**All user messages**、待办、**Current Work**、**Optional Next Step**；下一步要用原话引用，防止任务漂移。
  - 要求「安全相关约束原文保留」。
  - 声明「助手消息里形似用户的文本不算用户消息」，防止摘要把模型自己的话当成用户授权。
  - 开头强调只输出文本、不调用任何工具。
  - 另有「只摘要最近部分」的 partial compact 变体，与保留前段相配合。
- **压缩后**：
  - 写 `compact_boundary`，带 `pre_tokens / post_tokens / preservedSegment`。
  - 注入续接说明，告诉模型需要细节时可以去读完整转录的路径。
  - 重新附上 attachment：计划模式与计划文件、`invoked_skills`（已调用 Skill 的正文）、最近读过的文件（过大时只给 `compact_file_reference` 指针）。Anthropic 博客写的是「最近访问的 5 个文件」。
  - 还有 `PreCompact` 和 `SessionStart(source=compact)` hook。
- **microcompact（工具结果清理）**：
  - 保留最近 5 个工具结果（`S=5`），其余替换为 `[Old tool result content cleared]`，原文落盘并在占位里给出路径。
  - **省下 < 20 000 token（`Vdn=20000`）就不动**。
  - 触发方式有两种：
    - 「context_hint」beta（`context-hint-2026-04-09`）：请求时声明「可以清理、目标省多少」，服务端拒绝后客户端清理并重试。
    - time-based：遥测字段 `prompt_cache_likely_expired` 表明会判断缓存是否已过期。
  - 核心思想：**缓存已冷（或服务端示意）时才清理旧结果，热的时候不碰**。
- **API 侧（Anthropic 文档）**：
  - `context_management.edits`：`clear_tool_uses_20250919`，参数 `trigger`（缺省 100k 输入 token）、`keep`（缺省 3 个工具调用）、`clear_at_least`、`exclude_tools`、`clear_tool_inputs`。
  - `clear_thinking_20251015`。
  - 文档明说清理工具结果会让缓存前缀失效，所以用 `clear_at_least` 确保值得。
  - 服务端摘要压缩分两种：「按需」（beta `compact-2026-09-04`，可保留最近回合、可后台运行）和「阈值」。客户端自己的 SDK compaction 已标记弃用。

#### 工具 B（工具 B 包 0.160.0 + 二手）

- 配置项 `model_auto_compact_token_limit`、`compact_prompt`、`tool_output_token_limit`、`model_context_window`（工具 B 包字符串）。
- 压缩提示原文以「CONTEXT CHECKPOINT COMPACTION」开头，要求写给下一个 LLM 的 handoff summary，含进度与决策、约束与偏好、剩余工作、关键数据。
- 续接时用固定前言告诉模型「另一个模型已经做过一部分，这是它的摘要」，并保留最近的用户消息（约 20k token，二手）。
- 内置提示：长线程和多次压缩会降低准确度，建议开新线程。
- **远端压缩**：
  - 有 `compact_remote_v2.rs` 和 `ResponseItem::Compaction`。
  - 用 OpenAI Responses 的服务端压缩，返回加密的 compaction item 回放给后续请求。
  - OpenAI 文档：`POST /responses/compact`，或 `context_management:[{type:"compaction", compact_threshold}]`；支持 `store:false`；返回不透明的加密项。二手资料称「保留全部用户消息原文，其余替换为加密块」。

#### 工具 D（公开源码与 issue，二手为主）

- `chatCompressionService.ts`：阈值（历史上出现过 0.7、0.2、0.5，当前缺省约 0.5）；保留最新 30% 原文。
- 摘要为 XML `<state_snapshot>`（总目标、关键知识、文件系统状态、当前计划），先在 scratchpad 推理再输出。
- 有两段式「生成 → 校验 / 精修」（二手，未见一手）。
- 结果状态里有 `COMPRESSION_FAILED_INFLATED_TOKEN_COUNT`：压缩后反而更大就判失败。
- 另有工具输出遮蔽（tool output masking）和 50k token 的工具输出预算（二手）。

#### 工具 E

- 两步：
  - **prune**（无 LLM）：从新往旧走，保护最近 40k token 的工具输出（`PRUNE_PROTECT`）；更旧的工具输出合计 > 20k（`PRUNE_MINIMUM`）才把它们标记为已压缩，序列化成 `[Old tool result content cleared]`。`skill` 工具受保护；跳过最近 2 个 user 回合。
  - **compaction**：超过 `context − output` 时 LLM 摘要。
- 已知问题与 ama 高度相关：
  - #47485：单 user 消息的 headless 运行永不 prune（与 ama G1 相同）。
  - #16285：固定阈值不随窗口缩放。
  - #52697：保护区加上每次新增的摘要让压缩成为不动点，陷入无限压缩。

#### 工具 C（`本机材料`）

- 与 ama 档二同源：
  - `contextTokens > window − reserveTokens(16384)` 触发。
  - `keepRecentTokens 20000`，处理 split turn。
  - 在 `prepareNextTurn` 检查；溢出或 `length` 时压缩一次再重试。
  - 分支摘要，`<read-files>/<modified-files>` 累计。
  - 摘要请求不写缓存。
- **没有工具结果遮蔽层**。ama 在 工具 C 上加了档一和前缀续写。

#### 工具 H / 工具 I

- 工具 H：
  - 截断从中间删，「half / quarter」两档，保护首轮问答。
  - 先做「重复读同一文件 → 后续读替换成指针」的去重，目标省 30%。
  - Auto Compact 摘要；Focus Chain 让 todo 跨摘要保留。
- 工具 I：
  - 「Intelligent Context Condensing」，阈值可配（缺省 100%）。
  - 上下文错误时自动缩 25% 重试。
  - 后来把压缩和截断改成**打标记不删除**，回退时可恢复（与 ama 的 context_edit 投影思路一致）。

#### 工具 J（官方文档，未逐条复核）

- **repo map**：tree-sitter 抽符号并按图排序，在 token 预算内只给结构，不给全文。
- **历史摘要**：「已完成」的消息超过 `max_chat_history_tokens` 时用弱模型递归摘要。
- 本质上是「检索式上下文 + 历史摘要」，没有工具结果层，因为它没有通用工具循环。

#### 工具 M（SDK 文档）

- condenser 可链式组合（`PipelineCondenser`）：
  - `LLMSummarizingCondenser`（缺省；`max_size` 事件数、`keep_first`）
  - `ObservationMaskingCondenser`（旧观察换成 `<MASKED>`，`attention_window`）
  - `RecentEventsCondenser`、`AmortizedForgettingCondenser`（只留头尾，不摘要）
  - `LLMAttentionCondenser`、`StructuredSummaryCondenser`、`BrowserOutputCondenser`
- 遇到上下文超限时发「压缩请求事件」而不是报错。
- 压缩只追加 Condensation 事件，可完全撤销。
- 踩过的坑：`keep_first=0` 时把系统提示也摘要掉了；压缩后 Skill 和路径规则静默失效（issue #4544，**与 ama G3 同类**）。

#### 工具 S

- history processor `last_n_observations`：只保留最近 N 个观察原文，其余折叠。「The Complexity Trap」论文的「observation masking」就是基于这一做法（M=10）。

#### 工具 N

- 2025-10 用「Handoff」取代压缩：按目标从旧线程抽取提示和相关文件，开新线程。理由是压缩会鼓励冗长的线程。
- 2026 重写后回到**自动压缩（90% 触发）**，Handoff 下线，理由是前沿模型已经能很好地处理压缩。
- 启示：handoff 适合「换任务」，不适合作为长任务内的主机制。

#### 工具 K / 工具 F（未逐条复核）

- 工具 K：自动压缩阈值可配（缺省约 80%），超限时摘要。
- 工具 F：长对话超限时摘要，并提示开新对话。
- 两者都没有公开细节，不作为依据。

#### 某 Agent 框架的 middleware

- 把三件事做成可组合中间件：`SummarizationMiddleware`（trigger / keep 按 token、消息数或比例）、`ContextEditingMiddleware(ClearToolUsesEdit)`、`ToolCallLimit / ModelCallLimit`。
- 业界已把「清理工具结果 + 摘要 + 调用上限」当作标准三件套。

### 3.2 研究与实测

| 来源                                                                    | 设置                                                                                                                   | 结论                                                                                                                                                                                              | 对 ama 的含义                                                                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 「The Complexity Trap」（arXiv 2508.21433，NeurIPS'25 DL4C）            | 工具 S，SWE-bench Verified；Qwen3-32B、Qwen3-Coder 480B、Gemini 2.5 Flash 等 5 种配置；遮蔽窗口 M=10；摘要 N=21 / M=10 | 遮蔽比原始成本约减半，解题率与摘要持平或略高；摘要让轨迹长 13–15%；摘要调用本身占总成本 0.65–7.2%；混合（N=43 + 遮蔽 W=10）再省 7% / 11%                                                          | **遮蔽优先、摘要兜底**有直接证据。注意：论文的遮蔽是**每回合滚动**，对前缀缓存不友好；ama 要改成**批量、带门槛**的遮蔽 |
| ACON（arXiv 2510.00615，ICML 2026）                                     | AppWorld / OfficeBench / 多目标 QA                                                                                     | 用失败对比在自然语言里优化压缩指南，峰值 token 降 26–54%，精度大体保持；评审指出历史压缩因破坏 KV-cache **很少真正降低 API 成本**                                                                 | 摘要提示可以按「压缩后失败」的案例迭代；**压缩要算缓存账**                                                             |
| 厂商评测「Evaluating context compression」                              | 36k 条生产消息；用探针测召回、产物、续写、决策                                                                         | 结构化增量合并（3.70）> Anthropic 重写式（3.44）> OpenAI 不透明（3.35）；差距主要在文件路径、错误码等技术细节。属自家评测，无独立复现                                                             | 保留 ama 的分节模板和合并方式，补上「文件与代码」「错误」细节节                                                        |
| Liu「What Does Context Compression Cost an Agent?」（arXiv 2608.16370） | 确定性规划环境，24 回合上限，3 个模型                                                                                  | 压缩后完成率不变，但重新检索调用暴增（GPT-5.5：21.0 → 63.9）；把丢掉的状态放回能消除约一半；保留事实的压缩算子能避免大部分                                                                        | **压缩后回注关键状态**比追求更高压缩比更重要；评测不能只看完成率                                                       |
| Anthropic「Effective context engineering」（2025-09）                   | 工程经验                                                                                                               | 压缩是首选杠杆；清理工具结果最安全；结构化笔记（todo、NOTES.md、memory 工具）；子 Agent 只回传 1–2k token 摘要；写压缩提示应先追求召回再提高精度                                                  | 与推荐方案一致；子 Agent 隔离 ama 已有（`task`）                                                                       |
| 工具 R「Context Engineering」（2025-07）                                | 生产经验                                                                                                               | 输入:输出约 100:1，缓存命中率是首要指标；前缀稳定、上下文只追加、序列化确定；工具用 logits 遮蔽而不是增删；**文件系统作外部记忆，压缩必须可还原**（留 URL / 路径）；用 todo.md 复述目标；保留错误 | ama 的 outputs 落盘 + 占位路径已做到可还原；还缺 todo 复述                                                             |
| 「Context Rot」研究（2025-07）                                          | 18 个模型                                                                                                              | 输入越长，即使任务很简单，表现也一致下降                                                                                                                                                          | 即使窗口没满也值得遮蔽；阈值不宜接近 95%                                                                               |
| 「Don't Build Multi-Agents」（2025-06）及 2026 跟进                     | 经验                                                                                                                   | 长任务缺省用单线程 + 专门的压缩模型；压缩难做对，他们为此微调过小模型；2026 立场有所软化                                                                                                          | 摘要模型可以单独配置（例如更便宜的模型），但要以质量探针验收                                                           |

### 3.3 方案比较表

| 方案                         | 代表                                                           | 触发时机                                           | 保留什么                                     | 摘要模型                               | 对缓存的影响                                     | 质量 / 成本证据                              | 典型失败模式                                                                     |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------- | -------------------------------------- | ------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------- |
| 截断入转录（头 / 尾 + 落盘） | 全部产品；ama 档 0                                             | 结果产生时                                         | 头或尾 + 全文路径                            | 无                                     | **零**（写入时就定形）                           | 必备                                         | 截掉关键行；只留头部时丢失 bash 错误尾部                                         |
| 滚动观察遮蔽                 | 工具 S、上述论文、工具 M masking                               | 每回合                                             | 最近 M 回合的观察                            | 无                                     | **差**：每回合改动一个旧位置，缓存只读到那里     | 成本约 −50%，质量持平（论文按无缓存计价）    | 需要旧结果时得重新调用工具                                                       |
| 批量清理旧工具结果（带门槛） | 工具 A microcompact、Anthropic `clear_tool_uses`、工具 E prune | token 阈值 + `clear_at_least`；工具 A 另看缓存冷热 | 最近 K 个结果；可排除指定工具；落盘可还原    | 无                                     | **一次性**失效，之后重新命中                     | Anthropic 称最安全；工具 A 只在省 ≥ 20k 时动 | 门槛太低时频繁打断缓存；保护规则缺失时裁掉 Skill / todo（工具 E、工具 M 都踩过） |
| 中间截断                     | 工具 H half/quarter、工具 I −25%、工具 M amortized             | 超限                                               | 头 + 尾                                      | 无                                     | 一次性失效                                       | 便宜，丢信息                                 | 丢掉中段决策                                                                     |
| LLM 摘要（重写式）           | 工具 A、工具 B 本地、工具 D、工具 C                            | 阈值（50–95%）/ 溢出 / 手动                        | 摘要 + 最近若干原文                          | 同模型（工具 A 与 ama 共享缓存）或独立 | 摘要请求共享前缀时读价计；之后新前缀必然重写缓存 | 厂商评测 3.44；轨迹变长 13–15%               | 多次压缩后漂移、细节丢失、把模型的话当成用户指令                                 |
| LLM 摘要（结构化增量）       | 厂商评测方案、ama（合并上一份）                                | 同上                                               | 分节检查表 + 增量合并                        | 同上                                   | 同上                                             | 厂商评测 3.70，最优                          | 节越写越长，需要上限                                                             |
| 供应商原生摘要               | Anthropic `compact`、OpenAI `/responses/compact`               | 服务端阈值或按需                                   | Anthropic 可读摘要；OpenAI 加密块 + 用户消息 | 供应商模型                             | 由服务端管理；OpenAI 块只能回放给同家            | 厂商评测 OpenAI 3.35（压缩率极高、不透明）   | 锁定供应商；跨模型不可移植；无法审计内容                                         |
| 新线程交接                   | 工具 N handoff（已下线）、工具 B 建议开新线程                  | 手动或模型提议                                     | 生成的起始提示 + 文件                        | 同模型                                 | 新前缀                                           | 工具 N 已回到自动压缩                        | 用户负担重；不适合单任务内部                                                     |
| 外部记忆 / 笔记              | 工具 R 文件系统、Anthropic memory 工具、分层记忆系统           | 持续                                               | 文件里的状态                                 | 无                                     | 不进前缀即无影响                                 | 经验证据强                                   | 模型不主动记；读写增加回合                                                       |

**「哪个比较好」**：没有单一最优。证据最一致的组合是：

> **截断入转录 → 批量、可还原、带门槛的工具结果清理（缓存冷时优先）→ 结构化增量摘要兜底（共享前缀缓存）→ 压缩后回注关键状态 → 外部文件作为记忆。**

供应商原生压缩可以作为可选加速：质量不比自研结构化摘要好，而且不透明、锁定供应商。

---

## 4. ama 推荐方案与改动点

### 4.1 目标形态

```text
工具结果产生 ──► 档0 截断（头+尾，落盘）                   ← 不影响缓存
每次请求前（prepareNextTurn / 新提示前）
  ├─ 档一 遮蔽：candidates = 除最近 K 个结果、最近 T token 工具输出、保护集之外的旧大结果
  │    触发 = (tokens > pruneRatio×budget 且 可省 ≥ clearAtLeast)
  │         或 (缓存已冷 [idle > TTL] 且 可省 ≥ clearAtLeastCold)      ← 冷时零额外代价
  │    一次清到 targetRatio 以下（带回差），不逐回合推进
  ├─ 档二 摘要：tokens > budget（或溢出）→ 前缀续写摘要（已有）→ 失败回落独立请求
  │    熔断：连续失败 3 次 / 快速回填（连续 3 次 < 3 回合重新填满）/ 固定前缀已超阈值
  └─ 压缩后回注（append-only custom 消息，紧跟摘要）：
       todo 快照 · 最近修改/读取文件清单（可选：N 个小文件正文，预算内）· 已加载 Skill 正文或路径
       · 完整转录与 outputs 目录路径 · 当前计划
供应商原生（可选，仅官方端点、显式开启）：Anthropic compact / OpenAI responses.compact
```

### 4.2 与现有两档的差距与具体改动

| #   | 改动                                                                                                                                                                                                                                                                                        | 位置                                                                                   | 为什么                                                                                                             | 与 §9.1 的兼容性                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| C1  | **档一边界改成按工具结果新旧计算**：保留最近 `keepToolResults`（建议 5）个结果和最近 `protectTokens`（建议 `min(40k, 0.2×budget)`）的工具输出，去掉「两个 user 回合」条件，或保留它作为额外保护                                                                                             | `src/compaction/prune-tier.ts:54-71`                                                   | 修复 G1；对照 工具 A（留 5 个）、工具 E（保护 40k，同类 bug #47485）                                               | 不变                                                                                        |
| C2  | **加 `clearAtLeast` 门槛 + 回差**：可省 < max(20k, 10%×budget) 不裁；一次清到 `targetRatio`（例如 0.5×budget）以下，避免每回合推进                                                                                                                                                          | `prune-tier.ts` 新增返回 `savedTokens`；`session-compaction.ts:130-138`                | 修复 G2；对照 Anthropic `clear_at_least`、工具 A `Vdn=20000`                                                       | 降低缓存失效频率，符合「压缩少而一次到位」                                                  |
| C3  | **缓存冷时提前裁剪**：`SessionCacheController` 已知 TTL 和上次请求时间（`session-cache.ts:67,425-429`）；新提示到来且 `now − lastRequest > ttl` 时，即使未到 70%，只要可省 ≥ 门槛就裁                                                                                                       | `session-compaction.ts`（新增 `cacheCold()` 查询）、`session-cache.ts` 暴露            | 对照 工具 A 的 `prompt_cache_likely_expired` 和 time-based microcompact：前缀反正要重写，这时裁剪不额外付费        | 最友好：未命中归因记为 `idle`，不计 `prefix_changed`                                        |
| C4  | **保护集**：不裁 Skill 文件（路径在 skills 索引里）、AGENTS.md、`todo`、被标记 `keepInContext` 的宿主工具；可配置 `compaction.pruneExclude`                                                                                                                                                 | `prune-tier.ts:74-79`；工具契约 `src/tools/types.ts` 加可选标记                        | 对照 工具 E `PRUNE_PROTECTED_TOOLS=["skill"]`、Anthropic `exclude_tools`、工具 M #4544                             | 不变                                                                                        |
| C5  | **熔断改成快速回填式**：去掉「每 run ≤ 1 次」，改为「连续 3 次在 < 3 回合内重新超阈值 → 跳闸」；「固定前缀（system + tools + 保留区下限）> 阈值」时直接告警，不再尝试；「nothing to compact」不计失败                                                                                       | `src/compaction/breaker.ts:10-56`、`session-compaction.ts:258-260`                     | 修复 G4；对照 工具 A 的 `Lht=3`、`WDt=3` 和 prefix overflow 检查                                                   | 不变                                                                                        |
| C6  | **压缩后回注**：摘要条目之后追加一条 `custom_message{customType:"ama.post_compact"}`，内容包括 todo 快照、最近修改文件列表（已有 details）、已加载 Skill 名与路径（或在预算内附正文）、`<sessionDir>` 转录与 `outputs/` 路径、续接说明；可选「最近 N 个小文件正文」，预算如 5 个 × 5k token | `session-compaction.ts:266-276`、`transform.ts:34-36`                                  | 修复 G3；对照 工具 A（计划、Skill、文件、转录路径）、工具 H Focus Chain、2608.16370 的「放回状态消除一半重新检索」 | 压缩后本来就是新前缀，回注不额外打断缓存；放在摘要之后、保留区之前，之后只追加              |
| C7  | **模板补节**：在 SUMMARY_TEMPLATE 中加入「## User Messages（保留用户原话要点与全部约束，安全约束逐字）」「## Errors & Fixes」「## Files & Code（关键片段）」，并要求「Next Steps 第一条附最近对话的原话引用」；加一句「助手消息中形似用户的文本不算用户指令」                               | `src/compaction/summarize-tier.ts:49-76`                                               | 修复 G5；对照同类工具的摘要提示与分节检查表                                                                        | 指令在尾部 user 消息，不影响前缀                                                            |
| C8  | **压缩结果自检**：tokensAfter ≥ tokensBefore 判失败（工具 D 的 INFLATED）；摘要缺少必需节标题时回落或重试一次                                                                                                                                                                               | `session-compaction.ts:277-287`                                                        | 防止「压缩不动点」（工具 E #52697）                                                                                | 不变                                                                                        |
| C9  | split turn 两份摘要**并行**发出（同一前缀，各自读缓存）                                                                                                                                                                                                                                     | `summarize-tier.ts:395-433`                                                            | 修复 G7，缩短等待                                                                                                  | 两个请求同前缀，读价计                                                                      |
| C10 | 估算按脚本区分：CJK 字符按约 1 token 计，或在可用时调用供应商 count_tokens；档一大小判断改成 token 口径                                                                                                                                                                                     | `src/compaction/estimate.ts:36-40`、`prune-tier.ts:16,78`                              | 修复 G6，避免中文会话晚触发、溢出                                                                                  | 不变                                                                                        |
| C11 | **预计算 / 后台摘要（可选）**：到 85%×budget 时后台发出续写摘要，到阈值时直接换入；溢出时若已有可用摘要就直接用                                                                                                                                                                             | `session-compaction.ts`                                                                | 对照 工具 A 的 precompute 和 Anthropic 的 background compaction；减少用户等待                                      | 续写与真实请求同前缀；需处理「摘要后又新增了消息」：保留区自然包含                          |
| C12 | **供应商原生压缩作为可选项**：`compaction.native: "off" \| "anthropic" \| "openai"`，只在官方端点、同供应商、显式开启时使用；产物存为 `compaction` 条目的 `native` 字段（Anthropic 为可读摘要，OpenAI 为加密项），换模型时回落自研摘要                                                      | `src/ai/apis/anthropic-request.ts`、`openai-responses-request.ts`、`summarize-tier.ts` | 对照 工具 B 远端压缩、Anthropic compact；可省一次自研摘要                                                          | OpenAI 加密块只能回放给同家（与 reasoning item 同规则，`openai-responses-request.ts:6-13`） |
| C13 | Hook 补 `PostCompact`（或 `SessionStart{source:"compact"}`），允许外部回注                                                                                                                                                                                                                  | `src/hooks/types.ts:13-35,77`                                                          | 对照 工具 A                                                                                                        | additionalContext 走 custom 消息，只追加                                                    |

**不建议做的：**

- **逐回合滚动遮蔽**：论文按无缓存计价，ama 以缓存读为主，每回合改动旧位置会让缓存读价收益归零。
- **默认启用 Anthropic `clear_tool_uses` 服务端编辑**：它同样打断缓存，又让 ama 无法在转录里看见实际发出的内容，与「转录自有、可审计」冲突。最多作为 C12 的一部分可选开启。
- **把 todo 或记忆写进系统提示**：会改前缀；应走尾部 custom 消息。

### 4.3 缺省值建议（待实测校准）

| 键                                              | 建议缺省                                                    | 说明                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `compaction.reserveTokens`                      | 16 384（不变）                                              | 与 工具 C 一致                                                                |
| `compaction.keepRecentTokens`                   | 20 000（不变）                                              | 与 工具 C、工具 B 一致                                                        |
| `compaction.prune.keepToolResults`              | 5                                                           | 工具 A 同值                                                                   |
| `compaction.prune.protectTokens`                | `min(40k, 0.2×budget)`                                      | 随窗口缩放（工具 E #16285 的教训）                                            |
| `compaction.prune.clearAtLeast`                 | `max(20k, 0.1×budget)`                                      | 工具 A 20k、Anthropic `clear_at_least`                                        |
| `compaction.prune.triggerRatio` / `targetRatio` | 0.7 / 0.5                                                   | 带回差                                                                        |
| 摘要触发                                        | `window − reserve`（不变）；可选 `summaryRatio` 0.85 预计算 | 「Context Rot」研究的结论支持更早动手，但更早摘要会更频繁地重写缓存，需要实测 |
| 熔断                                            | 连续失败 3 次；快速回填 3 次 / 3 回合                       | 工具 A 同值                                                                   |

### 4.4 验证建议

- **单测**：
  - 单 user 消息、50 次工具调用，档一能触发。
  - 可省 < 门槛时不裁。
  - 缓存冷时提前裁剪。
  - Skill 和 todo 结果受保护。
  - 回差：连续回合不重复裁剪。
  - 快速回填熔断。
  - 回注条目在摘要之后。
  - tokensAfter ≥ tokensBefore 判失败。
- **缓存实验**（沿用 `docs/benchmarks/cache-*.md` 的方法）：同一长任务分别跑「现状」「C1+C2」「C1+C2+C3」，比较 cacheRead 占比、重写 token、总费用、压缩次数。
- **质量探针**（借厂商评测和 2608.16370 的方法）：每次压缩后问 4 类问题（召回、产物路径、续写下一步、决策理由），并统计压缩后 10 回合内的「重新读取同一文件」次数。这一项衡量回注的价值。

---

## 5. Harness 其它推荐改进（按价值 / 成本排序）

| 优先 | 改进                                                                                                                                                                                                                                                             | 价值                                               | 成本                                          | 与缓存前缀（§9.1）的兼容                                     | 参考                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1    | **重复调用检测**：同名同参数（规范化 JSON 后哈希）连续或累计 ≥ 3 次时，在工具结果末尾追加提醒；≥ 5 次时结束本 run 并给出 warning；工具可声明豁免（如轮询类）                                                                                                     | 防烧钱、防死循环；无人值守和嵌入场景必需           | 小（tool-runner 里加计数）                    | 提醒写进当次 toolResult，只追加                              | 工具 D LoopDetectionService（阈值 5，可按工具豁免，见 #9276）、工具 M StuckDetector                                  |
| 2    | **headless 预算**：`--max-turns`、`--max-cost`，会话级 `limits.maxTurns / maxCostUsd`；到限时 `agent_settled{warning}`，退出码区分                                                                                                                               | CI 失控保护（gap-audit 已列 P1）                   | 小（SDK 已有 maxTurns；`calculateCost` 已有） | 无影响                                                       | 工具 A SDK `error_max_turns / error_max_budget_usd`、框架乙 `max_turns`                                              |
| 3    | **统一提醒通道**：`custom_message{customType:"ama.reminder"}` 在下一次请求前追加，可选来源有：todo 复述（每 N 回合或 todo 变更后）、外部文件改动（读过的文件 mtime 或哈希变化时附 diff 片段）、上下文用量（到 70% / 85% 时提醒，引导模型写笔记或收尾）、预算剩余 | 对抗长任务漂移；文件变化通知能避免基于过期内容编辑 | 中                                            | 只追加在尾部，不进系统提示；频率要克制（每条都是新 token）   | 工具 A attachment（`todo_reminder`、`edited_text_file`、`total_tokens_reminder`、`budget_usd`）、工具 R todo.md 复述 |
| 4    | **todo 进默认预设并做复述**：todo 结果受档一保护，压缩后回注（C6）                                                                                                                                                                                               | 结构化进度，压缩后不迷路                           | 小                                            | 工具表变化要在会话开始时确定（预设固定），不在中途增删       | 工具 A TodoWrite、工具 H Focus Chain、工具 D write_todos                                                             |
| 5    | **通用截断改成头 + 尾**：`truncateResult` 保留前 70% 和后 30%，中间给出省略计数和全文路径                                                                                                                                                                        | 错误信息常在尾部                                   | 小                                            | 写入时定形，无影响                                           | 工具 B `tool_output_token_limit`、工具 A persisted-output                                                            |
| 6    | **后台 bash**：`run_in_background` + 读取输出 + 结束进程三件套；完成时通过提醒通道通知                                                                                                                                                                           | dev server、watch、长测试                          | 中                                            | 通知只追加                                                   | 工具 A、工具 B unified exec                                                                                          |
| 7    | **模型回退**：可重试错误用尽后（或 overloaded 时）切到 `fallbackModel` 重试一次；换模型时思考按跨模型规则降级（已有 `transform.ts`）                                                                                                                             | 可用性                                             | 中                                            | 换模型必然冷缓存，需告知用户；未命中归因已有 `model_changed` | 工具 A `fallbackModel`                                                                                               |
| 8    | **记忆**：`/memory` 编辑 AGENTS.md（gap-audit P2）；不在会话中途改系统提示，改动在下个会话生效或通过提醒通道告知                                                                                                                                                 | 跨会话知识                                         | 小                                            | 必须避免中途改前缀                                           | 工具 A 记忆、Anthropic memory 工具                                                                                   |
| 9    | **自我验证提示**：preamble 已有「verify your work」；可提供可选 Stop Hook 模板（例如要求运行测试），不内置                                                                                                                                                       | 质量                                               | 小                                            | 无                                                           | 工具 A Stop Hook                                                                                                     |
| 10   | **流式期间提前执行只读工具**（边流边执行 read/grep）                                                                                                                                                                                                             | 降延迟                                             | 大                                            | 无                                                           | 工具 A 有类似实现                                                                                                    |
| —    | 不做：文本 ReAct 模式、逐回合动态增删工具（改用 codemode 和预设）、Anthropic `clear_thinking`（ama 保留全部思考以保缓存，与官方「keep all 最大化缓存」建议一致）                                                                                                 |                                                    |                                               |                                                              | 工具 R「mask, don't remove」                                                                                         |

---

## 6. 风险与待定项

**风险**

1. **裁剪与缓存的权衡**：C1 让档一在长任务里真正生效，也就会真正打断缓存。必须同时做 C2（门槛 + 回差）和 C3（冷时优先），否则长任务费用可能上升。要以 §4.4 的缓存实验验收。
2. **回注体积**：C6 若附文件正文，压缩后首个请求更大。建议缺省只回注清单、todo、Skill 路径和转录路径，正文作为可选并设预算。
3. **续写摘要时模型调用工具**：工具仍在请求里（为保缓存），已有回落机制；C7 增加模板长度后，部分小模型可能更容易越界，需要在 `continuation.test.ts` 加越界用例。
4. **多次压缩漂移**：工具 B 明确提示长线程和多次压缩会降低准确度。快速回填熔断（C5）只防死循环，不防漂移；可以在第 3 次压缩后通过提醒通道建议用户 `/new` 或分叉（handoff 式），但不强制（工具 N 已证明强制 handoff 不受欢迎）。
5. **供应商原生压缩（C12）**：OpenAI 加密块无法审计；Anthropic 的压缩 API 仍在 beta、版本号频繁变化（`compact-2026-09-04`）；中转端点大多不支持。只能作为显式开启的可选项。
6. **工具 A 的 context_hint 机制**是第一方私有 beta，ama 无法使用；C3 用本地 TTL 推断替代，准确度取决于「供应商不报缓存」三态（wave3 §1.6）。对 `silent` 和 `unknown` 端点，C3 应退化为只按阈值裁剪。
7. **估算口径（C10）**：改估算会影响所有阈值的触发时机，需要回归现有压缩测试。

**待定项（需要用户或设计决定）**

- 档一缺省参数（`keepToolResults`、`protectTokens`、`clearAtLeast`、触发 / 目标比例）以实测为准，是否进精简配置面？
- 压缩后是否回注文件正文？缺省数量和预算是多少？
- todo 是否进默认预设（gap-audit 原判 P2，「以控制前缀」）？本报告建议进，理由是压缩回注和复述的收益更大。
- 提醒通道的频率与种类，以及是否允许宿主（Armadra）经 host 适配器注入提醒。
- 是否引入独立的摘要模型配置（`compaction.model`）？「Don't Build Multi-Agents」一文的做法支持这样做，但续写共享缓存要求同模型，两者冲突；可以只在独立请求回落路径上使用。
- C12 是否值得做：需要先在官方 Anthropic / OpenAI 端点做一次质量与费用对比。

---

## 7. 来源

**一手**

- ama：`docs/design/design.md` §3.6、§4、§9、§9.1；`docs/history/wave3-plan.md` §1.8–§1.9；`docs/history/gap-audit-2026-10.md` §1；源码行号见正文。
- 工具 A 2.1.285 打包文本 `本机材料`。关键词：`DISABLE_AUTO_COMPACT`、`rapid-refill breaker`、`compaction cannot help`、`tengu_compact_cache_sharing_success`、`cacheSafeParams`、`[KEEP-RECENT MC]`、`Vdn=20000`、`context-hint-2026-04-09`、`prompt_cache_likely_expired`、`compact_file_reference`、`invoked_skills`、`todo_reminder`、`edited_text_file`、`error_max_budget_usd`。
- 工具 B 0.160.0 二进制字符串 `本机材料`。关键词：`CONTEXT CHECKPOINT COMPACTION`、`compact_remote_v2.rs`、`ResponseItem::Compaction`、`model_auto_compact_token_limit`、`tool_output_token_limit`。
- 工具 C：`本机材料`。

**公开资料**

- [Anthropic：Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [Anthropic：Compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Anthropic：Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [OpenAI：Compaction guide](https://developers.openai.com/api/docs/guides/compaction)
- [The Complexity Trap（arXiv 2508.21433）](https://arxiv.org/abs/2508.21433)
- [ACON（arXiv 2510.00615）](https://arxiv.org/abs/2510.00615)
- [Liu：What Does Context Compression Cost an Agent?（arXiv 2608.16370）](https://arxiv.org/abs/2608.16370)
- 厂商评测：Evaluating Context Compression for AI Agents
- 工具 R：Context Engineering for AI Agents
- Context Rot 研究
- Don't Build Multi-Agents
- 社区整理：Context Compaction Research（工具 A / 工具 B / 工具 E / 工具 N）
- 工具 E #47485：单轮运行永不 prune、#16285、#52697、工具 E 上下文管理（社区 wiki）
- 工具 D：Chat Compression（社区 wiki）、#12068、#21792、loop 检测 #9276
- 工具 M：Context Condenser、#4544
- 工具 I：Intelligent Context Condensing、工具 I PR #9665、工具 H：Context engineering
- 工具 N：Handoff、工具 N, Rebuilt
- 某 Agent 框架的 middleware 文档
