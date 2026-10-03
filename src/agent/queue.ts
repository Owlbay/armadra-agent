/**
 * PendingMessageQueue（设计 §4.3）：steer / followUp 两条队列共用。[B2]
 *
 * `one-at-a-time`：每个投递点只取一条；`all`：一次取空。abort 不清队列。
 */

import type { QueueMode } from "./types.js";
import type { ImageBlock } from "../ai/types.js";
import type { AgentMessage } from "../session/types.js";

export class PendingMessageQueue {
  private items: AgentMessage[] = [];
  mode: QueueMode;

  constructor(mode: QueueMode = "one-at-a-time") {
    this.mode = mode;
  }

  get size(): number {
    return this.items.length;
  }

  enqueue(message: AgentMessage): void {
    this.items.push(message);
  }

  hasItems(): boolean {
    return this.items.length > 0;
  }

  /** 下一个投递点会取走的消息（不消费）。 */
  peek(): AgentMessage[] {
    if (this.mode === "all") return this.items.slice();
    const first = this.items[0];
    return first === undefined ? [] : [first];
  }

  drain(): AgentMessage[] {
    const drained = this.peek();
    this.items = this.items.slice(drained.length);
    return drained;
  }

  /** 取走全部（clearQueue）。 */
  clear(): AgentMessage[] {
    const all = this.items;
    this.items = [];
    return all;
  }

  /** 取走最后一条（Alt+Up 取回）。 */
  popLast(): AgentMessage | undefined {
    return this.items.pop();
  }

  snapshot(): readonly AgentMessage[] {
    return this.items.slice();
  }
}

/** 队列消息的显示文本（queue_update 事件用）。 */
export function queuedText(message: AgentMessage): string {
  if (message.role !== "user" && message.role !== "custom") return "";
  const { content } = message;
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("");
}

/**
 * 打断并立即发送的新回合输入：排队的 steer（按入队顺序）在前、本条在后，文字以空行拼接，图片依次保留。
 * 全部为空时 undefined（不打断）。
 */
export function mergeForInterrupt(
  queued: readonly AgentMessage[],
  text: string,
  images: readonly ImageBlock[] = [],
): { text: string; images: ImageBlock[] } | undefined {
  const texts: string[] = [];
  const merged: ImageBlock[] = [];
  for (const message of queued) {
    if (message.role !== "user") continue;
    const { content } = message;
    if (typeof content === "string") texts.push(content);
    else {
      texts.push(content.map((block) => (block.type === "text" ? block.text : "")).join(""));
      for (const block of content) if (block.type === "image") merged.push(block);
    }
  }
  texts.push(text);
  merged.push(...images);
  const parts = texts.filter((part) => part.trim() !== "");
  if (parts.length === 0 && merged.length === 0) return undefined;
  return { text: parts.join("\n\n"), images: merged };
}
