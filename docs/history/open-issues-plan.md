# 未关闭 Issue 设计与分批（#149–#156、#183）

> 状态：**已实施**（#149–#156、#183 均已关闭）。
> 基线 `main` = `155a32e`（v0.7.5，2026-10-10）。上游设计 docs/model-efficiency-plan.md（D3、D9、D12、§5 Q1/Q2/Q4、R6）、实测 docs/benchmarks/efficiency-2026-10.md（F/M/I 节）、#170 / PR #181 / #184 描述。
> 硬约束沿用 内存批次的共同规则「硬约束」：零运行时依赖；源码 ≤ 600 / 测试 ≤ 1000 行；**`session.ts`(596)、`subagent-registry.ts`(600)、`ai/providers/registry.ts`(599)、`compose-session.ts`(608) 不得加行**——本计划对前三者只做「同一行替换、净 0 或负」（§3、§5、§7 各一处，都在表里标明），compose-session.ts 完全不动；i18n en/zh；首请求 system + tools 逐字节稳定、`prompt-budget` 三档不变（本计划不改系统提示、工具描述与 schema）；协议只加可选字段；测试只用 fake；真实请求只经 astr（`astr/gpt-6-luna`）、packy（deepseek / kimi）或 ChatGPT 订阅便宜模型，**不用 Claude 订阅、无 Anthropic key**；不提参考项目名。
> 设计中的行号以 `155a32e` 为准，实施时自行核对；设计不成立时按最小偏差改并在 PR 写明。

## §0 总览与分批

| 批               | Issue          | 一句话                                                                                                                                                               | 拥有的文件（src / test / docs）                                                                                                                                                                                                                                                                                                                                                                                                                                              | 依赖 | 规模          | 真实请求                                                               |
| ---------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------- | ---------------------------------------------------------------------- |
| O-A 子 Agent     | #149 #150 #156 | general 保持 fresh、`subagents.forkMaxContextRatio` 暴露；fork `<task>` 列出 task/task_ctl 不可用并复测；后台 running 结果带 `details.context`                       | `src/agent/subagent-fork.ts`+test、`session-subagent.ts`+test、`subagent-background.ts`+test、`subagent-registry.ts`（**2 处同行替换，净 0**）、`subagent-registry.test.ts`、`src/agents/catalog.ts`（类型 1 行）、`src/config/types-w5.ts`、`schema.ts`、`json-schema.ts`、`settings-registry.ts`、`key-docs.ts`、`src/i18n/messages/config-keys.ts`、`docs/agents.md`、`docs/benchmarks/efficiency-2026-10.md`（新「F2」节）、`docs/design.md` §5.2 `task` 行、CHANGELOG×2 | 无   | 中（~160 行） | ≤ 8（#150：astr gpt-6-luna ×1、packy deepseek-v4-flash ×1，各 3–4 次） |
| O-B 请求层与目录 | #151 #152 #154 | Anthropic 文案按公开文档录制 + 关闭说明；`maxTokensCaps` 持久化到数据目录（30 天）；`models[].catalog` 写错给 warning                                                | `src/ai/apis/max-tokens.ts`+test、新 `src/ai/providers/max-tokens-cache.ts`+test、`src/cli/compose-providers.ts`+test、`src/ai/providers/enrich.ts`+test、`src/ai/providers/registry.ts`（**3 行换 2 行，净 −1**）、`registry.test.ts`、`docs/providers.md` + `docs/en/providers.md`（「max_tokens」小节、「模型元数据」节）、`docs/design.md` §3.4 一行与 §3.6「输出上限」行、`docs/benchmarks/efficiency-2026-10.md` M 节补两行、CHANGELOG×2                               | 无   | 中（~200 行） | ≤ 2（#152：packy kimi-k2.5 两个进程各 1 次）                           |
| O-C 分类器       | #153           | 中转 / 自定义供应商按会话模型继承的目录条目推断同厂商小模型（只认模型表里列出的）                                                                                    | `src/agent/session-classifier.ts`+test、`docs/permissions.md` + `docs/en/permissions.md`「模型」一条、`docs/design.md` §7.4 分类器一句、CHANGELOG×2                                                                                                                                                                                                                                                                                                                          | 无   | 小（~60 行）  | ≤ 2（packy deepseek-v4 会话 auto 模式各 1 次分类）                     |
| O-D 工具         | #155           | 后台 bash 输出按 `toolOutputBytes(maxResultChars)` 一次截到位                                                                                                        | `src/tools/background-jobs.ts`+test、`src/tools/bash.ts`+test、`docs/design.md` §5.2 `bash` 行、CHANGELOG×2                                                                                                                                                                                                                                                                                                                                                                  | 无   | 小（~30 行）  | 0                                                                      |
| O-E 会话         | #183           | 图片回读失败的 warn 接到会话日志：`ImageOffload` 缓冲 → `SessionManager.setWarn` → `SessionExtensions` 构造时接 `core.log`；TUI 转通知区；`--fork` 源会话显式传 warn | `src/session/offload.ts`+test、`manager.ts`+test、`src/agent/session-extensions.ts`+test、`src/modes/interactive/agent-ui.ts`+test、`src/i18n/messages/interactive.ts`（1 键 en/zh）、`src/cli/compose-store.ts`+test、`src/cli/compose.ts`（传 log 1–2 行）、`docs/session-format.md`「内存表示」一句、`docs/sessions.md` + `docs/en/sessions.md` 一句、CHANGELOG×2                                                                                                         | 无   | 中（~90 行）  | 0                                                                      |

并行关系：**五个批次完全并行**（源码文件两两不交；共享的只有 CHANGELOG 两份与 `docs/design.md` 的不同行，规则见 §10）。串行点只有批内：O-A 里 #150 的复测要在 `<task>` 文案改完、本地 `pnpm build` 之后跑；O-B 里 #151 的录制样本先于 #152 的持久化测试（同文件 `max-tokens.test.ts`，一个 PR 两个提交）。
建议合并顺序：O-D → O-C → O-B → O-A → O-E（小而确定的先进，带真实复测与 TUI 改动的后进；见 §10）。

真实请求合计 ≤ 12（A 8 + B 2 + C 2），全部经 astr / packy，key 只由 ama 自己解析，`AMA_DATA_DIR` / `AMA_CONFIG_DIR` 指向 /tmp。

## §1 #149 general 是否缺省 fork；`forkMaxContextRatio` 是否暴露

**现状**

- `src/agents/builtin.ts:36-58`：三个内置类型都不写 `context`，`requestedContext()`（`subagent-fork.ts:30-35`）缺省 `fresh`；`task` 工具描述已在 fresh / fork 之间给模型选择（`tools/task.ts:60`）。
- `subagent-fork.ts:23` `FORK_MAX_CONTEXT_RATIO = 0.5` 常量，`forkPlan`（`:74-115`）第 3 条回落用它；`subagents` 配置段（`config/types-w5.ts:85`、`json-schema.ts:194-201`）没有该键。配置整段经 `compose-agents.ts:62-67` 进 `SubagentEnvironment.modelConfig.subagents`，再由 `subagentRegistryFor(host, env)` 存进 `registry.env`（`subagent-registry.ts:160`，`private readonly`）。

**数据与推荐**（docs/benchmarks/efficiency-2026-10.md F 节，16 次请求）

- fork 首请求命中与父自己的下一回合相同：DeepSeek 77%（2048 块粒度上限）、Kimi 97.5%；经中转的 OpenAI 系两次分别 0% / 85%（不发路由键，与 fork 无关）。
- 经济性：F1 fork 子会话折合约 1.9k 全价 token，F4 fresh 1.3k——**fork 多花约 0.6k 换 8k 父上下文**；但这只是首请求。子会话每一回合都重读整段父前缀：按命中价 1/50（DeepSeek）8k × 30 回合 ≈ 4.8k 全价 token，按 1/4–1/10（Kimi / Anthropic）≈ 24k–60k，中转落空时全价。`general` 的典型任务（按指令改某处代码）通常不需要父上下文，而且 maxTurns 30 的子任务回合多；加上 D3 第 3 条会在长会话里把 fork 静默回落成 fresh，缺省 fork 会让同一类型在不同时刻拿到不同上下文。
- **推荐 ①：`general` 保持缺省 fresh**（不改 `builtin.ts`，与 §5 Q1 当时的推荐一致）；选择权留给模型（描述已写明 fork 适用「需要已读内容」）与类型 frontmatter。文档把上面的「每回合重读」成本写进 agents.md「何时用 fork」表下，并给出：DeepSeek 上「子任务要重读 ≥ 1 份已读文件」就划算；Kimi / Anthropic 上只在子任务**主要**依赖父上下文时用；经不发路由键的中转不建议。
- **推荐 ②：暴露 `subagents.forkMaxContextRatio`**（0.05–0.95，缺省 0.5）。理由：固定 0.5 的单位是「窗口比例」，在 1M 窗口模型上允许 50 万 token 的父上下文被每回合重读，用户需要调低；DeepSeek 用户又可能想调高。否决「先常量」的理由已不成立——键的接线不需要动 compose-session（配置段整段进 env）。否决「按供应商价差自动选 fork」：价差数据只覆盖目录有价的模型，中转一律无价，规则不可预测。

**方案**

1. `src/config/types-w5.ts` `SubagentsConfig` 加 `forkMaxContextRatio?: number`；`json-schema.ts:194` 段加 `forkMaxContextRatio: num(0.05, 0.95)`；`schema.ts` 同步校验（若 schema.ts 只按 json-schema 生成则无需改）；`key-docs.ts:69` 缺省表加 `forkMaxContextRatio: 0.5`；`settings-registry.ts:148` 旁加 `row("subagents.forkMaxContextRatio", "agents", "nextSession", "deny")`；`config-keys.ts` en/zh 各一条（en：`Fork sub-agents fall back to fresh when the parent's last request used more than this share of (window − compaction.reserveTokens); 0.05–0.95, default 0.5`）。
2. `src/agents/catalog.ts:19` `AgentModelConfig.subagents` 类型加 `forkMaxContextRatio?: number`（结构兼容，compose-agents 不改）。
3. `subagent-registry.ts:160` `private readonly env: SubagentEnvironment,` → `readonly env: SubagentEnvironment,`（同行替换，净 0；同文件 §3 的第二处替换见下）。
4. `subagent-fork.ts` `forkPlan(parent, spec, model, thinking, ratio = FORK_MAX_CONTEXT_RATIO)`：`ratio` 非有限数或出 (0,1) 时按缺省；`session-subagent.ts:235` 传 `subagentRegistryFor(parent).env.modelConfig?.subagents?.forkMaxContextRatio`。
5. `docs/agents.md` 164–175 行：回落条件改写为「超过（窗口 − reserveTokens）× `subagents.forkMaxContextRatio`（缺省 0.5）」；「何时用 fork」补每回合重读成本一段与上表「适合」列的措辞；注明内置类型保持 fresh 及理由。`docs/design.md` §5.2 `task` 行「上下文 > 50% 可用窗口」→「> `subagents.forkMaxContextRatio`（缺省 0.5）× 可用窗口」。

**协议 / 配置影响**：新配置键一个（可选）；无协议变化；前缀不变（不改描述）。
**测试**：`subagent-fork.test.ts` 加「ratio 0.2 时 promptTokens 刚过线回落、0.9 时放行；非法值按 0.5」；`session-subagent.test.ts` 加「config `subagents.forkMaxContextRatio` 经 env 生效」（harness 构造 env）；config 的 schema / settings-registry 既有用例自动覆盖新键（缺省值、层级）。
**验收**：上述用例绿；`ama config` 列表可见该键与说明；文档三处同步。
**风险**：`registry.env` 变公开后被别处读——只允许 session-subagent 读 `modelConfig`，评审守住。
**真实请求**：0（数据来自 F 节；#150 的复测顺带给出 fork 子会话多回合时每回合的 cacheRead 读数，写进 F2 节作为「每回合重读」的实测佐证）。

## §2 #150 fork 子会话 `<task>` 防串台句的复测

**现状**：`subagent-fork.ts:131-134` 的首句已含「Requests above were for the main agent: do only this task」，未复测。fork 子会话的工具表 = 父活动集，`task` / `task_ctl` 仍在表里（前缀不变），调用时按深度被 `task.ts:167-168` 拒绝（`Sub-agents are not available here`）；`<task>` 的「Tools not available to you」行（`:141-144`）只列类型限制的工具，`session-subagent.ts:243-245` 把 `PARENT_ONLY_TOOLS` 排除在外，所以子会话并不知道 `task` 不可用。

**方案**（文案加固 + 复测，一个 PR）

1. `session-subagent.ts:243` 之后另算 `briefUnavailable = [...unavailable, ...PARENT_ONLY_TOOLS.filter((n) => inherited.includes(n))]`，只用于 `forkBrief({ unavailable: briefUnavailable })`；`options.unavailableTools` 不变（深度拒绝文案保持）。效果：`<task>` 里出现 `Tools not available to you: task, task_ctl. Calls to them are rejected.`，模型在读到父消息里「调用 task」的指令时已被明确告知。
2. `forkBrief` 文案不再改（首句已有）。被否决：在子会话里真正摘掉 `task`——会改工具表、破坏 fork 的前缀相同性（D1）。
3. 复测脚本 仓库外的临时脚本 `fork-leak.mjs`（，仿 F 节：SDK `createRuntime`，`--tools read,task`，`full-auto`，无人值守；父消息 = `docs/design.md` 前 24 000 字符 + 「用 `context: "fork"` 调一次 `task`，子任务：读 `docs/agents.md` 前 60 行后回 OK；返回后回 DONE」）。每次运行 = 父请求 1 → 子会话（1–2 回合）→ 父请求 2。跑 `astr/gpt-6-luna` ×1、`packy/deepseek-v4-flash` ×1。
4. **判定**：读子会话 JSONL（`ama.task{context:"fork"}` 为首条的文件），assistant 消息里 `toolCall.name === "task" | "task_ctl"` 的数量 = 0 → 通过；两次都通过即关闭。任一次出现 → 再加一句到 `<task>` 首段末尾（`Do not call task or task_ctl.`）并各复测 1 次（预算内）；仍出现则在 Issue 记录、另开 Issue 讨论从子会话工具表摘除（需要放弃前缀相同）。
5. 顺带记录：子会话每回合 `usage.cacheRead / (input + cacheRead + cacheWrite)`，写进 benchmarks 新「F2：fork 子会话多回合与防串台复测」节（环境、两行数据、结论、局限）。

**改动文件**：`session-subagent.ts`（+2 行）、`subagent-fork.test.ts` 或 `session-subagent.test.ts`（断言 `<task>` 列出 task/task_ctl，且 `options.unavailableTools` 不含它们）、benchmarks、CHANGELOG。
**协议 / 配置影响**：无；`<task>` 是子会话的 user 消息，不在前缀里。
**验收**：fake 用例绿；两次真实复测子会话 0 次 task 调用（或按第 4 步的升级路径记录结果）。
**风险**：模型行为的单次样本没有统计意义——Issue 关闭说明写明「各 1 次」。
**真实请求**：≤ 8（2 次运行 × 3–4 次）。

## §3 #156 fork 后台任务 `running` 结果带 `details.context`

**根因**：`subagent-registry.ts:352-355` 后台任务同步返回 `startedResult(record, file)`，而实际模式要等 `execute → pool.acquire → handleFor → runner.start → startAmaChild` 里 `run.onEvent({type:"context"})`（`session-subagent.ts:294`）→ `applyRunnerEvent` 写 `record.info.context`（`task-record.ts:308-309`）。`runningResult`（`subagent-background.ts:34-45`）不读 `info.context`，所以 `running` 结果与前台转后台结果（`backgroundedResult`）都没有 `context`。`task.ts:180` 只透传 `result.context`。

**时序事实**：`startAmaChild` 在第一个 `await` 之前就发出 `context` 事件（`:219-294` 无 await），`pool.acquire` 有空位时只经微任务；所以在 `launch` 返回处等**一个宏任务**（`setImmediate`）就能拿到模式。拿不到的两种情况：并发池满（任务排队）、`isolation: "worktree"`（`await createWorktree`）。

**方案**

1. `subagent-background.ts`：`runningResult` 加 `...(record.info.context !== undefined ? { context: record.info.context } : {})`（`backgroundedResult` 随之受益——转后台时模式早已知道）；`startedResult(record, outputFile?, settle?: Promise<unknown>)` 改为 `async`：`if (settle) await Promise.race([settle.catch(() => undefined), new Promise((r) => setImmediate(r))]); return runningResult(...)`。
2. `subagent-registry.ts:355` `return Promise.resolve(startedResult(record, file));` → `return startedResult(record, file, running);`（同行替换，净 0；与 §1 第 3 条合计 2 处替换，文件仍 600 行）。
3. 被否决：在 `TaskRecord` 加 `onContext` 回调由 `applyRunnerEvent` 触发——多一条状态，收益与 `setImmediate` 相同；被否决：请求阶段预先算 fork 决策——要在注册表里复制模型解析，且 registry 不能加行。
4. 文档：`docs/agents.md:166`「只在请求了 fork 时 `details.context` 才出现」后补「后台任务的 `running` 结果也带它；任务排队或 worktree 隔离尚未就绪时该结果不带，`get_tasks` / 完成通知的 `TaskInfo.context` 仍有」。

**协议 / 配置影响**：`details.context` 已是可选字段（docs/rpc.md:217 已登记 `TaskInfo.context`），只是多一个出现时机；无版本变化。
**测试**：`subagent-background.test.ts`：`startedResult` 在 `settle` 未结束、`setImmediate` 内 `info.context` 被置为 `fork` → 结果带 `context: "fork"`；未置 → 不带；`backgroundedResult` 带已知模式。`subagent-registry.test.ts`：ama runner 工厂 stub 在 `start` 里同步 `onEvent({type:"context", mode:"fork"})`，`background: true` 的 `run()` 结果 `context === "fork"`、`status === "running"`；pool 满（maxConcurrent 1 且一个任务占着）时结果不带 `context`。`task.test.ts` 既有 details 断言延伸一条。
**验收**：上述用例绿；rpc / acp 黄金不变（黄金场景无后台 fork）。
**风险**：`launch` 返回多等一个宏任务，前台路径不受影响（只在 `background` 分支）；`settleTasks` / 通知顺序不变（`running.then(notify)` 仍先登记）。
**真实请求**：0。

## §4 #151 Anthropic 官方端点取样

**现状**：`max-tokens.ts:94-95` `CONTEXT_LIMIT` 正则按文档文案 `input length and max_tokens exceed context limit: X + Y > Z` 实现，`:100-103` 判 `Z − X < 1024` 为溢出；第 4 断点（`anthropic-request.ts:297` 倒数第二条 user）按官方「回看 20 块」文档实现，R6 标「未实测」。两者都需要官方端点返回。

**能否替代**：astr 是 OpenAI Responses 通道、packy 是 openai-completions，都没有 Anthropic 协议的官方上游；经中转的 Claude 模型即使存在，400 文案与缓存读数也是中转的，不是官方的。用户没有 Anthropic key、不用 Claude 订阅。**结论：无法验证，实现可做的部分后关闭。**

**可做的部分**

1. `max-tokens.test.ts` 补两条按**公开文档与公开错误报告**录制的文案（标注来源为「官方文档 / 公开 issue 文本」）：`input length and max_tokens exceed context limit: 199999 + 21333 > 200000, decrease input length or max_tokens and try again`（带尾句，`Z − X = 1` → 溢出）与 `… 150000 + 60000 > 200000 …`（`cap = 50000` → 以 50000 重发、`transient` 不记入 caps）。若 `classify` 对带尾句的文案已通过，只是补用例；若因 `:?\s*` 或数字格式不匹配则修正正则（预期无需改）。
2. `docs/providers.md`「max_tokens」小节与 `docs/en/providers.md:492` 同段：Anthropic 文案与第 4 断点统一标「按官方文档与公开报告实现，未经官方端点取样」。
3. 取样手册 仓库外的临时脚本 `anthropic-sample.md`（，写进 Issue 关闭说明）：拿到 key 后两条命令——① `AMA_LOG=debug ama -p … --model anthropic/claude-sonnet-4-6` 配 `modelOverrides.maxTokens: 200000` 与 ≈190k 输入触发 400，截取 stderr 文案；② 父会话 10 个并行 `read` 后再问一句，比较 `usage.cacheRead` 有无第 4 断点（临时 `compat.maxCacheBreakpoints: 3` 对照）。各 ≤ 3 次请求。

**关闭说明（写进 Issue）**：没有官方端点；正则与断点按文档实现并有 fake 用例守护；取样手册留档，拿到 key 时按手册补测，若文案不符再开 Issue 修正。
**改动文件**：`max-tokens.test.ts`（+~25 行）、providers 两份文档各 1 句、CHANGELOG 不写（无用户可见变化）。
**风险**：公开报告的文案可能过时；溢出判定仍由 `overflow.ts` 的 `prompt is too long` 兜底。
**真实请求**：0。

## §5 #152 `maxTokensCaps` 跨进程持久化

**现状**：`max-tokens.ts:26` `maxTokensCaps` 是进程级 `Map`；`postWithMaxTokensFallback`（`:135-157`）在 400 后 `set` 并重发，`:142` 下次直接 `withCap`。重启后每个模型首个请求仍被 400 拒一次（M 节）。数据目录缓存已有先例：`discovered-cache.ts`（`<dataDir>/models/discovered/<provider>.json`，tmp + rename）；`compose-providers.ts:144-151` 在 `dataDir !== undefined` 时并入缓存。

**方案**（二选一中选「写入数据目录」）

1. `max-tokens.ts`：加 `export function onMaxTokensCap(listener: (key: string, cap: number) => void): () => void`，`:151` `maxTokensCaps.set` 后通知监听者；`Map` 保留（既有用例不改）。
2. 新 `src/ai/providers/max-tokens-cache.ts`（≈80 行）：文件 `<dataDir>/models/max-tokens-caps.json`，形状 `{ version: 1, caps: { "provider/model": { cap, learnedAt } } }`；`loadMaxTokensCaps(dataDir, now = Date.now)`：读文件（坏文件 / 版本不符忽略），丢弃 `learnedAt` 超过 **30 天**的条目，`maxTokensCaps.set` 未有的键（进程内已学到的优先）；`attachMaxTokensCache(dataDir)`：先 load，再 `onMaxTokensCap` 订阅，每次学到就把整表（合并文件里未过期的其它条目）原子写回；返回取消函数；按 `dataDir` 幂等（同一进程重复组装注册表不重复订阅）。
3. `compose-providers.ts:144` 的 `if (dataDir !== undefined)` 块里加一行 `attachMaxTokensCache(dataDir)`。
4. 被否决「提示用户写 `modelOverrides.maxTokens`」：需要用户动作，且上限属于端点不属于配置；文档仍保留这条建议作为永久解法。
5. 文档：providers 两份「max_tokens」小节：「上限记入 `<dataDir>/models/max-tokens-caps.json`，30 天后重新探测；删掉该文件即重测；`modelOverrides.maxTokens` 写了更小的值时以它为准」；`docs/design.md` §3.6「输出上限」行加「跨进程持久化 30 天」；benchmarks M 节补「跨进程」两行。

**协议 / 配置影响**：无新配置键；新增一个数据目录文件（无凭据）。
**测试**：`max-tokens-cache.test.ts`：fake `fetch` 400 → 文件写出且含 `cap`、`learnedAt`；`maxTokensCaps.clear()` 后 `loadMaxTokensCaps` → 第一次请求体直接带上限、无 400；`learnedAt` 31 天前的条目不加载且写回时被清掉；坏 JSON 忽略不抛；`attach` 两次只订阅一次。`compose-providers.test.ts`：`dataDir` 给定时文件被读取（spy）。既有 `max-tokens.test.ts` 不改断言（`:21` 的 `clear()` 仍有效）。
**验收**：fake 用例绿；真实：packy `kimi-k2.5` 以 `maxTokens: 262144` 在隔离 `AMA_DATA_DIR` 下跑两个进程——第一个进程 1 次 400 + 重发（与 M1/M2 相同），**第二个进程 0 次 400**，`max-tokens-caps.json` 含 `packy/kimi-k2.5: 98304`。
**风险**：中转日后放宽上限时 30 天内仍按旧上限发（输出被压低）——文档写明删文件即重测；并发进程写同一文件：tmp + rename 原子，后写者赢，丢的只是另一进程刚学到的一条，下次再学。
**真实请求**：2。

## §6 #153 中转 / 自定义供应商也能用分类器小模型

**现状**：`session-classifier.ts:39-53` `smallModel` 只查 `catalogSmall(session.provider)`（`catalog.ts:460-463`，按**供应商 id** 读目录文件级 `small`），packy / astr 等没有目录文件 → undefined → 会话模型分类。`permissionClassifier` 选项由 `compose-session.ts:315` 写入（**冻结**），`ProviderRegistryApi`（`ai/types.ts:558-566`）只有 `list / get / findModel / resolveApiKey / getApi`，没有元数据接口；分类器已能 import `catalog.ts`。

**方案**（选「按目录继承推断」，不加配置键）

1. `smallModel(core, session)` 顺序改为：① `catalogSmall(session.provider)`（内置，照旧）；② 否则 `hit = catalogByAlias(session.id)`（D10 的同一套规则；`hit.tier` 有值时去掉思考档后再算）→ `origin = hit.ref` 的供应商段 → `smallId = catalogSmall(origin)`；`hit.ref === origin/smallId` 时返回 undefined（会话模型已是小模型）；③ 在 `core.options.providers.get(session.provider)?.models`（**只认模型表里列出的**：config `models[]`、发现缓存；不走 `findModel` 的合成路径）里找第一个 `m.id === smallId` 或 `catalogByAlias(m.id)?.ref === origin/smallId && tier === undefined` 的条目；④ `findModel(`${provider}/${m.id}`)` 与 key 检查沿用现有 `:42-52`。
2. 被否决「`providers.<id>.small` 配置键」：要进 `ProviderData` 得在 `registry.ts` 加 1 行，且 `permission.autoModel` 已是显式覆盖；若将来拆 registry 再加。被否决「允许合成模型」：中转未必真有该 id，分类请求出错即 ask（`permissions.md:173`），会把 auto 模式退化成逐条询问。
3. 文档：`permissions.md:174-177` 与 `docs/en/permissions.md:175`「中转与自定义供应商没有目录小模型，仍用会话模型」改为「中转 / 自定义供应商：会话模型按 id 继承了官方目录条目、且该供应商模型表里列有同厂商的小模型（同样按 id 继承到目录 `small` 条目）时用它，否则会话模型；仍推荐 `permission.autoModel`」；`docs/design.md:795` §7.4 同一句同步。

**协议 / 配置影响**：无。主会话请求不变（分类请求独立、`purpose: "classify"`）。
**测试**（`session-classifier.test.ts`，290 → ≤ 420 行）：注册表配一个自定义供应商 `relay`（fake 协议）`models: [{id:"deepseek-v4"}, {id:"deepseek-v4-flash"}]`；会话模型 `relay/deepseek-v4` → 分类请求 `model.id === "deepseek-v4-flash"`，debug 日志记一次；只列 `deepseek-v4` → 用会话模型；会话模型本身是 `deepseek-v4-flash` → 会话模型；`permission.autoModel` 配了仍优先；主会话请求前缀不变（延伸既有用例）。
**验收**：用例绿；真实：packy 配置里 `deepseek-v4` 为会话模型、`permission.mode: auto`，跑一条需要分类的 bash（如 `ls -la /tmp`）→ `AMA_LOG=debug` 看到 `permission classifier model: packy/deepseek-v4-flash` 且判定成功；astr `gpt-6-luna` 会话（已是 openai 的 small）→ 日志仍是会话模型。
**风险**：中转的「同名小模型」指向别的上游（R18 同类）——只影响分类器、不影响主会话；`permission.autoModel` 可覆盖。
**真实请求**：≤ 2。

## §7 #154 `models[].catalog` 写错时给 warning

**根因**：`enrich.ts:71-74` `catalogHit`：显式 `catalog: "provider/id"` 经 `catalogByRef` 不命中返回 undefined，`enrichEntry` 静默不继承；`registry.ts:320-322` 只对 `modelsDev` 不命中 warn。registry 不能加行。

**方案**

1. `enrich.ts`：`ModelMetadata` 加 `warnings?: string[]`；`enrichEntry(entry, index, providerId?: string)`：`typeof entry.catalog === "string" && hit === undefined` → push `catalog "${entry.catalog}" for "${providerId ?? "?"}/${entry.id}" not found; ignored`；同时把 modelsDev 的那条（`typeof modelsDev === "string" && looked && match === undefined`）也在这里生成（文案与 `registry.ts:322` 完全相同）。
2. `registry.ts:320-322` 三行换两行：`const { entry: filled, metadata } = enrichEntry(entry, this.modelsDev, id);` + `for (const warning of metadata.warnings ?? []) this.warn(warning);`（净 −1，文件 598 行）。`:431` 的 `synthesize` 调用不传 providerId（合成条目没有显式键，不会有 warning）。
3. 写错时**不**回落按 id 别名继承：用户显式指定，按指定失败处理（与 modelsDev 一致）。
4. `models list` 的来源列不改（`model-meta.ts:50-63` 已按 metadata 显示）；warning 走注册表 `warnings`（启动头部计数、`ama models list` 末尾、`AMA_LOG`）。

**协议 / 配置影响**：无。文案沿用注册表现有英文告警风格（与 `:322` 同形；这类诊断不经 i18n，已有先例，评审按 P2 判断时说明）。
**测试**：`enrich.test.ts`：错引用 → `metadata.warnings` 一条、不继承；正确引用 / `catalog: false` / 不写 → 无 warnings；`registry.test.ts`：config `providers.x.models: [{id:"m", catalog:"deepseek/nope"}]` → `registry.warnings` 含该条；既有 modelsDev 不命中用例的断言不变。
**验收**：用例绿；`registry.ts` 行数 ≤ 599。
**风险**：无。**真实请求**：0。

## §8 #155 后台 bash 输出按 `maxToolResultChars` 一次截到位

**根因**：`background-jobs.ts:161-172` `output(id)` 固定 `truncateTail(text)`（缺省 2000 行 / 50 KB）；`bash.ts:433`、`:446` 调用时不传上限，而前台路径 `:233` 已用 `toolOutputBytes(ctx.maxResultChars)`。超出部分再由会话层 `truncateMiddle` 二次截中段，与 #140 口径不一致。

**方案**

1. `background-jobs.ts`：`output(id, options: TruncateOptions = {})` → `truncateTail(text, options)`；头注释「2000 行 / 50 KB」改为「缺省 2000 行 / 50 KB，调用方可传字节上限」。
2. `bash.ts`：`jobAction` 里两处 `jobs.output(id)` → `jobs.output(id, { maxBytes: toolOutputBytes(ctx.maxResultChars) })`；截断说明行已写实际行数与 `Full output: <outputPath>`，不改文案。头注释第 11 行补「查询输出同样按会话结果上限尾截断」。
3. 被否决：在 `BackgroundJobs.start` 时记住上限——上限属于调用时的会话，续聊 / 换会话后不同。
4. `docs/design.md:531` 同表 `bash` 行补「`{job, action}` 查询输出同样按此上限尾截断」。

**协议 / 配置影响**：无（`structured` 形状不变）。
**测试**：`background-jobs.test.ts`：`output(id, { maxBytes: 2048 })` → `truncatedBy === "bytes"`、`outputBytes ≤ 2048`、内容是尾部；不传 → 缺省行为不变。`bash.test.ts`：`ctx.maxResultChars = 3000`，后台任务输出 20 KB → `wait` / `output` 结果 `content.length ≤ 3000`，含 `Full output:`，且 `details`/`structured` 不变。
**验收**：用例绿。**风险**：无。**真实请求**：0。

## §9 #183 会话图片回读失败无提示

**根因**：`offload.ts:93` `ImageOffload` 的 `warn` 是构造参数、缺省空函数；`manager.ts:84/107` 把 `warn` 作为 `private readonly` 存起来，只能在 `open / create / fork` 时传；生产创建点 `compose-store.ts:83-97`、`compose-session.ts:443-521`（冻结）、`session-subagent.ts:194-201`、`sdk.ts:317` 都不传。唯一日志通道 `stderrLog`（`compose-session.ts:109-115`）经 `options.log` → `AgentSessionImpl.log`（`session.ts:253-254`，读 `this.options.log`，TUI 的 `agent-ui.ts:211-231` 在运行时替换它）。回读失败分两段：`open()` 期间（`manager.ts:150-176` 的 `syncImages`，编辑不在活动分支时回读）与之后（`getEntries` / `fork` / `setLeaf`）。

**方案**（Issue 三个选项之外的第 4 种：在**消费方**接线 + 缓冲，覆盖全部创建点而不碰冻结文件）

1. `offload.ts`：`warn` 改为可设置——构造参数保留；加 `setWarn(fn)`；未设置时告警进 `pending: string[]`（上限 16 条，超出只计数、最后一条写「and N more」），`setWarn` 时按序冲刷并清空。`read()` 失败已删 locator 与 offloaded（`:194-195`），同一条目只告警一次。
2. `manager.ts`：`private warn` 去掉 `readonly`，加 `setWarn(fn: (message: string) => void): void`（置 `this.warn` 并转发 `this.images.setWarn`）；`fork()`（`:330`）照旧把 `this.warn` 传给子 manager（有则有）。
3. 接线点 `src/agent/session-extensions.ts:63` 构造函数末尾：`core.manager.setWarn((m) => core.log("warn", m))`（头注释加一行说明「会话级诊断：manager 的告警走 `options.log`」）。它在 `session.ts:100` 构造时对**每个** AgentSession 调一次（主会话、`switchSession` / ACP `session/new|load` / TUI `/resume`、fork、task 子会话、SDK），`open()` 期间缓冲的告警随即冲出；`core.log` 动态读 `options.log`，TUI 替换后的路由也生效。
4. TUI：`agent-ui.ts:103` 旁加 `SESSION_NOTICE = /^cannot read session entry (\S+) back from /`，`routeNotices` 的 `routed` 里匹配到且 `level === "warn"` → `this.deps.notice("warn", msg().interactive.imageReadBackFailed(entryId))` 并不再写 stderr；`src/i18n/messages/interactive.ts` 加键 en `Session image for entry {id} could not be read back (file changed); it stays empty` / zh `会话文件已改变，条目 {id} 的图片读不回，保留为空`。
5. `--fork <id>` 的源会话（`compose-store.ts:97`）不属于任何 AgentSession：`openSession(request, context)` 的 `context` 加可选 `log?: LogFn`，`SessionManager.open(file, { warn: (m) => context.log?.("warn", m) })`；调用方 `compose.ts`（`createSessionStore`）把 `options.log ?? stderrLog()` 传进去（`stderrLog` 从 `compose-session.js` 导入，无循环——compose-session 已 import compose-store，但 compose.ts 是上层）。若核对发现 compose-store → compose-session 会成环，则把 `stderrLog` 搬到新 `src/cli/log.ts`，`compose-session.ts:108-115` 八行换成一行 `export { stderrLog } from "./log.js";`（净 −7，允许）。
6. 被否决：选项 1（挪 `stderrLog` 作 manager 缺省）——`session/` 不能依赖 `cli/`，且 `AMA_LOG` 过滤与 TUI 路由都在 `options.log` 上；选项 2（所有创建点显式传）——`compose-session.ts` 冻结，漏掉多数路径；选项 3（`process.emitWarning`）——绕开 `AMA_LOG` 与 TUI。
7. 文档：`docs/session-format.md:110` 末句补「告警经会话日志（`AMA_LOG`，TUI 显示在通知区）」；`docs/sessions.md` / `docs/en/sessions.md` 在图片相关段落加一句同义说明。

**协议 / 格式影响**：零（JSONL、RPC、ACP 不变）；SDK 用户传入的 `sessionManager` 也会被接到 `options.log`（文档一句）。
**测试**：`offload.test.ts` 既有「文件被改写时告警不抛错」延伸：未 `setWarn` 时缓冲、`setWarn` 后按序冲出 **恰好 1 条**、再次回读不再告警；超过 16 条折叠。`manager.test.ts`：`open` 一个 `context_edit` 不在活动分支、文件被截短的会话 → `setWarn` 收到 1 条。`session-extensions.test.ts`（或 harness 用例）：`options.log` spy，manager 文件被外部改写后 `session.getEntries()` → `log("warn", /cannot read session entry/)` 恰好 1 次，覆盖 compose 路径（`composeSession` 建的会话）与 `session-subagent` 子会话（harness `startAmaChild` resume 路径）。`agent-ui.test.ts`：该行转为 `notice("warn", …)`、不再调原 log。`compose-store.test.ts`：`fork` 源会话读不回 → 传入的 `log` 收到 1 条。
**验收**：以上确定性断言；手动：TUI 下 `--resume` 一个被改写的会话后 `/tree` 换叶子，通知区出现一条、画面不乱；`-p` 下 stderr 一行 `ama: [warn] cannot read session entry …`；`AMA_LOG=error` 时无输出。
**风险**：`SessionExtensions` 承担接线职责略偏——头注释写明；若将来 `session.ts` 可改再搬回构造函数（1 行）。缓冲上限 16 防止异常文件刷屏。
**真实请求**：0。

## §10 共享文件规则与合并顺序

| 文件                                                 | 规则                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md` / `CHANGELOG.zh-CN.md`                | 两份目前没有未发布段。每批在**第一个 `## 0.7.5` 行之前**插入：`## Unreleased`、空行、子标题、空行、条目（每条一行 `- **…**: …`）、空行；中文同形 `## 未发布`。子标题**写死**：O-A / O-B / O-C / O-D 用 `### Model efficiency` / `### 模型调用效率`；O-E 用 `### Sessions` / `### 会话`。rebase 时若 `## Unreleased` 已存在：同名子标题下**追加**条目，不同子标题按固定顺序排列（Model efficiency 在前、Sessions 在后），不加导语。#151 无用户可见变化不写条目。 |
| `docs/design.md`                                     | 各批只改自己那一行：O-A §5.2 `task` 行（:540）；O-B §3.4（:427，`catalog` 写错给 warning）与 §3.6「输出上限」行；O-C §7.4（:795）；O-D §5.2 `bash` 行（:531）；O-E 不改。不重排表格、不改其它行；行号以合并时为准。                                                                                                                                                                                                                                             |
| `docs/benchmarks/efficiency-2026-10.md`              | O-A 新增「F2」节（放在 F 节之后、P 节之前）并在总览表加一行；O-B 只在 M 节末尾追加两行；都不改既有文字。                                                                                                                                                                                                                                                                                                                                                        |
| `docs/agents.md`                                     | 只有 O-A 改。                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `docs/providers.md` + `docs/en/providers.md`         | 只有 O-B 改（「max_tokens」小节、「模型元数据」节）。                                                                                                                                                                                                                                                                                                                                                                                                           |
| `docs/permissions.md` + `docs/en/permissions.md`     | 只有 O-C 改。                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `docs/session-format.md`、`docs/sessions.md` + en    | 只有 O-E 改。                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/agent/subagent-registry.ts`                     | 只有 O-A，且只做 §1-3 与 §3-2 两处同行替换，合入后仍 600 行。                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/ai/providers/registry.ts`                       | 只有 O-B，§7-2 的三换二，合入后 ≤ 599 行。                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/cli/compose-session.ts`、`src/agent/session.ts` | 本计划不改。                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/i18n/messages/*.ts`                             | O-A 只改 `config-keys.ts`（新键），O-E 只改 `interactive.ts`（新键）；不动既有键。                                                                                                                                                                                                                                                                                                                                                                              |
| 仓库外脚本与手册                                     | `仓库外的临时目录 `（`fork-leak.mjs`、`anthropic-sample.md`、#152 / #153 的复测命令），不进仓库。                                                                                                                                                                                                                                                                                                                                                               |

合并顺序：**O-D → O-C → O-B → O-A → O-E**。D、C 最小且无真实复测，先合可尽早让后面的批次 rebase 到含 `## Unreleased` 的 CHANGELOG；B 含 registry 行数变化先于 A 的 registry 替换（不同文件，仅为评审方便）；A 带复测数据与 benchmarks 新节；E 改 TUI 与 manager，最后合并后手动在 TUI 过一遍。每个 PR：`pnpm run ci` 绿 → push → `gh pr create --base main`，正文 `Closes #N`（O-A 三行、O-B 三行），实测数字写进 PR；O-A 的 PR 在 #150 复测后才开。

## §11 验收汇总

| Issue | 验收                                                                                                                                                                                                                | 真实请求 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| #149  | `general` 仍 fresh（`builtin.ts` 不变）；`subagents.forkMaxContextRatio` 出现在 `ama config` 列表与 json-schema，0.2 / 0.9 / 非法值三条 fake 用例；agents.md、design.md §5.2 同步；Issue 关闭说明写明推荐与数据依据 | 0        |
| #150  | `<task>` 列出 `task, task_ctl` 不可用（fake 断言）；astr gpt-6-luna 与 packy deepseek-v4-flash 各 1 次复测子会话 0 次 task 调用，数据入 benchmarks F2；若出现则按 §2-4 升级并记录                                   | ≤ 8      |
| #156  | 后台 fork 任务 `running` 结果 `details.context` 为实际模式（fake）；池满 / worktree 时不带且 `TaskInfo.context` 后到；黄金不变                                                                                      | 0        |
| #151  | 两条公开文案的 fake 用例；providers 两份标「未经官方端点取样」；取样手册留档；关闭                                                                                                                                  | 0        |
| #152  | `<dataDir>/models/max-tokens-caps.json` 写出 / 加载 / 30 天过期 / 坏文件忽略（fake）；packy kimi-k2.5 两个进程：第 1 个 400 一次，第 2 个 0 次                                                                      | 2        |
| #153  | fake `relay` 供应商四条用例；真实 packy deepseek-v4 会话 auto 模式分类器日志为 `packy/deepseek-v4-flash`                                                                                                            | ≤ 2      |
| #154  | 错 `catalog` 引用 → `registry.warnings` 一条、不继承；正确 / false / 不写无告警；registry.ts ≤ 599 行                                                                                                               | 0        |
| #155  | `output(id, {maxBytes})` 尾截断；`maxResultChars 3000` 时 job 结果 ≤ 3000 字符含 `Full output:`                                                                                                                     | 0        |
| #183  | 回读失败 → `options.log("warn")` **恰好 1 次**（compose 路径、子会话路径、`--fork` 源）；TUI 转通知区；`AMA_LOG=error` 静默；JSONL / RPC / ACP 不变                                                                 | 0        |

每批共同：`pnpm run ci` 绿；`prompt-budget` 三档数值不变（本计划不改系统提示 / 工具描述 / schema）；`cache-stability` / `cache-acceptance` 既有断言不改；rpc / acp 黄金不变；源码 ≤ 600 / 测试 ≤ 1000 行；两份 CHANGELOG 按 §10 格式。
