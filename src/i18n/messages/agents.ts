/**
 * 消息目录：agents（键名规范见 docs/i18n.md）。[W6-C0 建空壳，归 W6-A]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 *
 * W6-A：Agent 栏（状态、轮数、溢出行、按键提示）与子 Agent 视图（标题、占位、发送结果、外部 Agent 的说明）。
 * W7-A：进栏键落空提示、运行提示行的进栏附加项。
 * W7-C：转后台（Ctrl+B / 栏内 b / `/tasks bg`）、栏内 x 双击停止、停靠审批的提示、Esc 不影响后台任务。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

export const en = {
  status: {
    queued: "queued",
    running: "running",
    approval: "needs approval",
    completed: "done",
    failed: "failed",
    aborted: "stopped",
    max_turns: "out of turns",
    interrupted: "interrupted",
  },
  turns: (n: number) => plural(n, "turn"),
  bar: {
    more: (n: number) => `${n} more`,
    keys: (up: string, down: string) => `${up}${down} select · Enter open · Esc back`,
    /** [W7-C] 聚焦时的完整按键行（窄屏退回 `keys`）。 */
    keysFull: (up: string, down: string) =>
      `${up}${down} select · Enter open · b background · x stop · Esc back`,
    empty: "No sub-agent tasks yet",
    /** [W7-A] 运行提示行的附加项（有子 Agent 任务时）。 */
    runHint: (down: string) => `${down} Agent bar`,
  },
  /** [W7-A] 进栏键落空时的一行提示。 */
  focus: {
    busyInput: (down: string) => `Input is not empty; clear it and press ${down} for the Agent bar`,
    disabled: "Agent bar is off (ui.agentBar); use /tasks",
  },
  /** [W7-C] 前台任务转后台。 */
  background: {
    done: (ids: string) => `Moved to the background: ${ids}; you'll be notified when it finishes`,
    none: "No foreground task to move to the background",
    notForeground: (taskId: string) => `${taskId} is not a running foreground task`,
    runHint: (key: string) => `${key} to background`,
    timeout: (taskId: string, agent: string) =>
      `${taskId} ${agent} ran long and moved to the background (subagents.autoBackgroundAfterMs)`,
    host: (taskId: string, agent: string) =>
      `${taskId} ${agent} was moved to the background by the host`,
    moved: (elapsed: string) => `moved to the background · ${elapsed}`,
    started: "started in the background",
    interrupted: (ids: string) =>
      `Interrupted (background task ${ids} keeps running; Esc doesn't affect it)`,
  },
  /** [W7-C] 栏内 x 停止（双击确认）。 */
  stop: {
    confirm: (taskId: string) => `Press x again to stop ${taskId}`,
    ended: (taskId: string) => `${taskId} has already finished`,
  },
  /** [W7-C] 后台任务的审批停靠在栏里。 */
  approval: {
    runHint: (down: string) => `${down} handle approval`,
  },
  view: {
    back: "Esc back",
    stopHint: (taskId: string) => `/tasks stop ${taskId} to stop`,
    paused: "paused · End to follow",
    placeholder: (taskId: string) => `Message ${taskId}`,
    steered: (taskId: string) => `Sent to ${taskId}; delivered when its current turn ends`,
    queued: (taskId: string) => `Queued for ${taskId}; sent when its current run ends`,
    resumed: (taskId: string) => `Sent to ${taskId}; it continues in the background`,
    interrupted: (taskId: string) => `Interrupted ${taskId}; your message starts its next turn now`,
    queuedNoInterrupt: (taskId: string) =>
      `${taskId} cannot be interrupted here; queued, sent when its current run ends`,
    sendFailed: (message: string) => `Could not send: ${message}`,
    stopped: (taskId: string) => `Stopped ${taskId}`,
    commandsHere:
      "Only /tasks stop and /tasks bg work here; press Esc to go back for other commands",
    removed: (taskId: string) => `Task ${taskId} is gone`,
    unknown: (taskId: string) => `No task ${taskId}`,
    turn: (n: number) => `turn ${n}`,
    waiting: "Waiting for output…",
    noTranscript: "No transcript for this task",
    loadFailed: (message: string) => `Could not read the transcript: ${message}`,
    externalGone: (runner: string, sessionId: string) =>
      `Live output is kept only in memory. Run ${runner} and resume ${sessionId} to see the full transcript.`,
    externalNoSession: (runner: string) =>
      `Live output is kept only in memory; ${runner} did not report a session to resume.`,
  },
};

export const zh = {
  status: {
    queued: "排队",
    running: "运行中",
    approval: "等待审批",
    completed: "完成",
    failed: "失败",
    aborted: "已停止",
    max_turns: "轮数耗尽",
    interrupted: "已中断",
  },
  turns: (n) => `${n} 轮`,
  bar: {
    more: (n) => `另 ${n} 个`,
    keys: (up, down) => `${up}${down} 选择 · Enter 打开 · Esc 返回`,
    keysFull: (up, down) => `${up}${down} 选择 · Enter 打开 · b 转后台 · x 停止 · Esc 返回`,
    empty: "还没有子 Agent 任务",
    runHint: (down) => `${down} Agent 栏`,
  },
  focus: {
    busyInput: (down) => `输入框有字；清空后再按 ${down} 进 Agent 栏`,
    disabled: "Agent 栏已关闭（ui.agentBar），用 /tasks",
  },
  background: {
    done: (ids) => `已转后台：${ids}，完成后会通知`,
    none: "没有可转后台的前台任务",
    notForeground: (taskId) => `${taskId} 不是运行中的前台任务`,
    runHint: (key) => `${key} 转后台`,
    timeout: (taskId, agent) =>
      `${taskId} ${agent} 运行较久，已自动转后台（subagents.autoBackgroundAfterMs）`,
    host: (taskId, agent) => `${taskId} ${agent} 已由宿主转后台`,
    moved: (elapsed) => `已转后台 · ${elapsed}`,
    started: "已在后台启动",
    interrupted: (ids) => `已中断（后台任务 ${ids} 仍在运行，Esc 不影响）`,
  },
  stop: {
    confirm: (taskId) => `再按 x 停止 ${taskId}`,
    ended: (taskId) => `${taskId} 已结束`,
  },
  approval: {
    runHint: (down) => `${down} 处理审批`,
  },
  view: {
    back: "Esc 返回",
    stopHint: (taskId) => `/tasks stop ${taskId} 停止`,
    paused: "已暂停跟随 · End 继续",
    placeholder: (taskId) => `发给 ${taskId}`,
    steered: (taskId) => `已发给 ${taskId}，本轮结束后送达`,
    queued: (taskId) => `已排队，${taskId} 本次运行结束后发送`,
    resumed: (taskId) => `已发给 ${taskId}，在后台继续`,
    interrupted: (taskId) => `已打断 ${taskId}，这条消息立即开始新一轮`,
    queuedNoInterrupt: (taskId) => `${taskId} 不支持打断，已排队，本次运行结束后发送`,
    sendFailed: (message) => `发送失败：${message}`,
    stopped: (taskId) => `已停止 ${taskId}`,
    commandsHere: "这里只能用 /tasks stop 与 /tasks bg；其它命令按 Esc 返回后输入",
    removed: (taskId) => `任务 ${taskId} 已不存在`,
    unknown: (taskId) => `没有任务 ${taskId}`,
    turn: (n) => `第 ${n} 轮`,
    waiting: "等待输出…",
    noTranscript: "这个任务没有对话记录",
    loadFailed: (message) => `读取对话记录失败：${message}`,
    externalGone: (runner, sessionId) =>
      `实时输出只在内存里。用 ${runner} resume ${sessionId} 查看全文。`,
    externalNoSession: (runner) => `实时输出只在内存里；${runner} 没有报告可续接的会话。`,
  },
} satisfies Messages<typeof en>;
