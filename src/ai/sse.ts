/**
 * Server-Sent Events 解析（设计 §1.2 ai/sse.ts）：event / data / id / 多行 data / 注释行 /
 * CRLF、CR、LF 三种行尾 / UTF-8 跨块 / 首字节 BOM。
 *
 * 规则取自 WHATWG「Interpreting an event stream」：空行分派事件；`:` 开头是注释；字段名后的
 * 第一个空格去掉；多条 data 以 LF 连接。为兼容不规范服务端，流结束时未以空行收尾的最后一个
 * 事件也会分派。
 */

import { IdleTimeoutError } from "./http.js";

export interface SseEvent {
  /** `event:` 字段；缺省时为 undefined（规范上视为 "message"）。 */
  event: string | undefined;
  data: string;
  id: string | undefined;
}

export class SseParser {
  private buffer = "";
  private event: string | undefined;
  private data: string[] = [];
  private id: string | undefined;
  private hasData = false;
  private bomChecked = false;
  /** 上一块以 CR 结尾：下一块开头的 LF 属于同一个行尾。 */
  private pendingCr = false;

  /** 喂入一段文本，返回其中完整分派的事件。 */
  feed(chunk: string): SseEvent[] {
    let text = chunk;
    if (!this.bomChecked && text.length > 0) {
      this.bomChecked = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (this.pendingCr && text.startsWith("\n")) text = text.slice(1);
    this.pendingCr = false;
    this.buffer += text;
    const events: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer.charCodeAt(i);
      if (ch !== 10 && ch !== 13) continue;
      const line = this.buffer.slice(start, i);
      if (ch === 13) {
        if (i + 1 < this.buffer.length) {
          if (this.buffer.charCodeAt(i + 1) === 10) i++;
        } else {
          this.pendingCr = true;
        }
      }
      start = i + 1;
      const event = this.processLine(line);
      if (event) events.push(event);
    }
    this.buffer = this.buffer.slice(start);
    return events;
  }

  /** 流结束：处理残留行，并分派未以空行收尾的事件。 */
  flush(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      const event = this.processLine(this.buffer);
      if (event) events.push(event);
      this.buffer = "";
    }
    const last = this.dispatch();
    if (last) events.push(last);
    return events;
  }

  private processLine(line: string): SseEvent | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.event = value;
        break;
      case "data":
        this.data.push(value);
        this.hasData = true;
        break;
      case "id":
        if (!value.includes("\0")) this.id = value;
        break;
      default:
        // retry 与未知字段忽略
        break;
    }
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    const hadContent = this.hasData || this.event !== undefined;
    const event: SseEvent = { event: this.event, data: this.data.join("\n"), id: this.id };
    this.event = undefined;
    this.data = [];
    this.hasData = false;
    return hadContent ? event : undefined;
  }
}

/**
 * 从字节流读 SSE 事件；`signal` 中止时停止读取（调用方据此产出 aborted）。
 * `idleTimeoutMs`：等待下一块字节的上限，每收到一块即重新计时（消费者处理事件的时间不计）；
 * 超时取消底层流并抛 `IdleTimeoutError`（phase `stream`）。
 */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutMs?: number,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = new SseParser();
  const onAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let drained = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  const arm = (): void => {
    if (idleTimeoutMs === undefined || idleTimeoutMs <= 0) return;
    idle = setTimeout(() => {
      stalled = true;
      reader.cancel().catch(() => undefined);
    }, idleTimeoutMs);
  };
  try {
    while (true) {
      if (signal?.aborted) return;
      arm();
      const { value, done } = await reader.read();
      clearTimeout(idle);
      if (stalled && !signal?.aborted) throw new IdleTimeoutError(idleTimeoutMs ?? 0, "stream");
      if (done) break;
      if (signal?.aborted) return;
      for (const event of parser.feed(decoder.decode(value, { stream: true }))) yield event;
    }
    drained = true;
    for (const event of parser.feed(decoder.decode())) yield event;
    for (const event of parser.flush()) yield event;
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener("abort", onAbort);
    // 消费者提前退出（读到终止事件即 break）或中止：取消底层流，释放连接
    if (!drained) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
