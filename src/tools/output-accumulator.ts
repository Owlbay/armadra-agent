/**
 * 进程输出累积（设计 §5.2 bash）。[B3]
 *
 * - 保留滚动尾部（约 2 × maxBytes）用于流式 `onUpdate` 与最终尾截断；
 * - 内存里最多攒 `memoryLimitBytes`，超出即把已有内容落文件，之后增量追加，内存只留尾部；
 * - `finish()` 做尾截断（行数 + 字节）；发生截断而尚未落盘时补写全文，给出 `fullOutputPath`；
 * - 输出清洗：去 ANSI 转义与除 `\t\n` 外的控制字符，`\r\n` → `\n`。
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, sliceTailBytes, truncateTail } from "./truncate.js";

export interface OutputAccumulatorOptions {
  maxLines?: number;
  maxBytes?: number;
  /** 内存上限，缺省 1 MB。 */
  memoryLimitBytes?: number;
  /** 全文落盘路径（懒求值，只在需要时调用一次）。 */
  spillPath(): string;
}

export interface AccumulatedOutput {
  /** 尾截断后的输出。 */
  output: string;
  truncated: boolean;
  fullOutputPath?: string;
  totalBytes: number;
  totalLines: number;
  outputLines: number;
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function sanitizeOutput(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(ANSI, "").replace(/\r/g, "\n").replace(CONTROL, "");
}

export class OutputAccumulator {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly memoryLimit: number;
  private readonly decoder = new StringDecoder("utf8");
  private chunks: string[] = [];
  private memoryBytes = 0;
  private tailText = "";
  private spilledTo: string | undefined;
  private bytes = 0;
  private newlines = 0;
  private lastChar = "";

  constructor(private readonly options: OutputAccumulatorOptions) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.memoryLimit = options.memoryLimitBytes ?? 1024 * 1024;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  append(chunk: Buffer | string): void {
    const raw = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.bytes += raw.length;
    this.pushText(this.decoder.write(raw));
  }

  private pushText(text: string): void {
    if (text === "") return;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.newlines++;
    this.lastChar = text[text.length - 1] ?? this.lastChar;
    this.tailText += text;
    if (this.tailText.length > this.maxBytes * 4) {
      this.tailText = sliceTailBytes(this.tailText, this.maxBytes * 2);
    }
    if (this.spilledTo !== undefined) {
      appendFileSync(this.spilledTo, text);
      return;
    }
    this.chunks.push(text);
    this.memoryBytes += Buffer.byteLength(text, "utf8");
    if (this.memoryBytes > this.memoryLimit) this.spill();
  }

  private spill(): void {
    const target = this.options.spillPath();
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, this.chunks.join(""));
    this.spilledTo = target;
    this.chunks = [];
    this.memoryBytes = 0;
  }

  /** 当前滚动尾部（已清洗、尾截断），给流式 onUpdate。 */
  tail(maxLines = 50): string {
    return truncateTail(sanitizeOutput(this.tailText), { maxLines, maxBytes: this.maxBytes })
      .content;
  }

  finish(): AccumulatedOutput {
    this.pushText(this.decoder.end());
    const totalLines = this.newlines + (this.bytes > 0 && this.lastChar !== "\n" ? 1 : 0);
    let source: string;
    if (this.spilledTo !== undefined) {
      // 尾部可能从半行开始：去掉第一行残片。
      const cut = this.tailText.indexOf("\n");
      source = cut >= 0 ? this.tailText.slice(cut + 1) : this.tailText;
    } else {
      source = this.chunks.join("");
    }
    const result = truncateTail(sanitizeOutput(source), {
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    });
    const truncated = result.truncated || this.spilledTo !== undefined;
    if (truncated && this.spilledTo === undefined) this.spill();
    return {
      output: result.content,
      truncated,
      ...(truncated && this.spilledTo !== undefined ? { fullOutputPath: this.spilledTo } : {}),
      totalBytes: this.bytes,
      totalLines,
      outputLines: result.outputLines,
    };
  }
}
