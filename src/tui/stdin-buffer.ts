/**
 * 标准输入缓冲（设计 §12.3）。[B4]
 *
 * - 把分片到达的原始输入切成「一个键一个序列」：完整的 CSI / SS3 / OSC / APC / DCS、
 *   Alt 前缀（`ESC x`、`ESC ESC [ A`）、单个字素簇。
 * - 括号粘贴 `ESC[200~ … ESC[201~` 跨任意多个 data 块累积，结束时作为**一次** paste 事件发出；
 *   粘贴内部的 `\r` / `\n` / ESC 都是数据，不解析为键。
 * - 块末尾的不完整转义序列先挂起；在 `AMA_TUI_ESC_TIMEOUT` 毫秒内没有后续数据就原样发出
 *   （孤立 ESC 即 Escape 键）。缺省：SSH / tmux 下 100 ms，本地 10 ms。
 */

import { graphemeSegmenter } from "./ansi.js";
import { PASTE_END, PASTE_START } from "./keys.js";

export interface StdinBufferOptions {
  /** 每个完整键序列。 */
  onData(sequence: string): void;
  /** 括号粘贴正文（不含 200~/201~ 包裹）。 */
  onPaste(text: string): void;
  /** 孤立 ESC 判定超时（ms）；缺省见 `defaultEscTimeout()`。 */
  escTimeoutMs?: number;
}

/** 读环境：`AMA_TUI_ESC_TIMEOUT` 优先；否则 SSH / tmux 100 ms，本地 10 ms。 */
export function defaultEscTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["AMA_TUI_ESC_TIMEOUT"];
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (env["SSH_CONNECTION"] || env["SSH_TTY"] || env["SSH_CLIENT"] || env["TMUX"]) return 100;
  return 10;
}

type Scan =
  | { kind: "complete"; length: number }
  | { kind: "incomplete" }
  | { kind: "paste-start"; length: number };

/** 从 0 开始扫描一个转义序列（buf[0] === ESC）。 */
function scanEscape(buf: string): Scan {
  if (buf.length === 1) return { kind: "incomplete" };
  const second = buf[1]!;
  if (second === "[") {
    for (let j = 2; j < buf.length; j++) {
      const c = buf.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) {
        const seq = buf.slice(0, j + 1);
        if (seq === PASTE_START) return { kind: "paste-start", length: j + 1 };
        return { kind: "complete", length: j + 1 };
      }
      // CSI 参数 / 中间字节之外的字符：序列被打断，只取 ESC[
      if (c < 0x20 || c > 0x7e) return { kind: "complete", length: 2 };
    }
    return { kind: "incomplete" };
  }
  if (second === "O") {
    if (buf.length < 3) return { kind: "incomplete" };
    return { kind: "complete", length: 3 };
  }
  if (second === "]" || second === "_" || second === "P" || second === "^" || second === "X") {
    for (let j = 2; j < buf.length; j++) {
      const c = buf.charCodeAt(j);
      if (c === 0x07) return { kind: "complete", length: j + 1 };
      if (c === 0x1b) {
        if (j + 1 >= buf.length) return { kind: "incomplete" };
        if (buf[j + 1] === "\\") return { kind: "complete", length: j + 2 };
      }
    }
    return { kind: "incomplete" };
  }
  if (second === "\x1b") {
    // ESC ESC [ A：Alt + 转义序列；ESC ESC 单独出现为 Alt+Escape
    if (buf.length === 2) return { kind: "incomplete" };
    const inner = scanEscape(buf.slice(1));
    if (inner.kind === "complete") return { kind: "complete", length: inner.length + 1 };
    if (inner.kind === "paste-start") return { kind: "complete", length: 2 };
    return inner;
  }
  // Alt 前缀 + 单个字素
  const rest = buf.slice(1);
  const first = graphemeSegmenter().segment(rest.slice(0, 64))[Symbol.iterator]().next();
  const segment = first.done ? rest[0]! : first.value.segment;
  return { kind: "complete", length: 1 + segment.length };
}

export class StdinBuffer {
  private buffer = "";
  private pasteBuffer: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly escTimeoutMs: number;
  private destroyed = false;

  constructor(private readonly options: StdinBufferOptions) {
    this.escTimeoutMs = options.escTimeoutMs ?? defaultEscTimeout();
  }

  /** 是否处于括号粘贴中（等待 ESC[201~）。 */
  get inPaste(): boolean {
    return this.pasteBuffer !== null;
  }

  process(chunk: string | Buffer): void {
    if (this.destroyed) return;
    this.clearTimer();
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.drain();
  }

  /** 立即发出所有挂起数据（超时或停止时调用）。 */
  flush(): void {
    this.clearTimer();
    if (this.pasteBuffer !== null) {
      // 粘贴结束标记一直没到：按已收到的正文发出，不丢数据
      const text = this.pasteBuffer + this.buffer;
      this.pasteBuffer = null;
      this.buffer = "";
      this.options.onPaste(text);
      return;
    }
    if (this.buffer.length > 0) {
      const pending = this.buffer;
      this.buffer = "";
      this.options.onData(pending);
    }
  }

  destroy(): void {
    this.clearTimer();
    this.destroyed = true;
    this.buffer = "";
    this.pasteBuffer = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private drain(): void {
    while (this.buffer.length > 0) {
      if (this.pasteBuffer !== null) {
        if (!this.drainPaste()) return;
        continue;
      }
      const buf = this.buffer;
      if (buf.charCodeAt(0) === 0x1b) {
        const scan = scanEscape(buf);
        if (scan.kind === "incomplete") {
          this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
          }, this.escTimeoutMs);
          return;
        }
        this.buffer = buf.slice(scan.length);
        if (scan.kind === "paste-start") this.pasteBuffer = "";
        else this.options.onData(buf.slice(0, scan.length));
        continue;
      }
      const length = this.nextTextLength(buf);
      this.buffer = buf.slice(length);
      this.options.onData(buf.slice(0, length));
    }
  }

  /** 粘贴模式：找结束标记；标记可能被切在块边界上，保留可能的前缀等下一块。 */
  private drainPaste(): boolean {
    const combined = this.pasteBuffer! + this.buffer;
    const end = combined.indexOf(PASTE_END);
    if (end === -1) {
      const keep = partialSuffixLength(combined, PASTE_END);
      this.pasteBuffer = combined.slice(0, combined.length - keep);
      this.buffer = combined.slice(combined.length - keep);
      // buffer 里只剩可能的结束标记前缀：等下一块
      return false;
    }
    const text = combined.slice(0, end);
    this.pasteBuffer = null;
    this.buffer = combined.slice(end + PASTE_END.length);
    this.options.onPaste(text);
    return true;
  }

  /** 非转义数据：一个字素簇为一个序列（控制字符单独成序列）。 */
  private nextTextLength(buf: string): number {
    const c = buf.charCodeAt(0);
    if (c < 0x20 || c === 0x7f) return 1;
    const first = graphemeSegmenter().segment(buf.slice(0, 64))[Symbol.iterator]().next();
    if (first.done) return 1;
    // 字素簇不能吞掉后面的 ESC 或控制字符
    let len = first.value.segment.length;
    for (let i = 1; i < len; i++) {
      const cc = buf.charCodeAt(i);
      if (cc < 0x20 || cc === 0x7f) {
        len = i;
        break;
      }
    }
    return len;
  }
}

/** s 的后缀与 marker 的前缀最长重合长度（< marker.length）。 */
function partialSuffixLength(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1);
  for (let len = max; len > 0; len--) {
    if (marker.startsWith(s.slice(s.length - len))) return len;
  }
  return 0;
}
