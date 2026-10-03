/**
 * 交互界面对几类会话事件的友好提示（第五波其它批次转来的显示项）。[W5-A]
 *
 * - W5-I：`entry_appended` 里 `reason: "image_budget"` 的 `context_edit`（一次降级会连写多条，每条一个消息）
 *   合并成一条「已省略 N 张早期图片以符合请求上限」，N 按占位文本数；
 * - W5-H1：`compaction_end.error` 的「compaction did not shrink」换成中文说明（其余错误原样）；
 * - W7-C：`subagent_background`（超时自动 / 宿主转后台）一行提示。
 */

import { msg } from "../../i18n/index.js";
import type { SessionEvent } from "../../agent/types.js";
import {
  IMAGE_OMITTED_FOR_BUDGET,
  IMAGE_OMITTED_TOO_LARGE,
} from "../../compaction/image-budget.js";

/** `compaction_end.error` 的显示文本。 */
export function compactionErrorText(error: string): string {
  if (/compaction did not shrink/i.test(error)) {
    return msg().interactive.events.compactionNoShrink;
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
      this.notify(msg().interactive.events.imagesOmitted(n));
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
  const m = msg().interactive.events;
  if (event.kind === "turns") return m.limitTurns(event.limit);
  return m.limitCost(`$${event.limit.toFixed(2)}`, `$${event.value.toFixed(2)}`);
}

/** `model_fallback`：主模型失败后改用回退模型重试一次。 */
export function modelFallbackText(
  event: Extract<SessionEvent, { type: "model_fallback" }>,
): string {
  const ref = (m: { provider: string; id: string }): string => `${m.provider}/${m.id}`;
  return msg().interactive.events.modelFallback(ref(event.from), event.reason, ref(event.to));
}

/** `background_job`：后台命令启动 / 退出 / 停止。 */
export function backgroundJobText(
  event: Extract<SessionEvent, { type: "background_job" }>,
): string {
  const command = event.command.replace(/\s+/g, " ").trim();
  const short = command.length > 60 ? `${command.slice(0, 59)}…` : command;
  const m = msg().interactive.events;
  switch (event.phase) {
    case "started":
      return m.backgroundStarted(event.jobId, short);
    case "exited":
      return m.backgroundExited(event.jobId, String(event.exitCode ?? "?"), short);
    case "stopped":
      return m.backgroundStopped(event.jobId, short);
  }
}

/** [W7-C] `subagent_background`：超时自动 / 宿主转后台的一行提示（人按 Ctrl+B 的已有底部提示）。 */
export function subagentBackgroundText(
  event: Extract<SessionEvent, { type: "subagent_background" }>,
  agent: string,
): string {
  const m = msg().agents.background;
  return event.reason === "timeout" ? m.timeout(event.taskId, agent) : m.host(event.taskId, agent);
}
