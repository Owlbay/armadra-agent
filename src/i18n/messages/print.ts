/**
 * 消息目录：print（键名规范见 docs/i18n.md）。[W6-C0 建空壳，W6-I3 迁入 `src/modes/{print,rpc}/**`；
 * ACP 的文案在 [ACP-C0] 迁到 acp.ts]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 * RPC 的 `error` / `message` 是人读文本，宿主按 `code` 判断（docs/rpc.md）；JSON 字段名不在这里。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

export const en = {
  /** `ama -p` 的 stderr。 */
  print: {
    stdinIgnored: (wait: string) =>
      `ama: no piped input within ${wait}, ignored; to wait for it, end the arguments with -\n`,
    stdinWaiting:
      "ama: waiting for stdin to end (Ctrl+D ends it; the prompt can also be an argument)…\n",
    seconds: (n: number) => plural(n, "second"),
    millis: (n: number) => `${n} ms`,
    needsPrompt: "ama: -p needs a prompt (positional argument or stdin pipe)\n",
    retry: (attempt: number, max: number, seconds: number, error: string) =>
      `ama: ↻ retry ${attempt}/${max} (in ${seconds}s): ${error}\n`,
    modelFailed: "model call failed",
    waitingTasks: (n: number) =>
      `ama: waiting for ${plural(n, "background task")} and their notification turns (Ctrl+C stops them)\n`,
    planPending: (version: number, where: string) =>
      `ama: plan v${version} saved, awaiting approval (not executed): ${where}; -p does not approve on anyone's behalf — ` +
      "approve it in the interactive UI or via RPC plan_response, or set plan.unattended: approve to let -p approve and continue",
    limitTurns: (limit: number) =>
      `ama: reached the turn limit ${limit} (--max-turns / limits.maxTurns); run ended before finishing`,
    limitCost: (limit: string, spent: string) =>
      `ama: reached the cost limit ${limit} (spent ${spent}; --max-cost / limits.maxCostUsd); run ended before finishing`,
    denied: (count: number, tools: readonly string[], reason: string) =>
      `ama: ${plural(count, "tool call")} denied: ${tools.join(", ")}${reason !== "" ? ` (${reason})` : ""}; ` +
      "-p has no one to approve; to allow them use --permission-mode auto-edit|auto or --allow <rule>",
    searchToolsMissing: (preset: string, missing: readonly string[]) =>
      `ama: the ${preset} preset has no ${missing.join(" / ")}; add ${missing.length === 1 ? "it" : "them"} with ` +
      `tools.default: [${missing.map((name) => `"+${name}"`).join(",")}]`,
  },
  /** RPC 响应的 `error`（人读）。 */
  rpc: {
    unknownCommand: (type: string) => `unknown command: ${type}`,
    parseFailed: (error: string) => `JSON parse failed: ${error}`,
    badTaskId: "taskId must be a string",
    missingType: "missing type",
    unsupported: "this session does not support this command",
    noPlan: "this session has no plan extension",
    badMode: (modes: readonly string[]) => `mode must be ${modes.join(" | ")}`,
  },
};

export const zh = {
  print: {
    stdinIgnored: (wait) => `ama: 未在 ${wait}内收到管道输入，已忽略；需要等待请在末尾加 -\n`,
    stdinWaiting: "ama: 正在等待 stdin 输入结束（Ctrl+D 结束；提示也可以直接写成参数）…\n",
    seconds: (n) => `${n} 秒`,
    millis: (n) => `${n} 毫秒`,
    needsPrompt: "ama: -p 需要提示（位置参数或 stdin 管道）\n",
    waitingTasks: (n) => `ama: 等待 ${n} 个后台任务及其通知回合结束（Ctrl+C 中止）\n`,
    retry: (attempt, max, seconds, error) =>
      `ama: ↻ 重试 ${attempt}/${max}（${seconds}s 后）：${error}\n`,
    modelFailed: "模型调用失败",
    planPending: (version, where) =>
      `ama: 计划 v${version} 已落盘、待审批（未执行）：${where}；-p 不替人批准——` +
      "在交互界面或 RPC plan_response 里审批，或设 plan.unattended: approve 让 -p 批准后接着执行",
    limitTurns: (limit) =>
      `ama: 已达到回合上限 ${limit}（--max-turns / limits.maxTurns），运行在完成前结束`,
    limitCost: (limit, spent) =>
      `ama: 已达到费用上限 ${limit}（累计 ${spent}；--max-cost / limits.maxCostUsd），运行在完成前结束`,
    denied: (count, tools, reason) =>
      `ama: ${count} 次工具调用被拒：${tools.join("、")}${reason !== "" ? `（${reason}）` : ""}；` +
      "-p 没有人审批，需要放行时用 --permission-mode auto-edit|auto 或 --allow <规则>",
    searchToolsMissing: (preset, missing) =>
      `ama: ${preset} 预设没有 ${missing.join(" / ")}，可用 ` +
      `tools.default: [${missing.map((name) => `"+${name}"`).join(",")}] 加上`,
  },
  rpc: {
    badTaskId: "taskId 应为字符串",
    unknownCommand: (type) => `未知命令：${type}`,
    parseFailed: (error) => `JSON 解析失败：${error}`,
    missingType: "缺少 type",
    unsupported: "该会话不支持此命令",
    noPlan: "该会话没有装配 plan 扩展",
    badMode: (modes) => `mode 应为 ${modes.join(" | ")}`,
  },
} satisfies Messages<typeof en>;
