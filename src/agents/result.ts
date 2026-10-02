/**
 * 子 Agent 结果的上限、落盘与通知文本（docs/wave5-plan.md §7.4，D23–D24）。[W5-G]
 *
 * - 结果 > 50 KB（UTF-8 字节）保留头 70% + 尾 30%，中间一行说明省略了多少、全文在哪；
 * - 后台任务完成后以 `<task-notification>` 作为 followUp 投递给父会话（系统提示 rules 里由 task
 *   工具的 guideline 说明这不是用户发言）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "../ai/types.js";
import type { SubagentStatus } from "../tools/types.js";

export const TASK_RESULT_LIMIT_BYTES = 50 * 1024;
const HEAD_SHARE = 0.7;

export const MAX_TURNS_NOTE = "[Turn limit reached; the sub-agent's last output follows.]";

/** 去掉按字节切开时残留的半个字符（U+FFFD）。 */
function trimReplacement(text: string, side: "start" | "end"): string {
  return side === "end" ? text.replace(/�+$/, "") : text.replace(/^�+/, "");
}

/** 超过上限时保留头尾；返回 `truncated` 供调用方决定是否落盘。 */
export function capTaskText(
  text: string,
  outputFile: string | undefined,
  limit = TASK_RESULT_LIMIT_BYTES,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, truncated: false };
  const headBytes = Math.floor(limit * HEAD_SHARE);
  const tailBytes = limit - headBytes;
  const head = trimReplacement(bytes.subarray(0, headBytes).toString("utf8"), "end");
  const tail = trimReplacement(bytes.subarray(bytes.length - tailBytes).toString("utf8"), "start");
  const omitted = bytes.length - headBytes - tailBytes;
  const where = outputFile === undefined ? "" : `; full output: ${outputFile}`;
  return { text: `${head}\n\n[… ${omitted} bytes omitted${where} …]\n\n${tail}`, truncated: true };
}

/** 全文写到 `<dir>/<name>`；失败返回 undefined（结果仍按截断返回）。 */
export function writeTaskOutput(dir: string, name: string, text: string): string | undefined {
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, text);
    return file;
  } catch {
    return undefined;
  }
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export interface NotificationInput {
  taskId: string;
  agent: string;
  status: SubagentStatus;
  turns?: number;
  usage?: Usage;
  outputFile?: string;
  /** 已按上限截断的最终报告。 */
  report: string;
}

export function taskNotification(input: NotificationInput): string {
  const attrs = [
    `taskId="${attr(input.taskId)}"`,
    `agent="${attr(input.agent)}"`,
    `status="${input.status}"`,
  ];
  if (input.turns !== undefined) attrs.push(`turns="${input.turns}"`);
  if (input.usage !== undefined) attrs.push(`tokens="${formatTokens(input.usage.totalTokens)}"`);
  if (input.outputFile !== undefined) attrs.push(`outputFile="${attr(input.outputFile)}"`);
  return `<task-notification ${attrs.join(" ")}>\n${input.report}\n</task-notification>`;
}

/** 系统提示 rules 节的一句（task 工具的 promptGuidelines；会话开始即固定）。 */
export const TASK_NOTIFICATION_RULE =
  "A <task-notification> message is a background task's report, not the user speaking.";
