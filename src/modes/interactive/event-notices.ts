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
