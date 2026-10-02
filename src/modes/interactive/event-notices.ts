/**
 * 交互界面对几类会话事件的友好提示（第五波其它批次转来的显示项）。[W5-A]
 *
 * - W5-I：`entry_appended` 里 `reason: "image_budget"` 的 `context_edit`（一次降级会连写多条，每条一个消息）
 *   合并成一条「已省略 N 张早期图片以符合请求上限」，N 按占位文本数；
 * - W5-H1：`compaction_end.error` 的「compaction did not shrink」换成中文说明（其余错误原样）。
 */

import type { SessionEvent } from "../../agent/types.js";
import {
  IMAGE_OMITTED_FOR_BUDGET,
  IMAGE_OMITTED_TOO_LARGE,
} from "../../compaction/image-budget.js";

/** `compaction_end.error` 的显示文本。 */
export function compactionErrorText(error: string): string {
  if (/compaction did not shrink/i.test(error)) {
    return "压缩后上下文没有变小，已保留原对话（不写摘要）";
  }
  return error;
}

function count(text: string, needle: string): number {
  let n = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** 同一轮同步写下的 image_budget 降级合并成一条提示。 */
export class ImageBudgetNotices {
  private pending = 0;
  private scheduled = false;

  constructor(private readonly notify: (text: string) => void) {}

  onEvent(event: SessionEvent): void {
    if (event.type !== "entry_appended") return;
    const entry = event.entry;
    if (entry.type !== "context_edit" || entry.reason !== "image_budget") return;
    const text = entry.replacement ?? "";
    const images = count(text, IMAGE_OMITTED_FOR_BUDGET) + count(text, IMAGE_OMITTED_TOO_LARGE);
    this.pending += Math.max(1, images);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      const n = this.pending;
      this.pending = 0;
      this.scheduled = false;
      this.notify(`已省略 ${n} 张早期图片以符合请求上限`);
    });
  }
}

// ---------------------------------------------------------------------------
// [W5-U] 第五波 harness 事件（W5-H2）的提示文本：交互界面与 line 模式共用
// ---------------------------------------------------------------------------

/** `agent_settled.warning` 为它时不再单独显示（`limit_reached` 事件已给出友好提示）。 */
export const LIMIT_WARNING = "limit_reached";

/** `limit_reached`：回合 / 费用到限（每次运行每类一次）。 */
export function limitReachedText(event: Extract<SessionEvent, { type: "limit_reached" }>): string {
  if (event.kind === "turns")
    return `已到回合上限（${event.limit} 回合），本次运行停止；发新消息继续（--max-turns / limits.maxTurns）`;
  const spent = `$${event.value.toFixed(2)}`;
  return `已到费用上限 $${event.limit.toFixed(2)}（本次运行已用 ${spent}），本次运行停止；发新消息继续（--max-cost / limits.maxCostUsd）`;
}

/** `model_fallback`：主模型失败后改用回退模型重试一次。 */
export function modelFallbackText(
  event: Extract<SessionEvent, { type: "model_fallback" }>,
): string {
  const ref = (m: { provider: string; id: string }): string => `${m.provider}/${m.id}`;
  return `${ref(event.from)} 不可用（${event.reason}），本次请求改用 ${ref(event.to)}，回复后切回`;
}

/** `background_job`：后台命令启动 / 退出 / 停止。 */
export function backgroundJobText(
  event: Extract<SessionEvent, { type: "background_job" }>,
): string {
  const command = event.command.replace(/\s+/g, " ").trim();
  const short = command.length > 60 ? `${command.slice(0, 59)}…` : command;
  switch (event.phase) {
    case "started":
      return `后台命令 ${event.jobId} 已启动：${short}`;
    case "exited":
      return `后台命令 ${event.jobId} 已退出（码 ${event.exitCode ?? "?"}）：${short}`;
    case "stopped":
      return `后台命令 ${event.jobId} 已停止：${short}`;
  }
}
