/**
 * 消息目录：interactive（键名规范见 docs/i18n.md）。[W6-C0 建空壳，归 W6-I2]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 *
 * 单文件 600 行上限：消息区与工具块在 `interactive-view.ts`（`view`），启动头与启动期交互在
 * `interactive-startup.ts`（`startup`），行式界面在 `interactive-line.ts`（`line`）。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";
import * as line from "./interactive-line.js";
import * as startup from "./interactive-startup.js";
import * as view from "./interactive-view.js";

export const en = {
  commands: {
    /** [W6-C0] 第六波命令登记了但本构建还没有实现。 */
    unavailable: (name: string) => `/${name} is not available in this build yet`,
    treeDescription: "Browse the session tree and rewrite from before a message",
    permissionsDescription: "Permission mode, decision order and rules",
    keyHints: [
      "Enter send (while running = steer)  Alt+Enter queue after this turn  Shift+Enter / Ctrl+J newline",
      "Esc interrupt (queued messages go back to the editor)  Alt+↑ take back the last queued message",
      "Ctrl+X (while running) interrupt the current turn and send the input now, queued steers first; ui.enterWhileRunning: interrupt swaps it with Enter",
      "Idle Esc Esc: empty input = rewind (/rewind), with text = clear (↑ to restore)",
      "Shift+Tab / Tab (empty input) cycle permission mode (confirm before Bypass)  Ctrl+L model  Ctrl+T thinking level  Ctrl+O expand tool output and thinking",
      "Approval: 1–3 or ↑↓ Enter to choose, y allow  a allow for this session  n / Esc deny  v full input",
      "Plan approval: 1 approve  2 run in a fresh context  3 keep revising  4 reject and leave Plan  e edit plan  Esc stay in Plan",
      "Ctrl+B move foreground sub-agent tasks to the background (in tmux: C-b C-b)  ↓ (empty input) Agent bar: b background  x twice to stop  Enter open",
      "Ctrl+V paste a clipboard image (inserts @path)  Ctrl+G footer two rows / one row",
      "Ctrl+C clear input (again to quit)  Ctrl+D quit on empty input  Tab complete  @ reference a file",
    ].join("\n"),
    permissionsMode: (label: string, mode: string) => `Permission mode: ${label} (${mode})`,
    permissionsOrder: (order: string) => `Order: ${order}`,
    rulesNone: "Rules: (none)",
    rules: (n: number) => `Rules (${n}):`,
    recentAuto: (n: number) => `Recent auto decisions (${n}):`,
    noUserMessages: "No user messages yet",
    treeUnsupported: "This session does not support /tree",
    treeBusy: "Can't switch branches while running (press Esc to interrupt first)",
    treeTitle: "Session tree",
    modelTitle: "Choose a model",
    modelSet: (ref: string) => `Model: ${ref}`,
    noOtherSessions: "No other sessions in this directory",
    resumeTitle: "Resume a session",
    resumed: (id: string) => `Resumed session ${id}`,
    forkTitle: "Fork before which message",
    forked: (id: string) => `Forked to new session ${id}`,
    modeCancelled: (label: string) => `Cancelled; permission mode is still ${label}`,
    modeSet: (label: string) => `Permission mode: ${label}`,
    thinkingTitle: "Thinking level",
    numberFooter: (arrows: string, n: number) =>
      `${arrows} select · 1-${n} pick · Enter confirm · Esc cancel`,
  },
  paste: {
    /** 编辑器里大粘贴的折叠标记（`tui/components/editor-paste.ts`；识别正则同时认两种语言）。 */
    marker: (id: number, lines: number) => `[paste #${id} · ${plural(lines, "line")}]`,
  },
  /** 按键分派的一行提示（`key-dispatch.ts`）。 */
  keys: {
    escRewind: "Press Esc again to rewind",
    escClear: "Press Esc again to clear",
    cleared: "Input cleared · ↑ to restore",
    bypassSkipped: (label: string) => `Bypass not entered · ${label}`,
    clearedCtrlC: "Input cleared · press Ctrl+C again to quit",
    ctrlCAgain: "Press Ctrl+C again to quit",
    interrupted: "Interrupted",
    interruptSent: "Interrupted · sending now",
    nothingToSend: "Nothing to send",
    toolsExpanded: "Tool output: expanded",
    toolsCollapsed: "Tool output: collapsed",
  },
  /** 交互模式装配（`interactive-mode.ts`）。 */
  app: {
    placeholder: "Type a message, / for commands, @ for files, Shift+Enter for newline",
    notTty: "stdin / stdout is not a terminal",
    keybindingsWarning: (warning: string) => `keybindings.json: ${warning}`,
    noResult: "(no result)",
    followed: (text: string) => `${text} (with the previous confirmation)`,
    terminalInitFailed: (error: string) => `Terminal initialization failed: ${error}`,
  },
  clipboard: {
    noTool:
      "Can't read clipboard images: no system command available (macOS osascript / pngpaste, Linux wl-paste / xclip, Windows PowerShell)",
    noImage: "No image in the clipboard",
    failed: (error: string) => `Failed to read the clipboard: ${error}`,
    reading: "Reading clipboard…",
    inserted: "Inserted clipboard image",
  },
  completion: {
    promptTemplate: "prompt template",
  },
  /** 会话事件的提示（`event-notices.ts`、`session-events.ts`；line 模式共用）。 */
  events: {
    compactionNoShrink:
      "Compaction did not shrink the context; kept the original conversation (no summary)",
    imagesOmitted: (n: number) =>
      `Omitted ${plural(n, "earlier image")} to stay within the request limit`,
    limitTurns: (limit: number) =>
      `Reached the turn limit (${plural(limit, "turn")}); this run stopped. Send a new message to continue (--max-turns / limits.maxTurns)`,
    limitCost: (limit: string, spent: string) =>
      `Reached the cost limit ${limit} (this run used ${spent}); this run stopped. Send a new message to continue (--max-cost / limits.maxCostUsd)`,
    modelFallback: (from: string, reason: string, to: string) =>
      `${from} unavailable (${reason}); this request uses ${to} and switches back after the reply`,
    backgroundStarted: (jobId: string, command: string) =>
      `Background command ${jobId} started: ${command}`,
    backgroundExited: (jobId: string, code: string, command: string) =>
      `Background command ${jobId} exited (code ${code}): ${command}`,
    backgroundStopped: (jobId: string, command: string) =>
      `Background command ${jobId} stopped: ${command}`,
    compactionFailed: (error: string) => `Compaction failed: ${error}`,
    compactionCancelled: "Compaction cancelled",
  },
  statusLine: {
    usage: "Usage: /statusline [full|compact]",
    full: "Status line: full (two rows)",
    compact: "Status line: compact (one row)",
    cacheSilent: "n/a",
    sandbox: "sandbox",
    cycleHint: "shift+tab to cycle",
    /** full 本行 Ctx 段末尾：自动压缩开着。 */
    autoCompact: "auto",
    /** 模型没有上下文窗口（状态栏 `ctx ?`）时提示一次。 */
    noWindow: (model: string) =>
      `Context window unknown for ${model}: the status bar shows ctx ? and auto-compaction is off. Run \`ama models discover\` or set contextWindow for this model in the config.`,
    /** [W6] 订阅配额行（full 第三行）与窄屏 / compact 短格式；标签自带分隔（英文冒号后空格）。 */
    quota: {
      session: "Session: ",
      reset: "Reset: ",
      weekly: "Weekly: ",
      weeklyReset: "Weekly Reset: ",
      window: (duration: string) => `${duration}: `,
      windowReset: (duration: string) => `${duration} Reset: `,
      short5h: "5h",
      shortWeek: "wk",
      pending: "Quota: shown after the first request",
    },
  },
  subagent: {
    running: (elapsed: string) => `running ${elapsed}`,
    backgroundEnd: (taskId: string, agent: string, status: string, turns: number) =>
      `Background task ${taskId} (${agent}) ${status}${turns > 0 ? ` · ${plural(turns, "turn")}` : ""} · /tasks to view output`,
    notificationTurns: (turns: string) => `${turns} ${turns === "1" ? "turn" : "turns"}`,
    viewOutput: "/tasks to view output",
  },
  agentUi: {
    tasksTitle: "Subagent tasks",
    tasksFooter: (arrows: string) => `${arrows} select · Enter view · Esc cancel`,
    viewOutput: "View output so far",
    stop: "Stop task",
    stopped: (taskId: string) => `Stopped ${taskId}`,
  },
  keybindings: {
    notObject: "keybindings must be an object",
    unknownAction: (action: string) => `unknown action: ${action}`,
    badKeys: (action: string) => `${action}: keys must be a string or an array of strings`,
    readFailed: (path: string, error: string) => `failed to read ${path}: ${error}`,
    badJson: (path: string, error: string) => `${path} is not valid JSON: ${error}`,
  },
  editor: {
    completionFooter: "Tab accept · Esc close",
  },
  view: view.en,
  startup: startup.en,
  line: line.en,
};

export const zh = {
  commands: {
    unavailable: (name) => `/${name} 当前版本尚未提供`,
    treeDescription: "浏览会话树，回到某条消息之前重写",
    permissionsDescription: "权限模式、判定顺序与规则",
    keyHints: [
      "Enter 发送（运行中 = 插话）  Alt+Enter 排到本轮之后  Shift+Enter / Ctrl+J 换行",
      "Esc 中断（排队消息回填编辑器）  Alt+↑ 取回最后一条排队消息",
      "Ctrl+X（运行中）打断当前回合并立即发送输入（排队的插话在前）；ui.enterWhileRunning: interrupt 时与 Enter 互换",
      "空闲时 Esc Esc：输入框为空 = 回滚（/rewind），有字 = 清空（↑ 取回）",
      "Shift+Tab / Tab（输入为空时）切换权限模式（进入 Bypass 前确认）  Ctrl+L 模型  Ctrl+T 思考级别  Ctrl+O 展开工具输出与思考",
      "审批：1–3 或 ↑↓ Enter 选择，y 允许  a 本会话允许同类  n / Esc 拒绝  v 完整输入",
      "计划审批：1 批准  2 新上下文执行  3 继续修改  4 放弃并退出 Plan  e 编辑计划  Esc 留在 Plan",
      "Ctrl+B 前台子 Agent 任务转后台（tmux 里 C-b C-b）  ↓（空输入）Agent 栏：b 转后台  x 连按两次停止  Enter 打开",
      "Ctrl+V 粘贴剪贴板图片（插入 @路径）  Ctrl+G 底部信息行两行 / 一行",
      "Ctrl+C 清空输入（再按退出）  Ctrl+D 空输入时退出  Tab 补全  @ 引用文件",
    ].join("\n"),
    permissionsMode: (label, mode) => `权限模式：${label}（${mode}）`,
    permissionsOrder: (order) => `判定顺序：${order}`,
    rulesNone: "规则：（无）",
    rules: (n) => `规则（${n}）：`,
    recentAuto: (n) => `最近的 auto 判定（${n}）：`,
    noUserMessages: "还没有用户消息",
    treeUnsupported: "当前会话不支持 /tree",
    treeBusy: "运行中不能切换分支（先 Esc 中断）",
    treeTitle: "会话树",
    modelTitle: "选择模型",
    modelSet: (ref) => `模型：${ref}`,
    noOtherSessions: "本目录没有其它会话",
    resumeTitle: "恢复会话",
    resumed: (id) => `已恢复会话 ${id}`,
    forkTitle: "从哪条消息之前分叉",
    forked: (id) => `已分叉到新会话 ${id}`,
    modeCancelled: (label) => `已取消，权限模式仍为 ${label}`,
    modeSet: (label) => `权限模式：${label}`,
    thinkingTitle: "思考级别",
    numberFooter: (arrows, n) => `${arrows} 选择 · 1-${n} 直接选 · Enter 确认 · Esc 取消`,
  },
  paste: {
    marker: (id, lines) => `[粘贴 #${id} · ${lines} 行]`,
  },
  keys: {
    escRewind: "再按 Esc 回滚",
    escClear: "再按 Esc 清空",
    cleared: "已清空输入 · ↑ 取回",
    bypassSkipped: (label) => `未进入 Bypass · ${label}`,
    clearedCtrlC: "已清空输入 · 再按 Ctrl+C 退出",
    ctrlCAgain: "再按一次 Ctrl+C 退出",
    interrupted: "已中断",
    interruptSent: "已打断，立即发送",
    nothingToSend: "没有可发送的内容",
    toolsExpanded: "工具输出：展开",
    toolsCollapsed: "工具输出：折叠",
  },
  app: {
    placeholder: "输入消息，/ 命令，@ 文件，Shift+Enter 换行",
    notTty: "stdin / stdout 不是终端",
    keybindingsWarning: (warning) => `keybindings.json：${warning}`,
    noResult: "（没有结果）",
    followed: (text) => `${text}（随上一次确认）`,
    terminalInitFailed: (error) => `终端初始化失败：${error}`,
  },
  clipboard: {
    noTool:
      "读不了剪贴板图片：没有可用的系统命令（macOS osascript / pngpaste，Linux wl-paste / xclip，Windows PowerShell）",
    noImage: "剪贴板里没有图片",
    failed: (error) => `读取剪贴板失败：${error}`,
    reading: "读取剪贴板…",
    inserted: "已插入剪贴板图片",
  },
  completion: {
    promptTemplate: "提示模板",
  },
  events: {
    compactionNoShrink: "压缩后上下文没有变小，已保留原对话（不写摘要）",
    imagesOmitted: (n) => `已省略 ${n} 张早期图片以符合请求上限`,
    limitTurns: (limit) =>
      `已到回合上限（${limit} 回合），本次运行停止；发新消息继续（--max-turns / limits.maxTurns）`,
    limitCost: (limit, spent) =>
      `已到费用上限 ${limit}（本次运行已用 ${spent}），本次运行停止；发新消息继续（--max-cost / limits.maxCostUsd）`,
    modelFallback: (from, reason, to) =>
      `${from} 不可用（${reason}），本次请求改用 ${to}，回复后切回`,
    backgroundStarted: (jobId, command) => `后台命令 ${jobId} 已启动：${command}`,
    backgroundExited: (jobId, code, command) =>
      `后台命令 ${jobId} 已退出（码 ${code}）：${command}`,
    backgroundStopped: (jobId, command) => `后台命令 ${jobId} 已停止：${command}`,
    compactionFailed: (error) => `压缩失败：${error}`,
    compactionCancelled: "压缩已取消",
  },
  statusLine: {
    usage: "用法：/statusline [full|compact]",
    full: "状态栏：完整（两行）",
    compact: "状态栏：精简（一行）",
    cacheSilent: "未报告",
    sandbox: "沙箱",
    cycleHint: "shift+tab 切换",
    autoCompact: "auto",
    noWindow: (model) =>
      `${model} 没有上下文窗口信息：状态栏显示 ctx ?，自动压缩关闭。运行 \`ama models discover\`，或在配置里为该模型设置 contextWindow。`,
    quota: {
      session: "5 小时：",
      reset: "重置：",
      weekly: "本周：",
      weeklyReset: "本周重置：",
      window: (duration) => `${duration}：`,
      windowReset: (duration) => `${duration}重置：`,
      short5h: "5h",
      shortWeek: "周",
      pending: "配额：首次请求后显示",
    },
  },
  subagent: {
    running: (elapsed) => `运行中 ${elapsed}`,
    backgroundEnd: (taskId, agent, status, turns) =>
      `后台任务 ${taskId}（${agent}）${status}${turns > 0 ? ` · ${turns} 轮` : ""} · /tasks 查看输出`,
    notificationTurns: (turns) => `${turns} 轮`,
    viewOutput: "/tasks 查看输出",
  },
  agentUi: {
    tasksTitle: "子 Agent 任务",
    tasksFooter: (arrows) => `${arrows} 选择 · Enter 查看 · Esc 取消`,
    viewOutput: "查看已有输出",
    stop: "停止任务",
    stopped: (taskId) => `已停止 ${taskId}`,
  },
  keybindings: {
    notObject: "keybindings 必须是对象",
    unknownAction: (action) => `未知动作：${action}`,
    badKeys: (action) => `${action}：键必须是字符串或字符串数组`,
    readFailed: (path, error) => `读取 ${path} 失败：${error}`,
    badJson: (path, error) => `${path} 不是合法 JSON：${error}`,
  },
  editor: {
    completionFooter: "Tab 接受 · Esc 关闭",
  },
  view: view.zh,
  startup: startup.zh,
  line: line.zh,
} satisfies Messages<typeof en>;
