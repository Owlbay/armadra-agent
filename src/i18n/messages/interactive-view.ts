/**
 * 消息目录：interactive 的消息区部分（键名规范见 docs/i18n.md）。[W6-I2]
 *
 * 单文件 600 行上限，`interactive.ts` 拆出：消息区（`message-view.ts`）、运行指示（`run-indicator.ts`）、
 * 工具摘要与工具块（`tool-summary.ts`、`tool-view.ts`）。经 `msg().interactive.view` 取用。
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

export const en = {
  message: {
    /** 退出摘要的时长：不足 1 分钟按秒，否则按分钟。 */
    duration: (seconds: number) =>
      seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`,
    sessionPrefix: (rule: string) => `${rule} session `,
    turns: (n: number) => plural(n, "turn"),
    rebill: (cost: string) => ` (re-billed ${cost})`,
    resume: "  resume: ",
    origin: {
      steer: "steer",
      followUp: "follow-up",
      host: "host",
      task: "subagent notice",
      plan: "plan",
      interrupt: "interrupt",
    },
    planHandoff: "Start executing the approved plan",
    thinkingStreaming: (glyph: string, ellipsis: string) => `${glyph} Thinking${ellipsis}`,
    thinking: (glyph: string, tokens: string) => `${glyph} Thought · ${tokens} tokens`,
    moreLines: (ellipsis: string, n: number) => `${ellipsis} ${plural(n, "more line")}`,
    image: "[image]",
    modelError: "Model call failed",
    interrupted: "Interrupted",
    lengthLimit: "Output hit the length limit",
    hookBlocked: (glyph: string, reason: string) => `${glyph} Blocked by hook: ${reason}`,
    retry: (glyph: string, attempt: number, max: number, seconds: number, error: string) =>
      `${glyph} Retry ${attempt}/${max} (in ${seconds}s): ${error}`,
    retryFailed: (error: string | undefined) =>
      `Retry failed${error !== undefined ? `: ${error}` : ""}`,
    summaryTokens: (before: string, after: string | undefined) =>
      `${before}${after !== undefined ? ` → ${after}` : ""} tokens`,
    compacted: "Context compacted",
    branchSummary: "Branch summary",
  },
  run: {
    esc: "Esc to interrupt",
    awaitingApproval: "Awaiting approval",
    runningTool: (name: string) => `Running ${name}`,
    runningTools: (n: number) => `Running ${n} tools`,
    retry: (attempt: number, max: number) => `Retrying ${attempt}/${max}`,
    retryIn: (seconds: number) => `in ${seconds}s`,
    compacting: "Compacting context",
    replying: "Replying",
    thinking: "Thinking",
    queueMore: (ellipsis: string, n: number) => `${ellipsis} ${n} more`,
    queueHint: (arrow: string) => `Alt+${arrow} take back · Esc refill and interrupt`,
    /** 有排队的插话时（`key` = 立即送出它们的键：专用键，或 interrupt 模式下的 Enter）。 */
    queueHintNow: (arrow: string, key: string) =>
      `Alt+${arrow} take back · ${key} send now · Esc refill and interrupt`,
    /** 输入框有字时：Enter 与专用键各做什么（`ui.enterWhileRunning`）。 */
    sendHint: (mode: "queue" | "interrupt", key: string) =>
      mode === "queue"
        ? `Enter queue · ${key} interrupt & send`
        : `Enter interrupt & send · ${key} queue`,
  },
  tool: {
    interrupted: "interrupted",
    timedOut: "timed out",
    exit: (code: number) => `exit ${code}`,
    lines: (n: number) => plural(n, "line"),
    failed: "failed",
    image: (mime: string) => `image ${mime}`,
    emptyFile: "empty file",
    read: (n: number) => `read ${plural(n, "line")}`,
    edits: (n: number) => plural(n, "edit"),
    write: (created: boolean, n: number) =>
      `${created ? "created" : "overwrote"} · ${plural(n, "line")}`,
    noMatch: "no matches",
    matches: (matches: number, files: number | undefined) =>
      `${plural(matches, "match", "matches")} · ${files === undefined ? "? files" : plural(files, "file")}`,
    files: (n: number) => plural(n, "file"),
    codemode: (calls: number, lines: number) =>
      `${plural(calls, "inner call")} · script printed ${plural(lines, "line")}`,
    done: "done",
    outputLines: (n: number) => `${plural(n, "line")} of output`,
    awaiting: (glyph: string) => `${glyph} awaiting approval`,
    subagentRunning: (elapsed: string) => `subagent · running ${elapsed}`,
    running: (elapsed: string) => `running · ${elapsed}`,
    moreLines: (ellipsis: string, n: number) =>
      `${ellipsis} ${plural(n, "more line")} (Ctrl+O to expand)`,
    earlierCalls: (ellipsis: string, n: number) => `${ellipsis} ${plural(n, "earlier call")}`,
  },
};

export const zh = {
  message: {
    duration: (seconds) => (seconds < 60 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`),
    sessionPrefix: (rule) => `${rule} 会话 `,
    turns: (n) => `${n} 回合`,
    rebill: (cost) => `（重计费 ${cost}）`,
    resume: "  恢复：",
    origin: {
      steer: "插话",
      followUp: "之后",
      host: "宿主",
      task: "子 Agent 通知",
      plan: "计划",
      interrupt: "打断",
    },
    planHandoff: "按批准的计划开始执行",
    thinkingStreaming: (glyph, ellipsis) => `${glyph} 思考中${ellipsis}`,
    thinking: (glyph, tokens) => `${glyph} 思考 · ${tokens} token`,
    moreLines: (ellipsis, n) => `${ellipsis} 另 ${n} 行`,
    image: "[图片]",
    modelError: "模型调用失败",
    interrupted: "已中断",
    lengthLimit: "输出达到长度上限",
    hookBlocked: (glyph, reason) => `${glyph} Hook 阻止：${reason}`,
    retry: (glyph, attempt, max, seconds, error) =>
      `${glyph} 重试 ${attempt}/${max}（${seconds}s 后）：${error}`,
    retryFailed: (error) => `重试失败${error !== undefined ? `：${error}` : ""}`,
    summaryTokens: (before, after) => `${before}${after !== undefined ? ` → ${after}` : ""} token`,
    compacted: "上下文已压缩",
    branchSummary: "分支摘要",
  },
  run: {
    esc: "Esc 中断",
    awaitingApproval: "等待确认",
    runningTool: (name) => `运行 ${name}`,
    runningTools: (n) => `运行 ${n} 个工具`,
    retry: (attempt, max) => `重试 ${attempt}/${max}`,
    retryIn: (seconds) => `${seconds}s 后`,
    compacting: "压缩上下文",
    replying: "回复中",
    thinking: "思考中",
    queueMore: (ellipsis, n) => `${ellipsis} 另 ${n} 条`,
    queueHint: (arrow) => `Alt+${arrow} 取回 · Esc 回填并中断`,
    queueHintNow: (arrow, key) => `Alt+${arrow} 取回 · ${key} 立即发送 · Esc 回填并中断`,
    sendHint: (mode, key) =>
      mode === "queue" ? `Enter 排队 · ${key} 打断并发送` : `Enter 打断并发送 · ${key} 排队`,
  },
  tool: {
    interrupted: "已中断",
    timedOut: "超时",
    exit: (code) => `退出 ${code}`,
    lines: (n) => `${n} 行`,
    failed: "失败",
    image: (mime) => `图片 ${mime}`,
    emptyFile: "空文件",
    read: (n) => `读取 ${n} 行`,
    edits: (n) => `${n} 处修改`,
    write: (created, n) => `${created ? "新建" : "覆盖"} · ${n} 行`,
    noMatch: "无匹配",
    matches: (matches, files) => `${matches} 处匹配 · ${files ?? "?"} 个文件`,
    files: (n) => `${n} 个文件`,
    codemode: (calls, lines) => `${calls} 个内层调用 · 脚本输出 ${lines} 行`,
    done: "完成",
    outputLines: (n) => `${n} 行输出`,
    awaiting: (glyph) => `${glyph} 等待确认`,
    subagentRunning: (elapsed) => `子 Agent · 运行中 ${elapsed}`,
    running: (elapsed) => `运行中 · ${elapsed}`,
    moreLines: (ellipsis, n) => `${ellipsis} 另 ${n} 行（Ctrl+O 展开）`,
    earlierCalls: (ellipsis, n) => `${ellipsis} 前 ${n} 个调用`,
  },
} satisfies Messages<typeof en>;
