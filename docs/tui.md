# 终端界面

交互模式的使用说明，以及终端组件库 `@armadra/agent/tui` 的 API。设计依据见 [design.md](design.md) §12。

`ama` 在终端里直接运行（stdin / stdout 都是 TTY、`TERM` 不是 `dumb`、没有 `--no-tui`）时进入交互模式。界面只用**主屏**：对话历史滚进终端回滚，不切备用屏，所以在 tmux 里 `capture-pane` 能读到完整对话，退出后对话也留在屏幕上。

## 布局

视觉规格（配色、字形、逐屏样稿）见 [tui-design.md](tui-design.md)。层级用缩进表达：第 0 列是用户 `›`、工具 `⏺` 与提示符号，第 2 列是结果连接符 `⎿`，第 4 列是工具输出；去掉颜色（`NO_COLOR`、`capture-pane` 不带 `-e`）也读得出结构。

```
 ▄███▄  ██▄   ▄██  ▄███▄    ama 0.6.2                     ← 启动头（normal 档）
██▀ ▀██ ███▄ ▄███ ██▀ ▀██   anthropic/claude-sonnet-4-5@messages · 思考 medium
███████ ██ ▀█▀ ██ ███████   ~/Projects/demo · 已信任（trust.json）
██   ██ ██     ██ ██   ██   Accept edits · 预设 default
▀▀   ▀▀ ▀▀     ▀▀ ▀▀   ▀▀   AGENTS.md · 2 Skill
                            /help 命令 · Shift+Tab 切模式 · Ctrl+O 展开工具输出

› 读一下 README                                    ← 用户消息（续行缩进 2 列）

✻ 思考 · 120 token                                 ← 思考块（折叠；Ctrl+O 展开）

⏺ read README.md                                   ← 工具调用：⏺ 工具名 摘要
  ⎿ 读取 5 行                                       ← 一行结果摘要
      1  # Demo                                     ← 输出正文（缩进 4 列）
    … 另 2 行（Ctrl+O 展开）
⏺ bash pnpm test                                   ← 相邻工具调用之间不空行
  ⎿ ⠋ 运行中 · 4s

  ↳ 之后  顺便更新文档                              ← 排队消息
    Alt+↑ 取回 · Esc 回填并中断
⠋ 运行 bash · 4s · Esc 中断                         ← 运行中动词
────────────────────────────────────────────────
› 输入消息，/ 命令，@ 文件，Shift+Enter 换行        ← 输入框（占位）
────────────────────────────────────────────────
codemode on        tps: 100 tok/s • 546 tok / 5.5s (avg 100 · ttft 1.4s) · ↑12k ↓1.2k · cache 80% ♨ · [-]   ← 速率行（full）
Accept edits | shift+tab 切换    claude-opus-5-5 medium | Ctx 3.0% | proj ⎇ main 5ae9e54 ↑2 (+12,-3) | $0.26 | 2h24m
                                    5 小时：10.0% | 重置：2h 18m | 本周：31.0% | 本周重置：6d 5h   ← 订阅配额行（full，ChatGPT 订阅模型）
```

- **用户消息**：`›` 开头，续行缩进 2 列；运行中插话标 `↳ 插话`，排到本轮之后的标 `↳ 之后`，宿主（Armadra 画布）注入的标 `↳ 宿主`，打断并发送开的新回合标 `↳ 打断`（会话文件里的 `origin` 不变：steer / followUp / host / interrupt）。
- **思考块**：`ui.showThinking` = `collapsed`（缺省，`✻ 思考中…` → `✻ 思考 · 1.2k token`，`Ctrl+O` 展开为缩进的正文，最多 60 行）/ `full`（总是展开）/ `hidden`。
- **工具调用**：标题 `⏺ 工具名 摘要`，`⏺` 运行中为强调色、成功绿、失败红；第二行 `⎿` 后是结果摘要——`读取 N 行`、`N 处修改 · +a −b`、`退出 0 · 2.1s · 48 行`、`14 处匹配 · 6 个文件`、`N 个内层调用 · 脚本输出 M 行`、`子 Agent · 运行中 1m05s` / `完成 · 1m42s · ↑28k ↓4.1k`；运行中摘要行带与底部同帧的 spinner 与秒数。正文折叠显示前 3 行，`edit` 显示 diff（前 12 行，≥ 60 列带行号），`bash` 运行中滚动显示最后 8 行。`Ctrl+O` 展开 / 折叠全部（含思考块）。codemode 脚本里的内层调用挂在外层调用下面（折叠时只列最近 5 个的标题与摘要）。
- **提示**：`✗` 错误、`↻ 重试 n/m`、`!` 警告（缓存未命中、上下文余量）、`⛔ Hook 阻止`、宿主通知、审批被拒或超时的说明；压缩 / 分支摘要是左竖条卡片（`▎ 上下文已压缩  128k → 24k token`）。
- **运行中**：`⠋ 动词 · 已用时 · …`，动词按当前最深状态取：`等待确认`（审批打开）、`运行 bash` / `运行 3 个工具`、`重试 2/3 · 2s 后`、`压缩上下文`、`回复中 · ↓≈1.2k`（本条输出的估算 token）、`思考中`。有阻塞中的前台子 Agent 任务时加 `Ctrl+B 转后台`，Agent 栏里有任务时加 `↓ Agent 栏`（有停靠的审批时换成 `↓ 处理审批`）：`⠏ 运行 task · 4s · Esc 中断 · Ctrl+B 转后台 · ↓ Agent 栏`，一行放不下时从后往前整项丢掉。输入框有字时最前面加 `Enter 排队 · Ctrl+X 打断并发送`（`ui.enterWhileRunning: "interrupt"` 时是 `Enter 打断并发送 · Ctrl+X 排队`）；有排队的插话时队列末行是 `Alt+↑ 取回 · Ctrl+X 立即发送 · Esc 回填并中断`。
- **状态栏**：模式永远在最左；`full` 左右分区——左列是状态与开关（权限模式、`shift+tab` 提示、codemode、沙箱、预设、回退），右列是度量与模型（tps、用量、模型、Ctx、git、费用、时长、配额），右列右对齐、左列为空时整行靠右；除 full 布局下的订阅配额行外，状态栏是最后一行（`compact` 永远是最后一行）。`compact` 的分隔符固定为 `·`（嵌入宿主按此解析），`full` 用 `|`。布局由 `ui.statusLine` 决定：独立终端缺省 `full`（两行），有 profile 的嵌入宿主缺省 `compact`（一行，布局与以前相同）；运行时 `Ctrl+G` 或 `/statusline [full|compact]` 切换，只影响本会话。`full` 时输入框在倒数第 4 行（`compact` 仍是倒数第 3 行）。
  - **`full` 上行（速率行）**：左区是开关类项 `codemode on|only`（网络未隔离时追加 `net!`）· `沙箱` · `preset <名>`（非 default 时）· `→ <回退模型>`（回退中，黄色）· 排队数 · 宿主状态，没有时左区为空。右区 `tps: <速率> tok/s • <输出 token> tok / <耗时> (avg <会话均速> · ttft <首 token 延迟>) · ↑<输入> ↓<输出> · 缓存 · 重计费 · [-]`——速率在流式中是最近 2 s 的瞬时值（`tps:` 强调色），结束后是该请求的平均值，生成不足 0.25 s 的整块回复不算速率、显示 `—`；耗时从首 token 起；`↑` 输入含缓存读写；ASCII 下 `•` 为 `*`、`→` 为 `->`；行尾 `[-]` 提示可折叠。只统计对话请求（压缩摘要、保温、分类器不计）。窄时先丢右区度量（输出量 / 耗时、token、缓存、重计费、avg、ttft），再丢左区开关（宿主状态、排队数、预设、回退、沙箱、codemode）；`tps` 与 `[-]` 不丢。
  - **`full` 下行**：左区 `权限模式 | shift+tab 切换`，右区 `模型 思考级别 | Ctx 3.0% | <目录名> ⎇ <分支> <短提交> ↑N ↓N (+a,-d) | $费用 | 会话时长`（Ctx 一位小数，宽屏也不换余量表）；窄时依次丢弃切换提示、思考级别、增删行、目录名、分支与提交、时长、费用、上下文、模型。
  - **订阅配额行**（`full` 第三行，在状态栏下方）：当前模型走 ChatGPT 订阅（`chatgpt` 供应商）时显示 `5 小时：<已用%> | 重置：<距重置> | 本周：<已用%> | 本周重置：<距重置>`（英文界面 `Session: … | Reset: … | Weekly: … | Weekly Reset: …`），数据来自最近一次 `quota_update`（codex 方式的 `x-codex-primary/secondary-*` 响应头与 `codex.rate_limits` 事件；siwc 只有超限 429 时才有）。重置时间是相对时长（`2h 18m`、`6d 5h`），每分钟刷新一次。codex 方式在第一次请求前显示「配额：首次请求后显示」（第一次请求就会带回配额，先占住行免得行数跳动）；siwc 没有数据时不占行（只有超限才有配额，占位会一直挂着）；非订阅模型不显示。窄于 80 列时压缩为 `5h 10% ↻2h18m · 周 31% ↻6d5h`，再窄先丢重置时间。配额行在右区右对齐。标签按窗口时长认而不是按 primary / secondary 槽位：300 分钟是「5 小时」、10080 分钟是「本周」，其它时长用实际时长（`1d：`）；缺时长时 primary 当 5 小时、secondary 当本周（与另一个窗口撞名时取另一种）；按时长从短到长排。用量 0、无时长、无重置时间的窗口是服务端的「没有这个窗口」，不显示（有的套餐 codex 只送一个周窗口，放在 primary）。`Ctrl+G` / `/statusline compact` 折叠时配额行与速率行一起收起（`compact` 只保留一行，宿主按「最后一行 = 状态栏」锚定）。
  - **配色**（`full`）：标签、单位、分隔符与括号暗灰；速率数字紫、输出量 / 耗时 / avg 蓝、ttft 紫；模型与思考级别蓝；Ctx 与配额百分比按阈值绿 / 黄 / 红（≥ 70% 黄、≥ 90% 红）；目录与分支绿、短提交暗灰、`↑N` 领先橙、`↓N` 落后红、`(+a,-d)` 绿 / 红；费用黄；时长与重置时间紫。都取主题语义色，深 / 浅主题与 16 色各有对应；`NO_COLOR` 与 ASCII 不着色、结构不变。`compact` 的着色不变。
  - **`compact`**：一行，右区 模型 · 思考级别 · `↑ ↓` · 缓存 · 费用 · 重计费 · 上下文占用 · 目录 ⎇ 分支 提交 +a −b · 会话时长 · 排队数 · codemode · 预设 · 宿主状态 · 订阅配额短项（`5h 10% 周 31%`，只在有配额数据时；项内不含 `·`）；窄时依次丢弃配额短项、切换提示、宿主状态、预设、重计费、费用、缓存、token、思考级别、排队数、codemode、增删行、目录名、分支与提交、时长、上下文、模型。
  - **git**：分支与短提交直接读 `.git/HEAD`（worktree 认；detached 只显示短提交；非 git 目录整段省略，只剩目录名）；`+a −b` 是工作区（含暂存）相对 HEAD 的增删行，回合结束、写类工具结束、回滚、`/tree` 之后在后台跑 `git diff --numstat HEAD`，至多 10 秒一次，超过 2 秒或失败就本会话不再显示增删；`AMA_STATUS_GIT=0` 关闭。`full` 的 `↑N` / `↓N` 是当前分支领先 / 落后上游的提交数：分支在 git 配置里有上游（`branch.<名>.merge`）时，同一节流周期接着跑 `git rev-list --left-right --count @{upstream}...HEAD`（同样 2 秒超时，超时本会话不再统计）；为 0、没有上游或 detached 不显示；ASCII 下为 `^N` / `vN`。
  - **费用**含子任务、保温、分类器与外部 Agent 以美元计的用量（其它单位只在 `/session`）；**时长**从本进程打开当前会话起算（`Ns` / `Nm` / `NhMm`）。
  - bash 命令在操作系统沙箱里跑时（`sandbox.bash: "auto"` 且本机可用，见 [sandbox.md](sandbox.md)）用量类项多一个 `沙箱`，宽度不够时与 codemode 一起先丢。
  - 模型回退中（`fallbackModel`，主模型过载或重试用尽后改用回退模型重试一次）`compact` 的模型项显示 `主模型 → 回退模型`（回退模型黄色），`full` 的模型项只留主模型、速率行左区显示 `→ 回退模型`，回退模型回复、切回主模型后消失；消息区同时有一行说明。
  - 模型名随宽度缩写（< 100 列去供应商、< 60 去渠道、< 48 去版本后缀）；`compact` ≥ 110 列时上下文显示为余量表 `ctx ▮▮▮▯▯▯▯▯▯▯ 34%`；会变的数字按最宽形状占位，数值变化不会让某项时有时无。ASCII 模式 `⎇` → `git`、`−` → `-`、`♨` → `~`、`↻` → `@`。
- **退出**：消息区最后追加一行会话摘要与恢复命令，留在终端回滚里：

```
─ 会话 3f2a9c1e · 12 分钟 · 7 回合 · ↑128k ↓9.4k · cache 81% · $0.42（重计费 $0.03）
  恢复：ama --resume 3f2a9c1e
```

## 缓存与上下文

状态栏各项：

| 项              | 含义                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `cache 83%`     | **最近一次**请求的命中率（读缓存 /（输入 + 缓存读 + 缓存写））；会话累计在 `/session`                               |
| `cache —`       | 端点还没报过缓存（`unknown`：还没有足够长的可比请求）                                                               |
| `cache 未报告`  | 端点不报缓存（`silent`：连续 3 个可比请求读写都是 0，或 `compat.cacheReporting: "silent"`）；这类请求不进命中率分母 |
| `♨`             | 保温计时中（工具长时间运行时按 TTL 重放前缀，`/cache warm` 可切换）                                                 |
| `rebill $0.11`  | 本会话缓存未命中导致的重计费金额；模型没有价格时显示 token 数；为 0 不显示                                          |
| `ctx 72%`       | 上下文占用，< 70% 绿色、≥ 70% 黄色、≥ 90% 红色；`ctx ?` 表示模型没有窗口信息                                        |
| `codemode only` | codemode 生效（`on` / `only`）；网络未隔离（Node 22 / 24 且没有操作系统沙箱，见 sandbox.md）时追加红色 `net!`       |

消息区（line 模式写 stderr，前缀 `ama: `）只在两种情况下提示一行，`cache.missNotices: false` 可关：

- 一次未命中重计费 ≥ 20k token 或 ≥ $0.10：`缓存未命中（空闲 7 分钟后）：重计费 38.2k token（约 $0.11）`。原因有空闲超时、子任务运行、切换模型、系统提示 / 工具表变化、服务端淘汰；更小的未命中只进统计。
- 上下文占用跨过 70% / 90%（各一次）：`上下文已用 72%，约剩 9 回合（按最近 5 回合均值）`；回合数估不出时给余量 token。
- line 模式在 `AMA_LOG=info` 时另写保温成功：`缓存保温已刷新（读 12k token，$0.001）`。

`/session` 在消息区画一张左竖条面板，会话信息之后是「缓存」段，`/cache` 只显示这一段（line 模式与 RPC 是同样内容的纯文本）：

```
▎ 会话 3f2a9c1e  ~/.local/share/ama/sessions/…/3f2a9c1e.jsonl
▎ 模型    anthropic/claude-sonnet-4-5 · 思考 medium · 权限 Accept edits
▎ 消息    用户 7 · 助手 9 · 工具调用 23
▎ 用量    输入 3.4k · 输出 9.4k · 缓存读 118k · 缓存写 6.2k · $0.42
▎ 上下文  ▮▮▮▯▯▯▯▯▯▯ 34% · 68k / 200k
▎
▎ 缓存
▎   输入      3.4k = 缓存读 2.2k（65%）+ 未缓存 1.2k
▎   报告状态  reported
▎   命中率    最近 84% · 会话 65%
▎   未命中    0 次
▎   保温      streaming · 已停止：模型目录没有缓存 TTL
▎   上下文    1%，余量 ≈ 127k token ≈ 2443 回合
```

未命中行按原因分列（`3 次，重计费 61k token ≈ $0.18（空闲超时 2 · 前缀变化 1）`）；保温行在计时中显示 `streaming · 下次 2m 10s · 期望节省 $0.18 ≥ $0.05`，停止时给原因；有 task 子会话时另有「子任务」行。

- `/cache warm off|streaming|idle`：本会话内切换保温（不写配置；`idle` 在空闲时也保温，适合贵模型）。
- `/cache fingerprint`：最近一次真实请求的前缀指纹——system 与工具表各一个 16 位哈希加模型名。两次之间哈希变了，就是宿主或 Hook 中途改了系统提示 / 工具表。

取舍：状态栏显示最近一次命中率（会话累计放 `/session`）；`cache.missNotices` 缺省开（门槛下很少触发）；`Meter` 组件不进缺省状态栏。命中率、未命中与保温的判定规则见 [providers.md](providers.md)「缓存」。

`ama models cache-probe <provider/model>` 用一个固定前缀相隔几秒发两次最小请求，判定端点 `reported` / `silent` / `inconclusive` 并给出配置建议（会计费：先打印预估，非交互环境需 `--yes`）。

## 按键

| 按键                 | 作用                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enter                | 发送；运行中 = steer（排队，等下一个投递点：本次模型回复结束或本批工具结束）                                                                                                                                                                   |
| Ctrl+X               | 运行中打断并立即发送：中止当前回合（模型流与正在跑的工具，工具记「aborted by user」），立刻以输入框的文字开新回合，排队的插话拼在前面；输入为空时只把排队的插话立即送出。空闲时等同 Enter。`ui.enterWhileRunning: "interrupt"` 时与 Enter 互换 |
| Alt+Enter            | 运行中排到本轮之后（followUp）；空闲时等同 Enter                                                                                                                                                                                               |
| Shift+Enter / Ctrl+J | 换行                                                                                                                                                                                                                                           |
| Esc                  | 中断：排队的消息回填到输入框，然后停止当前运行（连带前台子 Agent 任务；后台任务不受影响，提示里写明）；补全打开时先关补全                                                                                                                      |
| Esc Esc（空闲）      | 输入框为空：打开回滚列表（同 `/rewind`）；有字：清空并存进输入历史                                                                                                                                                                             |
| Alt+↑                | 取回最后一条排队消息                                                                                                                                                                                                                           |
| Shift+Tab / Tab      | 循环权限模式 Manual → Accept edits → Plan → Auto → Bypass permissions（Tab 只在输入为空、补全未打开时，否则仍是补全；进入 Bypass 前确认，见下文「进入 Bypass」）                                                                               |
| Ctrl+O               | 展开 / 折叠工具输出与思考块                                                                                                                                                                                                                    |
| Ctrl+L / Ctrl+T      | 选择模型 / 思考级别                                                                                                                                                                                                                            |
| Ctrl+G               | 底部信息行 两行（full）↔ 一行（compact），只影响本会话                                                                                                                                                                                         |
| Ctrl+V               | 粘贴剪贴板里的图片：存进数据目录，光标处插入 `@<路径>`（同 `/paste`）                                                                                                                                                                          |
| Ctrl+C               | 清空输入；输入为空时 1.5 秒内再按一次退出（退出码 130）                                                                                                                                                                                        |
| Ctrl+D               | 输入为空时退出                                                                                                                                                                                                                                 |
| Tab                  | 补全                                                                                                                                                                                                                                           |
| ↑ / ↓                | 单行时浏览历史（`<数据目录>/history`，500 条）                                                                                                                                                                                                 |
| ↓（空输入）          | 进入 Agent 栏（有子 Agent 任务即可）；有字时仍是下移 / 历史并提示一次，见「子 Agent」                                                                                                                                                          |
| Ctrl+B               | 有阻塞中的前台子 Agent 任务（或 `task_ctl wait`）时全部转后台，不看输入框有没有字；没有时是光标左移。tmux 里按 `C-b C-b`，见「子 Agent」                                                                                                       |

按键可在 `~/.config/ama/keybindings.json` 覆盖，键是动作 id（`app.interrupt`、`app.rewind`、`app.message.followUp`、`app.message.interrupt`、`app.statusLine.toggle`、`app.paste.image`、`app.agents.focus`、`app.tasks.background`、`tui.editor.newLine` ……），值是按键或按键数组，空数组表示禁用。`app.rewind` 是空闲时双击的那个键（缺省 Esc，两次间隔 ≤ 800 ms）。

### 打断并立即发送

运行中按 Enter 缺省是**排队**（steer）：消息等下一个投递点才送达——模型在长篇输出、或工具在跑一个 5 分钟的命令时要等很久。要立刻改方向，在输入框写好后按 **`Ctrl+X`**（动作 `app.message.interrupt`）：

- 当前回合立即中止：模型流断开，正在执行的工具按中断收尾（每个工具调用恰有一个结果，记「aborted by user」），被打断的回复按中断规则留在会话里；随后**不用再按 Enter**，这段文字直接作为新回合的用户消息发出（会话里 `origin: "interrupt"`，消息区标 `↳ 打断`）。
- 已排队的插话一起带上：按入队顺序拼在这段文字前面（空行分隔）；排到本轮之后的（Alt+Enter）留在队列，新回合结束后照常送达。
- 只连带前台：前台子 Agent 任务随主回合中止，后台任务不受影响。
- 补全打开、审批框或选择器打开时不触发；斜杠命令照常当命令执行；输入为空时只把排队的插话立即送出（没有可发的内容时提示一行）。
- 中断的请求前缀不变：新回合的请求以被打断那次请求的全部消息为前缀，缓存照常命中。
- Esc 不变：仍是中断并把排队消息回填输入框（中断即撤回见下文），不会自动发送。
- 想让 Enter 直接打断：`/config` 里把 `ui.enterWhileRunning` 设为 `interrupt`（立即生效），这时 Enter 打断并发送、`Ctrl+X` 排队。

缺省键选 `Ctrl+X` 的原因：macOS Terminal、iTerm2、tmux、Windows Terminal 都原样送达，且没有别的绑定；`Ctrl+Enter` 不开 kitty 键盘协议时与 Enter 无法区分，`Ctrl+S` 可能被 XOFF 流控吃掉，`Alt+Enter` 已是 followUp，`Alt+字母` 在 macOS 缺省不送 Meta，`Ctrl+]` 在非美式键盘上难按。可在 `keybindings.json` 改。

line 模式（`--no-tui`）运行中输入 `/interrupt <文本>` 效果相同（空闲时就是普通提示）；交互界面里也认这条命令。RPC 是 `prompt` / `steer` 的 `interrupt: true`，见 [rpc.md](rpc.md)。

## 回滚

设计见 [rewind-plan.md](rewind-plan.md)。每条开启新回合的用户消息都是一个回滚点；edit / write 改过的文件在消息发出前有检查点（`checkpoints.mode`，bash 改动只在下一回合重拍已跟踪文件时收进来）。

- **入口**：`/rewind`，或空闲且输入框为空时双击 Esc——第一次底部提示「再按 Esc 回滚」（1 秒消失），800 ms 内再按打开列表。输入框有字时双击 Esc 是清空（提示「再按 Esc 清空」），文字存进输入历史，↑ 取回。运行中 Esc 仍是中断；审批对话框、选择器打开时 Esc 归它们。
- **中断即撤回**：运行中按 Esc 中断，若这一回合还没有任何回复文字或工具调用、输入框为空（`ui.restoreOnCancel`，缺省 true），自动撤回这条消息并把原文放回输入框，消息区一行「已撤回被中断的消息」。
- **列表**：活动路径上的回滚点，最早在上、最近在下，缺省选中最后一条。高亮行右侧是代码改动统计（对该行做一次预览，结果缓存）：`3 文件 +12 −48` / `无代码改动`，计算中 `…`，预览失败 `—`；没有检查点（内存会话、检查点关闭、超出保留数）的行标 `仅对话`。
- **确认面板**：底部左竖条面板，消息原文（最多 3 行）与时间，下面是编号选项，每项下一行是预览：

```
▎ 回滚到这条消息之前  3 分钟前
▎ › 把 src/tui/tui.ts 的差分渲染改成按行比较，
▎   顺便补上测试
▎
▎ › 1. 恢复代码和对话
▎      将恢复 3 个文件 +12 −48 · 对话将分叉
▎   2. 恢复对话
▎      代码不变（保留之后的修改）· 对话将分叉
▎   3. 恢复代码
▎      将恢复 3 个文件 +12 −48 · 对话不变
▎   4. 从这里摘要
▎      对话将分叉，离开的部分写成摘要
▎   5. 摘要到这里
▎      之前的对话压缩成摘要，之后的保留
▎   6. 取消
▎
▎ git HEAD 已变化：3f2a9c1 → 9e8d7c6（ama 不动 git）
▎   git log --oneline 3f2a9c1e0b7d..HEAD
▎   git reset --soft 3f2a9c1e0b7d
▎
▎ ↑↓ 选择 · 1-6 直接执行 · Enter 确认 · Esc 取消
```

- 两个「恢复代码」项只在预览有改动时出现。「对话将分叉」：回到这条消息之前，原来的后续留在会话树里（`/tree` 可回去）；对话类操作之后消息区重画、原消息放回输入框（图片随下一条消息发送）。模型、思考级别、权限模式不变。
- 两个摘要项可以在行内输入说明：选中后直接打字，Enter 提交；数字键直接执行、不带说明；有说明时 Esc 先清空说明。
- 冲突（文件在回合外被改过）与无法恢复的文件（符号链接、硬链接、父目录被移动、过大未备份……）列在选项下面；选了代码类且有冲突时多一步「跳过冲突文件，恢复其余 / 覆盖冲突文件 / 返回」。
- git HEAD 与检查点记录的不同时给出两条命令，ama 只显示、不执行。
- **结果**：消息区一条通知——`已恢复 3 个文件，跳过 1 个（冲突 1）`、`没有文件被恢复，跳过 2 个（符号链接 1、父目录被移动 1）`、`代码没有变化`，之后最多 5 行跳过明细；运行中、没有检查点、全部失败分别提示「正在运行，不能回滚（先按 Esc 中断）」「这条消息没有代码检查点，只能恢复对话」「没有文件被恢复：…」。
- 宽度不足 56 列时面板去空行，只给选中项画预览。ASCII 模式（`AMA_ASCII=1`）竖条为 `|`、减号为 `-`、箭头为 `^v`。
- **line 模式**（`--no-tui`）：`/rewind` 列出编号（1 = 最早）；`/rewind <n> [both|conversation|code] [overwrite]`（缺省 both，没有检查点时 conversation；`overwrite` 覆盖冲突文件）；`/rewind <n> summarize-from|summarize-up-to [说明]`。单行原消息放回编辑行。

## 命令

`/help` 列出全部命令。交互模式另有：

- `/rewind`：回滚列表与确认面板（见上文「回滚」）；带参数时与 line 模式相同。
- `/tree`：列出会话里的全部用户消息（分叉处缩进，`●` 是当前分支）；选中一条后回到它之前，原文回填输入框，修改后发送就形成新分支。
- `/fork`（无参数）：同样选一条用户消息，从它之前复制出新会话。
- `/model`、`/resume`、`/permission`、`/thinking` 不带参数时打开选择器；`/permissions` 显示权限判定顺序、已加载规则与最近 20 条 auto 判定（层、结果、原因）。
- `/permission` 选择器标题「权限模式」：Manual / Accept edits / Plan / Auto / Bypass permissions / Allowlist only，每项一行说明，右侧数字 1–6 直接选；当前模式打 `✓`，配置里的缺省模式标 `Default`，Auto 标 `Recommended`，底部一行按键提示。`/permission auto`、`/permission Accept edits` 直接切换。状态栏最左是模式的显示名。auto 模式下需要确认时，审批对话框多一行「Auto 规则层 / 分类器：原因」。详见 [permissions.md](permissions.md)。
- 选择器底部一行按键提示（`↑↓ 选择 · Enter 确认 · Esc 取消`），选中行有底色（≥ 256 色；更少时强调色粗体）。
- `/model` 选择器（`Ctrl+L` 同）给当前模型打 `✓`，并带 `(i/n)` 计数，说明里有上下文与 `img`（收图片）：
  - **缺省只列已配置的供应商**：有 key、OAuth 已登录（需重新登录的不算）或本地服务；组标题是「供应商 · 状态」。当前模型不在列表里时置顶一行（组「当前」）。
  - **`Tab` 切到「全部」**（再按切回，筛选文本保留）：另列没配置的供应商，组标题标「未配置 key」；选中它们的模型不切换，底部提示 `ama auth set <供应商>`（自定义供应商用 `ama providers add`）。选 `Tab` 而不是列表底部的「添加模型」项：不占列表位置、不混进筛选结果，筛到一半也能切。
  - **`Space` 把高亮的模型加入 / 移出清单**（用户级 `models.enabled`，写回 config.json）：设置了清单后「已配置」视图只列清单内的模型（加当前模型）；清单移空时删掉这个键。经 `provider/*` 列入的不能单独移出，按提示用 `ama models disable`。已在用清单时，从「全部」选中清单外的模型会先加入清单再切换。`Space` 因此不再用作筛选的分词（筛选按一个词匹配，`provider/model` 也能筛）。
  - **多渠道供应商每个模型一行**（首选渠道），说明里写「另有 @渠道」；筛选文本里带 `@`（如 `@messages`）时列出 `模型@渠道` 行，直接选中即用该渠道。选 `@` 而不是 `→` 展开：与 `provider/model@channel` 的写法一致，启动选择器里也能用同一习惯。`/model packy/kimi-k2.5@messages` 仍可直接切到指定渠道。
  - **ChatGPT 订阅**：`ama auth login chatgpt` 后自动拉取账户可用的模型（只读的模型列表接口，不消耗额度）缓存到 `<dataDir>/models/discovered/chatgpt.json`，选择器里按普通模型列出；没缓存时 chatgpt 组有一行「运行 ama models discover chatgpt 获取模型」（见 [providers.md](providers.md#chatgpt-登录)）。
  - 命令行同一份清单：`ama models enable <provider/model[@channel]|provider/*>…`、`ama models disable …`、`ama models list --enabled`（没设清单时列出选择器缺省显示的模型）。
- 输入里的 `@图片路径`（可加引号，Tab 补全路径）或粘贴 / 拖入的图片文件路径作为图片附件随消息发送；当前模型不收图片时 `@` 附件报错、不发送，未加 `@` 的路径忽略（见 [providers.md](providers.md)「图像输入」）。
- `/statusline [full|compact]`：切换底部信息行（无参数时在两者间切换，同 `Ctrl+G`），只影响本会话；line 模式没有底部信息行。
- `/session`、`/cache`：会话用量与缓存统计面板（见上文「缓存与上下文」）；`/permissions` 同样是面板，allow 绿、deny 红，判定顺序折行对齐。`/session` 有子 Agent 任务时多一行「子 Agent」（任务数与各状态），用过外部 Agent 时多一段「外部 Agent」（每个 Agent 的运行次数与用量，美元 / token / 请求数按各自单位，不换算）。
- `/plan`：当前计划面板（见下文「Plan 审批」）；`/plan <目标>` 进入 Plan 模式并发出目标；`/plan approve [模式|fresh]`、`/plan reject` 不开对话框直接批准 / 放弃。
- `/tasks`：聚焦 Agent 栏，`/tasks <id>` 打开子 Agent 视图；`/agents`：可用的子 Agent 类型（见下文「子 Agent」）。
- `/paste`：同 `Ctrl+V`。

## 进入 Bypass

切到 Bypass permissions（`full-auto`）之前底部弹一个确认框，样式同审批对话框（边框黄）：

```
╭─ 进入 Bypass permissions？ ──────────────────────────────────────────────────╮
│ 所有工具调用都不再询问：写文件、执行命令、联网直接放行                       │
│ 只有危险命令仍会询问，deny 规则照常生效；只建议在一次性沙箱、容器里用        │
│                                                                              │
│   1. 进入 Bypass                                                       y     │
│ › 2. 取消                                                              n Esc │
│                                                                              │
│ ↑↓ 选择 · Enter 确认 · 1-2 直接选 · Esc 取消                                 │
╰──────────────────────────────────────────────────────────────────────────────╯
```

- 触发：Tab / Shift+Tab 循环到 Bypass、`/permission` 选择器选 Bypass、`/permission full-auto`。缺省选中「取消」：↑↓ 移动、Enter 确认、`1` / `2` 或 `y` / `n` 直选，Esc / Ctrl+C 取消（Ctrl+C 在这里不算退出的第一下）。
- 取消：循环时**跳过 Bypass 回到循环起点 Manual**（底部提示「未进入 Bypass · 权限模式：Manual」），这样不进 Bypass 也能一路 Tab 绕回去，且落点总比 Auto 更严；选择器与命令取消时保持原模式（消息区「已取消，权限模式仍为 …」）。
- 本次运行确认过一次后，再切到 Bypass 不再问；启动时已是 Bypass（`--permission-mode full-auto`、配置、profile）视为已确认，不弹。
- 宽 < 56 列时去掉空行、按键提示缩短；ASCII 模式边框 `+ - |`、选中符 `>`、箭头 `^v`。帧黄金 `test/fixtures/tui/bypass-confirm-*.txt`。
- line 模式（`--no-tui`）：`/permission full-auto` 先打印上面两行说明，再问 `确认进入 Bypass？[y/N]`（单键，Enter = N）；管道输入没有这一步。

## 选择与确认的按键

所有让人做选择的地方都支持 ↑↓ 移动 + Enter 确认，原有快捷键保留：

| 位置                                    | 按键                                                     |
| --------------------------------------- | -------------------------------------------------------- |
| 审批对话框（含外部 Agent 首次运行确认） | ↑↓ Enter · 1–3 · y / a / n · Esc 拒绝 · v 完整输入       |
| 计划审批框（主选项、执行模式）          | ↑↓ Enter · 1–4 / 1–3 · e 编辑计划 · Esc 留在 Plan / 返回 |
| 回滚确认面板、冲突覆盖二次确认          | ↑↓ Enter · 数字直接执行 · Esc 取消 / 返回                |
| 进入 Bypass 确认                        | ↑↓ Enter · 1–2 · y / n · Esc 取消                        |
| 权限模式、思考级别选择器                | ↑↓ Enter · 数字直接选 · Esc 取消                         |
| 模型、会话、树、任务选择器              | ↑↓ Enter · 输入过滤 · Esc 取消（可过滤的列表不用数字键） |
| 启动时信任目录                          | ↑↓ Enter · 1–4 直接选 · Esc / Ctrl+C = 本次不信任        |
| CLI 子命令计费 / 写入确认（TTY）        | ↑↓ Enter · 1–2 · y / n · Esc / Ctrl+C 取消（缺省取消）   |

CLI 子命令（`ama providers add` / `refresh` 的写入与 `--probe` 计费确认、`ama models cache-probe`）在 TTY 下用同一套方向键选择，结束后收成一行「? 继续？ 继续」并恢复终端；stdin 不是 TTY（管道、CI）时仍是文本 `继续？[y/N]`（这些命令非交互时本就要求 `--yes`），`--yes` 跳过确认。

## 补全

- 首行行首输入 `/`：命令、提示模板（`/<名字>`）、Skill（`/skill:<名字>`）。
- `@`（行首或空格之后）：当前目录下的文件与目录（尊重 `.gitignore`），含 `*` `?` `[` `{` 时按 glob 匹配相对路径。

## 审批

工具调用需要确认时，底部弹出对话框：标题是原因（`需要确认` / `危险命令` / `Hook 要求确认`，子 Agent 与外部 Agent 发起的带来源标注，见下文「子 Agent」），边框随预览严重度变红 / 黄；bash 显示完整命令，write 显示路径与行数，edit 显示每处修改的 −/+ 摘要。下面是编号选项：

```
╭─ 危险命令 ─────────────────────────────────────────────╮
│ bash  危险命令                                          │
│ $ rm -rf build dist/*.map > out.log                     │
│                                                         │
│ 删除 build/：目录，132 个文件，1.2 MB                   │
│ 这条命令可能有破坏性，请确认                            │
│                                                         │
│   1. 允许                                         y     │
│   2. 本会话允许同类                               a     │
│ › 3. 拒绝                                         n Esc │
│                                                         │
│ ↑↓ 选择 · Enter 确认 · v 完整输入                       │
╰─────────────────────────────────────────────────────────╯
```

`1`–`3` 或 `↑↓` + Enter 选择，`y` 允许、`a` 本会话内同类不再询问、`n` / Esc / Ctrl+C 拒绝、`v` 查看完整输入。缺省选中项：危险命令是「拒绝」，其余是「允许」。窄于 56 列时紧凑显示（工具名单独一行、不留空行）。10 分钟不作答按拒绝处理（`AMA_APPROVAL_TIMEOUT_MS` 可改）。

输入摘要之后是**执行前预览**：这一步会碰到什么。

- bash：识别每段命令（含 `sh -c`、`eval`、`xargs`、`find -exec` 里嵌套的命令）中的 `rm` / `rmdir` / `unlink`、`mv`、`git clean`、`git checkout -- <路径>`、`git reset --hard` 与 `>` / `>>` 重定向目标，列出路径是否存在、大小、目录里的文件数；通配符与变量不展开，原样显示并提示实际范围可能更大。
- write：目标是否存在、现有行数与大小 → 新内容；覆盖本会话没读过的文件标黄。
- edit：对原文干跑一遍，列出每处 −n/+m 行与总变化；匹配不到或不唯一时提前说明。

预览按严重度着色（危险红、警告黄、其余暗色），只读、有上限：每个目录最多计 2000 项，整次预览 200 ms 预算，超出只给提示、不降低严重度；超过 2 MiB 的文件只报大小。预览失败不影响审批。line 模式在问句之前逐行打印同样的预览；RPC 客户端从 `permission_request.preview` 拿到它（[rpc.md](rpc.md)「审批」）。

## Plan 审批

Plan 模式（Shift+Tab、`/permission plan`、`/plan <目标>`、`--permission-mode plan`）下模型只读调研，最后给出 `<proposed_plan>` 计划块（规则见 [plan.md](plan.md)）。回合结束、会话空闲后底部弹出审批框：

```
╭─ 计划待审批 ─────────────────────────────────────────────────────────────────╮
│ 计划 v1 · 3 步 · ~/.local/share/ama/plans/3f2a9c1e-…-v1.md                   │
│ 状态栏显示回退模型                                                           │
│   S1 读 status-bar.ts 与 status-area.ts                                      │
│   S2 model_fallback 时记下主模型与回退模型                                   │
│   S3 帧黄金与文档                                                            │
│                                                                              │
│ › 1. 批准并执行                                                              │
│   2. 批准，在新上下文执行                                                    │
│   3. 继续修改…                                                               │
│   4. 放弃，退出 Plan 模式                                                    │
│                                                                              │
│ ↑↓ 选择 · Enter 确认 · e 编辑计划 · Esc 留在 Plan                            │
╰──────────────────────────────────────────────────────────────────────────────╯
```

- **1 批准并执行** / **2 批准，在新上下文执行**：接着选执行模式——回到进入前的模式（缺省）/ Accept edits / Auto，Esc 返回。批准后计划步骤变成待办（首项进行中），模式切过去并开始执行。「新上下文执行」新建一个会话，带着获批的计划与待办，以计划全文作首条消息开始执行（原会话留在树里）。
- **3 继续修改**：在框里写修改意见（Enter 发送，`Ctrl+E` 改用外部编辑器写，Esc 返回），意见作为普通消息发给模型，仍在 Plan 模式，模型重写计划后再次弹框。直接在输入框里打字发送效果相同。
- **4 放弃**：计划标为已放弃，回到进入 Plan 前的模式。**Esc**：计划标为已放弃，但留在 Plan 模式（可以继续聊、让模型重新规划）。
- **e 编辑计划**：用 `$VISUAL` / `$EDITOR`（缺省 `vi`，Windows `notepad`）打开计划全文，界面挂起；保存退出后框里提示「已在编辑器里修改」，批准时以修改后的版本（新版本号）执行。
- `/plan`：面板列出版本、状态（待审批 / 已批准 / 已放弃 / 已被新版本取代）、计划文件、所处模式与批准后回到的模式、步骤与待办进度；有待审批的计划时同时重新打开审批框（resume 回来时消息区会提示一行）。
- 窄于 56 列时紧凑显示（不留空行，按键提示缩短，摘要截断）；ASCII 模式选中符为 `>`、箭头为 `^v`。
- **line 模式**：计划提出后打印一行 `◇ 计划 v1 待审批（文件）：/plan approve [模式|fresh] 批准 · /plan reject 放弃 · 直接输入修改意见`；回复 `1` / `2` / `3` 也能批准（Manual 等进入前的模式 / Accept edits / Auto）。`/plan approve` 开始执行后等这一轮跑完再读下一行。

## 子 Agent

`task` 工具（[agents.md](agents.md)）启动的子 Agent 在消息区折叠成 task 工具行，运行中一行状态：

```
⏺ task 检查 src/tui 的测试覆盖缺口
  ⎿ ⠋ explore · 运行中 1m05s · 3 轮 · read grep bash · ↑12k ↓3.4k
⏺ task 后台审查
  ⎿ 已在后台启动
    ↳ t2 explore · 运行中 40s · 1 轮 · read
⏺ task scan
  ⎿ 已转后台 · 12s
    ↳ t3 explore · 运行中 30s · 2 轮 · grep
```

- 状态行是类型（外部 Agent 写 `claude（claude）` 这类 runner）、状态与耗时、轮数、最近 3 个工具、用量；前台任务结束后换成结果摘要。后台任务（交互界面缺省后台，见 [agents.md](agents.md)「前台与后台」）的工具调用立即返回，摘要行是「已在后台启动」，下面多一行跟随状态（运行中每秒刷新）；前台任务转后台后摘要行是「已转后台 · 已用时」，同样带跟随行（给模型的说明文字不显示，`Ctrl+O` 展开可见）；超时自动转后台（`subagents.autoBackgroundAfterMs`）或宿主转的另有一行提示；完成后模型收到的 `<task-notification>` 在消息区只显示一行「↳ 子 Agent 通知 t2 explore 完成 · 7 轮 · /tasks 查看输出」，失败或被停止时另有一行黄色提示。
- `/tasks`：聚焦 Agent 栏（见下）；`/tasks <id>` 直接打开该任务的子 Agent 视图；`/tasks stop <id>` 停止；`/tasks bg [id]` 转后台（不给 id = 全部阻塞中的前台任务，同 `Ctrl+B`）。`ui.agentBar: "off"` 时 `/tasks` 仍是任务选择器（新的在上，Enter 查看输出、运行中可停止）。line 模式 `/tasks` 列表、`/tasks <id>` 输出、`/tasks stop <id>` 停止、`/tasks bg [id]` 转后台（运行中输入也按命令处理，不当插话）。
- 转后台（`Ctrl+B`，键位动作 `app.tasks.background`）：主回合在等前台任务（`task` 带 `background: false`、`-p` 缺省，或 `task_ctl wait`）时按下，工具调用立即返回、任务继续跑，主回合接着往下走，你可以继续发消息；任务结束后照常收到 `<task-notification>` 并开一轮。底部提示「已转后台：t2，完成后会通知」。没有可转的任务时 `Ctrl+B` 落回编辑器（光标左移），不吞键。tmux 的缺省前缀就是 `C-b`：在 tmux 里按 `C-b C-b`（缺省 `send-prefix`）把它透传给 ama，或进栏按 `b`；也可在 `keybindings.json` 改成别的键。
- Esc 只中断前台：运行中按 Esc 停主回合，连带还在前台的子任务；已转后台的任务继续跑，中断提示写「已中断（后台任务 t2 仍在运行，Esc 不影响）」。
- `/agents`：可用类型——名字、runner、来源（内置 / 用户 / 项目 / profile / 宿主），外部 Agent 带「已安装 版本」或「未安装」，再加一行说明。
- 外部 Agent 自己报告的提示（预算用尽、超时、模式降级等）在消息区显示为一行 `[claude · t3] …`。

### Agent 栏

状态行上方（提示行之下）列出子 Agent 任务，每个任务一行，最多 3 行，多出的给一行「另 N 个」：

```
⏺ t1 explore · 运行中 1m05s · 3 轮 · grep  找出 src/tui 的测试缺口
⏺ t2 codex · 等待审批 40s  review the diff
⏺ t3 explore · 排队  排队中的任务
另 1 个
```

- 状态：排队（并发池满）/ 运行中（用时、轮数、最近一个工具）/ 等待审批（审批框里正有它的请求，或停靠在栏里，整行黄色）/ 完成 / 失败 / 已停止（以及轮数耗尽、已中断）；`⏺` 运行中强调色、完成绿、失败红、其余黄 / 暗；ASCII 下是 `*`。
- 什么时候显示：有排队、运行中或等审批的任务；本会话里结束、还没在视图里看过的任务保留到看过为止，最多 10 分钟。resume 进来时已经结束的任务不显示（`/tasks` 里能看到）。
- 进入：输入框为空、补全没开时按 `↓`，本会话有任务即可（栏收起了也行，与 `/tasks` 一致）；tmux 内外一样。运行中也能进，运行提示行末尾的 `↓ Agent 栏` 就是提醒。键位动作 `app.agents.focus`（缺省只有 `down`），可在 `keybindings.json` 改。
- 按了没进去时底部提示一行（3 秒）：输入框有字——「输入框有字；清空后再按 ↓ 进 Agent 栏」（每段草稿一次，光标在末行时；`↓` 照常下移）；栏关闭——「Agent 栏已关闭（ui.agentBar），用 /tasks」；没有任务——「还没有子 Agent 任务」。在用 `↑` `↓` 浏览输入历史时 `↓` 只翻历史。
- `Ctrl+B` 不进栏，是「前台任务转后台」（见上）。想要原来的「`Ctrl+B` 进栏」可在 `keybindings.json` 写 `"app.agents.focus": ["down", "ctrl+b"]` 并把 `app.tasks.background` 改成别的键。
- 栏里：`↑` `↓` 选（列出本会话全部任务，窗口跟着滚；在第一项再按 `↑` 回到输入框），Enter 打开子 Agent 视图（选中的任务有停靠的审批时随即弹出），`b` / `Ctrl+B` 把选中的前台任务转后台（不是前台运行中的给一行提示），`x` 停止选中的任务（第一次提示「再按 x 停止 t2」，1.5 秒内再按才停），Esc 回到输入框；其它字母回到输入框并把字填进去。末行是按键提示 `↑↓ 选择 · Enter 打开 · b 转后台 · x 停止 · Esc 返回`，窄屏丢掉 `b` / `x` 两项。
- 嵌入宿主（有 profile）不再缺省关闭栏；宿主自己展示子任务、不要栏时在 profile 里写 `ui.agentBar: "off"`（见 [host-api.md](host-api.md)「嵌入 Armadra」）。关闭后栏不显示，`↓` 在有任务时提示改用 `/tasks`。

### 子 Agent 视图

栏里 Enter 或 `/tasks <id>` 打开。它是主屏上的底部覆盖层，高度是终端行数 − 1（不切备用屏），关掉之后消息区与回滚历史原样：

```
t2 explore · 运行中 1m05s · 3 轮 · ↑12k ↓3.4k · Esc 返回 · /tasks stop t2 停止
› 找出 src/tui 的测试缺口

⏺ grep "describe(" src/tui
  ⎿ 14 处匹配 · 6 个文件
…
────────────────────────────────────────
› 发给 t2
────────────────────────────────────────
```

- 正文实时跟随：ama 子 Agent 显示子会话的全部消息与工具调用（与消息区同样的渲染）；子会话句柄已被释放（保留上限 16 个）或会话是 resume 进来的，就只读加载子会话文件，任务再次运行时接上实时事件。外部 Agent（claude / codex / ACP）显示本进程内存里的实时输出（文本、思考、工具起止、回合、提示；最多 2000 条 / 1 MB，不落盘）；ama 重启后只剩一行说明「用原 CLI resume <会话 id> 查看全文」。
- 输入框为空时：`↑` / PgUp 上翻（暂停跟随，底部提示「已暂停跟随 · End 继续」），`↓` / PgDn 下翻，End（暂停时也可按 `f`）回到跟随；`←` `→` 切到上一个 / 下一个任务；Esc 返回主界面。输入框有字时 Esc 先清空。
- Enter 把输入发给这个子 Agent（会话里记为 `origin: "direct"` 的 user 消息，见 [session-format.md](session-format.md)）：ama 子 Agent 运行中 → 排到它本轮结束时送达；外部 Agent 运行中或任务还在排队 → 等本次运行结束后续聊；已结束 → 后台续聊（同 `task_ctl send`，完成后主会话照常收到 `<task-notification>`）。底部一行提示发送结果。父会话的模型不知道你直接和子 Agent 说过话，结果经结束通知自然带回。
- `Ctrl+X` 打断并发送给这个子 Agent：ama 子 Agent 运行中 → 中止它当前这一轮（工具按中断收尾）并立即以这条消息开新一轮，任务照常完成、照常通知主会话；外部 Agent 的驱动能中断单个回合（ACP `session/cancel`、Claude stream-json interrupt、Codex `turn/interrupt`）→ 中断后立即以它（连同之前排着的消息）开下一回合；不能（oneshot、宿主驱动）或任务还在并发池排队 → 退回排队并提示「不支持打断，已排队」；已结束 → 同 Enter 的后台续聊。`ui.enterWhileRunning: "interrupt"` 时与 Enter 互换。主会话不受影响。
- 视图里 Esc 不中断任何东西：Esc 只是返回。停止子任务用 `/tasks stop <id>`，转后台用 `Ctrl+B` 或 `/tasks bg [id]`——在视图输入框里也能用（视图里只认这两条命令）。
- 正在看的任务等审批时标题显示「等待审批」，审批框照常弹在视图上面（带 `[task:<类型>]` 来源）；它的审批停靠在栏里时，打开视图即弹出。

### 后台任务的审批停靠

后台任务（含转后台的）要审批时，不打断你正在做的事：

- 主会话在运行、输入框有草稿或已有别的覆盖层时，不弹框，先**停靠**：Agent 栏该任务行显示「等待审批」（黄色），运行提示行附 `↓ 处理审批`；子任务在这期间等着。
- 主会话空闲、输入框为空、没有覆盖层时自动弹出；进栏选中它按 Enter（打开视图）立即弹出。
- 停靠期间主会话自己或前台任务又要审批：审批是串行的，先弹停靠的这个，再弹它们，主会话的审批不会被挡住。
- 前台任务与主会话自己的审批照旧立即弹出；超时（缺省 10 分钟按拒绝）、中止与无人值守规则不变。RPC 客户端照常收到 `permission_request`，自己决定怎么呈现。

审批框的来源标注：

| 来源                                       | 标题前缀                                  | 正文                                          |
| ------------------------------------------ | ----------------------------------------- | --------------------------------------------- |
| task 子 Agent 的工具调用                   | `[task:explore]`（查不到类型时 `[task]`） | 同主会话                                      |
| 外部 Agent（claude / codex / ACP）请求权限 | `[claude · 会话 abc12345]`                | 外部 Agent 给的标题、种类、涉及路径与输入摘要 |
| 外部 Agent 本会话首次运行                  | 标题「首次运行外部 Agent」                | 说明（以你在该 CLI 的登录运行）与模式         |

三种都只有「允许 / 本会话允许同类 / 拒绝」三项（外部 Agent 的「本会话允许」由它自己记住）。Manual 模式下 `task(agent="claude")` 本来要问两次（task 调用一次、首次运行一次）：task 调用的审批框里已写明「以你在 claude CLI 的登录运行（含本会话首次运行确认）」，允许之后紧接着的首次运行确认自动通过，消息区一行「已允许 task（随上一次确认）」；中间夹了别的审批、拒绝、超过 60 秒，或不是这次调用建立的任务，首次运行确认照常弹出。

## 轨迹

`/trace` 打开当前会话的轨迹：按回合 → 请求 → 工具 → 子调用 / 子 Agent 分层，每行显示耗时、token 与缓存命中，
看清一次回答慢在哪里（首 token、解码、工具、审批、重试、压缩）。`/trace t2` 直接看任务 t2：ama 子 Agent 显示它
自己的子轨迹，外部 Agent（claude / codex …）只有回合骨架（种类、状态、时间与计数，没有命令行与路径）。

覆盖层在主屏底部、高 `行数 − 1`，退出后消息区不变：

```text
轨迹 · 1 回合 · 2 请求 · 3 次工具 · 12s · ↑8.1k ↓240 · 缓存 70% · ttft p50 0.8s / p90 0.9s · 120 tok/s
 ▾ #1 跑测试并找出 TODO                                    12s ▕██░░░░░░░▒██▏ ↑8.1k ↓240     70%
   ▾ 请求 claude-sonnet-4-5 · ttft 0.8s · 167 tok/s       1.7s ▕██░░░░░░░░  ▏ ↑3.9k ↓150     46%
       bash pnpm test                                     8.0s ▕ ░░░░░░░░░  ▏
       grep TODO                                          0.3s ▕ ░░         ▏
       ⛔ write notes.md                                  2.2s ▕ ░░░░       ▏
›    请求 claude-sonnet-4-5 · ttft 0.9s · 82 tok/s        2.0s ▕         ▒██▏ ↑4.2k ↓90      93%
↑↓ 移动 · → 展开 · ← 折叠 · Enter 详情 · f 跟随 · Esc 关闭
```

- **条形**是所在回合的相对时间轴：`▒` 首 token 等待（TTFT）、`█` 解码、`░` 工具；进行中的节点只画起点 `│`，不编造时长。
  ASCII（`ui.ascii` / `AMA_ASCII=1`）或无色（`NO_COLOR`）时降级为 `[==..--]`（`.` TTFT、`=` 解码、`-` 工具、`|` 起点）。
- **列**：↑ 是提示 token（含缓存读写），↓ 是输出 token，百分比是缓存命中（缓存读 / 提示 token）。宽 < 60 列只留标签与耗时，40 列可用。
- **记号**：`✗` 失败、`⛔` 被拒、`↻` 被重试掉的请求、`!` 中断或未完成、`·` 进行中；耗时前的 `≈`（ASCII `~`）表示**推算**——
  0.6 之前的会话没有计时记录，按条目时间估出，首 token 与吞吐不显示，汇总的 ttft 分位只用精确值。
- **按键**：`↑↓` / `PgUp` `PgDn` / `Home` `End` 移动；`→` 展开（子 Agent 展开时读它的子会话）或进到第一个子行，`←` 折叠或回到父行；
  `Enter` 详情卡片（类型、状态、开始时刻、耗时、模型与尝试次数、回退来源、TTFT、吞吐、token 与缓存、费用、审批等待；回合的提示、
  请求的回复文字、工具参数（截到 500 字符）与结果（截到 2000 字符）），卡片里 `↑↓` 滚动、`Esc` / `Enter` 返回；`f` 跟随开关；
  `Esc` 先关详情再关视图。
- **长会话**：先显示最后 50 个回合，顶部一行「更早的 N 个回合」上按 `Enter`（或在第一行继续按 `↑`）再往前加载 50 个；只渲染可见行。
- **运行中**：轨迹随会话事件刷新（最多每秒 2 次）；有进行中的节点时自动跟随最新一行，手动上移即暂停（标题右侧显示「已暂停跟随」），
  `End` 或 `f` 恢复。
- 保温与权限分类等辅助请求收在末尾「辅助请求 N 次」一组，缺省折叠。
- line 模式（`--ui line`、管道）里 `/trace [任务 id]` 打印同一棵树的文本（全部展开、不画条形）。

计时来自会话文件里的 `custom{customType:"ama.trace"}` 条目（[session-format.md](session-format.md)），只有 id、时间与计数；
提示、参数、结果的预览从会话条目按需读取，不进轨迹本身。

## Memory

需开启记忆（`ama memory enable` 或 `--memory`，见 [memory.md](memory.md)）。`/memory` 在消息区画一张卡片：每个作用域一段
（`用户 /memories/user/ · N 条 · 索引 X / 4.0 KiB`），条目一行「名字 — 说明 更新于 日期」，超过 90 天未更新的标灰；
索引超出上限时多一行黄字说明有几条没进系统提示；项目未受信任、本会话禁止写入时卡片底部各提示一行。

`/memory show <名字>` 把正文画成卡片；`/memory edit [名字|作用域]` 挂起界面打开 `$VISUAL` / `$EDITOR`（编辑临时副本，
保存退出后存回并重建索引，凭据与上限检查同模型写入）；`/memory rm <名字>` 弹确认框（缺省选中「取消」，`y` 删除、`n` / Esc 取消）；
`/memory on|off` 切本会话写开关；`/memory reload` 重渲染系统提示的 `memory` 节（提示会断一次缓存）。行式界面同一套命令输出文本，
`edit` 改用 `ama memory edit`，`rm` 需加 `--yes`。会话未开启记忆时只提示如何开启。

## 剪贴板图片

`Ctrl+V` 或 `/paste` 读系统剪贴板里的图片（macOS `osascript` / `pngpaste`，Linux `wl-paste` / `xclip`，Windows PowerShell），存为 `<数据目录>/clipboard/<时间>.png`，在输入框光标处插入 `@<路径>`，发送时按 `@图片` 附件处理（超过当前模型的单图上限时按 `images.resize` 缩放）。没有可用命令或剪贴板里没有图片时底部提示一行，输入框不变。文字仍用终端自己的粘贴（Cmd+V / Ctrl+Shift+V）。`ama sessions prune` 清理 7 天前的剪贴板文件。

## 启动画面

`ui.quietStartup` / `--quiet-startup`：`normal` 显示「AMA」字符画与信息列——版本、模型与思考级别、目录（`~` 缩写）与信任状态、权限模式 / 预设 / codemode、已加载的上下文文件 / Skill / 提示模板 / Hook、警告数与常用按键；宽 ≥ 72 列字符画在左、信息在右，48–71 列字符画在上，窄于 48 列退回两行简洁头（版本 · 模型 · 思考 / 模式 · 目录 · 信任）；`ui.logo: "off"` 或 `ui.compact` 只显示信息列。字符画按字母取主题的 accent → user → tool 三色，ASCII 模式换成 `_ / \ |` 拼的字形。启动时播放一次约 1 秒的「点亮」扫描（字形先暗后亮，高亮带从左扫到右，结束定格），只在原地重画、不在回滚里留帧；按任意键立即定格，按键照常进入输入框。以下情况直接显示定格帧：`ui.animation: false`、`NO_COLOR` / 无色终端、非 TTY、嵌入宿主（profile.host）、`CI` 环境、启动即带提示（`ama "…"`）、终端矮于 16 行或内容超出一屏；行式界面、`-p`、RPC、ACP 不画启动头。`header` 只有一行 `✻ ama 版本 · 模型 · 模式 · /help`（profile 缺省）；`silent` 不显示。`--resume` 不带 id、模型没有 key、会话目录不存在、项目资源需要信任时，界面启动前会先出现一个小的选择 / 输入提示，答完收成一行留在屏幕上。

## 在 tmux / Armadra 终端节点里

- 括号粘贴：启动时开启；粘贴的多行内容整体进入输入框（超过 10 行或 1 000 字符折叠为 `[粘贴 #N · M 行]`），粘贴后紧跟的回车直接发送，适合由外部程序写入。
- 不查询终端能力、不开鼠标与 Kitty 键盘协议，避免回包混进输入；tmux ≥ 3.4 透传同步输出，旧版本也能正常显示。
- tmux 的缺省前缀 `C-b` 会被 tmux 客户端吃掉：转后台按 `C-b C-b`（`send-prefix` 透传），或 `↓` 进 Agent 栏按 `b`；进栏用 `↓`，不受前缀影响。
- 窗口尺寸变化时整屏重画最后一屏，回滚里的历史不受影响。
- 自动降级：非 TTY、`TERM=dumb`、`--no-tui` 或终端初始化失败时使用行式界面，命令与审批问答相同。

## 配置与排错

`config.json` 的 `ui` 段（项目级也可设）：

| 键                | 缺省        | 作用                                                                                          |
| ----------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `ui.theme`        | `dark`      | `dark` / `light` / `auto`；auto 只看 `COLORFGBG`（不发终端查询），猜不出用 dark，建议显式配置 |
| `ui.ascii`        | 自动检测    | ASCII 字形（`›` → `>`、`⏺` → `*`、`⎿` → `L`、框线 → `+ - \|`、spinner 4 帧）                  |
| `ui.compact`      | `false`     | 消息区块间不空行、启动头不画字符画                                                            |
| `ui.logo`         | `auto`      | 启动头的「AMA」字符画；`off` 只显示信息列                                                     |
| `ui.animation`    | `true`      | `false`：运行中 spinner 静止为 `·`，只在秒数变化时重绘；启动字符画不播放动画                  |
| `ui.markdown`     | `true`      | `false`：助手正文不做 Markdown 渲染                                                           |
| `ui.showThinking` | `collapsed` | 见「布局」                                                                                    |
| `ui.quietStartup` | `normal`    | 见「启动画面」                                                                                |

- **ASCII 模式**：`AMA_ASCII=1`（或 `ui.ascii: true`）强制开启，`AMA_ASCII=0` 强制关闭；自动检测在区域设置（`LC_ALL` > `LC_CTYPE` > `LANG`）已设置但不含 UTF-8、`TERM=linux`、Windows 上既没有 `WT_SESSION` 也没有 `TERM_PROGRAM`（旧 conhost）时开启。Windows Terminal 走 Unicode。
- **字符错位**：`⏺`（U+23FA）、`⎿`、`▎` 在个别字体（尤其 emoji 回退字体）下画成两格，宽度计算按 wcwidth（一格），会出现列错位或残影——换等宽字体或设 `AMA_ASCII=1`。
- **颜色**：`NO_COLOR` 或 `TERM=dumb` 无色；16 色终端按内置表取近，选中行不用底色而用强调色粗体；浅色终端设 `ui.theme: "light"`。

### `/config` 设置面板与 `ama config`

`/config` 打开设置面板（底部覆盖层）：按分组列出约 60 个标量设置，每行「标签 · 生效值 · 生效档 · 来源」。

```text
▎ 设置  写入：用户级 ~/.config/ama/config.json  [Tab 切换]
▎ / 搜索
▎ 界面
▎ › 主题                      light             重启             来源 user
▎   Markdown 渲染             true              即时
▎ 权限
▎   权限模式                  plan              即时             [锁定] project
▎ ────────────────────────────────────────────────────────────
▎ 配色主题：dark、light，或 auto（…）
▎ ↑↓ 选择 · Enter/空格 修改 · / 搜索 · Tab 用户级/项目级 · Backspace 恢复缺省 · Esc 关闭
```

- **按键**：↑↓ 移动；Enter / 空格：布尔取反、≤ 4 项的枚举循环、更长的枚举（思考强度、权限模式等）与模型开选择器、数字和文本开行内输入（非法值红字留在框里，Esc 放弃）；`/` 搜索键名、标签、枚举值与说明，Esc 先清搜索再关闭；Backspace / Delete 按两次 = 删掉写入层里的这一项（回到下层的值）。
- **写入层**：缺省写用户级 `~/.config/ama/config.json`；Tab 切到项目级 `.ama/config.json`，只许收紧（与合并规则同一判定），只认用户级的项变灰、Enter 给出原因。改动**立即写盘**（写前重读文件、只改这一项、校验、留 `.bak`），没有「保存」按钮；没有文件锁，与 `ama config edit` 同时改时后写者覆盖这一项。手排的格式会被规整成 2 空格缩进。
- **来源与锁定**：来源是 default / user / profile / project / cli / env；被更上层覆盖的项（profile、项目级、命令行参数、`AMA_CACHE_WARMING` 等环境变量）标 `[锁定]`，说明行写出原因，不让改。嵌入宿主（有 profile）时标题提示「写入用户级配置」。
- **生效档**：「即时」项当场作用于本会话与界面（主题以外的 `ui` 显示项、`defaultModel`、`thinkingLevel`、`permission.mode`、`compaction.enabled`、`retry.enabled`、`cache.warming`）；「新会话」项在 `/new` / `/resume` 后生效；「重启」项（工具预设、codemode、沙箱、`ui.theme`、`ui.ascii`、`ui.language` 等）下次启动生效。面板 = 持久化，`/model` `/thinking` `/permission` `/statusline` 仍只改本会话。
- **缓存**：标「动缓存」的项会改变缓存前缀；对话已有回复时第一次改这类项，面板底部提示一次「下一次请求按未命中计费」。
- 面板里把 `permission.mode` 设为 `full-auto` 会先弹 Bypass 确认，并说明以后每次启动都生效。
- 关闭时消息区出一条汇总：「主题：dark → light（用户级）」，需重启 / 新会话生效的项另列一行；没改动不出。
- 列表、对象类的键不在面板里，最后一组「在别处修改」给出入口（`ama providers`、`/permissions`、`ama config edit`、`--json-value` 等）。

`/config key=value`（或 `/config key value`）不开面板，直接写用户级一项，回显与命令行相同；line 模式同样可用，无参数时列出全部设置。

命令行（与面板共用编辑核心）：

```text
ama config get <key> [--json]                              生效值、来源、生效档
ama config set <key> <value> [--project] [--json-value] [--yes]
ama config unset <key> [--project]
ama config list [前缀] [--json] [--all]                    缺省只列面板里的设置
```

值按类型解析：`true/false/on/off/1/0`、数字（可写 `30_000`）、枚举不分大小写、`none` / `unset` = 删除；列表与对象用 `--json-value`（如 `ama config set tools.disabled '["bash"]' --json-value`）。未知键、非法值、项目级放宽被拒都退出码 3，文件不动；`get` / `list` 不会创建配置目录。`ama config set permission.mode full-auto` 在终端里先确认，非终端需要 `--yes`。

可选 `ui.replyLanguage`（如 `Chinese`）：会话开始在系统提示 `rules` 节末尾追加一句英文规则 `Reply to the user in Chinese.`，不设时请求零字节变化；只认用户级 / profile。

## 组件库（`@armadra/agent/tui`）

交互模式用的终端组件单独导出，零依赖，宿主或其它 Node 程序可以直接用来画主屏界面。

```ts
import { TUI, ProcessTerminal, Text, Editor, createTheme } from "@armadra/agent/tui";

const tui = new TUI(new ProcessTerminal());
const theme = createTheme("dark");
const log = new Text("");
const editor = new Editor({
  theme,
  requestRender: () => tui.requestRender(),
  onSubmit: (text) => {
    log.setText(`you said: ${text}`);
    tui.requestRender();
  },
});
tui.addChild(log);
tui.addChild(editor);
tui.setFocus(editor);
tui.start();
```

| 导出                                                                      | 作用                                                                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Component`、`Focusable`、`CURSOR_MARKER`                                 | 组件契约：`render(width)` 返回各行（每行可见宽 ≤ width）、`handleInput?(data)`、`invalidate()`；获焦组件在光标处输出 `CURSOR_MARKER`                       |
| `TUI`                                                                     | 根容器与差分渲染（主屏、同步输出）：`addChild`、`start` / `stop`、`requestRender`、`setFocus`、`addInputListener`、`showOverlay`                           |
| `ProcessTerminal`、`MemoryTerminal`、`VirtualScreen`                      | 真实终端（raw 模式、括号粘贴）；内存终端与 VT 屏幕（测试、帧黄金）                                                                                         |
| `Container`、`Text`、`TruncatedText`、`Markdown`、`Box`、`Card`、`Spacer` | 基础组件；`Card` 是左竖条卡片，`Box` 可设 `borderColor`                                                                                                    |
| `Loader`                                                                  | 运行指示：`setVerb(动词, 附加项, { elapsed, optional })`（`optional` 一行放不下时整项丢掉）、`frame` / `onFrame`（与别的组件同帧换字）、`animation: false` |
| `Editor`、`EditorBuffer`、`PasteStore`                                    | 多行编辑器（历史、补全接口 `AutocompleteProvider`、粘贴折叠）                                                                                              |
| `SelectList`                                                              | 可过滤的选择列表：分组、徽标、数字键、`stacked`、`currentValue`（✓）、`footer` 按键提示                                                                    |
| `KeyValue`、`Meter`                                                       | 两列对齐的键值表（`wrap` 折行对齐值列）；余量表（`levelColor` 阈值着色）                                                                                   |
| `compositeOverlays`、`OverlayOptions`                                     | 覆盖层合成（居中 / 底部锚定）                                                                                                                              |
| `createTheme`、`plainTheme`、`detectCapabilities`、`Theme`                | 主题与颜色能力探测（`NO_COLOR`、16 / 256 / truecolor）；14 个语义色，`resolveThemeName("auto")`                                                            |
| `Theme.glyphs`、`UNICODE_GLYPHS`、`ASCII_GLYPHS`、`detectAscii`           | 字形表（`›` `⏺` `⎿` `✻` `▎`、框线、spinner 帧……）与 ASCII 回退；`createTheme(name, { ascii })`                                                             |
| `Keybindings`、`DEFAULT_KEYBINDINGS`、`loadKeybindingsFile`               | 动作 id → 按键，`keybindings.json` 覆盖                                                                                                                    |
| `parseKey`、`matchesKey`、`StdinBuffer`                                   | 键序列解析与 Esc 超时切分（`AMA_TUI_ESC_TIMEOUT`）                                                                                                         |
| `visibleWidth`、`truncateToWidth`、`wrapTextWithAnsi`、`sliceByColumn` 等 | 带 ANSI 与宽字符的宽度计算与截断                                                                                                                           |

## 测试

帧黄金都在 `test/fixtures/tui/`，`MemoryTerminal` 还原屏幕（无色，只验布局与字形）：

- `src/modes/interactive/interactive-mode.test.ts`：80x24、40x24 跑一次完整的读文件 run（启动、输入、工具运行中、结束、`Ctrl+O` 展开、退出摘要）→ `run-*.txt`；审批、缓存提示等。
- `src/modes/interactive/interactive-frames.test.ts`：启动头（`startup-normal-*`、`header-quiet-*`；字符画各变体与动画见 `startup-logo.test.ts` / `startup-logo-*`）、工具层级（`tools-*`）、提示（`notices-*`）、运行中动词（`loader-verbs-*`）、`/session` 面板（`panel-session-*`）、ASCII 模式整条 run（`ascii-run-*`）。
- 第五波（W5-U）：`plan-dialog.test.ts`（`plan-dialog-*`：四选项、执行模式、修改意见、外部编辑、ASCII、40 列）、`approval-origin.test.ts`（`approval-origin-*`、`approval-task-agent-*`、`approval-first-run-*`、`approval-task-external-*` 与首次运行合并）、`subagent-view.test.ts`（`subagent-view-*`）、`tasks-panel.test.ts`（`tasks-picker-*`、`tasks-output-*`、`agents-panel-*`）、`harness-notices.test.ts`（`harness-notices-*`）、`interactive-w5.test.ts`（plan → 审批 → 执行、`/plan`、后台任务进 `/tasks`、Ctrl+V，`interactive-plan-*`、`interactive-tasks-*`）。
- `src/tui/tui-frames.test.ts`：组件级（对话、Markdown、编辑器占位 / 多行 / 粘贴 / 补全）；`status-bar.test.ts` 的 `status-widths.txt`；`approval-dialog.test.ts`、`pickers.test.ts` 的审批与模式选择器。

改界面后用 `AMA_UPDATE_GOLDEN=1 pnpm vitest run src/modes/interactive src/tui` 更新，并逐个审阅 `git diff test/fixtures/tui`。
