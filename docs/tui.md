# 终端界面

> 草稿（B7）：交互模式的使用说明。组件库（`@armadra/agent/tui`）的 API 说明由 B9 统稿时补入；设计依据见 [design.md](design.md) §12。

`ama` 在终端里直接运行（stdin / stdout 都是 TTY、`TERM` 不是 `dumb`、没有 `--no-tui`）时进入交互模式。界面只用**主屏**：对话历史滚进终端回滚，不切备用屏，所以在 tmux 里 `capture-pane` 能读到完整对话，退出后对话也留在屏幕上。

## 布局

```
ama 0.1.0 · Enter 发送 · Esc 中断 · Ctrl+C 两次退出 · /help 命令    ← 启动画面
› 读一下 README                                                    ← 用户消息
思考 · 120 token                                                    ← 思考块（折叠）
● read  README.md                                                   ← 工具调用
  …前 3 行结果…
回答正文（Markdown）
↳ followUp  之后再提交                                               ← 排队消息
⠋ 工作中 · Esc 中断 (12s)                                            ← 运行中
──────────────────────────────────
输入框
──────────────────────────────────
anthropic/claude-sonnet · think:medium · ↑12k ↓1.2k · cache 80% ♨ · $0.12 · rebill $0.11 · ctx 34% · mode:default · preset:default
```

- **用户消息**：`›` 开头；运行中插话标 `↳ steer`，排到本轮之后的标 `↳ followUp`，宿主（Armadra 画布）注入的标 `↳ host`。
- **思考块**：`ui.showThinking` = `collapsed`（缺省，一行计数）/ `full`（全文）/ `hidden`。
- **工具调用**：一行标题，圆点运行中为强调色、成功绿、失败红；折叠显示结果前 3 行，`edit` 显示 diff（前 12 行），`bash` 运行中滚动显示最后 8 行。`Ctrl+O` 展开 / 折叠全部。codemode 脚本里的内层调用挂在外层调用下面。
- **提示**：压缩摘要卡、`↻ 重试 n/m`、`⛔ Hook 阻止`、宿主通知、审批被拒或超时的说明都进消息区。
- **状态栏**：模型 · 思考级别 · `↑` 输入（含缓存读写）`↓` 输出 · 缓存 · 费用 · 重计费 · 上下文占用 · 排队数 · 权限模式 · codemode · 工具预设 · 宿主状态。终端太窄时依次丢弃宿主状态、预设、重计费、费用、缓存、token、思考级别、排队数、codemode，模型、上下文与权限模式最后丢。

## 缓存与上下文

> 草稿（W3-C2）：第三波 §1.10 的展示面。

状态栏各项：

| 项              | 含义                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `cache 83%`     | **最近一次**请求的命中率（读缓存 /（输入 + 缓存读 + 缓存写））；会话累计在 `/session`                               |
| `cache —`       | 端点还没报过缓存（`unknown`：还没有足够长的可比请求）                                                               |
| `cache 未报告`  | 端点不报缓存（`silent`：连续 3 个可比请求读写都是 0，或 `compat.cacheReporting: "silent"`）；这类请求不进命中率分母 |
| `♨`             | 保温计时中（工具长时间运行时按 TTL 重放前缀，`/cache warm` 可切换）                                                 |
| `rebill $0.11`  | 本会话缓存未命中导致的重计费金额；模型没有价格时显示 token 数；为 0 不显示                                          |
| `ctx 72%`       | 上下文占用，≥ 70% 黄色、≥ 90% 红色；`ctx ?` 表示模型没有窗口信息                                                    |
| `codemode:only` | codemode 生效（`on` / `only`）；运行时 Node 的权限模型不隔离网络（Node 22 / 24）时追加红色 `net!`                   |

消息区（line 模式写 stderr，前缀 `ama: `）只在两种情况下提示一行，`cache.missNotices: false` 可关：

- 一次未命中重计费 ≥ 20k token 或 ≥ $0.10：`缓存未命中（空闲 7 分钟后）：重计费 38.2k token（约 $0.11）`。原因有空闲超时、子任务运行、切换模型、系统提示 / 工具表变化、服务端淘汰；更小的未命中只进统计。
- 上下文占用跨过 70% / 90%（各一次）：`上下文已用 72%，约剩 9 回合（按最近 5 回合均值）`；回合数估不出时给余量 token。
- line 模式在 `AMA_LOG=info` 时另写保温成功：`缓存保温已刷新（读 12k token，$0.001）`。

`/session` 在会话信息之后有「缓存」段，`/cache` 只显示这一段：

```
缓存
  输入      3.4k = 缓存读 2.2k（65%）+ 未缓存 1.2k
  报告状态  reported
  命中率    最近 84% · 会话 65%
  未命中    0 次
  保温      streaming · 已停止：模型目录没有缓存 TTL
  上下文    1%，余量 ≈ 127k token ≈ 2443 回合
```

未命中行按原因分列（`3 次，重计费 61k token ≈ $0.18（空闲超时 2 · 前缀变化 1）`）；保温行在计时中显示 `streaming · 下次 2m 10s · 期望节省 $0.18 ≥ $0.05`，停止时给原因；有 task 子会话时另有「子任务」行。

- `/cache warm off|streaming|idle`：本会话内切换保温（不写配置；`idle` 在空闲时也保温，适合贵模型）。
- `/cache fingerprint`：最近一次真实请求的前缀指纹——system 与工具表各一个 16 位哈希加模型名。两次之间哈希变了，就是宿主或 Hook 中途改了系统提示 / 工具表。

定稿的取舍：状态栏显示最近一次命中率（会话累计放 `/session`）；`cache.missNotices` 缺省开（门槛下很少触发）；`Meter` 组件不进缺省状态栏。

`ama models cache-probe <provider/model>` 用一个固定前缀相隔几秒发两次最小请求，判定端点 `reported` / `silent` / `inconclusive` 并给出配置建议（会计费：先打印预估，非交互环境需 `--yes`）。

## 按键

| 按键                 | 作用                                                               |
| -------------------- | ------------------------------------------------------------------ |
| Enter                | 发送；运行中 = steer（插到当前轮）                                 |
| Alt+Enter            | 运行中排到本轮之后（followUp）；空闲时等同 Enter                   |
| Shift+Enter / Ctrl+J | 换行                                                               |
| Esc                  | 中断：排队的消息回填到输入框，然后停止当前运行；补全打开时先关补全 |
| Alt+↑                | 取回最后一条排队消息                                               |
| Shift+Tab            | 循环权限模式 plan → default → auto-edit → full-auto                |
| Ctrl+O               | 展开 / 折叠工具输出                                                |
| Ctrl+L / Ctrl+T      | 选择模型 / 思考级别                                                |
| Ctrl+C               | 清空输入；输入为空时 1.5 秒内再按一次退出（退出码 130）            |
| Ctrl+D               | 输入为空时退出                                                     |
| Tab                  | 补全                                                               |
| ↑ / ↓                | 单行时浏览历史（`<数据目录>/history`，500 条）                     |

按键可在 `~/.config/ama/keybindings.json` 覆盖，键是动作 id（`app.interrupt`、`app.message.followUp`、`tui.editor.newLine` ……），值是按键或按键数组，空数组表示禁用。

## 命令

`/help` 列出全部命令。交互模式另有：

- `/tree`：列出会话里的全部用户消息（分叉处缩进，`●` 是当前分支）；选中一条后回到它之前，原文回填输入框，修改后发送就形成新分支。
- `/fork`（无参数）：同样选一条用户消息，从它之前复制出新会话。
- `/model`、`/resume`、`/permission`、`/thinking` 不带参数时打开选择器；`/permissions` 显示权限判定顺序与已加载规则。
- `/session`、`/cache`：会话用量与缓存统计（见下文「缓存与上下文」）。

## 补全

- 首行行首输入 `/`：命令、提示模板（`/<名字>`）、Skill（`/skill:<名字>`）。
- `@`（行首或空格之后）：当前目录下的文件与目录（尊重 `.gitignore`），含 `*` `?` `[` `{` 时按 glob 匹配相对路径。

## 审批

工具调用需要确认时，底部弹出对话框：bash 显示完整命令，write 显示路径与行数，edit 显示每处修改的 −/+ 摘要；子 Agent 发起的请求标 `[task]`。`y` 允许、`n` / Esc 拒绝、`a` 本会话内同类不再询问、`v` 查看完整输入。10 分钟不作答按拒绝处理（`AMA_APPROVAL_TIMEOUT_MS` 可改）。

## 启动画面

`ui.quietStartup` / `--quiet-startup`：`normal` 显示标题、模型、目录与信任状态、已加载的上下文文件 / Skill / 提示模板 / Hook；`header` 只有标题行（profile 缺省）；`silent` 不显示。`--resume` 不带 id、模型没有 key、会话目录不存在、项目资源需要信任时，界面启动前会先出现一个小的选择 / 输入提示，答完收成一行留在屏幕上。

## 在 tmux / Armadra 终端节点里

- 括号粘贴：启动时开启；粘贴的多行内容整体进入输入框（超过 10 行或 1 000 字符折叠为 `[paste #N +M lines]`），粘贴后紧跟的回车直接发送，适合由外部程序写入。
- 不查询终端能力、不开鼠标与 Kitty 键盘协议，避免回包混进输入；tmux ≥ 3.4 透传同步输出，旧版本也能正常显示。
- 窗口尺寸变化时整屏重画最后一屏，回滚里的历史不受影响。
- 自动降级：非 TTY、`TERM=dumb`、`--no-tui` 或终端初始化失败时使用行式界面，命令与审批问答相同。

## 测试

`src/modes/interactive/interactive-mode.test.ts` 用 `MemoryTerminal`（80x24、40x24）+ fake 供应商跑一次完整的读文件 run，把启动、输入、工具运行中、结束、`Ctrl+O` 展开、退出各帧写进 `test/fixtures/tui/run-*.txt`。改界面后用 `AMA_UPDATE_GOLDEN=1 pnpm vitest run src/modes/interactive` 更新并审阅差异。
