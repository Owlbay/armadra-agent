# Agent 切换修复与主会话并行交流设计

> 针对两条用户反馈：① 「`Ctrl+B` / `↓` 进 Agent 栏、Enter 开子 Agent 视图没有效果」；② 「ama 运行其它 Agent 时主会话应该还能继续交流，像 Claude Code 那样」。
> 本文是设计稿（目标），现状以 [tui.md](tui.md)「子 Agent」与 [agents.md](agents.md) 为准；实施完成后把本文结论回写到那两份文档，本文留作依据。
> 复现基于 main `98edd83`（0.6.2 + 未发布修复）的打包产物 `dist/bundle/ama.cjs`，2026-10-03。

## §0 结论

| #   | 决定                                                                                                                                                                                                                                                                                                                                             | 理由 / 证据                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 问题 1 不是处理器坏了：按键链路在 80×24 / 120×40、运行中 / 空闲、tmux 内（`send-keys`）/ tmux 外（expect 伪终端）都能进栏、开视图（§1.2）。失败只在四种环境条件下复现：tmux 客户端吞掉 `Ctrl+B`；`↓` 又只在「栏可见」时生效；嵌入宿主（有 profile）缺省 `ui.agentBar: "off"`；输入框有字时两个键都无声落回编辑器。                               | §1.2 复现记录、§1.3 根因（`key-dispatch.ts:153-160`、`agent-ui.ts:305-306`、`merge.ts:60`、`keybindings.ts:50`）                                                                                                           |
| D2  | 修法是换键位 + 放宽门控 + 给反馈，不改状态机：`↓`（空输入，**有任务即可**，不再要求栏可见）成为进栏主键；`Ctrl+B` 改作「前台任务转后台」（与 Claude Code 对齐）；运行提示行与栏末行写明按键；输入有字时按进栏键给一行提示。                                                                                                                      | tmux 缺省前缀就是 `C-b`，Claude Code 自己的 keybindings 文档也把 tmux `ctrl+b` 列为要避开的冲突；`↓` 在空输入、未浏览历史时本来是空操作（`editor.ts:293-296`），可以无损征用                                               |
| D3  | 子 Agent 缺省后台运行（`task.background` 缺省 `true`），模型只在「下一步必须等结果」时写 `background:false`；`-p` 强制前台缺省。工具描述与一句规则按 Claude Code 的措辞改写，固定英文、会话内不变。                                                                                                                                              | Claude Code 工具描述：「Agents run in the background by default… Set to false only when your very next action depends on this agent's result」；现有后台通道（`notify` → `followUp(origin:"task")`、W5-H2 收尾投递）已稳定 |
| D4  | 新增「转后台」原语：`SubagentRegistry.background(taskId?)` 让阻塞中的前台 `task`（及 `task_ctl wait`）立即以固定英文结果返回，主回合继续，任务改记后台、完成后照常 `<task-notification>`。入口：TUI `Ctrl+B`、栏 / 视图内 `b`、`/tasks bg [id]`、RPC `background_task`、SDK `session.backgroundTask()`、配置 `subagents.autoBackgroundAfterMs`。 | Claude Code 的 `background_tasks` 控制请求：「Each blocking tool call returns immediately with a 'running in the background' tool_result and the turn continues」                                                          |
| D5  | Esc 语义不变：中断主回合连带中止**仍是前台**的任务（它们属于本回合）；已转后台 / 本来就是后台的任务不受影响。                                                                                                                                                                                                                                    | 转后台时解绑父 `signal`（`subagent-registry.ts:277-281` 的 `onParentAbort`）即可；与 Claude Code 一致                                                                                                                      |
| D6  | 后台任务的审批不再独占主输入框：主会话忙或输入框有字时「停靠」在 Agent 栏（状态「等待审批」+ 提示行），空闲且输入为空时自动弹出；栏里 Enter 立即处理。前台任务与主会话自己的审批照旧立即弹出。                                                                                                                                                   | 现在审批框一开就 `editor.disableSubmit = true`（`interactive-mode.ts:462-470`），后台任务一问权限主会话就不能发消息，与「继续交流」矛盾                                                                                    |
| D7  | 分三批实施：A「Agent 栏可达性」、B「core 转后台与缺省后台」（可再拆 B1 / B2）并行；C「TUI 接入转后台与审批停靠」在 A、B 之后。文件所有权互不重叠（§5）。                                                                                                                                                                                         | A 只碰键位与栏；B 只碰 core / 工具 / RPC / 配置；C 才把两者接起来                                                                                                                                                          |

需要用户确认的事项见 §6（都给了推荐缺省，不确认就按推荐做）。

## §1 问题 1：Agent 栏「没有效果」

### §1.1 现状链路

```text
终端字节 → TUI.handleInput（tui.ts:193）→ 监听器 createKeyDispatch（key-dispatch.ts:143）
  ├ inactive()（已退出或有覆盖层）→ 不处理
  ├ agents.handleKey：栏聚焦时先消费（↑↓ / Enter / Esc / Ctrl+B / 可打印字符）
  ├ app.agents.focus（ctrl+b | down）且 editor.isEmpty() 且补全未开 → agents.focus(data)
  │     agent-ui.ts:304 focusFromKey：视图未开、ui.agentBar ≠ off；↓ 另要求 bar.visible；bar.focus() 要求注册表有任务
  └ 其余 app.* 动作 → 落回编辑器（Ctrl+B = 光标左移，↓ = 下移 / 历史下一条）
```

`inactive()` 是 `finished || tui.hasOverlay`（`interactive-mode.ts:441`），`busy()` 没参与进栏判定——**运行中也能进栏**，设计如此。

### §1.2 复现记录

环境：`dist/bundle/ama.cjs`，`--model fake/echo --tools read,task --permission-mode full-auto --no-session --trust`，fake 脚本让父会话调 `task(agent="explore")`，子会话 `delayMs` 15–40 s 后回报（父子共用一份脚本，第 n 次调用取第 n 条）。按键用 `tmux send-keys`（直接注入 pane，不经过 tmux 客户端的前缀处理）。

| #   | 场景                                                                                                                     | 操作               | 现象                                                                                                                                                        | 结论                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | 80×24，前台 task 运行中（主回合阻塞，提示行 `⠏ 运行 task · 3s · Esc 中断`），栏显示 `⏺ t1 explore · 运行中 3s  fg scan`  | `Ctrl+B`           | 栏聚焦：`› ⏺ t1 …` + 末行 `↑↓ 选择 · Enter 打开 · Esc 返回`                                                                                                 | 运行中可进栏                            |
| 2   | 同上，栏聚焦                                                                                                             | `↓`                | 停在唯一一项                                                                                                                                                | 正常                                    |
| 3   | 同上                                                                                                                     | `Enter`            | 底部覆盖层：标题 `t1 explore · 运行中 33s · Esc 返回 · /tasks stop t1 停止`，正文 `› find the entry file`，输入框 `› 发给 t1`；子会话还没产出时正文只有提示 | 视图可开；子会话无输出时正文空白是预期  |
| 4   | 视图内                                                                                                                   | `Esc`              | 回主界面，栏仍显示 t1 运行中                                                                                                                                | 正常                                    |
| 5   | 输入框有字 `ab`                                                                                                          | `Ctrl+B`           | 光标左移一格，栏无变化，**无任何提示**                                                                                                                      | 设计如此，但零反馈                      |
| 6   | 空闲，t1 已完成未查看（栏 `⏺ t1 explore · 完成 15s · 1 轮`）                                                             | `Ctrl+B` → `Enter` | 进栏；视图标题 `t1 explore · 完成 15s · 1 轮 · ↑1k ↓7 · Esc 返回`，正文含子会话最终回复                                                                     | 空闲可进栏、可看完成任务                |
| 7   | 视图 Esc 返回后（已查看的完成任务从栏消失）                                                                              | `↓`                | **无反应**（栏不可见，`focusFromKey` 对 `down` 返回 false）                                                                                                 | `↓` 的「栏可见」门控导致不对称          |
| 8   | 同上                                                                                                                     | `Ctrl+B`           | 进栏（有任务即可）                                                                                                                                          | 与 #7 对比                              |
| 9   | 120×40，子会话有 `read` 调用                                                                                             | `Ctrl+B` → `Enter` | 栏 `⏺ t1 explore · 运行中 4s · 1 轮 · read`；视图正文实时显示子会话的文本与 `⏺ read …` 工具行                                                               | 宽屏正常，视图跟随子会话                |
| 10  | 后台 task（`background:true`）                                                                                           | 观察               | task 工具行 `完成 · 0.0s` + 跟随行 `↳ t1 explore · 运行中 5s`，父会话随即空闲，栏显示 t1 运行中                                                             | 后台通道正常                            |
| 11  | **嵌套 tmux**：外层 tmux pane 里 `tmux attach` 到内层会话，向外层 pane 注入 `C-b`（等价于人在 tmux 客户端里按 `Ctrl+B`） | `Ctrl+B`           | **栏无变化**——被内层 tmux 客户端当作前缀吃掉                                                                                                                | tmux 缺省前缀吞键，确证                 |
| 12  | 同上                                                                                                                     | `↓`                | 进栏                                                                                                                                                        | 文档里「tmux 用 ↓」成立，但只在栏可见时 |
| 13  | **tmux 外**：`/usr/bin/expect` 伪终端直接起 ama（`TERM=xterm-256color`），发 `\x02`、`\x1b[B`、`\r`                      | 同 #1–#3           | 日志里出现 `↑↓ 选择 · Enter 打开` 3 次、`发给 t1` 1 次、`Esc 返回 · /tasks stop` 2 次                                                                       | 不在 tmux 里链路同样通                  |

没有复现出「按键到达进程却不响应」的情况。

### §1.3 根因

1. **键选错了**：`app.agents.focus` 缺省 `["ctrl+b", "down"]`（`src/tui/keybindings.ts:50`）。`Ctrl+B` 是 tmux 的缺省前缀，在 tmux 客户端里永远到不了 ama（#11）；Claude Code 的 keybindings 文档也把「tmux (`ctrl+b`)」列为必须警告的冲突，它自己把 `ctrl+b` 用作「任务转后台」而不是导航。用户若在 tmux 里（或任何把 `Ctrl+B` 当快捷键的宿主）试 `Ctrl+B`，就是「没有效果」。
2. **`↓` 的门控比 `Ctrl+B` 严**：`agent-ui.ts:306` 对 `down` 额外要求 `bar.visible`，而 `visibleRows()`（`agent-bar.ts:160-170`）在任务结束并被查看后、或超过 10 分钟后为空——这时 `↓` 没反应、`Ctrl+B` 却能进栏（#7 vs #8）。tmux 用户被引导用 `↓`，恰好撞上更严的门。
3. **嵌入宿主缺省关闭**：`PROFILE_DEFAULTS.ui.agentBar = "off"`（`src/config/merge.ts:60`）。带 profile 启动（Armadra 画布等）时 `barEnabled()` 为 false，`focusFromKey` 直接返回 false，两个键都落回编辑器，`/tasks` 退回旧选择器——与反馈完全吻合的「全部不能用」。
4. **零反馈**：三种落空（有字、栏关闭、无任务）都无声；运行提示行只写 `Esc 中断`，未聚焦的栏不显示任何按键提示，用户无从得知「要先清空输入」或「在 tmux 里换键」。

次要：`docs/tui.md` 键位表把 `Ctrl+B / ↓` 写成等价，没有说明 `↓` 的附加条件。

### §1.4 修复（批次 A）

| 改动                                                                                                                                                                                                                                             | 文件                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `app.agents.focus` 缺省改为 `["down"]`；`focusFromKey` 去掉 `bar.visible` 门控（有任务即可，与 `/tasks` 一致）。`Ctrl+B` 从该动作移除，留给 §2 的 `app.tasks.background`（批次 A 先不绑定任何新动作，键落回编辑器）。                            | `src/tui/keybindings.ts`、`src/modes/interactive/agent-ui.ts`                                                                          |
| 栏聚焦时 `Ctrl+B` 不再是「返回」（`agent-ui.ts:322` 去掉 `app.agents.focus` 的 blur 分支里对它的依赖——用 `tui.select.cancel` 与 `app.agents.focus` 本身即可，自动随键位表变化）。                                                                | `agent-ui.ts`                                                                                                                          |
| 落空反馈：进栏键在输入有字时提示「输入框有字；清空后再按 ↓ 进 Agent 栏」；`ui.agentBar: off` 时提示「Agent 栏已关闭（ui.agentBar），用 /tasks」；无任务时提示现有 `agents.bar.empty`。提示走 `showHint`（底部提示行，3 s）。                     | `key-dispatch.ts`（`agents.focus` 返回 `true \| "busy-input" \| "disabled" \| "empty"`）、`agent-ui.ts`、`src/i18n/messages/agents.ts` |
| 运行提示行：有子 Agent 任务时追加 `↓ Agent 栏`（`⠏ 运行 task · 4s · Esc 中断 · ↓ Agent 栏`），窄屏先丢它。未聚焦的栏末行不加（省行）。                                                                                                           | `src/modes/interactive/run-indicator.ts`、`src/i18n/messages/interactive.ts`                                                           |
| 嵌入宿主：`PROFILE_DEFAULTS` 不再强制 `agentBar: "off"`，改为由宿主 profile 显式写（Armadra 若自己展示节点再关）。见 §6 Q3。                                                                                                                     | `src/config/merge.ts`、`docs/host-api.md`（profile 字段说明）                                                                          |
| 文档：键位表与「Agent 栏」节改写（`↓` 唯一缺省进栏键；tmux 说明改为「`Ctrl+B` 在 tmux 里要按两次 `C-b C-b`（send-prefix）才能透传」挪到 §2 的转后台键）。                                                                                        | `docs/tui.md`、`docs/en/tui.md`、CHANGELOG 未发布段                                                                                    |
| 测试：`keybindings.test.ts` 缺省表；`agent-ui.test.ts`：空输入 `↓` 在栏不可见但有任务时进栏、有字时返回提示码、`off` 时提示；`key-dispatch` 测试：`Ctrl+B` 空输入时落回编辑器；帧黄金 `test/fixtures/tui/agent-bar-*.txt` 重拍（末行文案变化）。 | 对应 `*.test.ts`                                                                                                                       |

## §2 问题 2：主会话在子 Agent 运行时继续交流

### §2.1 对照 Claude Code

从本机打包文本（`/tmp/cc-src/big.txt`）核对到的行为：

- 子 Agent 缺省后台：工具参数说明「Agents run in the background by default; you will be notified」；系统提示要求「do NOT sleep, poll, or proactively check on its progress」。
- 前台任务可转后台：键位上下文 `Task` 绑定 `ctrl+b` 与 chord `ctrl+x ctrl+b` → `task:background`；控制请求 `background_tasks` 说明「Each blocking tool call returns immediately with a 'running in the background' tool_result」，无 `tool_use_id` 时「backgrounds all foreground tasks (Ctrl+B semantics)」。
- 转后台的工具结果是固定文案，并区分原因：手动（`backgroundedByUser`）、超时自动（`timedOutAfterMs`）、为投递排队消息而转（`backgroundedToDeliverMessage`：「so that a message that arrived while it was running can reach you; it was not interrupted」）。
- 完成以 `task-notification` 消息注入，是后台任务报告而非用户发言；`/tasks` 列表管理后台任务（`x` 停止）；可以查看子 Agent 对话（`viewingAgentTaskId`）。

### §2.2 现状

- `task` 前台：`SubagentRegistry.launch` 把 `running` 直接返回给工具（`subagent-registry.ts:288`），tool-runner 等它结束，主回合阻塞；父 `signal` 中止连带中止子任务（`:277-281`）。运行中用户输入是 steer（Enter）或 followUp（Alt+Enter），在子任务结束、模型下一轮才看到。
- `task` 后台（`background:true`）：立即返回 `startedResult`，完成后 `notify` → `waitForIdle` → `followUp(text, {origin:"task"})`（`:490-500`），串行投递；W5-H2 保证收尾阶段入队的 followUp 本周期投递（`session-run.ts:204-236`）。被停止的任务不通知。
- 缺省前台：三个内置类型 `background: false`（`builtin.ts:30`），工具描述只说「background: returns a taskId now」，模型几乎不会主动用。
- 审批：子任务的权限请求转到父会话 broker（`session-subagent.ts:273`），TUI 弹模态框并禁用主输入提交（`interactive-mode.ts:462-470`）。
- `-p`：`await session.prompt()` 后直接收尾（`print-mode.ts:175`），运行中的后台任务随会话 dispose 被中止，通知丢失。

### §2.3 状态机

任务级（注册表 `TaskRecord`，新增 `foregroundWaiter`）：

```text
                 task(background:false)                      task(background:true) / 类型 background / 缺省
  ┌────────────┐ ───────────────────────► ┌──────────────┐ ◄───────────────────────────────────────────────┐
  │ (工具调用) │                           │ foreground   │                                                  │
  └────────────┘                           │ 父回合阻塞    │ ──background(taskId) / Ctrl+B / 超时──► ┌────────────┐
                                           └──────┬───────┘   工具立即返回 BACKGROUNDED 文本        │ background │
                                                  │ 结束：结果作为工具结果返回                        │ 父回合继续  │
                                                  ▼                                                └─────┬──────┘
                                           ┌──────────────┐                                              │ 结束：notify → followUp(origin:task)
                                           │ terminal     │ ◄────────────────────────────────────────────┘
                                           └──────────────┘
  父 Esc（abort）：foreground → aborted（现状）；background 不受影响（D5）
```

主会话级（不变，只写清交错规则）：

```text
idle ──用户 Enter──► running(user turn)
idle ──任务完成通知──► running(task turn, origin:task)          # 空闲即投递，输入框草稿保留
running ──用户 Enter──► steer 队列（本回合工具批次后、下一轮模型请求前投递）
running ──用户 Alt+Enter──► followUp 队列（本回合结束后投递）
running ──任务完成通知──► followUp 队列（排在用户 followUp 之后，按完成顺序）
running ──任何队列非空且回合收尾──► 同周期续投（W5-H2），steer 先于 followUp
```

规则：用户的话永远排在通知前（steer 优先于 followUp；同为 followUp 时先入先出，而通知只在任务完成时入队）。通知不打断正在流式的回合。多个通知各开一轮，不合并（报告 ≤ 50 KB 已截，合并反而让模型一次读太多）。

### §2.4 键位方案（完整）

| 键          | 主界面（输入框）                                                                                                             | Agent 栏聚焦                                                     | 子 Agent 视图                     | 备注                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------- |
| `↓`         | 输入为空且有子 Agent 任务 → 进栏（`app.agents.focus`）；否则编辑器（下移 / 历史下一条）                                      | 下一项                                                           | 正文下翻一行                      | 批次 A。空输入未浏览历史时 `↓` 本是空操作，无损                 |
| `Ctrl+B`    | 有阻塞中的前台 task / `task_ctl wait` → 全部转后台（`app.tasks.background`），**不看输入框是否有字**；否则编辑器（光标左移） | 转后台**选中的**任务（只对前台任务有效）                         | 转后台正在看的任务                | 批次 C。tmux 里按 `C-b C-b`（缺省 `send-prefix`）透传；文档写明 |
| `b`         | —（可打印字符进输入框）                                                                                                      | 同 `Ctrl+B`（选中项）                                            | —（进输入框）                     | 给 tmux 用户的无前缀替代                                        |
| `x`         | —                                                                                                                            | 停止选中任务（1.5 s 内再按一次确认，提示行写「再按 x 停止 t2」） | —（用 `/tasks stop`）             | 对齐 Claude Code `/tasks` 的 `x`                                |
| `Enter`     | 提交（运行中 = steer）                                                                                                       | 打开视图；选中项「等待审批」时先弹它的审批框                     | 发给子 Agent                      | D6 的停靠审批入口                                               |
| `Esc`       | 运行中：中断主回合（连带中止前台任务；后台任务不受影响）；空闲：双击回滚                                                     | 返回输入框                                                       | 输入为空返回，有字清空            | 不变                                                            |
| `Alt+Enter` | followUp                                                                                                                     | —                                                                | —                                 | 不变                                                            |
| `/tasks`    | 聚焦栏；`/tasks <id>` 视图；`/tasks stop <id>`；**新增** `/tasks bg [id]`（无 id = 全部前台任务）                            | —                                                                | 只认 `/tasks stop` 与 `/tasks bg` | line 模式同样接受 `bg`                                          |

`keybindings.json` 新动作 `app.tasks.background`（缺省 `["ctrl+b"]`）；`app.agents.focus` 缺省 `["down"]`。想要原来的「`Ctrl+B` 进栏」可自己覆盖。`tui.editor.cursorLeft` 保留 `ctrl+b`（只在没有前台任务时才轮到它）。

### §2.5 转后台原语（core）

```ts
// src/agent/subagent-registry.ts
/** 把阻塞中的前台任务改为后台：工具调用立即返回，任务继续，完成后照常通知。返回实际转了的 taskId。 */
background(taskId?: string, reason: BackgroundReason = "user"): string[];
export type BackgroundReason = "user" | "timeout" | "host";

// src/agents/task-record.ts
export interface TaskRecord {
  // …现有字段…
  /** 前台等待者：launch 时建，转后台时 resolve；结束时 settle 掉。 */
  foregroundWaiter?: { resolve(result: SubagentResult): void; detachParent(): void };
}
```

行为（`launch` 内）：

1. 前台启动时建 `foregroundWaiter`：`detachParent` 移除 `onParentAbort`、`delete record.onUpdate`；返回给工具的是 `Promise.race([running, waiter.promise])`。
2. `background(taskId)`：`record.running !== undefined && !record.info.background` 才动；置 `info.background = true`、`persist(record)`、`detachParent()`、`emit({ type: "subagent_background", taskId, parentToolCallId, reason })`、`void running.then(r => this.notify(record, r))`、`waiter.resolve(backgroundedResult(record, reason))`。无参 = 对全部前台运行中任务执行。
3. `backgroundedResult` 文本固定英文、只追加不改前缀（工具结果不进缓存前缀，但要稳定以便测试与模型学习）：

   ```text
   [task t2] Moved to the background by the user; it was not interrupted. A <task-notification> arrives when it finishes; use task_ctl to wait, stop or read output. Do not wait for it unless the user asks.
   ```

   `reason: "timeout"`：`Still running after 120s and moved to the background; …`。`status: "running"`、`taskId`、`outputFile` 同 `startedResult`。

4. `task_ctl wait`：`wait(taskId, timeoutMs)` 增加可选 `signal`（由 `background()` 触发的会话级 `detachSignal`）；被触发时返回 `undefined`，`task-ctl.ts` 文案改为「Task t2 is still running and was moved to the background by the user; do not wait again — a <task-notification> arrives when it finishes.」
5. 自动转后台：`subagents.autoBackgroundAfterMs`（缺省 `0` 关闭）。`launch` 对前台任务起定时器，到时调用 `background(taskId, "timeout")`。TUI 一行提示（`event-notices.ts`）。
6. `Esc`：父 `signal` 只连着仍是前台的任务（D5）。`abort()` 后立即 `background()` 已无意义（任务已 aborted），`background()` 对非运行中任务返回空数组。
7. 并发写冲突：转后台不改隔离方式；描述里保留「writers should use isolation worktree」。

事件（`src/agent/types-w5.ts`）：

```ts
export interface SubagentBackgroundEvent {
  type: "subagent_background";
  taskId: string;
  parentToolCallId: string;
  reason: "user" | "timeout" | "host";
}
```

RPC（`src/rpc.ts`、`docs/rpc.md`，44 条）：`background_task { taskId?: string } → { backgrounded: string[] }`；事件表加 `subagent_background`。SDK：`session.backgroundTask(taskId?)`。ACP：无独立入口（宿主用 RPC），任务仍按 ACP 的 tool call 进度呈现。

### §2.6 缺省后台与提示文本

- 配置 `subagents.background: "auto" | "always" | "never"`，缺省 `"auto"`：交互 TUI / RPC / ACP 下等价 `always`（`task.background` 缺省 `true`），`-p` 下等价 `never`。类型定义文件的 `background:` 与调用参数仍是显式覆盖（优先级：调用参数 > 类型定义 > 配置）。内置类型的 `background: false` 改为「未指定」（`AgentDefinition.background?: boolean`），由配置决定。
- `task` 描述（`src/tools/task.ts` `BASE_DESCRIPTION`）在缺省后台时改为：

  ```text
  Delegate to a sub-agent (fresh context; give full instructions). Runs in the background by default: returns a taskId now and a <task-notification> arrives when it finishes — keep working or reply to the user, do not poll. Set background:false only when your very next step needs the result. taskId: continue that task. Tasks in one reply run in parallel; writers should use isolation worktree.
  ```

  缺省前台（`-p` / `never`）时保持现文案。两种文本都是会话常量，会话内前缀稳定；同一台机器上 TUI 与 `-p` 的工具表因此不同字节，这是已接受的代价（两者本就少有共享缓存的机会）。

- 规则（`promptGuidelines`）把 `TASK_NOTIFICATION_RULE` 扩成两句以内：`A <task-notification> message is a background task's report, not the user speaking. Never sleep or poll (task_ctl wait) for a background task; its notification arrives on its own.` 只在 task 工具可用时出现。
- 预算：描述 +约 45 token、规则 +约 20 token；`src/cli/prompt-budget.test.ts` 的 `default` 上限 2000 当前通过，批次 B 实施后必须重跑，超了优先精简文案而不是抬上限。
- `-p`：缺省前台；显式 `background:true` 仍生效。运行结束时若还有后台任务在跑：等它们结束并投递通知、跑完通知回合再退出（受 `--max-turns` / `--max-cost` 约束，SIGINT 照常中止），json 结果带 `tasks`（同 `getStats().tasks`）。见 §6 Q5。

### §2.7 审批路由（D6）

- 请求带 `context.taskId` 且该任务 `info.background === true`（含转后台）→ 「停靠」：不开覆盖层，`approvals` 记下，栏行状态「等待审批」，提示行 `t2 等待审批 · ↓ 处理`；满足「主会话空闲（`!indicator.busy`）且输入为空且无覆盖层」时自动弹出；栏里 Enter 立即弹出；视图里正在看该任务也立即弹出。
- 前台任务与主会话自己的请求：照旧立即弹出。
- 停靠期间子任务阻塞在权限等待（现状如此，`broker.ask` 未返回）；超时 / 取消语义不变。
- RPC 客户端不受影响（事件照发，客户端自己决定呈现）。

### §2.8 TUI 呈现

- 转后台后 task 工具行改成后台样式：`⎿ 已转后台 · 12s` + 跟随行 `↳ t2 explore · 运行中 …`（复用 `tool-view.ts:246` 的跟随行）；`subagent_background` 事件驱动 `SubagentTracker.background = true`。
- 通知到达仍是一行 `↳ 子 Agent 通知 t2 explore 完成 · 7 轮 · /tasks 查看输出`（现状）。
- 运行提示行：有前台任务时 `⠏ 运行 task · 4s · Esc 中断 · Ctrl+B 转后台 · ↓ Agent 栏`，窄屏按顺序丢后两项。
- 栏末行（聚焦时）：`↑↓ 选择 · Enter 打开 · b 转后台 · x 停止 · Esc 返回`，窄屏丢 `b` / `x` 说明。

### §2.9 配置键

| 键                                | 类型 / 缺省                               | 说明                                        | 层级               |
| --------------------------------- | ----------------------------------------- | ------------------------------------------- | ------------------ |
| `subagents.background`            | `"auto" \| "always" \| "never"`，`"auto"` | §2.6                                        | 用户 / 项目 / 宿主 |
| `subagents.autoBackgroundAfterMs` | 整数 ≥ 0，`0`                             | 前台任务运行超过该毫秒数自动转后台；0 关闭  | 用户 / 项目        |
| `ui.agentBar`                     | 不变                                      | 不再被 `PROFILE_DEFAULTS` 置 `off`（§6 Q3） |                    |

登记：`src/config/types-w5.ts`（`SubagentsConfig`）、`schema-w5.ts`、`json-schema.ts`、`settings-registry.ts`（`/config` 面板，`restart` 生效）、`i18n/messages/config-keys.ts`、`docs/agents.md`「配置」表。

### §2.10 风险与对策

| 风险                                           | 对策                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 缓存：描述 / 规则改动让前缀变一次              | 一次性、随版本；文本会话内不变；`prompt-budget.test.ts` 与 `cache-stability` 用例守住                     |
| 模型不适应：起了后台任务又反复 `task_ctl wait` | 规则一句「不要轮询」；`wait` 被转后台时返回明确文案；`autoBackgroundAfterMs` 兜底                         |
| 两个 Agent 同时改同一文件                      | 不变：描述要求 writers 用 worktree；父会话的检查点仍记非隔离子任务的编辑（RW-B），回滚可覆盖              |
| 上下文膨胀：多任务多通知                       | 报告 ≤ 50 KB、全文落 outputs/（现状）；通知各一轮，不合并；`context_pressure` 提醒已有                    |
| Esc 时用户以为后台任务也停了                   | 中断提示改为「已中断（后台任务 t2 仍在运行，Esc 不影响）」；栏仍显示运行中                                |
| 停靠的审批被忘记                               | 栏行黄色「等待审批」+ 提示行；主会话一空闲就自动弹出                                                      |
| `-p` 等后台任务导致无人值守挂住                | 受 `--max-turns` / `--max-cost` / `limits.*`；审批在 `-p` 下视同拒绝（现状）；SIGINT/SIGTERM 中止         |
| 转后台瞬间任务恰好结束                         | `background()` 以 `record.running` 为准，结束后返回空数组；`Promise.race` 先到者为准，`finish` 只执行一次 |

## §3 接口汇总

```ts
// src/agent/subagent-registry.ts [B1]
background(taskId?: string, reason?: BackgroundReason): string[];
wait(taskId: string, timeoutMs: number, options?: { signal?: AbortSignal }): Promise<SubagentResult | undefined>;
// src/agents/task-control.ts [B1]
export interface TaskControl { /* … */ background(taskId?: string): string[]; }
// src/agent/types-w5.ts [B1]
export interface SubagentBackgroundEvent { type: "subagent_background"; taskId: string; parentToolCallId: string; reason: "user" | "timeout" | "host" }
// src/agent/types.ts（AgentSession）[B1]
backgroundTask(taskId?: string): string[];
// src/rpc.ts [B2]
background_task: { taskId?: string } → { backgrounded: string[] }
// src/config/types-w5.ts [B2]
subagents.background?: "auto" | "always" | "never"; subagents.autoBackgroundAfterMs?: number;
// src/tui/keybindings.ts [A / C]
"app.agents.focus": ["down"]; "app.tasks.background": ["ctrl+b"];
// src/modes/interactive/key-dispatch.ts [A]
AgentKeys.focus(data): true | "busy-input" | "disabled" | "empty";
// src/modes/interactive/key-dispatch.ts [C]
KeyDispatchDeps.backgroundTasks?(): string[];   // 有前台任务时 Ctrl+B 调用
```

## §4 测试要求

- 单元（B1）：前台 `background()` 后工具结果为固定文案、`subagent_background` 事件、父 abort 不再中止它、结束后 `<task-notification>` 投递；`wait` 被 signal 打断；`autoBackgroundAfterMs` 定时；非运行中返回空数组；转后台瞬间结束的竞争。
- 单元（B2）：配置解析与层级；`-p` 下缺省前台；`-p` 等待后台任务并输出 `tasks`；RPC `background_task` 黄金记录（`test/fixtures/rpc/background.out.jsonl`）。
- 单元（A）：§1.4 的测试行。
- 单元（C）：`Ctrl+B` 有前台任务时触发 `backgroundTasks`、没有时落回编辑器（含有字 / 无字）；栏 `b` / `x`（双击确认）；停靠审批在空闲且空输入时自动弹出、忙时记录到栏、栏 Enter 弹出；工具行后台样式；帧黄金 `agent-bar` / `agent-view` / `run-background-80x24.txt`。
- e2e（B2）：fake 脚本前台 task + 子会话 `delayMs`，RPC `background_task` 后 `tool_execution_end` 立即到达且文本含 `Moved to the background`，随后 `subagent_end` 与 `origin: "task"` 的 user 消息；`-p` 显式 `background:true` 时进程等到通知回合结束才退出。
- 提示预算：`pnpm vitest run src/cli/prompt-budget.test.ts` 在 B1 后必须通过。
- 手工：tmux 内 `C-b C-b` 转后台、`↓` 进栏；tmux 外 `Ctrl+B`；嵌入宿主（profile）栏可用。

## §5 分批实施

| 批次 | 内容                                                                             | 文件所有权（互不重叠）                                                                                                                                                                                                                                                                                                                                    | 依赖                                   | 验收                                                                                                             |
| ---- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A    | Agent 栏可达性（§1.4）：键位、门控、落空提示、运行提示行、profile 缺省、文档     | `src/tui/keybindings.ts`、`src/modes/interactive/{key-dispatch,agent-ui,agent-bar,run-indicator}.ts` 及其测试、`src/i18n/messages/{agents,interactive}.ts`、`src/config/merge.ts`、`docs/tui.md`、`docs/en/tui.md`、`docs/host-api.md`、`test/fixtures/tui/agent-*`                                                                                       | 无                                     | §1.4 测试全绿；`pnpm typecheck`；手工 tmux 内 `↓` 进栏                                                           |
| B1   | core 转后台原语与缺省后台（§2.5、§2.6 的工具 / 规则部分）                        | `src/agent/subagent-registry.ts`、`src/agent/subagent-direct.ts`、`src/agents/{task-record,task-control,result,builtin,types}.ts`、`src/tools/{task,task-ctl,types}.ts`、`src/agent/types-w5.ts`、`src/agent/session.ts`（`backgroundTask`）、对应测试、`src/cli/prompt-budget.test.ts`                                                                   | 无                                     | 单元全绿；预算测试通过；`AgentDefinition.background` 可选后 catalog 测试通过                                     |
| B2   | 配置键、`-p` 行为、RPC 命令与事件、SDK 导出、文档                                | `src/config/{types-w5,schema-w5,json-schema,settings-registry}.ts`、`src/i18n/messages/config-keys.ts`、`src/modes/print/print-mode.ts`、`src/rpc.ts`、`src/modes/rpc/commands.ts`、`src/index.ts`、`test/e2e/subagent.e2e.test.ts`、`test/fixtures/rpc/background.out.jsonl`、`docs/{agents,rpc,sessions}.md` 与 `docs/en/` 同名、CHANGELOG 两份未发布段 | B1 的接口（按 §3 先写，B1 合入后联调） | RPC 黄金；e2e；`ama config list` 显示新键                                                                        |
| C    | TUI 接入（§2.4 的 `Ctrl+B` / `b` / `x` / `/tasks bg`、§2.7 审批停靠、§2.8 呈现） | `src/modes/interactive/{key-dispatch,agent-ui,agent-bar,agent-view,tool-view,subagent-view,approval-dialog,approval-merge,event-notices,commands}.ts`、`src/modes/commands-core.ts`、`src/modes/interactive/tasks-report.ts`、`src/i18n/messages/{agents,interactive}.ts`、`docs/tui.md`、`docs/en/tui.md`、帧黄金                                        | A、B1                                  | §4 的 C 项；手工：前台 task 运行中 `Ctrl+B` → 工具行转后台样式、主回合继续、通知到达；后台任务审批停靠与自动弹出 |

A ∥ B1 ∥ B2 可三代理并行；C 在 A 与 B1 合入后由一个代理做。A 与 C 都碰 `key-dispatch.ts` / `agent-ui.ts`，所以 C 必须等 A 合入再开分支，不能并行。另一代理正在改 `startup-header.ts` / `startup-screen.ts`，各批次都不碰它们。

## §6 需要用户确认（都给了推荐）

| #   | 事项                                                                                                                  | 推荐缺省                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | 子 Agent 缺省后台（TUI / RPC / ACP），模型需要结果时自己写 `background:false`？还是保持缺省前台、只加 `Ctrl+B` 转后台 | **缺省后台**（与 Claude Code 一致；用户反馈的核心诉求）。保留 `subagents.background: "never"` 给想要旧行为的人                                                                 |
| Q2  | `Ctrl+B` 从「进 Agent 栏」改为「前台任务转后台」，`↓`（空输入）成为唯一缺省进栏键                                     | **改**。tmux 吃 `Ctrl+B` 是问题 1 的直接原因之一；转后台是 Claude Code 的 `Ctrl+B` 语义，复用肌肉记忆；进栏另有 `/tasks`                                                       |
| Q3  | 嵌入宿主（有 profile）是否继续缺省关闭 Agent 栏                                                                       | **不再强制关**：`PROFILE_DEFAULTS` 删掉 `agentBar: "off"`，Armadra 需要关时在自己的 profile 写 `ui.agentBar: "off"`。若 Armadra 的终端节点确实不该显示栏，则保留现状、只修键位 |
| Q4  | 后台任务的审批「停靠」（主会话忙或有草稿时不弹，空闲自动弹）还是照旧立即弹模态框                                      | **停靠**（D6）；前台任务与主会话自己的审批不变                                                                                                                                 |
| Q5  | `-p` 结束时还有后台任务：等它们与通知回合结束（受预算约束）还是直接退出并中止                                         | **等**（Claude Code 的 `-p` 同样等后台 Agent 落定）；缺省 `-p` 本就前台，只影响显式 `background:true`                                                                          |
| Q6  | `subagents.autoBackgroundAfterMs` 缺省 0（关闭）还是给一个值（如 120000）                                             | **0**。先让人用 `Ctrl+B` 决定；观察一版后再定                                                                                                                                  |
