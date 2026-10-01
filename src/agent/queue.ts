/**
 * PendingMessageQueue（设计 §4.3）：steer / followUp 两条队列共用。[B2]
 *
 * `one-at-a-time`：每个投递点只取一条；`all`：一次取空。abort 不清队列。
 */

import type { QueueMode } from "./types.js";
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
