# 第五波设计与实施计划

> 状态：实施设计（2026-10-02）。基线：`main` = `c126ae5`（RW-A / RW-B 已合入；RW-C 交互界面与 RW-D 影子 git 进行中，见 §12）。
> 设计依据：`docs/design/design.md`（§2 工程约定、§4 循环、§5 工具 / 预设 / codemode、§7 权限、§9 压缩、§9.1 缓存保证、§12 界面、§13 SDK / RPC、§16 批次写法）、`docs/history/rewind-plan.md`、`docs/design/tui-design.md`、`docs/guides/providers.md`、`docs/guides/permissions.md`，以及五份调研（R1 模型目录 / 协议 / 图像，R2 外部 Agent 控制面，R3 Plan，R4 子 Agent，R5 harness 与压缩；只借鉴行为，不复制代码；本文引用他人原文每段不超过 15 词）。
> 硬约束不变：TypeScript、Node ≥ 22、**零运行时依赖**、单文件 ≤ 600 行、单 bundle、缓存前缀逐字节稳定（§9.1：任何模式切换 / 提醒只能追加在末尾）、API Key only、Skills 不做 MCP、**权限请求不代答**。
> 路径相对仓库根；`[W5-x]` 为本波批次编号（§11）。

## §0 结论

| #   | 决定                                                                                                                                                                                                                                                                                                                           | 理由 / 证据                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 状态栏改为**两行**：上行「速率行」（本次 tok/s、输出 token / 耗时、会话均速、首 token 延迟，右端 `[-]` 可折叠），下行「状态行」沿用现状并补 git 与会话时长；下行**模式仍在最左、分隔符仍为 `·`**                                                                                                                               | 现状栏已有模式 / 缓存 / rebill / codemode 等 13 项（`src/modes/interactive/status-bar.ts:9-16`），单行塞不下用户要的 7 项新信息；下行的字段顺序与分隔符是 tmux 宿主解析的既有约定（`tui-design.md` §3.10），不能改                                                                                                   |
| D2  | 速率与首字延迟在**会话层包一层流**取得（与 `SessionCacheController.wrapStream` 同一手法），协议层不改；流式期间速率行以 ≤ 2 Hz 刷新，下行只在事件时刷新                                                                                                                                                                        | 协议层已把 `text_delta` 等事件逐个送出（`src/ai/types.ts:435-446`），首 token 时刻与增量字节在会话层就能记；`tui-design.md` §3.10 要求状态栏不随 chunk 抖动——只放宽速率行一处                                                                                                                                        |
| D3  | git 信息：分支与短提交号**零依赖读 `.git/HEAD`**（复用 `src/checkpoints/git-head.ts`）；工作区增删行用 `git diff --numstat` 子进程，**只在回合边界刷新、≥ 10 s 一次、2 s 超时**，没有 git 或超时即省略                                                                                                                         | 增删行无法不起进程得到；回合边界刷新与节流把成本压到可忽略；检查点已有读 HEAD 的实现                                                                                                                                                                                                                                 |
| D4  | 嵌入宿主（有 profile）时 `ui.statusLine` 缺省 `compact`（只一行），独立终端缺省 `full`                                                                                                                                                                                                                                         | 宿主以「最后一行 = 状态栏、倒数第 3 行 = 输入框」锚定（`tui-design.md` 第 28 行）；两行会移动输入框，嵌入场景保持原布局                                                                                                                                                                                              |
| D5  | models.dev 快照**入库**：`src/ai/providers/models-dev/<provider>.json`（一家一份）+ 生成的 `models-dev-data.ts`；运行时只读快照与 `ama models refresh` 写下的用户级覆盖，**启动与运行都不联网**；`refresh-catalog` 改名 `refresh`（旧名保留为别名）                                                                            | 现状运行时缓存 2.3 MB 且首次要联网（`src/ai/providers/models-dev-cache.ts:1-10`）；R1 §0.2 实测 20 家裁剪后约 108 KB，可随 bundle 携带；MIT 许可只要求保留声明（R1 §1.2）                                                                                                                                            |
| D6  | 人工目录 `catalog/*.json` 改为**只写覆盖项与 ama 特有字段**（`api`、`channels`、`thinkingLevelMap`、`promptCache`、`compat`，以及有意调小的 `maxTokens`），数值事实（上下文、输出上限、价格、模态、知识截止）从快照继承；测试报告与快照相同的冗余值                                                                            | 已定；R1 §1.4 指出两处重复必然漂移；`catalog.ts:8-10` 的「宁缺不猜」原则由快照兜底                                                                                                                                                                                                                                   |
| D7  | 刷新用 GitHub Action **每周一 03:17 UTC + 手动触发**，脚本零依赖；有改动才开 PR 到固定分支 `chore/models-dev-refresh`；PR 用 `MODELS_DEV_PR_TOKEN`（App token / PAT），没有该 secret 时 workflow 自己先跑 `pnpm run ci` 再用缺省 token 开 PR                                                                                   | 上游每天 20–40 个提交（R1 §0.3），每日开 PR 太吵；`GITHUB_TOKEN` 开的 PR 不触发 `on: pull_request`（`.github/workflows/ci.yml:3-7`），而仓库约定 CI 绿才合并                                                                                                                                                         |
| D8  | 内置供应商支持**内置渠道**（`BuiltinProvider.channels` + `defaultChannel`，用户配置同名覆盖）；缺省渠道按 §3.2 表：Anthropic / 通义 / MiniMax / 腾讯 / 阶跃 → messages，OpenAI / xAI / 火山方舟 → responses，其余 chat；**DeepSeek、智谱、Kimi 的缺省切到 messages 以实测门为前提**，未过门前保留 chat 并提供 `@messages` 渠道 | 现状 `api` 单值、渠道只能来自用户配置（`src/ai/providers/builtin.ts:1-12`、`channels.ts:26-50`）；R1 §2.1 表：只有通义 / MiniMax M2 / 腾讯真正执行 `cache_control`，DeepSeek 忽略、智谱 / Kimi 自动缓存；Kimi K3 在 Messages 端点有 `tool_use.id` 复用的第三方报告（R1 §2.3）——没有真实 key 验证前不改用户的缺省路径 |
| D9  | Coding Plan 类订阅端点**不做内置渠道**，只在 `docs/guides/providers.md` 写配置示例                                                                                                                                                                                                                                             | R1 §4.4：额度只限编程工具，`-p` / RPC 属自动化调用，有封号风险；由用户自己决定                                                                                                                                                                                                                                       |
| D10 | Anthropic 协议增加**按主机的 compat 推断表**（`anthropic-compat.ts`），`OFFICIAL_HOSTS` 改为按主机的缓存能力表                                                                                                                                                                                                                 | `detectAnthropicCompat` 只合并 provider / model compat（R1 §0.5），第三方 Messages 端点的 beta 头、1h TTL、adaptive thinking 全靠缺省；`cache-params.ts:26` 只认两个官方主机，xAI / Mistral / Kimi 官方推荐的 `prompt_cache_key` 缺省不发                                                                            |
| D11 | 图像：大小按 **base64 后**计算并按端点分档（官方 Anthropic 10 MB、Gemini 20 MB、中转 / 未知 5 MB）；单请求图片总量超预算时把**最旧的图换成占位文本**，以 `context_edit{reason:"image_budget"}` 持久化而不是请求时临时处理                                                                                                      | `MAX_IMAGE_BYTES` 比较原始字节（`src/tools/image-file.ts:14,116`），base64 后约 6.7 MB，超过 Bedrock 系中转 5 MB；历史图片每轮重发会撞 Anthropic 32 MB / Gemini 20 MB 上限（R1 §3.4）；持久化成 `context_edit` 之后前缀稳定、未命中归因天然把它当重置点（§9.1）                                                      |
| D12 | 剪贴板图片：`Ctrl+V` / `/paste` 调系统命令（macOS `osascript`、Wayland `wl-paste`、X11 `xclip`、Windows PowerShell）读位图到数据目录临时文件再走 `loadImageFile`；缩放可选（`images.resize`，缺省 `auto`：有 `sips` / `magick` 才缩，只在超限时）；是否发送按模型 `input` 含 `image`                                           | 零依赖不能解码像素（R1 §3.4 第 5 条），系统工具是唯一途径；全仓库没有读剪贴板的代码（R1 §3.3）                                                                                                                                                                                                                       |
| D13 | **统一入口**：模型只认识 `task(agent=…)` 与 `task_ctl`；`agent` 既可以是 ama 自己的子 Agent 类型，也可以是外部 CLI Agent（定义文件 `runner: claude \| codex \| acp:<program>`）。**不新增 `agent_run / agent_status / agent_stop`**                                                                                            | 用户要求「与第 5 项统一入口」；R2 §3.3 的三个工具与 `task(agent, prompt, background, taskId)` + `task_ctl(list \| wait \| stop \| output)` 一一对应；少一套动词，嵌入 Armadra 时宿主也只需接管一个入口                                                                                                               |
| D14 | 驱动分层：`src/drivers/`，内部词汇 = ACP 子集；优先级 原生 ACP > 已装 ACP 适配器 > 原生结构化协议（Claude stream-json、Codex app-server）> 一次性打印模式；**同一批实现 `ama --mode acp`**（ACP 服务端），类型与分帧从 `@armadra/agent/acp` 子路径导出供 Armadra 复用                                                          | R2 §0.1–0.2：ACP 一个客户端覆盖三十多家，Claude / Codex 本机已装、原生协议能力更全（`--max-budget-usd`、`turn/steer`）；Armadra D12 已在等 ama 的 ACP 服务端；协议栈只维护一份                                                                                                                                       |
| D15 | 外部 Agent 的权限请求**只交给人**：进 ama 的 broker 链（宿主 → UI → 无人值守拒绝），auto 分类器不参与，模型没有任何回答审批的工具；`AskUserQuestion` / `elicitation` / `requestUserInput` 同样只接受人的输入；子 Agent 的模式**不得比 ama 当前模式宽**                                                                         | 用户硬约束；Armadra 审查准则把「替人回答权限提示」列为 P1；R2 §3.4                                                                                                                                                                                                                                                   |
| D16 | 子进程环境**缺省剥离**所有内置供应商的 key 环境变量（`BUILTIN_PROVIDERS[].envKeys`）、`*_BASE_URL` 与 `AMA_*`；`agents.<id>.env.passthrough` 显式放回                                                                                                                                                                          | R2 K4：`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 漏进子进程会把 Claude / Codex 从订阅切到 API 计费；ama 不能区分「用户 shell 本来就有」与「为 ama 设的」，所以缺省全剥、显式放回                                                                                                                                        |
| D17 | 嵌入宿主时 ama **不自己 spawn 外部 Agent**：有 `profile.host` 即禁用 `claude` / `codex` 等外部 runner；HostApi 新增可选面 `runners.provide(runner)`，宿主注入的 runner 以同一 `task(agent=…)` 入口出现                                                                                                                         | R2 §3.7：绕过画布 spawn 会让节点、连线授权与审批全部失效（Armadra 审查 P1）；可选面与 `cache?` 同一做法，`HOST_API_VERSION` 不变                                                                                                                                                                                     |
| D18 | Plan 模式说明以 `custom_message{ama.plan_mode}` **尾部注入**（首次完整版，之后每 5 回合简版，每第 5 次完整版，压缩后补一次完整版）；退出注入 `ama.plan_mode_exit`；**不新增 enter / exit 工具**，不改系统节与工具表                                                                                                            | §9.1 前缀稳定；`custom_message` 投影为 user 消息已有先例（`src/agent/session-run.ts:101-108` 的 `ama.aborted`）；生态里按模式增删工具导致缓存命中率下降的事故（R3 §1.5）                                                                                                                                             |
| D19 | 计划产物 = 模型回复里的 `<proposed_plan>` 块，**由 ama 提取并落盘**（`custom{ama.plan}` + `<dataDir>/plans/<session>-v<N>.md`）；审批四选项（批准执行 / 批准并指定模式 / 批准到新上下文 / 继续修改）；无人值守 `plan.unattended` 缺省 `stop`                                                                                   | 模型在 plan 下不需要写权限，避开「模型不敢写计划文件」类 bug（R3 §1.5）；ama 不替人批准                                                                                                                                                                                                                              |
| D20 | **`todo` 进 `default` 预设**（会话开始即固定，不中途开启）；`todo` 增 `update` 补丁动作与 `planStep` 字段；以 `bench-presets` 复测为门：费用增幅 ≤ 5% 且成功率不降才保留，否则退回「只在 plan 交接时用 `[DONE:n]` 文本标记」                                                                                                   | D19 修订：todo 是 parallel 工具、与同回复的其它调用一起发出不加往返；约 150 token 留在缓存前缀；R5 G3 的压缩回注与 R3 的交接都依赖它；用户倾向进并要求复测                                                                                                                                                           |
| D21 | plan 模式放行**只读 bash 子集**（`READONLY_BASH`：比 auto 安全名单更窄，去掉测试 / 构建运行器、无重定向、无命令替换、无网络），`task` 在子会话强制 plan 时放行；**`allowlist` 同步放行同一子集**，保持 `plan ⊆ allowlist ⊆ default` 的全序                                                                                     | 现状 plan 下连 `git log` 都不行（`src/permissions/pipeline.ts:68-74`）；全序被 `isAtLeastAsStrict` 与「项目级只能收紧」依赖（`docs/guides/permissions.md` 第 22-24 行），改成不可比要动合并规则；只读子集是静态确定的名单，CI 用 allowlist 多放行 `ls` / `git log` 无害                                              |
| D22 | 子 Agent 定义文件 `.ama/agents/*.md`（项目级需信任）与 `~/.config/ama/agents/*.md`，frontmatter 与 Skill 同风格（kebab-case）；内置 `general` / `explore` / `plan`；只读类型**复用 `plan` 权限模式强制**，不新增 `read-only` 模式；`.claude/agents` 兼容读取本波不做                                                           | R4 §3.1–3.2；D21 之后 plan 模式已含只读 bash，再加一种模式只增加全序与界面负担                                                                                                                                                                                                                                       |
| D23 | `task` 改 `parallel`、结果 50 KB 上限（头 + 尾）并全文落 `outputs/`、maxTurns 耗尽时以 `toolChoice:"none"` 收尾一轮要报告；**子会话工具表与父字节一致**（保留 `task` schema，运行时按深度拒绝）                                                                                                                                | R4 G3：`tool-runner.ts:330-334` 批中任一 sequential 则整批串行；G6 结果无上限；G10 工具表不同导致子会话首请求连 tools+system 前缀都不命中                                                                                                                                                                            |
| D24 | 子 Agent 后台运行（`background: true` → 立即返回 `taskId`，完成后以 `<task-notification>` 走 followUp 队列）、`taskId` 续聊（注册表 LRU 16，resume 时重建）、`isolation: worktree`（`<repo>/.ama/worktrees/<taskId>`，分支 `ama/task-<taskId>`，无改动自动删）；深度仍 ≤ 1，并发 4、排队上限 16                                | R4 §3.4、§3.7；followUp 队列已有（`src/agent/queue.ts`）；深度 1 是多数对照的缺省，协调场景由 Armadra 承担                                                                                                                                                                                                           |
| D25 | 压缩按 R5 §4 做 C1–C10 与 C13：档一改按**工具结果新旧**计边界、加 `clearAtLeast` 门槛与回差、缓存冷时提前裁、保护集；熔断改快速回填式；压缩后以 `custom_message{ama.post_compact}` 回注关键状态；模板补节；结果自检；split 并行；CJK 估算；`PostCompact` Hook。**C11 预计算与 C12 供应商原生压缩本波不做**                     | G1 是 P0：单 user 消息时 `planPrune` 直接返回空（R5 §1.2，`prune-tier.ts:61-71`），Armadra 嵌入正是这种形态；C11 要处理「摘要后又有新消息」的竞态、C12 不透明且锁定供应商，收益都要先测                                                                                                                              |
| D26 | 压缩后回注**只含清单与指针**：todo 快照、最近修改 / 读取文件路径、已加载 Skill 名与路径、当前计划、完整转录与 `outputs/` 路径；**不回注文件正文**                                                                                                                                                                              | R5 §6 风险 2：回注正文让压缩后首个请求变大；路径指针足以让模型按需 `read`，与「文件系统作外部记忆」一致                                                                                                                                                                                                              |
| D27 | 档一缺省参数：`keepToolResults 5`、`protectTokens min(40k, 0.2×budget)`、`clearAtLeast max(20k, 0.1×budget)`、触发 0.7 / 目标 0.5；只有 `compaction.prune.keepResults` 与 `compaction.prune.clearAtLeast` 进配置面，其余随窗口缩放的常量不暴露                                                                                 | R5 §4.3；按比例缩放避免固定阈值不随窗口变化的坑；精简配置原则（D20 of design）                                                                                                                                                                                                                                       |
| D28 | 中文 token 估算改为**按脚本区分**：CJK 统一表意文字 / 假名 / 谚文每字 1 token，其余字符 / 4；档一大小判断改用 token 口径                                                                                                                                                                                                       | R5 G6：字符 / 4 对中文低估 3–4 倍，中文会话会晚触发直至溢出；`PRUNE_MIN_BYTES` 与 token 口径不一致                                                                                                                                                                                                                   |
| D29 | harness：重复调用检测（同名同参 ≥ 3 次提醒、≥ 5 次结束 run）、`--max-turns / --max-cost` 与 `limits.*`、统一提醒通道 `ama.reminder`（todo 复述、外部文件改动、上下文用量、预算）、通用截断改头 + 尾、后台 bash（不加新工具，`bash{background}` + `bash{job, action}`）、模型回退 `fallbackModel`                               | R5 §5 按价值 / 成本排序的前 7 项；全部只追加尾部，不碰 §9.1 前缀                                                                                                                                                                                                                                                     |
| D30 | 会话层新增 **`SessionExtension` 扩展点**（`beforePrompts` / `wrapStream` / `onEvent` / `onAgentSettled` / `contributeStats`），遥测、plan、提醒、图片预算、子 Agent 通知都以扩展实现在各自文件；契约 PR 把 `session.ts` 的设置类方法移到 `session-settings.ts` 腾出空间                                                        | `session.ts` 已 600 行满（D17 of design），五个批次都要在同一处接线必然冲突；扩展点让各批次只拥有自己的文件，组装表 `compose-extensions.ts` 每批次只加一行（与第三波 `models.ts` 动作表同一做法）                                                                                                                    |
| D31 | 契约改动集中为前置 PR「contracts-wave5」[W5-C0]：类型、配置键（全部）、RPC 命令 / 事件 / 能力、CLI 新参数、`session.ts` 拆分、`presets.ts` 的 todo；全部可选字段，`RPC_PROTOCOL_VERSION` / `HOST_API_VERSION` / `SESSION_FORMAT_VERSION` 不变                                                                                  | 第二、三波同一做法有效；RW 计划把配置键分给各批次导致 `config/{types,schema,json-schema,key-docs}.ts` 四文件被多批次改，本波批次更多，集中到 C0                                                                                                                                                                      |
| D32 | 与进行中的 RW-C（`src/modes/interactive/**`、`commands-core.ts`、`docs/guides/tui.md`）与 RW-D（`src/checkpoints/shadow-git.ts`）**不重叠**：本波第一组批次不碰这些文件；界面类批次（状态行 W5-A、界面集成 W5-U）排在 RW-C 合入之后                                                                                            | `rewind-plan.md` §8 的文件所有权                                                                                                                                                                                                                                                                                     |

## §1 终端底部信息行

### §1.1 目标样式

80 列、`ui.statusLine: "full"`：

```text
tps 100 tok/s · 546 tok / 5.5s · avg 100 · ttft 1.4s                  ↑12.3k ↓1.2k · cache 83% ♨ · [-]
Manual · shift+tab 切换        claude-opus-5-5 medium · ctx 3.0% · vitaweave ⎇ main 5ae9e54 +12 −3 · $0.26 · 2h24m
```

- **上行（速率行，`status-line.ts`）**：左区 `tps <本次或最近一次 tok/s> · <输出 token> tok / <耗时>s · avg <会话均速> · ttft <首 token 延迟>`；右区从现状栏迁来的「用量类」项：`↑ ↓` token、`cache`、`rebill`、`queue`、`codemode`、`preset`、宿主状态 `[…]`；行尾 `[-]`（折叠提示，ASCII 同形）。流式期间 `tps` 是最近 2 s 滑动窗口的瞬时值，前缀 `tps` 用 accent；结束后显示该请求的平均值。
- **下行（状态行，现 `status-bar.ts`）**：左区不变（模式 + `shift+tab 切换`）；右区 `模型 思考级别 · ctx N% · <目录名> ⎇ <分支> <短提交> +a −b · $费用 · 会话时长`。模型与思考级别之间用空格（同一项），其它项仍用 `·`。`ctx` 保留一位小数（`3.0%`），≥ 110 列换 Meter（现状）。
- **`compact`**：只显示下行，上行的用量类项按现状回到下行（即今天的样子 + git + 时长）。`[-]` 不显示。
- **折叠开关**：`ui.statusLine: "full" | "compact"`（缺省独立 `full`，有 profile 时 `compact`，`PROFILE_DEFAULTS`）；运行时 `Ctrl+G`（键位动作 `status_line.toggle`，可在 `keybindings.json` 覆盖）或 `/statusline [full|compact]` 切换，只影响本会话。
- **ASCII / NO_COLOR**：`⎇` → `git`（`vitaweave git main 5ae9e54`），`−` → `-`，`♨` → `~`（现有 glyph 表）；无色时信息不丢（阈值色只是第二通道）。
- **tmux 宿主解析**：下行是最后一行、模式最左、`·` 分隔的约定不变；嵌入缺省 `compact`，布局与今天完全相同；`docs/guides/tui.md` 写明「`full` 时输入框在倒数第 4 行」。

### §1.2 丢弃顺序

上行（数字大先丢；`tps` 项与 `[-]` 永不丢）：

| 优先级 | 项       | 优先级 | 项            |
| ------ | -------- | ------ | ------------- |
| 1      | `ttft`   | 6      | `cache`       |
| 2      | `avg`    | 7      | `↑ ↓` token   |
| 3      | 宿主状态 | 8      | `queue`       |
| 4      | `preset` | 9      | `codemode`    |
| 5      | `rebill` | 10     | `N tok / T s` |

下行（模式永不丢；`shift+tab 切换` < 40 列即丢）：

| 优先级 | 项       | 优先级 | 项             |
| ------ | -------- | ------ | -------------- |
| 0      | 模型     | 4      | git 分支与提交 |
| 1      | `ctx`    | 5      | 目录名         |
| 2      | `$` 费用 | 6      | git `+a −b`    |
| 3      | 会话时长 | 7      | 思考级别       |

`compact` 模式下的下行按现状优先级，git 三项插在 `ctx` 之后（分支 4、目录 5、增删 6），时长 3，现状的 queue / codemode / preset / 宿主顺延。模型名缩写规则不变（`abbreviateModel`）。

### §1.3 数据来源

```ts
// src/agent/session-telemetry.ts [W5-A]（SessionExtension，§10.1）
export interface RequestTelemetry {
  requestAt: number;
  firstTokenAt?: number; // 首个 text_delta / thinking_delta / toolcall_start
  doneAt?: number;
  outputTokens?: number; // usage.output（含 reasoning）；流式期间用增量字符 / 4 估算
  tps?: number; // outputTokens / (doneAt − firstTokenAt)
  ttftMs?: number;
}
export interface SessionTelemetry {
  last?: RequestTelemetry; // 最近一次 purpose:"turn" 的请求
  live?: { tps: number; outputTokens: number; elapsedMs: number }; // 流式中
  avgTps?: number; // 会话内全部 turn 请求的 Σoutput / Σ(done − firstToken)
  sessionStartedAt: number; // 本进程打开该会话的时刻（不是会话文件创建时间）
}
// SessionStats.telemetry?: SessionTelemetry（C0 契约）；SessionEvent 加 { type: "telemetry_tick" }（流式中 ≤ 2 Hz，TUI 只重绘速率行）
```

- 只统计 `purpose: "turn"`；`summary` / `warm` / `probe` / `classify` 不计入均速。
- 瞬时 tps 用 2 s 滑动窗口的增量字符 / 4（与 `estimate.ts` 同口径，中文按 D28 改进后的估算）；`ui.animation: false` 时不发 `telemetry_tick`，只在请求结束刷新。
- 费用：`SessionStats.cost`（含子任务、保温、分类器，现状）；时长：`now − sessionStartedAt`，格式 `Ns` / `Nm` / `NhMm`。

```ts
// src/git/info.ts [W5-A]（零依赖读 HEAD；numstat 子进程节流）
export interface GitInfo {
  branch?: string; // detached 时 undefined，显示短提交
  shortHead?: string; // 7 位
  insertions?: number; // 工作区（含暂存）相对 HEAD；拿不到为 undefined
  deletions?: number;
}
export class GitInfoWatcher {
  constructor(
    cwd: string,
    deps?: { spawn?; now?; minIntervalMs?: number /* 10 000 */; timeoutMs?: number /* 2 000 */ },
  );
  /** 回合边界调用：读 HEAD（同步、便宜）；距上次 numstat ≥ minInterval 则后台起一次 `git diff --numstat HEAD`。 */
  refresh(): void;
  current(): GitInfo | undefined;
  onChange(listener: () => void): () => void;
}
```

- 触发点：`agent_settled`、`tool_execution_end`（write / edit / bash）、`session_rewound`、`/tree` 之后；numstat 环境加 `GIT_OPTIONAL_LOCKS=0`，超时或非零退出就省略增删项并在本会话停用 numstat（HEAD 仍显示）；非 git 目录整段省略。
- 配置 `ui.statusLine` 之外不加键；`AMA_STATUS_GIT=0` 环境变量关闭 numstat（排错用）。

### §1.4 测试

帧黄金 `test/fixtures/tui/status-widths.txt` 扩为 40 / 60 / 80 / 110 列 × full / compact；ASCII 变体；`session-telemetry.test.ts` 用 fake 供应商（脚本 `delayMs`）断言 ttft 与 tps 的计算、`telemetry_tick` 频率 ≤ 2 Hz、非 turn 请求不计入；`git/info.test.ts` 用临时仓库（有 git 则跑，无则跳过）断言节流、超时降级、detached HEAD。

## §2 模型元数据本地化

### §2.1 快照

```text
src/ai/providers/models-dev/
  _meta.json          { source, license: "MIT", upstream: "anomalyco/models.dev", sha256, fetchedAt }   // fetchedAt 只在 sha256 变化时更新
  _providers.json     收录清单与 OpenRouter 前缀白名单（脚本与测试共用）
  anthropic.json openai.json google.json xai.json deepseek.json moonshotai.json moonshotai-cn.json
  zhipuai.json zai.json alibaba.json alibaba-cn.json minimax.json minimax-cn.json stepfun.json stepfun-ai.json
  volcengine.json tencent-tokenhub.json mistral.json meta.json xiaomi.json groq.json openrouter.json
src/ai/providers/models-dev-data.ts   生成：MODELS_DEV_SOURCES: Record<id, string>（同 catalog-data.ts 手法）
THIRD_PARTY_NOTICES.md                models.dev 的 MIT 声明与来源 URL
```

- 单家文件形状与 `ModelsDevProvider` 兼容，`ModelsDevIndex` 原样复用；`trimModel()` 扩展字段：`family`、`knowledge`、`release_date`、`last_updated`、`limit.input`、`cost.context_over_200k` / `cost.tiers`、`reasoning_options`、`interleaved`、`status`、`modalities.input`。
- 过滤：丢 `status: "deprecated"`、`modalities.output` 不含 `text`、`limit.context` 为 0、`tool_call: false`；OpenRouter 只留 `_providers.json` 白名单前缀。
- 规范化：键递归排序、2 空格缩进、末尾换行，无变化时字节相同。
- `Model` 契约新增可选字段（C0）：`family?`、`knowledge?`、`releaseDate?`、`inputLimit?`、`status?: "beta"`；`ModelCost` 已有 `tiers`，映射 `context_over_200k` → `tiers[{inputTokensAbove: 200000, …}]`。

### §2.2 运行时数据流

```text
loadModelsDevIndex(dataDir)
  = 快照（bundle 内）
  ⊕ 用户级覆盖 <dataDir>/models-dev.json（只有 `ama models refresh` 会写；存在且 fetchedAt 晚于快照才叠加；同 provider/model 以覆盖为准）
```

- `ama models refresh [--provider id]`：显式联网，拉 `api.json`、按同一清单裁剪、写用户级覆盖文件并打印新增 / 删除 / 变价摘要；`refresh-catalog` 作别名。`ama providers add|refresh` 与 `ama models discover` **不再联网拉 models.dev**，只用已有索引（它们对 `/models` 的请求照旧）。
- `enrich.ts` 优先级不变：config > 目录 > models.dev（快照 ⊕ 覆盖）> 缺省；内置目录模型也经 models.dev 补齐（D6）。
- 目录格式：`catalog/*.json` 条目允许只有 `{ "id" }`（数值从快照继承）；`checkCatalogModel` 改为「目录 ∪ 快照」合并后再校验必填；`catalog.test.ts` 新增断言：目录条目中与快照取值相同的 `contextWindow / maxTokens / cost / input` 视为冗余报错（`UPDATE_CATALOG=1` 时自动删除冗余字段）。有意保留的覆盖写 `"_reason"` 注释字段（校验允许、运行时忽略）。

### §2.3 生成脚本与 Action

- `scripts/update-models-dev.mjs`（零依赖，Node 22 `fetch`，超时 60 s）：拉取 → 校验（顶层对象、供应商数 > 100、清单每家存在且 ≥ 1 条）→ 裁剪 → 规范化 → 写 JSON 与 `models-dev-data.ts` → stdout 摘要（新增 / 删除 / `context`、`output`、`cost` 变化）；删除比例 > 30% 时退出码 3（Action 据此加 `needs-review` 标签而不是失败）。`catalog.test.ts` 的 `generate()` 抽到 `scripts/lib/inline-json.mjs` 两处共用。
- `.github/workflows/models-dev.yml`：`schedule: "17 3 * * 1"` + `workflow_dispatch`；`permissions: { contents: write, pull-requests: write }`；`concurrency: models-dev`；步骤：checkout → pnpm → `node scripts/update-models-dev.mjs > /tmp/summary.md` → `pnpm prettier --write src/ai/providers/models-dev src/ai/providers/models-dev-data.ts` → `git diff --quiet` 判断 → **若 `secrets.MODELS_DEV_PR_TOKEN` 存在**：`peter-evans/create-pull-request@v7`（`token` 用它，固定分支 `chore/models-dev-refresh`，标题 `chore(providers): 刷新 models.dev 快照`，body 为摘要）；**否则**先 `pnpm run ci`，再用 `github.token` 开 PR 并在 body 顶部注明「本 PR 由缺省 token 创建，CI 未自动触发，已在 workflow 内跑过 `pnpm run ci`」。
- 不发布、不推 main、只开 PR；合并仍由人做。

### §2.4 测试

`models-dev.test.ts`：trimModel 新字段、过滤规则、白名单；`models-dev-cache.test.ts`：快照 ⊕ 覆盖的合并与 fetchedAt 比较、无覆盖文件时零文件 IO 之外不联网（fake fetch 必须不被调用）；`catalog.test.ts`：继承、冗余报错、`_reason`；脚本用 fixture `test/fixtures/models-dev/api.sample.json` 跑一遍断言字节稳定与摘要；bundle 体积测试：`dist/bundle/ama.cjs` 增量 ≤ 200 KB。

## §3 协议优先级与内置渠道

### §3.1 契约

```ts
// src/ai/types.ts [C0]
export interface ProviderData {
  …;
  channels?: ProviderChannel[]; // 内置渠道（已有类型），用户 config 同名覆盖、新增追加
  defaultChannel?: string;
}
export interface AnthropicMessagesCompat {
  …; // 已有：supportsCacheControlOnTools、supportsTemperatureWithThinking、adaptiveThinking、maxCacheBreakpoints
  sendInterleavedThinkingBeta?: boolean; // 缺省：官方 true、其它主机 false
  sendCacheControl?: boolean; // 缺省 true；DeepSeek 等「忽略」的端点可关以减少请求体
}
export interface OpenAIResponsesCompat {
  …;
  explicitCacheField?: "volcengine"; // 火山方舟 `caching:{type:"enabled"}`（可选，P2）
}
```

- `registry.ts` 物化：`builtin.channels` ← 用户 `channels`（同名字段级覆盖、新名追加）；`defaultChannel` 用户优先；`isRelayedBaseUrl()` 改为按渠道比较主机。
- `anthropic-compat.ts`（新）：主机子串表 → `AnthropicMessagesCompat` 缺省：`api.anthropic.com`（全开）、`api.deepseek.com`（`sendCacheControl:false`、`sendInterleavedThinkingBeta:false`、`adaptiveThinking:false`）、`open.bigmodel.cn` / `api.z.ai`、`api.moonshot.*`、`dashscope*`（`supportsLongCacheRetention:false`）、`api.minimax*`、`api.stepfun.com`、`tokenhub.tencentmaas.com`（`supportsLongCacheRetention:true`）、`openrouter.ai`（流式 usage 在 `message_delta`，解析已合并则不需开关，测试核对）；其它主机保守缺省。
- `cache-params.ts`：`OFFICIAL_HOSTS` → `HOST_CACHE_CAPABILITIES: Record<host, Partial<PromptCacheCompat>>`，新增 `api.x.ai`、`api.mistral.ai`、`api.moonshot.cn/.ai`（`sendPromptCacheKey:true`）、`tokenhub.tencentmaas.com`（`supportsLongCacheRetention:true`）。

### §3.2 内置供应商缺省渠道（目标表）

| id                    | 渠道（首个为缺省）                                                                          | 切换条件                                                 |
| --------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `anthropic`           | `messages`                                                                                  | 不变                                                     |
| `openai`              | `responses`、`chat`                                                                         | 直接切（目录去掉 12 处逐条 `api` 覆盖）                  |
| `xai`                 | `responses`、`chat`                                                                         | 直接切（官方已把 Anthropic 兼容标 deprecated，不做渠道） |
| `google`              | `gemini`                                                                                    | 不变                                                     |
| `dashscope`           | `messages`（`/apps/anthropic`）、`responses`、`chat`                                        | 显式缓存 5m，直接切；`dashscope-intl` 作渠道             |
| `minimax`（新）       | `messages`（`api.minimaxi.com/anthropic`；国际 `api.minimax.io` 渠道）、`responses`、`chat` | 官方推荐；M3 缓存行为列入实测                            |
| `tencent`（新）       | `messages`（`tokenhub.tencentmaas.com`）、`chat`                                            | 显式缓存含 1h，直接切                                    |
| `stepfun`（新）       | `messages`、`chat`（`responses` 按模型，目录标注）                                          | 直接切                                                   |
| `volcengine`（新）    | `responses`（`ark.cn-beijing.volces.com/api/v3`）、`chat`                                   | 直接切；Coding Plan 端点只写文档                         |
| `deepseek`            | `chat`、`messages`（`/anthropic`）                                                          | **实测门**：过门后缺省改 messages                        |
| `zhipu`               | `chat`、`messages`（`/api/anthropic`；国际 `api.z.ai` 渠道）                                | 实测门                                                   |
| `moonshot`            | `chat`、`messages`、`responses`（国际 `.ai` 渠道）                                          | 实测门（K3 `tool_use.id` 报告）                          |
| `openrouter`          | `chat`；目录 `anthropic/*` 模型级 `messages`                                                | 不变                                                     |
| `groq` / `mistral`    | `chat`                                                                                      | 不变（`mistral` 缺省开 `sendPromptCacheKey`）            |
| `ollama` / `lmstudio` | `chat`                                                                                      | 不变                                                     |

**实测门**（`scripts/channel-probe.mjs`，本地、需真实 key、每家 ≤ 8 请求）：对 `<provider>/<model>@messages` 跑 ① `ama models check`（一次最小调用）② 工具调用往返（读一个临时文件）③ thinking 开启下两回合（签名回放）④ `cache-probe`（两次、看 `cache_read_input_tokens`）；四项全过且 `tool_use.id` 唯一 → 该家缺省切 messages，结果表写进 `docs/guides/providers.md`「渠道实测」。未过或没 key 的保持 chat。切换是**纯数据改动**（`builtin.ts` 一行），可随时跟进。

### §3.3 目录与文档

- 新增 `catalog/{minimax,stepfun,volcengine,tencent}.json`（D6 格式，数值来自快照）；`catalog.test.ts:58-64` 的集合断言同步。
- `docs/guides/providers.md`「内置供应商」表加渠道列、新增四家、Coding Plan 配置示例段、「渠道实测」表；`docs/design/design.md` §3.3 表加一句指向。

### §3.4 测试

内置渠道物化与用户覆盖的真值表；`anthropic-compat` 主机表真值表 + 请求快照（beta 头、`cache_control` 有无、TTL）；`HOST_CACHE_CAPABILITIES`；`channel-probe` 用 fake 供应商走通（`fake/echo@messages`）。

## §4 图像能力

| 项           | 设计                                                                                                                                                                                                                                                                                                                                                                 | 落点                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 大小上限     | `base64Bytes = ceil(bytes/3)*4`；上限按端点：`imageLimits(model, api)` → 官方 Anthropic 10 MB、Gemini 20 MB、OpenAI 20 MB、中转（`isRelayedBaseUrl`）/ 未知 5 MB；`read` 与 `--image` / `@路径` 共用                                                                                                                                                                 | `src/tools/image-file.ts`、新 `src/ai/image-limits.ts`                                                           |
| 尺寸         | 已有 `imageSize()`：任一边 > 8000 px 拒绝（Anthropic 400）；可缩放时先缩                                                                                                                                                                                                                                                                                             | `image-file.ts`                                                                                                  |
| 请求总量预算 | 预算按协议：Anthropic 32 MB、Gemini 20 MB、其它 20 MB（base64 后）；每次请求前 `planImageBudget(items, budget)` 从最旧的图开始降级到 ≤ 60% 预算（一次多降，减少反复失效），每条被降级的消息追加 `context_edit{reason:"image_budget", replacement: 原文本 + "[earlier image omitted to fit request size]"}`；> 20 张图时另检查每边 ≤ 2000 px                          | 新 `src/compaction/image-budget.ts`（纯函数）+ `src/agent/session-images.ts`（SessionExtension `beforePrompts`） |
| 不收图模型   | 现状 `normalizeContext` 替换占位（`src/ai/context.ts:32,60-91`）不变；快照提供 `modalities.input`，自定义模型离线也能判断                                                                                                                                                                                                                                            | —                                                                                                                |
| 剪贴板       | `pasteClipboardImage(dataDir)`：按平台依次尝试 `osascript -e 'the clipboard as «class PNGf»'`（写临时文件）/ `pngpaste`、`wl-paste -t image/png`、`xclip -selection clipboard -t image/png -o`、`powershell Get-Clipboard -Format Image`；成功写 `<dataDir>/clipboard/<ts>.png` 并返回路径，编辑器插入 `@<路径>`；没有工具或剪贴板无图返回 undefined（界面提示一行） | 新 `src/tools/clipboard-image.ts`；界面接线归 W5-U（`Ctrl+V`、`/paste`）                                         |
| 缩放         | `images.resize: "auto" \| "off"`（缺省 auto）：只在超限时，依次找 `sips -Z <edge>`（macOS）、`magick` / `convert -resize`，输出到临时文件再校验；找不到工具则按原规则拒绝并提示                                                                                                                                                                                      | 新 `src/tools/image-resize.ts`                                                                                   |
| 清理         | `<dataDir>/clipboard/` 超过 7 天的文件在 `ama sessions prune` 时清理                                                                                                                                                                                                                                                                                                 | `src/cli/subcommands/sessions.ts`（gc 一行）                                                                     |

契约：`ContextEditReason` 加 `"image_budget"`；`ImagesConfig { resize?: "auto" | "off" }` → `AmaConfig.images`。缓存影响：降级写 `context_edit` 后前缀改变一次，未命中归因视为重置点（现有规则）；状态栏提示「已省略 N 张早期图片以符合请求上限」一次。

测试：base64 换算与分档；预算函数（最旧先降、60% 回差、> 20 张的边长检查）；`session-images` 用 fake 断言 `context_edit` 条目与投影；剪贴板与缩放用 fake `spawn`（命令可注入）覆盖各平台分支与「无工具」路径。

## §5 原生操控其他 Agent

### §5.1 分层与文件

```text
src/drivers/                      零依赖；只依赖 agent/types、permissions/types、tools/types
  types.ts        [C0] AgentDriver / DriverSession / DriverEvent / DriverCapabilities / DriverPermissionRequest（ACP 词汇）
  catalog.ts      内置驱动表（数据）：agentId → 候选链 [{ kind, program, args, env, modes, resume, sessionIdRule, verified?: 版本区间 }]
  probe.ts        PATH 探测 + `--version` + 能力缓存（每进程一次，写 <dataDir>/drivers.json）
  env.ts          子进程环境清理（D16）
  pool.ts         并发池 / 预算 / 看门狗 / 进程树回收（复用 tools/process-tree.ts）
  store.ts        会话引用：custom{ama.agent-session} 与 custom{ama.agent-usage}
  runner.ts       ProcessRunner：把 AgentDriver 适配成 SubagentRunner（§7.6）
  acp/
    types.ts      v1 子集（initialize、session/new|load|resume|list|close、session/prompt|cancel|set_mode、session/update、session/request_permission、usage_update）
    client.ts     JSON-RPC over NDJSON（复用 modes/rpc/jsonl.ts 分帧）
    driver.ts     AcpDriver
    server.ts     ama --mode acp：把 AgentSession 暴露为 ACP Agent
    testing/fake-agent.mjs  黄金记录用假 Agent
  native/
    claude-stream.ts       `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`
    codex-app-server.ts    `codex app-server`：initialize、thread/start|resume|fork|read|list、turn/start|steer|interrupt、model/list、account/rateLimits/read + 审批类 ServerRequest
    oneshot.ts             `claude -p --output-format json` / `codex exec --json` / `gemini -p --output-format stream-json`：无审批，只在 plan 模式或只读任务下用
  normalize/      原生事件 → DriverEvent 映射表
src/acp.ts                       `@armadra/agent/acp` 子路径：类型、AcpClient、分帧、fake agent 路径
src/modes/acp/acp-mode.ts        --mode acp 的进程入口（stdio、hello、退出）
```

### §5.2 接口

```ts
export interface DriverCapabilities {
  resume: "resume" | "load" | "none";
  list: boolean;
  permissions: "interactive" | "none" | "unreliable";
  steer: boolean;
  modes: readonly PermissionMode[];
  usage: "tokens" | "usd" | "requests" | "none";
  images: boolean;
}
export interface AgentDriver {
  readonly agentId: string;
  readonly kind: "acp" | "acp-adapter" | "claude-stream" | "codex-app-server" | "oneshot" | "host";
  probe(): Promise<{ installed: boolean; version?: string; capabilities: DriverCapabilities }>;
  open(opts: {
    cwd: string;
    mode: PermissionMode;
    model?: string;
    resume?: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
  }): Promise<DriverSession>;
}
export interface DriverSession {
  readonly sessionId: string; // 一律存 CLI 自己的 id
  prompt(
    content: ContentBlock[],
    hooks: {
      onEvent(e: DriverEvent): void;
      onPermission(
        req: DriverPermissionRequest,
        signal: AbortSignal,
      ): Promise<DriverPermissionOutcome>;
    },
  ): Promise<TurnResult>; // { stopReason, finalText, usage?, filesTouched[], toolSummary[≤ 20 行] }
  steer?(content: ContentBlock[]): Promise<void>;
  cancel(): Promise<void>; // 协议级中断；15 s 无回合结束 → 关 stdin → SIGTERM 进程树
  close(): Promise<void>; // 挂起审批统一回 cancelled
}
export type DriverEvent =
  | { type: "message_delta"; text: string }
  | { type: "thought_delta"; text: string }
  | {
      type: "tool_call";
      id: string;
      title: string;
      kind: AcpToolKind;
      status: "pending" | "in_progress" | "completed" | "failed";
      locations?: string[];
    }
  | { type: "plan"; entries: { content: string; status: string }[] }
  | {
      type: "usage";
      input?: number;
      output?: number;
      cacheRead?: number;
      costUsd?: number;
      contextTokens?: number;
      contextWindow?: number;
    }
  | { type: "notice"; level: "info" | "warn"; text: string };
```

原生协议到 `DriverEvent` 的映射按 R2 §3.2 表；Codex 只依赖 12 个方法与 5 类审批请求，`generate-json-schema` 的输出作黄金文件锁形状（`test/fixtures/drivers/codex-schema/`）。

### §5.3 权限：交人、不代答

```ts
// src/permissions/types.ts [C0]
export interface ApprovalRequestContext {
  depth: number;
  parentToolCallId?: string;
  readFiles?: ReadonlySet<string>;
  taskId?: string; // [W5] 子 Agent 任务 id
  origin?: {
    // [W5] 来自外部 Agent 的权限请求
    agent: string;
    sessionId: string;
    toolCall: { title: string; kind: string; locations?: string[]; inputSummary?: string };
    options: {
      optionId: string;
      kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
    }[];
  };
}
```

1. 子 Agent 自己的策略先判，只有它决定「要问人」的请求才到 ama；到了以后**只走 broker 链**（宿主 → UI → 无人值守拒绝），auto 分类器与模型都不参与。
2. 选项映射：允许 → 首个 `allow_once`；本会话允许 → `allow_always`（Codex `acceptForSession`；由子 Agent 自己记，ama 不缓存）；拒绝 → `reject_once`。`reject_always` 与 Codex execpolicy 修订只在对话框「更多」里出现。
3. 无人值守：`reject_once`；Claude 以 `--permission-prompts none` 启动，拒绝记入 `result.permission_denials`。
4. 父 abort、`task_ctl stop`、超时：挂起请求回 `cancelled`。
5. `AskUserQuestion` / `ExitPlanMode` / `requestUserInput` / `elicitation`：作为「Agent 在提问」事件显示，只接受人的输入；无人值守时回 cancelled。
6. 模式：子 Agent 的模式 ≤ ama 当前模式（`isAtLeastAsStrict`）；更宽需用户级 `agents.<id>.maxMode`。
7. 对话框标注 `[claude · 会话 abc1]`（与 `[task]` 同一手法）；RPC `permission_request` 带 `context.origin`。

### §5.4 环境、信任、并发、成本

| 项       | 规则                                                                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 环境     | `buildChildEnv(process.env, agentId, config)`：删 `BUILTIN_PROVIDERS` 全部 `envKeys`、`*_BASE_URL`、`AMA_*`、`CODEX_API_KEY`；保留 `PATH / HOME / LANG / TERM / SSH_* / 代理变量`；`agents.<id>.env.passthrough: string[]` 放回；`--bare` 永不缺省 |
| 信任     | 只在 ama 已信任的目录（`config/trust.ts`）里起外部 Agent；未信任时 `task` 返回错误并提示 `ama trust`（`claude -p` 会跳过目录信任对话框并执行项目 hooks，R2 K6）                                                                                    |
| 并发     | `agents.maxConcurrent` 缺省 3；每个 agent 另有上限（`agents.<id>.maxConcurrent`，claude 缺省 2）；超出排队，排队可被 abort；与 `SubagentPool`（ama 子会话）分开计数                                                                                |
| 预算     | `task` 参数 `budgetUsd`（Claude 透传 `--max-budget-usd`，其它由驱动累计 `usage` 超限 `cancel()`）；`agents.sessionBudgetUsd`；无美元单位的（Codex 订阅 token、Copilot premium request）按各自单位计，不换算                                        |
| 记账     | 每回合写 `custom{ama.agent-usage, agent, sessionId, unit, amount, tokens?}`；`SessionStats.external?: { byAgent: Record<string, { runs, unit, amount, tokens? }> }`；`/session` 新「外部 Agent」段                                                 |
| 看门狗   | `timeoutMs` 缺省 30 min；中断后 15 s 内无回合结束 → 关 stdin → SIGTERM 进程树；空闲 10 min 关进程（能 resume 的下次再起；`resume:"none"` 的常驻并在 `/tasks` 标注）                                                                                |
| 敏感数据 | ama 会话只存 `finalText` 摘要、用量与引用；原始事件只在内存展示，不进 JSONL（Armadra 审查 P0）                                                                                                                                                     |
| 孤儿进程 | 进程组 + `process-tree.ts`；`<dataDir>/drivers/pids.json` 登记，启动时清理                                                                                                                                                                         |

### §5.5 嵌入宿主

```ts
// src/host/types.ts [C0]，可选面
readonly runners?: {
  /** 宿主注入的 runner（画布节点等）；注入后同名的内置外部 runner 被替换。 */
  provide(runner: SubagentRunner & { readonly id: string; readonly description: string }): () => void;
};
```

有 `profile.host` 时：内置外部 runner（`claude` / `codex` / ACP）一律不可用（`task(agent="claude")` 返回「宿主环境下由宿主提供」），只有宿主 `provide()` 的 runner 可用；`disable("task")` 的现状继续有效。Armadra 侧实现另立计划。

### §5.6 `ama --mode acp`

- 与 `--mode rpc` 同一引擎：`initialize` → `agentCapabilities{ loadSession: true, sessionCapabilities: { list, resume, close }, promptCapabilities: { image: true } }`；`session/new` 建会话、`session/load` 回放 `entry_appended`、`session/resume` 不回放、`session/prompt` → `prompt` + 事件映射（`message_update` → `agent_message_chunk`，思考 → `agent_thought_chunk`，`tool_execution_*` → `tool_call` / `tool_call_update`，`todo_updated` → `plan`，usage → `usage_update`）；`session/request_permission` 由 ama 的审批请求映射（`allow_once` / `allow_always` / `reject_once`）；`session/cancel` → `abort`；`session/set_mode` → `set_permission_mode`。
- 不声明 `fs` / `terminal` 客户端能力（与 Armadra Q5 一致）。
- CLI：`--mode acp`（与 `-p` 互斥；`args.ts` 由 C0 加）；退出语义同 rpc。
- 用途：被 Zed / JetBrains / Armadra 的 ACP 节点驱动；**ama 驱动 ama** 作为驱动层的零费用端到端用例（fake 供应商）。

### §5.7 测试

假 ACP Agent 黄金记录（允许 / 拒绝 / 取消三路径、父 abort 后挂起请求回 `cancelled`、resume）；`ama --mode acp` 黄金记录（`test/fixtures/acp/*.jsonl`）；Claude / Codex 驱动用录制的事件流回放（`test/fixtures/drivers/{claude,codex}/*.jsonl`，手工录制、标注版本）；环境清理真值表；看门狗（fake 时钟）；真实 CLI 的两轮往返 + 一次触发审批的写文件（临时目录）**只在本地**（`AMA_E2E_AGENTS=1`，需要用户已登录的 claude / codex；Claude 配置目录前后做字节指纹比对）。

## §6 Plan 能力

### §6.1 流程

```text
进入 plan（Shift+Tab / /plan [目标] / --permission-mode plan / RPC set_permission_mode / SDK）
  记 prePlanMode → custom{ama.plan_state{active:true, prePlanMode}} → 下一次 prompts 前注入 ama.plan_mode（完整版）
只读探索：read/grep/glob/ls、READONLY_BASH、强制 plan 的 task 子 Agent、codemode strict；每 5 回合简版提醒；压缩后补完整版
模型输出 <proposed_plan>…</proposed_plan>（每回合 ≤ 1 个，修订整份重写）
agent_settled：根会话提取 → custom{ama.plan{status:"proposed"}} + 文件 → 事件 plan_proposed → 审批
  1 批准并执行（切回 prePlanMode；进入前就是 plan 则 default）
  2 批准并执行（指定 auto-edit / auto）
  3 批准，在新上下文执行（fork 新会话，首条 user 消息 = 计划全文 + 文件路径）
  4 继续修改…（意见作普通 user 消息，留在 plan）
  Esc：留在 plan，计划标 rejected
交接：steps → ama.todo（全部 pending，首项 in_progress）；注入 ama.plan_mode_exit + ama.plan_approved（计划全文 + 路径 + 「按 todo 推进，每完成一步 todo update」）；触发新回合；plan.model 配置时在此切回执行模型
```

### §6.2 提示与权限

- 三种 `custom_message`（`display:false`，经 `persistMessage` 落盘，resume / fork 重放一致）：`ama.plan_mode`（完整版 300–500 token / 简版 1–2 句）、`ama.plan_mode_exit`、`ama.plan_approved`。注入点：`SessionExtension.beforePrompts`。
- 完整版要点：先探索再提问，仓库里查得到的不问；计划要具体到换人执行不必再决策；列关键文件，重复改动只写一次；必须有验证节；不要用文字问「可以吗」，计划块本身就是审批入口；plan 下用户要求执行按「请规划如何执行」理解；输出格式见 §6.3。
- 被拒消息改为带指引：`Plan mode is active: write/execute tools are disabled. Finish the plan with a <proposed_plan> block.`
- 管线第 ③ 步（`modeDecision` 细化，输入可见）：

| 调用                        | plan 下                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| read / grep / glob / ls     | 放行                                                                                                                                                                                      |
| `todo get`                  | 放行；`todo set / update` **拒绝**并提示用 `<proposed_plan>`（计划与清单分开，避免跳过审批）                                                                                              |
| bash                        | `plan.bash: "readonly" \| "ask" \| "deny"`（缺省 readonly）：每段命令都在 `READONLY_BASH` 且无重定向 / 命令替换 / 嵌套 shell → 放行；否则 `readonly` 下拒绝、`ask` 下询问（无人值守拒绝） |
| write / edit                | 拒绝（计划文件由 ama 进程写）                                                                                                                                                             |
| task                        | 放行，子会话强制 `plan` 且不提取计划块（子会话的 `<proposed_plan>` 作为 task 结果文本返回）                                                                                               |
| codemode                    | strict 时放行（现状）；脚本内嵌套调用照常过管线                                                                                                                                           |
| deny 规则 / 危险命令 / Hook | 先于模式判定（不变）                                                                                                                                                                      |

- `READONLY_BASH`（`src/permissions/readonly-bash.ts`）：`ls cat head tail wc stat file echo printf pwd which env`（无写）、`grep rg fd find`（禁 `-exec` / `-delete` / `--pre`）、`git status|log|show|diff|branch --list|rev-parse|blame|ls-files`、`tree`、`du`、`jq`（无 `-i`）；复用 `analyzeBashForAuto` 的分词 / 嵌套展开 / 重定向检查；机密路径仍由规则层挡。`allowlist` 用同一名单（D21）。
- `docs/guides/permissions.md`：模式表 plan 行「执行」改为「只读命令放行，其余拒绝」，allowlist 行同步；严格度一节加说明。

### §6.3 产物与持久化

```markdown
<proposed_plan>

# <标题>

## 背景

## 步骤

- [ ] S1 <动作>（涉及：path/a.ts）
- [ ] S2 <动作> [depends: S1] [agent: codex]

## 验证

## 假设与风险

</proposed_plan>
```

```ts
// custom{customType:"ama.plan"}
interface PlanData {
  id: string;
  version: number;
  status: "proposed" | "approved" | "rejected" | "superseded";
  markdown: string;
  steps: { id: string; text: string; dependsOn?: string[]; agent?: string }[];
  sourceEntryId: string;
  filePath?: string;
}
// custom{customType:"ama.plan_state"}
interface PlanStateData {
  active: boolean;
  prePlanMode: PermissionMode;
  planId?: string;
}
```

- 提取（`src/plan/extract.ts`，纯函数）：只认不在代码围栏内、开闭标签各占一行的块；多个块取最后一个；步骤识别 `- [ ] Sx` 与编号列表两种，上限 30 条；找不到块时 `/plan approve` 可「把上一条回复当作计划」。
- 文件：缺省 `<dataDir>/plans/<sessionId>-v<N>.md`；`plan.directory` 可指到项目内（必须在项目根之内，否则 warning 回落缺省）；由 ama 进程写，不经工具调用。
- 用户编辑：审批框「在外部编辑器里改」（`$VISUAL` / `$EDITOR`，TUI 挂起）；改后 version+1，交接消息放修改后全文。
- 模式持久化：`ama.plan_state` 让 resume 回到 plan 模式（补上现状「模式不持久化」的缺口，`src/agent/session.ts:468-471`）。
- `docs/reference/session-format.md` custom 表登记 `ama.plan`、`ama.plan_state`、`ama.plan_mode`、`ama.plan_mode_exit`、`ama.plan_approved`。

### §6.4 规划 / 执行分模型（可选）

`plan.model`（`provider/model[@channel]`）、`plan.thinkingLevel`：进入 plan 时切到规划模型，**批准时**切回；缺省不设；文档写明切换时一次全价重读（`model_changed`）；选「新上下文执行」时搭配最划算。

### §6.5 RPC / SDK

| 类型 | 名称                                 | 形状                                                                                       |
| ---- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| 能力 | `set_client_capabilities` 加 `plans` | 声明后计划审批交客户端；未声明按 `plan.unattended`                                         |
| 事件 | `plan_proposed`                      | `{ planId, version, markdown, steps, filePath? }`                                          |
| 事件 | `plan_resolved`                      | `{ planId, decision: "approve" \| "approve_fresh" \| "revise" \| "reject", mode? }`        |
| 事件 | `todo_updated`                       | `{ items }`                                                                                |
| 命令 | `plan_response`                      | `{ planId, decision, mode?, feedback?, editedMarkdown? }`（与 `permission_response` 同构） |
| 命令 | `get_plan`                           | `{ planId? }` → `PlanData \| null`                                                         |
| 命令 | `get_todos`                          | → `{ items }`                                                                              |

SDK：`session.plan.current()`、`session.plan.respond()`；`CreateSessionOptions.plan?: { model?, thinkingLevel?, directory?, bash?, unattended?, onProposed?(plan): Promise<PlanDecision> }`。Hook `PlanProposed` 本波不做。

### §6.6 测试

前缀稳定用例扩展：20 回合中 plan ↔ default 切换 3 次，system + tools 指纹不变、`cache_miss` 无 `prefix_changed`；提醒节奏（第 1 / 6 / 11 回合，第 26 回合完整版，压缩后补发）；权限真值表（plan × read / write / execute × bash 只读 / 非只读 / 重定向；allowlist 同步）；提取边界（不闭合、代码块内、多个块、编号列表、> 30 条）；`plan_state` resume；交接端到端（fake：plan → 批准 → todo 条目 → 执行模式）；`plan.unattended` 两值；RPC 黄金记录 `plan.out.jsonl`。

## §7 子 Agent

### §7.1 定义文件

发现顺序（复用 `skills/discover.ts` 的来源与信任逻辑）：`--agent-dir`（可重复）→ profile `agentDirs` → `~/.config/ama/agents/*.md` → `<cwd>/.ama/agents/*.md`（需信任；未信任跳过并在 `doctor` / 启动头列出）。同名先发现者胜并 warning；内置类型可被覆盖。

```markdown
---
name: reviewer # ^[a-z0-9-]{1,64}$，缺省取文件名
description: 只读审查改动，按文件与行号报告问题。 # 必填 ≤ 1024，进 task 描述
tools: read, grep, glob, bash # 白名单；与 disallowed-tools 二选一
disallowed-tools: edit, write
permission-mode: plan # plan | inherit（缺省 inherit）；只能更严
model: inherit # inherit | provider/model | fast | strong
thinking: low
max-turns: 20 # 缺省 30
isolation: none # none | worktree
background: false
runner: ama # ama（缺省）| claude | codex | acp:<program>
---

（正文 = 追加到子会话系统提示末尾的角色说明）
```

不做：`hooks`、`mcpServers`、`memory`、`color`、`initialPrompt`、`skills`（子会话继承父的 Skill 索引）。`fast` / `strong` 别名映射在 `models.aliases`（C0 配置键）。

### §7.2 内置类型

| 类型                               | 工具     | 权限                  | 系统提示追加（要点）                                         | 模型                                           |
| ---------------------------------- | -------- | --------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| `general`                          | 父活动集 | 继承                  | 你是被委派的子 Agent；直接完成，不要再委派；结束时给精简报告 | inherit                                        |
| `explore`                          | 父活动集 | **plan 模式强制**     | 只定位不评审；返回路径与行号；说明搜索范围                   | inherit（`agents.explore.model` 可指便宜模型） |
| `plan`                             | 父活动集 | plan 模式强制         | 输出分步计划、关键文件、取舍；不得修改文件                   | inherit                                        |
| `claude` / `codex`（探测到才注册） | —        | 外部 Agent 自己的策略 | —                                                            | 外部                                           |

只读靠权限层而不是改工具表（D23 缓存对齐）；explore 下的 bash 用 `READONLY_BASH`，识别不了就拒绝（不弹审批）。

### §7.3 工具形态

```ts
interface TaskInput {
  prompt: string;
  agent?: string; // 缺省 general；描述里列出 name: description（总预算 400 token，超出只列名）
  description?: string;
  background?: boolean; // 缺省取类型的 background
  taskId?: string; // 续聊：向已有子会话追加消息，忽略 agent / tools / model
  isolation?: "none" | "worktree";
  budgetUsd?: number; // 外部 Agent
  // 保留但描述里不展开：tools, model, thinkingLevel, maxTurns
}
// task_ctl
interface TaskCtlInput {
  action: "list" | "wait" | "stop" | "output";
  taskId?: string;
  timeoutMs?: number;
}
```

- `task` 的 `executionMode` 改 `parallel`（同轮多个 task 真并行，池限流；与 `edit` 同批仍串行，合理）。
- 预设：`task_ctl` 与 `task` 同进退（`default` 下只在 codemode 脚本里；`+task` 一起暴露）。
- 首次以某外部 Agent 运行时走一次 `execute` 类审批，说明「将以你在 X 的现有登录运行，模式 Y」；allow 规则 `task(claude)` 可放行。

### §7.4 前台 / 后台、结果、生命周期

- 前台：同现状；结果 = 最终报告，> 50 KB 保留头 70% + 尾 30% 并全文写 `outputs/<taskId>.md`；`maxTurns` 耗尽时最后一轮 `toolChoice:"none"` 要报告，结果前加「轮数耗尽，以下为最后输出」。
- 后台：立即返回 `{ taskId, status: "running", outputFile }`；完成后向父 followUp 队列放一条 user 消息：

  ```text
  <task-notification taskId="t3" agent="explore" status="completed" turns="7" tokens="12.3k">
  …最终报告（≤ 50 KB）…
  </task-notification>
  ```

  父空闲时触发新回合；父正忙则在下一回合边界投递（不打断）。系统提示 `rules` 节加一句「task-notification 不是用户发言」（会话开始即固定，不改前缀）。后台子 Agent 的审批照常弹给父界面；`-p` 下 ask 视同拒绝。

- 注册表（`src/agent/subagent-registry.ts`）：子会话结束后不立即 `dispose`，保留 16 个（LRU 释放内存，JSONL 永在）；父 resume 时从 `custom{ama.task}` 重建（未完成标 `interrupted`，`taskId` 续聊可接上）。
- `isolation: worktree`：`git worktree add -b ama/task-<taskId> <repo>/.ama/worktrees/<taskId>`；子会话 cwd 指向它；结束时无改动 `git worktree remove`，有改动保留并在结果里给分支名与 `git diff --stat`；非 git 目录直接报错，不回落共享目录；`.ama/worktrees/` 加进内置 ignore；文档写明「worktree 不保证可运行（依赖不共享）」。
- 深度 ≤ 1；`SubagentPool` 4 + `maxPending` 16（超出报错「不要重试」）。

### §7.5 事件与界面

| 事件              | 字段                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent_start`  | `taskId, parentToolCallId, agent, runner, description, background, model?, sessionFile?, cwd`                                                      |
| `subagent_update` | `taskId, kind: "tool" \| "text" \| "turn", toolName?, textDelta?（节流 ≥ 250 ms）, turn, usage`                                                    |
| `subagent_end`    | `taskId, status: "completed" \| "failed" \| "aborted" \| "max_turns" \| "interrupted", usage, cache?, outputFile?, worktree?: { branch, changed }` |

外部 runner 发同一组事件（`runner: "claude"`），usage 字段按单位。TUI（W5-U）：工具行折叠显示 `agent · 状态 · 轮数 · 最近 3 个工具 · ↑↓`；`/tasks` 列后台任务（状态、耗时、费用），回车展开最终文本；`/agents` 列类型与来源；审批对话框标 `[task:<agent>]`。RPC：`get_tasks` → 注册表快照；`get_agents` → 类型列表。

### §7.6 与外部 Agent 的统一

```ts
// src/tools/types.ts [C0]
export interface SubagentRunner {
  readonly id: string; // "ama" | "claude" | "codex" | "acp:<program>" | 宿主 id
  start(req: {
    prompt: string;
    cwd: string;
    mode: PermissionMode;
    model?: string;
    resume?: string;
    budgetUsd?: number;
    signal: AbortSignal;
    onEvent(e: SubagentEvent): void;
  }): Promise<RunnerHandle>;
}
export interface RunnerHandle {
  readonly id: string; // 子会话 / 外部会话 id
  send(text: string): Promise<void>; // 续聊
  wait(): Promise<SubagentResult>;
  stop(): Promise<void>;
}
```

- `AmaRunner`（现 `runSubagent`）、`ProcessRunner`（`drivers/runner.ts`，W5-E）、宿主 runner（§5.5）。`runner` 非 ama 时 `tools / permission-mode` 字段忽略并 warning，`isolation` 仍有效（ama 建好 worktree 再传 cwd）。
- 结果统一 `SubagentResult`（文本、usage 可缺、`sessionRef`、`status`）；外部会话引用写 `custom{ama.agent-session}`（§5.1 store）。

### §7.7 测试

定义文件解析（frontmatter 复用、字段校验、未信任跳过、同名覆盖）；只读类型调 write 被拒、bash 非只读被拒不弹审批；同轮 3 个 task 真并行且 ≤ 4；结果截断与 `outputs/` 落盘；maxTurns 收尾报告；`cache-stability` 证明子会话首请求 tools + system 指纹与父相同；后台两个 explore → 通知按完成顺序到达、父中途对话不受阻；`taskId` 续聊复用同一 JSONL；resume 重建注册表；worktree（有 git 才跑）无改动自动删、有改动保留；`subagent_*` 事件 RPC 黄金记录。

## §8 Agent Harness 与自动压缩

### §8.1 目标形态

```text
工具结果产生 → 档 0 截断（头 70% + 尾 30%，全文落盘）                                   ← 不影响缓存
每次请求前（prepareNextTurn / 新提示前）
  ├─ 档一 遮蔽：候选 = 除最近 keepToolResults 个、最近 protectTokens 的工具输出、保护集之外的旧大结果
  │    触发 = (tokens > 0.7×budget 且 可省 ≥ clearAtLeast) 或 (缓存已冷 且 可省 ≥ clearAtLeast)
  │    一次清到 0.5×budget 以下；image_budget 在同一处处理（§4）
  ├─ 档二 摘要（续写保缓存，现状）→ 自检（tokensAfter < tokensBefore，必需节齐全）→ 失败回落独立请求
  │    熔断：连续失败 3 次 / 快速回填（连续 3 次在 < 3 回合内重新超阈值）/ 固定前缀已超阈值 → 告警不再试
  └─ 压缩后回注 custom_message{ama.post_compact}（紧跟摘要）：todo 快照 · 最近修改 / 读取文件路径 · 已加载 Skill 名与路径 · 当前计划 · 转录与 outputs 路径 · 续接说明
```

### §8.2 改动清单

| #   | 改动                                                                                                                                                                                                         | 位置                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| C1  | 档一边界按工具结果新旧：保留最近 `keepToolResults` 个与最近 `protectTokens` 内的工具输出；去掉「两个 user 回合」条件                                                                                         | `src/compaction/prune-tier.ts`                                    |
| C2  | `planPrune` 返回 `savedTokens`；可省 < `clearAtLeast` 不动；一次清到 `targetRatio`                                                                                                                           | `prune-tier.ts`、`src/agent/session-compaction.ts`                |
| C3  | `SessionCacheController.isCold()`（`now − lastRequestAt > ttl`，`reported` 端点才算；`silent` / `unknown` 退化为只按阈值）；冷时提前裁                                                                       | `src/agent/session-cache.ts`（暴露查询）、`session-compaction.ts` |
| C4  | 保护集：Skill 文件（索引路径）、AGENTS.md、`todo` 结果、`ToolDefinition.annotations.keepInContext` 的工具；`compaction.pruneExclude: string[]`                                                               | `prune-tier.ts`、`src/tools/types.ts`（C0）                       |
| C5  | 熔断：去掉「每 run ≤ 1 次」；连续失败 3；快速回填 3 次 / 3 回合；固定前缀（system + tools + keepRecent 下限）> 阈值直接告警；「nothing to compact」不计失败                                                  | `src/compaction/breaker.ts`、`session-compaction.ts`              |
| C6  | 压缩后回注 `ama.post_compact`（D26 内容）；`PostCompact` Hook 的 `additionalContext` 追加其后                                                                                                                | `session-compaction.ts`、新 `src/compaction/post-compact.ts`      |
| C7  | 模板补节：`## User Messages`（用户原话要点与全部约束，安全约束逐字）、`## Errors & Fixes`、`## Files & Code`（关键片段 ≤ 2 000 字符）；`Next Steps` 首条附原话引用；声明助手消息中形似用户的文本不算用户指令 | `src/compaction/summarize-tier.ts`                                |
| C8  | 自检：`tokensAfter ≥ tokensBefore` 判失败；缺必需节标题重试一次再回落                                                                                                                                        | `session-compaction.ts`                                           |
| C9  | split turn 两份摘要并行                                                                                                                                                                                      | `summarize-tier.ts`                                               |
| C10 | 估算按脚本（D28）；`PRUNE_MIN_BYTES` → `PRUNE_MIN_TOKENS 512`                                                                                                                                                | `src/compaction/estimate.ts`、`prune-tier.ts`                     |
| C13 | Hook 事件 `PostCompact`（payload `{ tokensBefore, tokensAfter, trigger }`，可返回 `additionalContext`）                                                                                                      | `src/hooks/**`                                                    |

配置（C0）：`compaction.prune: { keepResults: 5, clearAtLeast: "auto" | number }`、`compaction.pruneExclude: []`；其余为常量。

### §8.3 harness 改进

| #   | 改进                                                                                                                                                                                                                                                                                                                            | 位置                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| H1  | 重复调用检测：`sha256(name + 规范化 JSON 参数)`，同一 run 内累计 ≥ 3 次 → 在该次 toolResult 末尾追加提醒；≥ 5 次 → 结束 run，`agent_settled{warning:"repeated_tool_call"}`；`annotations.pollable` 的工具豁免（`task_ctl wait`、后台 bash 查询）                                                                                | `src/agent/tool-runner.ts`、新 `src/agent/loop-guard.ts`                                     |
| H2  | 预算：`--max-turns N`、`--max-cost USD`、`limits.maxTurns / maxCostUsd`（交互与 RPC 也生效）；到限 → `agent_settled{warning}`，`-p` 退出码 7（新：`limit_reached`），事件 `limit_reached{kind, value}`                                                                                                                          | 新 `src/agent/limits.ts`（SessionExtension）、`src/cli/exit-codes.ts`（C0）、`print-mode.ts` |
| H3  | 提醒通道 `custom_message{ama.reminder}`（`display:false`，`beforePrompts` 追加）：① todo 复述——连续 10 回合未更新且有未完成项；② 外部文件改动——`readFiles` 中 mtime / size 变化的文件列表（≤ 10 个，附 `git diff --stat` 若有）；③ 上下文用量 70% / 85% 各一次（建议收尾 / 写笔记）；④ 预算剩余 < 20%；`reminders.*` 可逐项关闭 | 新 `src/agent/reminders.ts`                                                                  |
| H4  | `todo` 进 default 预设（D20）；`todo` 加 `action:"update"`、`planStep`；结果受 C4 保护                                                                                                                                                                                                                                          | `src/tools/presets.ts`（C0）、`src/tools/todo.ts`（W5-F 拥有）                               |
| H5  | 通用截断头 + 尾：`truncateResult` 保留前 70% / 后 30%，中间 `[… N 字符已省略，全文 path]`；`bash` 仍尾截断、`read` 仍头截断                                                                                                                                                                                                     | `src/tools/truncate.ts`、`tool-runner.ts`                                                    |
| H6  | 后台 bash：`bash{ command, background: true }` → `{ jobId, outputPath, pid }` 立即返回；`bash{ job: jobId, action: "wait" \| "stop" \| "output" }`；完成时经 H3 通道通知「后台命令 jobId 已退出（码 N）」；进程树随会话 dispose 回收；`annotations.pollable` 覆盖 `wait`/`output`                                               | `src/tools/bash.ts`、新 `src/tools/background-jobs.ts`                                       |
| H7  | 模型回退：`fallbackModel`（`provider/model[@channel]`）；可重试错误用尽或 `overloaded` 时切到它重试一次本请求，事件 `model_fallback{from, to, reason}`，思考块按跨模型规则降级（`transform.ts` 已有），状态栏显示 `→ fallback`；成功后下一回合仍回主模型                                                                        | `src/agent/session-run.ts`、`retry.ts`                                                       |

缓存：H1–H7 全部只追加尾部消息或改工具结果写入时的形状，不碰 system / tools 前缀；H7 换模型必然冷缓存，归因 `model_changed`。

### §8.4 验证

- 单测：单 user 消息 + 50 次工具调用触发档一；可省不足不裁；冷时提前裁；保护集；回差连续回合不重复裁；快速回填熔断；回注条目紧跟摘要；自检失败；CJK 估算；loop guard 3 / 5 阈值与豁免；limits 三入口；提醒四类各一次且可关；头尾截断；后台 bash 三动作与通知；fallback 一次与归因。
- 缓存实验（`scripts/cache-experiment.mjs` 新 case E6）：同一长任务跑「现状」「C1+C2」「C1+C2+C3」，比较 cacheRead 占比、重写 token、费用、压缩次数，报告 `docs/benchmarks/cache-<date>.md`。
- 质量探针（新 `scripts/compaction-probe.mjs`，本地）：每次压缩后问 4 类问题（召回、产物路径、下一步、决策理由），统计压缩后 10 回合内重复读同一文件的次数。
- 预设基准：`bench-presets` 加 `default+todo` 对照组，判定 D20 的门。

## §9 契约变更清单（[W5-C0]，一个前置 PR）

| 文件                                                 | 变更                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ai/types.ts`                                    | `Model.family? / knowledge? / releaseDate? / inputLimit? / status?`；`ProviderData.channels? / defaultChannel?`；`AnthropicMessagesCompat.sendInterleavedThinkingBeta? / sendCacheControl?`；`OpenAIResponsesCompat.explicitCacheField?`                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/agent/types.ts`                                 | `SessionEvent` 加 `telemetry_tick`、`subagent_start/update/end`、`plan_proposed/resolved`、`todo_updated`、`limit_reached`、`model_fallback`、`background_job`；`SessionStats.telemetry? / external? / tasks?`；`AgentSessionOptions.extensions?: SessionExtension[]`、`limits?`、`fallbackModel?`                                                                                                                                                                                                                                                                                                                           |
| `src/agent/session-extensions.ts`（新）              | `SessionExtension` 接口与 `runExtensions` 辅助（§10.1）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/agent/session.ts` → `session-settings.ts`（新） | 把 `setModel / setThinkingLevel / setPermissionMode / setActiveTools / addTool / updateSystem / announceStart / getTools` 移出（纯搬迁 + 扩展点调用 ≤ 20 行）                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/cli/compose-extensions.ts`（新）                | 扩展组装表（空表 + 注释；各批次只追加一行）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/session/types.ts`                               | `ContextEditReason` 加 `"image_budget"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/tools/types.ts`                                 | `ToolDefinition.annotations.pollable? / keepInContext?`；`SubagentRequest.agent? / background? / taskId? / isolation? / budgetUsd?`；`SubagentResult.taskId / status / outputFile? / sessionRef?`；`SubagentRunner / RunnerHandle / SubagentEvent`；`ToolContext.tasks?`（注册表只读视图）                                                                                                                                                                                                                                                                                                                                   |
| `src/permissions/types.ts`                           | `ApprovalRequestContext.taskId? / origin?`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/host/types.ts`                                  | `HostApi.runners?`（可选面）；`AgentEvents` 加 `subagent_start/end`、`plan_proposed/resolved`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/hooks/types.ts`                                 | `PostCompact`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/drivers/types.ts`、`src/agents/types.ts`（新）  | §5.2 驱动类型；`AgentDefinition`（§7.1 字段的 TS 形状）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/config/{types,schema,json-schema,key-docs}.ts`  | 新键：`ui.statusLine`；`images.resize`；`plan.{bash,directory,unattended,model,thinkingLevel}`；`agents.{maxConcurrent,sessionBudgetUsd,dirs,<id>.{maxConcurrent,maxMode,model,env.passthrough}}`；`subagents.{maxConcurrent,maxPending,defaultModel}`；`models.aliases.{fast,strong}`；`fallbackModel`；`compaction.prune.{keepResults,clearAtLeast}`、`compaction.pruneExclude`；`limits.{maxTurns,maxCostUsd}`；`reminders.{todo,fileChanges,contextPressure,budget}`；`todo.reminder`。`schema.ts` 已 574 行 → 新键校验放 `schema-w5.ts`。项目级允许：`plan.bash` 只能更严、`reminders`、`ui.statusLine`；其余只认用户级 |
| `src/rpc.ts`                                         | 命令 `plan_response / get_plan / get_todos / get_tasks / get_agents`；能力 `plans`；事件由 `SessionEvent` 派生自动包含                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/cli/args.ts`、`src/cli/exit-codes.ts`           | `--mode acp`、`--max-turns`、`--max-cost`、`--agent-dir`；退出码 7 `limit_reached`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/tools/presets.ts`                               | `default` 加 `todo`；`task_ctl` 随 `task`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `package.json`、`src/acp.ts`（新）                   | `exports["./acp"]`（先导出类型与分帧）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `docs/reference/session-format.md`                   | custom 表登记 `ama.plan*`、`ama.post_compact`、`ama.reminder`、`ama.agent-session`、`ama.agent-usage`；`context_edit.reason` 加 `image_budget`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

全部为可选字段 / 新命令；`RPC_PROTOCOL_VERSION`、`HOST_API_VERSION`、`SESSION_FORMAT_VERSION` 不变（`release-check` 不要求升主版本）。

## §10 关键接口

### §10.1 会话扩展点

```ts
// src/agent/session-extensions.ts [C0]
export interface SessionExtensionContext {
  readonly core: SessionCore; // appendEntry / reloadMessages / emit / manager / model() / cache
  readonly config: AmaConfig;
}
export interface SessionExtension {
  readonly id: string;
  /** 新回合 prompts 投递前；返回要**追加在 prompts 之后**的消息（只能 custom_message；不得改已有消息）。 */
  beforePrompts?(
    ctx: SessionExtensionContext,
    prompts: readonly AgentMessage[],
  ): Promise<AgentMessage[]> | AgentMessage[];
  wrapStream?(stream: StreamFn): StreamFn;
  onEvent?(event: SessionEvent): void;
  onAgentSettled?(ctx: SessionExtensionContext): Promise<void> | void;
  contributeStats?(stats: SessionStats): void;
  dispose?(): void;
}
// src/cli/compose-extensions.ts [C0；各批次各加一行]
export function composeExtensions(deps: ComposeExtensionDeps): SessionExtension[] {
  return [
    // [W5-A] createTelemetryExtension(...)
    // [W5-I] createImageBudgetExtension(...)
    // [W5-F] createPlanExtension(...)
    // [W5-H2] createRemindersExtension(...), createLimitsExtension(...)
  ];
}
```

`session.ts` 的调用点：`runPrompt` 组装 prompts 后依次调 `beforePrompts`（顺序 = 表顺序，plan 模式说明在提醒之前）；`stream` 构造时按表顺序 `wrapStream`（缓存控制器最外层，保证它看到的是最终请求）；`emit` 后广播 `onEvent`；`agent_settled` 后 `onAgentSettled`；`getStats` 末尾 `contributeStats`。

### §10.2 其它签名

```ts
// src/git/info.ts [W5-A]                    见 §1.3
// src/agent/session-telemetry.ts [W5-A]    export function createTelemetryExtension(deps: { now?(): number }): SessionExtension & { snapshot(): SessionTelemetry };
// scripts/update-models-dev.mjs [W5-M1]    CLI：--url --out --dry-run；退出码 0 无变化 / 0 有变化 / 1 失败 / 3 删除超阈值
// src/ai/providers/models-dev-cache.ts [W5-M1]
export function loadModelsDevIndex(dataDir: string): ModelsDevIndex; // 快照 ⊕ 覆盖；零网络
export async function refreshModelsDev(opts: {
  dataDir;
  env;
  providers?: string[];
}): Promise<RefreshResult>; // 只被 `ama models refresh` 调用
// src/ai/apis/anthropic-compat.ts [W5-M2]  export function detectAnthropicCompat(model: Model, provider: ProviderData): AnthropicMessagesCompat;
// src/ai/image-limits.ts [W5-I]            export function imageLimits(model: Model, api: Api): { perImageBase64: number; perRequestBase64: number };
// src/compaction/image-budget.ts [W5-I]    export function planImageBudget(items: readonly ContextItem[], budgetBytes: number): { targetId: string; replacement: string }[];
// src/tools/clipboard-image.ts [W5-I]      export async function pasteClipboardImage(dataDir: string, deps?: { platform?; spawn? }): Promise<string | undefined>;
// src/drivers/env.ts [W5-E]                export function buildChildEnv(env: NodeJS.ProcessEnv, agentId: string, config: AgentsConfig | undefined): NodeJS.ProcessEnv;
// src/drivers/runner.ts [W5-E]             export function createProcessRunner(driver: AgentDriver, deps: { brokers; pool; store }): SubagentRunner;
// src/plan/extract.ts [W5-F]               export function extractProposedPlan(markdown: string): { markdown: string; steps: PlanStep[] } | undefined;
// src/permissions/readonly-bash.ts [W5-F]  export function isReadonlyBash(command: string): boolean;
// src/agents/discover.ts [W5-G]            export function discoverAgents(dirs: AgentDirSources, options: { trusted: boolean }): { agents: AgentDefinition[]; warnings: string[]; skippedUntrusted: string[] };
// src/agent/subagent-registry.ts [W5-G]    export class SubagentRegistry { start(req): TaskHandle; get(taskId); list(); rebuild(entries); }
// src/agent/loop-guard.ts [W5-H2]          export class LoopGuard { observe(call: ToolCallBlock, tool: ToolDefinition): "ok" | "remind" | "stop"; }
// src/agent/reminders.ts [W5-H2]           export function createRemindersExtension(settings: RemindersConfig): SessionExtension;
// src/tools/background-jobs.ts [W5-H2]     export class BackgroundJobs { start(cmd, opts): Job; wait(id, timeoutMs); stop(id); output(id); disposeAll(); }
```

## §11 批次与文件所有权

| 批次                     | 内容                                                                                                                                                                                       | 独占文件（到文件）                                                                                                                                                                                                                                                                                                                                                                                                    | 依赖                                     | 验收                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W5-C0** 契约与扩展点   | §9 全部；`session.ts` 拆分；扩展点与组装表；config 键校验与 key-docs；RPC 类型；CLI 参数解析（只解析，不实现）                                                                             | §9 列出的文件 + `src/agent/session-settings.ts`、`src/config/schema-w5.ts`                                                                                                                                                                                                                                                                                                                                            | RW-B 已合入（✓）                         | `pnpm run ci` 绿；`cache-stability.test.ts` 不变；`session.ts` ≤ 560 行；json-schema 一致性测试绿                                                                                           |
| **W5-M1** 模型元数据入库 | §2：快照、脚本、Action、目录继承与冗余检查、`ama models refresh`、`THIRD_PARTY_NOTICES.md`                                                                                                 | `src/ai/providers/{models-dev,models-dev-cache,models-dev-data,catalog,catalog-data,enrich}.ts`、`src/ai/providers/models-dev/**`、`src/ai/providers/catalog/*.json`（现有 13 份改为覆盖格式）、`scripts/update-models-dev.mjs`、`scripts/lib/inline-json.mjs`、`.github/workflows/models-dev.yml`、`THIRD_PARTY_NOTICES.md`、`src/cli/subcommands/{models,providers}.ts`、`docs/guides/providers.md`「模型元数据」节 | C0                                       | 启动零网络（fake fetch 断言）；快照 ⊕ 覆盖；目录冗余检查；脚本字节稳定；bundle 增量 ≤ 200 KB；Action 在 fork 上 `workflow_dispatch` 跑通一次（用户操作）                                    |
| **W5-M2** 渠道与协议     | §3：内置渠道、缺省渠道表、新增四家、Anthropic 主机 compat、缓存能力表、`channel-probe`                                                                                                     | `src/ai/providers/{builtin,registry,channels}.ts`、`src/ai/apis/{anthropic-request,anthropic-compat,cache-params,openai-compat,openai-responses-request}.ts`、`src/cli/compose-providers.ts`、`scripts/channel-probe.mjs`、新增 `catalog/{minimax,stepfun,volcengine,tencent}.json`（M1 合入后按新格式加）、`docs/guides/providers.md`「内置供应商」「渠道实测」节                                                    | C0；目录文件部分依赖 M1                  | 渠道物化真值表；compat 主机表 + 请求快照；`fake/echo@messages` 跑通 probe；实测门结果表（用户提供 key 后补）                                                                                |
| **W5-I** 图像            | §4 底层：大小 / 尺寸 / 预算 / 剪贴板 / 缩放 / `-p --image`                                                                                                                                 | `src/tools/{image-file,read,clipboard-image,image-resize}.ts`、`src/modes/image-input.ts`、新 `src/ai/image-limits.ts`、`src/compaction/image-budget.ts`、`src/agent/session-images.ts`、`src/cli/subcommands/sessions.ts`（clipboard gc 一行）、`compose-extensions.ts` 一行                                                                                                                                         | C0                                       | 真值表与预算单测；fake 端到端 `context_edit{image_budget}`；各平台剪贴板分支（fake spawn）                                                                                                  |
| **W5-E** Agent 驱动      | §5：`drivers/**`、ACP 客户端 / 服务端、Claude / Codex 原生、oneshot、环境清理、池、看门狗、store、`ProcessRunner`、`--mode acp` 入口、`@armadra/agent/acp`                                 | `src/drivers/**`、`src/modes/acp/**`、`src/acp.ts`、`src/cli/{main,bootstrap}.ts`（acp 分派）、`test/fixtures/{acp,drivers}/**`、`docs/guides/agents.md`（新，外部 Agent 部分）、`docs/reference/acp.md`（新）                                                                                                                                                                                                        | C0                                       | 假 ACP Agent 黄金记录（三路径 + cancelled）；`ama --mode acp` 黄金记录；ama 驱动 ama 端到端（fake 供应商）；录制回放的 Claude / Codex 驱动用例；环境清理真值表；本地真实 CLI 用例（用户跑） |
| **W5-G** 子 Agent        | §7：定义文件、内置类型、`task` 新参数与并行、`task_ctl`、结果上限、工具表对齐、后台 + 通知、注册表、续聊、worktree、事件                                                                   | `src/agents/**`（除 types.ts）、`src/tools/{task,task-ctl}.ts`、`src/agent/{session-subagent,subagent-registry,worktree}.ts`、`src/agent/system-prompt.ts`（rules 一句 + 角色追加）、`src/cli/compose-agents.ts`（新：发现与注册）、`docs/guides/agents.md`（子 Agent 部分）                                                                                                                                          | C0；`ProcessRunner` 来自 E（开发期用桩） | §7.7 全部；`cache-stability` 子会话首请求指纹相同；RPC 黄金记录 `subagent.out.jsonl`                                                                                                        |
| **W5-F** Plan            | §6：提醒注入、只读 bash、管线细化、提取 / 落盘 / 审批编排、交接、`todo` 改动、`plan_state`、RPC 命令、SDK                                                                                  | `src/plan/**`、`src/agent/session-plan.ts`、`src/permissions/{pipeline,readonly-bash,modes}.ts`、`src/tools/todo.ts`、`src/modes/rpc/commands.ts`（本波全部新命令，`get_tasks / get_agents` 用 C0 的只读视图接口）、`src/sdk.ts`、`compose-extensions.ts` 一行、`docs/guides/permissions.md`、`docs/reference/rpc.md`（新增节）、`docs/guides/plan.md`（新）                                                          | C0                                       | §6.6 全部；RPC 黄金记录 `plan.out.jsonl`                                                                                                                                                    |
| **W5-H1** 压缩           | §8.2 C1–C10、C13                                                                                                                                                                           | `src/compaction/**`（除 image-budget.ts）、`src/agent/session-compaction.ts`、`src/agent/session-cache.ts`（`isCold()`）、`src/hooks/**`、`docs/guides/hooks.md`、`docs/design/design.md` §9 表修订                                                                                                                                                                                                                   | C0                                       | §8.4 单测；缓存实验 E6 报告                                                                                                                                                                 |
| **W5-H2** harness        | §8.3 H1–H3、H5–H7（H4 的预设在 C0、todo 在 F）                                                                                                                                             | `src/agent/{loop,tool-runner,session-run,retry,loop-guard,limits,reminders}.ts`、`src/tools/{bash,truncate,background-jobs}.ts`、`src/modes/print/print-mode.ts`（退出码 7）、`src/cli/compose-session.ts`、`compose-extensions.ts` 两行、`scripts/bench-presets.mjs`（`default+todo` 组）、`docs/benchmarks/presets-<date>.md`                                                                                       | C0；与 H1 文件不重叠可并行               | §8.4 单测；`bench-presets` 报告给出 D20 结论                                                                                                                                                |
| **W5-A** 状态行          | §1 全部（不含 `Ctrl+V`）                                                                                                                                                                   | `src/agent/session-telemetry.ts`、`src/git/**`、`src/modes/interactive/{status-bar,status-line,interactive-mode,key-dispatch}.ts`、`src/tui/keybindings.ts`、`src/modes/commands-core.ts`（`/statusline`）、`compose-extensions.ts` 一行、`test/fixtures/tui/status-*.txt`、`docs/guides/tui.md`「状态栏」、`docs/design/tui-design.md` §3.10                                                                         | C0；**RW-C 合入**                        | §1.4；tmux 手测 `full` / `compact` 与 `Ctrl+G`；40 列不抖动                                                                                                                                 |
| **W5-U** 界面集成        | plan 审批对话框与 `/plan`；`/tasks`、`/agents`、子 Agent 折叠视图与 `[task:<agent>]` / `[claude · 会话]` 标注；`Ctrl+V` / `/paste`；外部 Agent 提问事件显示；`/session` 新段               | `src/modes/interactive/**`（A 合入后）、`src/modes/commands-core.ts`、`src/modes/session-report.ts`、`src/modes/interactive/line/**`、`docs/guides/tui.md` 其余节                                                                                                                                                                                                                                                     | A、F、G、I、E 合入                       | 帧黄金：审批框（四选项、外部编辑）、`/tasks`、`/agents`、折叠视图、line 模式 `/plan approve`；`Ctrl+V` 在 macOS 手测                                                                        |
| **W5-Z** 文档与发布      | README（文档表、`ama models refresh`、子 Agent / Plan / 外部 Agent 三节）、`docs/design/design.md` 增补、CHANGELOG、e2e（acp / plan / subagent 的 bundle 级）、CI 加 `models-dev.yml` 校验 | `README.md`、`CHANGELOG.md`、`docs/design/design.md`、`test/e2e/**`、`.github/workflows/ci.yml`                                                                                                                                                                                                                                                                                                                       | 全部合入后                               | `pnpm run ci` 与 `AMA_E2E=1 pnpm test:e2e` 三平台绿                                                                                                                                         |

冲突回避：`compose-extensions.ts` 是唯一允许多批次各加一行的文件（rebase 时自然合并）；`docs/reference/rpc.md` / `docs/reference/session-format.md` 各批次只改自己的节；`src/agent/session.ts` 本波除 C0 外无人改（扩展点足够，不够先回到 C0 所有者）；`src/modes/interactive/**` 与 `commands-core.ts` 在 RW-C → A → U 之间串行；`src/tools/todo.ts` 归 F（H4 的 todo 改动由 F 做）；`src/cli/subcommands/sessions.ts` 的 clipboard gc 归 I（RW 的 GC 已合入）。

### §11.1 并行分组与合入顺序

```text
G0  C0 契约（1 代理，1 天）—— 前提：main 含 RW-B（✓）；不碰 RW-C / RW-D 的文件
G1  并行 6：M1 ｜ E ｜ G ｜ F ｜ H1 ｜ I
G2  并行 4：M2（M1 合入后加目录文件）｜ H2 ｜ A（RW-C 合入后）｜ E/G 的联调（ProcessRunner 接 task）
G3  串行：U（A、F、G、I、E 合入后）→ Z
```

- 每批次细粒度提交、一个 PR、CI 绿后由主会话合并（merge commit，不 squash）；不发版，Z 之后再定 0.5.0。
- 真实 key / 真实 CLI 的验证全部在本地，CI 永不设置这些变量（`PACKY_API_KEY`、`AMA_E2E_AGENTS`、`AMA_REAL_*`）。

### §11.2 提交序列（每条 = 模块 + 测试）

- **C0**：① `feat(contracts): 第五波类型——Model 元数据字段、内置渠道、Anthropic compat 开关、ContextEditReason image_budget`；② `feat(contracts): SessionEvent 子 Agent / 计划 / 预算 / 遥测事件与 SessionStats 扩展`；③ `refactor(agent): session.ts 设置类方法移到 session-settings.ts，新增 SessionExtension 扩展点与组装表`；④ `feat(contracts): SubagentRunner / AgentDriver / AgentDefinition 类型、ApprovalRequestContext.origin、HostApi.runners`；⑤ `feat(config): 第五波配置键与校验（schema-w5）、key-docs、json-schema`；⑥ `feat(rpc): 计划 / 任务命令类型与 plans 能力`；⑦ `feat(cli): --mode acp、--max-turns、--max-cost、--agent-dir 解析与退出码 7`；⑧ `feat(tools): default 预设加 todo，task_ctl 随 task`；⑨ `docs: session-format 登记第五波 custom 类型`。
- **M1**：① 脚本与 fixture；② 快照入库 + data.ts + NOTICES；③ `trimModel` 字段扩展；④ 快照 ⊕ 覆盖的加载；⑤ `ama models refresh`；⑥ 目录覆盖格式与冗余检查（13 份目录逐家一提交）；⑦ Action；⑧ 文档。
- **M2**：① 内置渠道物化；② `anthropic-compat`；③ 缓存能力表；④ OpenAI / xAI 缺省 responses 与目录去覆盖；⑤ 四家新供应商（每家一提交）；⑥ `channel-probe`；⑦ 文档。
- **I**：① base64 与分档；② 尺寸与缩放；③ 预算纯函数 + 扩展；④ 剪贴板；⑤ gc 与文档。
- **E**：① ACP 类型与分帧 + fake agent；② `AcpClient` + `AcpDriver`；③ `ama --mode acp`；④ env / pool / store；⑤ `claude-stream`；⑥ `codex-app-server` + schema 黄金；⑦ `oneshot`；⑧ `ProcessRunner`；⑨ 文档。
- **G**：① 定义文件发现与解析；② 内置类型与系统提示追加；③ `task` 参数、并行、结果上限、工具表对齐；④ 注册表与续聊；⑤ 后台与通知；⑥ `task_ctl`；⑦ worktree；⑧ 事件与 RPC 黄金；⑨ 文档。
- **F**：① `readonly-bash` + 管线细化 + allowlist 同步；② 提醒注入与 `plan_state`；③ 提取与落盘；④ 审批编排与交接；⑤ `todo update / planStep`；⑥ RPC / SDK；⑦ 分模型；⑧ 文档。
- **H1**：① C10 估算；② C1 + C2；③ C3；④ C4；⑤ C5；⑥ C7 + C8 + C9；⑦ C6 + C13；⑧ 缓存实验与报告。
- **H2**：① 头尾截断；② loop guard；③ limits；④ 提醒通道；⑤ 后台 bash；⑥ fallback；⑦ bench-presets 对照组与报告。
- **A**：① 遥测扩展；② git info；③ 速率行组件与帧黄金；④ 状态行 git / 时长；⑤ 折叠开关与命令；⑥ 文档。
- **U**、**Z**：按界面 / 文档各一提交。

## §12 与进行中批次的关系

| 进行中         | 文件                                                                           | 本波处理                                                                              |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| RW-C 交互界面  | `src/modes/interactive/**`、`src/modes/commands-core.ts`、`docs/guides/tui.md` | G1 不碰；W5-A 在 RW-C 合入后开始并 rebase；W5-U 在 A 之后                             |
| RW-D 影子 git  | `src/checkpoints/shadow-git.ts` 及其测试                                       | 无重叠；W5-A 只 import `checkpoints/git-head.ts`（已合入），不改它                    |
| RW-B（已合入） | `session-rewind.ts`、RPC 回滚命令、`PostRewind`                                | C0 的 `session.ts` 拆分不动 rewind 相关行；`PostCompact` 与 `PostRewind` 同一模式追加 |

## §13 风险与待定项

| #    | 风险 / 待定                                                                                                                 | 处置                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| R1   | `session.ts` 拆分与扩展点改动会话核心，回归面大                                                                             | C0 只做纯搬迁 + 调用点；现有 `session*.test.ts`、`cache-stability` 全部不改断言；C0 单独评审                                     |
| R2   | 缺省渠道切到 messages 后第三方端点细节差异（beta 头被拒、`tool_use.id` 复用、usage 位置）                                   | 实测门（§3.2）；400 自动剥离已有；compat 主机表保守缺省；切换是数据改动可快速回退                                                |
| R3   | Claude stream-json 控制协议非公开接口，Codex app-server 标 experimental                                                     | 按 `system/init.capabilities` 特性检测；catalog 记已验证版本区间；越界降级到 ACP 适配器或 oneshot（只读）；schema 黄金文件锁形状 |
| R4   | 外部 Agent 的输出带提示注入回到协调者                                                                                       | 结果作为工具结果按资料处理；摘要限长；不读对方转录                                                                               |
| R5   | 档一在长任务里真正生效后打断缓存                                                                                            | C2 门槛 + 回差与 C3 冷时优先同批交付；E6 实验验收，若费用上升回调 `clearAtLeast`                                                 |
| R6   | todo 进 default 预设的前缀成本                                                                                              | D20 的基准门；不过门退回 `[DONE:n]` 文本交接                                                                                     |
| R7   | 速率行每 500 ms 刷新带来的闪烁 / tmux 流量                                                                                  | 只重绘一行；`ui.animation:false` 关闭；嵌入缺省 `compact`                                                                        |
| R8   | `git diff --numstat` 在大仓库上慢                                                                                           | 2 s 超时后本会话停用；≥ 10 s 一次；`AMA_STATUS_GIT=0`                                                                            |
| R9   | 后台子 Agent 的审批弹窗打断用户与父的对话                                                                                   | 对话框标 `[task:<agent>]`；`-p` 下视同拒绝；explore / plan 类型不会弹（只读）                                                    |
| R10  | 两个 general 子 Agent 并行改同一文件                                                                                        | 工具描述写明并行写请用 `isolation: worktree`；`file-mutex` 保证单次写原子                                                        |
| R11  | 计划块识别不稳（弱模型不输出标签）                                                                                          | 只认规范块；`/plan approve` 的「把上一条回复当作计划」；被拒消息自带指引                                                         |
| R12  | models.dev 数据质量（`output == context`、转售价不同、偶发错误值）                                                          | `MODELS_DEV_MAX_OUTPUT` 封顶已有；匹配优先原厂；PR 摘要人工审                                                                    |
| R13  | ACP v2 计划取消 `session/load`                                                                                              | 优先 `resume`，`load` 只作回退                                                                                                   |
| 待定 | `.claude/agents` 兼容读取；Hook `PlanProposed`；fork 模式子 Agent；C11 预计算；C12 供应商原生压缩；提醒通道是否允许宿主注入 | 本波不做；Z 之前在本文附记决定                                                                                                   |

## §14 需要用户做的事

1. **Action token**：在仓库 secrets 加 `MODELS_DEV_PR_TOKEN`（GitHub App installation token 或 fine-grained PAT，权限 `contents: write` + `pull-requests: write`），否则 models.dev 刷新 PR 不会触发 CI（workflow 会退回自跑 `pnpm run ci`）。合入 M1 后手动 `workflow_dispatch` 跑一次。
2. **真实 key 验证**（本地，M2 的实测门）：对 DeepSeek、智谱、Kimi、MiniMax、阿里、腾讯、阶跃、火山方舟各跑 `node scripts/channel-probe.mjs --model <id>@messages`（每家 ≤ 8 请求），把结果表交给 M2 补进 `docs/guides/providers.md`；没有 key 的保持 chat。
3. **外部 Agent 端到端**（本地，E 的验收）：本机已登录的 `claude` 与 `codex`，`AMA_E2E_AGENTS=1 pnpm test:e2e`（临时目录写文件 + 一次审批）；跑前后比对 `~/.claude` 配置目录指纹。
4. **审阅决定**：D8 实测门策略、D13 统一入口（不建 `agent_*` 工具）、D20 todo 入默认预设的门槛、D21 allowlist 同步放宽、D25 不做 C11 / C12、D26 不回注正文；以及 §13「待定」里是否归档调研原文。
5. **D20 基准**：H2 的 `bench-presets default,default+todo` 需要中转 key（约 ≤ 60 请求、< $3）。
