/**
 * 助手事件流（设计 §3.1）：生产者 push 事件，消费者 `for await` 读取，`result()` 拿最终消息。
 *
 * 不变量（由本类守住，协议实现不必各自防御）：
 * - 终止事件（done / error）之后的 push 一律丢弃，只会有**一个**终止事件；
 * - `result()` 在终止事件时 resolve（error 也 resolve，不 reject）；
 * - `end()` 前没有终止事件属于实现缺陷：补一个 error 事件兜底，消费者不会永远挂起。
 */

import type { AssistantEvent, AssistantEventStream, AssistantMessage } from "./types.js";

type Waiter = (result: IteratorResult<AssistantEvent>) => void;

export class AssistantEventStreamImpl implements AssistantEventStream {
  private readonly queue: AssistantEvent[] = [];
  private readonly waiters: Waiter[] = [];
  private finished = false;
  private closed = false;
  private lastPartial: AssistantMessage | undefined;
  private resolveResult!: (message: AssistantMessage) => void;
  private readonly resultPromise: Promise<AssistantMessage>;

  constructor() {
    this.resultPromise = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  /** 最近一个事件携带的部分消息。 */
  get partial(): AssistantMessage | undefined {
    return this.lastPartial;
  }

  /** 已经推过终止事件。 */
  get isFinished(): boolean {
    return this.finished;
  }

  push(event: AssistantEvent): void {
    if (this.finished || this.closed) return;
    if ("partial" in event) this.lastPartial = event.partial;
    if (event.type === "done" || event.type === "error") {
      this.finished = true;
      this.resolveResult(event.message);
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
    if (this.finished) this.close();
  }

  /** 结束流；若还没有终止事件，补一个 error。 */
  end(fallback?: AssistantMessage): void {
    if (!this.finished) {
      const message = fallback ?? this.lastPartial;
      if (message) {
        message.stopReason = "error";
        message.errorMessage ??= "Stream ended without a terminal event";
        this.push({ type: "error", reason: "error", message });
      }
    }
    this.close();
  }

  result(): Promise<AssistantMessage> {
    return this.resultPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<AssistantEvent> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<AssistantEvent>>((resolve) => this.waiters.push(resolve));
      },
      return: () => Promise.resolve({ value: undefined, done: true }),
    };
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
}

/** 把一个异步生产函数包成事件流；生产函数抛出的异常编码为 error 事件（流函数不抛错）。 */
export function runEventStream(
  initial: () => AssistantMessage,
  produce: (stream: AssistantEventStreamImpl) => Promise<void>,
): AssistantEventStreamImpl {
  const stream = new AssistantEventStreamImpl();
  void produce(stream).then(
    () => stream.end(),
    (error: unknown) => {
      const message = stream.partial ?? initial();
      message.stopReason = "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "error", message });
      stream.end();
    },
  );
  return stream;
}

/** 读完一个事件流，返回全部事件（测试与非流式调用用）。 */
export async function collectEvents(
  stream: AsyncIterable<AssistantEvent>,
): Promise<AssistantEvent[]> {
  const events: AssistantEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
