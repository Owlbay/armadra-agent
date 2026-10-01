/**
 * 头 / 尾截断（行数 + 字节双阈值，先到者为准）与全文落盘（设计 §5.2、§4.4）。[B3]
 *
 * - read / grep 用**头截断**（保留开头，提示 offset 续读）；bash 用**尾截断**（保留结尾）。
 * - 字节按 UTF-8 计；不切断多字节字符；单行超过字节上限时按字符边界截该行。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
/** grep 匹配行的字符上限。 */
export const GREP_MAX_LINE_CHARS = 500;

export interface TruncateOptions {
  maxLines?: number;
  maxBytes?: number;
}

export interface TruncateResult {
  content: string;
  truncated: boolean;
  /** 哪个阈值先到；未截断为 null。 */
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 末尾换行不算一行：`"a\nb\n"` 是 2 行。 */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 按 UTF-8 字节数从头截取，不切断字符。 */
export function sliceHeadBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // 回退到字符起始字节（10xxxxxx 是续字节）。
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** 按 UTF-8 字节数从尾截取，不切断字符。 */
export function sliceTailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

function limits(options: TruncateOptions): { maxLines: number; maxBytes: number } {
  return {
    maxLines: options.maxLines ?? DEFAULT_MAX_LINES,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
  };
}

/** 保留开头。 */
export function truncateHead(text: string, options: TruncateOptions = {}): TruncateResult {
  const { maxLines, maxBytes } = limits(options);
  const lines = splitLines(text);
  const totalBytes = byteLength(text);
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return {
      content: text,
      truncated: false,
      truncatedBy: null,
      totalLines: lines.length,
      totalBytes,
      outputLines: lines.length,
      outputBytes: totalBytes,
    };
  }
  const out: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (const line of lines) {
    if (out.length >= maxLines) {
      truncatedBy = "lines";
      break;
    }
    const cost = byteLength(line) + (out.length > 0 ? 1 : 0);
    if (bytes + cost > maxBytes) {
      truncatedBy = "bytes";
      if (out.length === 0) out.push(sliceHeadBytes(line, maxBytes));
      break;
    }
    out.push(line);
    bytes += cost;
  }
  const content = out.join("\n");
  return {
    content,
    truncated: true,
    truncatedBy,
    totalLines: lines.length,
    totalBytes,
    outputLines: out.length,
    outputBytes: byteLength(content),
  };
}

/** 保留结尾。 */
export function truncateTail(text: string, options: TruncateOptions = {}): TruncateResult {
  const { maxLines, maxBytes } = limits(options);
  const lines = splitLines(text);
  const totalBytes = byteLength(text);
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return {
      content: text,
      truncated: false,
      truncatedBy: null,
      totalLines: lines.length,
      totalBytes,
      outputLines: lines.length,
      outputBytes: totalBytes,
    };
  }
  const out: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (out.length >= maxLines) {
      truncatedBy = "lines";
      break;
    }
    const line = lines[i] ?? "";
    const cost = byteLength(line) + (out.length > 0 ? 1 : 0);
    if (bytes + cost > maxBytes) {
      truncatedBy = "bytes";
      if (out.length === 0) out.push(sliceTailBytes(line, maxBytes));
      break;
    }
    out.push(line);
    bytes += cost;
  }
  out.reverse();
  const content = out.join("\n");
  return {
    content,
    truncated: true,
    truncatedBy,
    totalLines: lines.length,
    totalBytes,
    outputLines: out.length,
    outputBytes: byteLength(content),
  };
}

/** 单行按字符截断，附省略提示。 */
export function truncateLine(line: string, maxChars = GREP_MAX_LINE_CHARS): string {
  const chars = Array.from(line);
  if (chars.length <= maxChars) return line;
  return `${chars.slice(0, maxChars).join("")}… [${chars.length - maxChars} more chars]`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 截断全文的落盘目录：`ctx.outputDir`，内存会话落到系统临时目录。 */
export function resolveOutputDir(outputDir: string | undefined): string {
  return outputDir ?? join(tmpdir(), "ama-outputs");
}

/** 文件名里只保留安全字符。 */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned === "" ? "output" : cleaned.slice(0, 120);
}

/** 写全文，返回绝对路径。 */
export function writeFullOutput(
  outputDir: string | undefined,
  fileName: string,
  content: string | Buffer,
): string {
  const dir = resolveOutputDir(outputDir);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, safeFileName(fileName));
  writeFileSync(target, content);
  return target;
}
