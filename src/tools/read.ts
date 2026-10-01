/**
 * `read` 工具（设计 §5.2）。[B3]
 *
 * 文本按 `cat -n` 形状返回（行号右对齐 6 位 + Tab）；头截断 2000 行 / 50 KB 先到者，末尾提示
 * `offset` 续读；NUL 嗅探判二进制并拒绝；png / jpg / gif / webp 作为 ImageBlock 返回（模型不支持
 * 图片时只给路径与尺寸）；成功后 `ctx.markRead(abs)`。
 */

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { ContentBlock } from "../ai/types.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { displayPath, resolvePath } from "./paths.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js";
import { normalizeToLF, splitBom } from "./edit-fuzzy.js";

export interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadToolOptions {
  /** 当前模型是否接受图片输入；缺省 true。 */
  supportsImages?(ctx: ToolContext): boolean;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const SNIFF_BYTES = 8000;

export function isBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
}

export interface ImageSize {
  width: number;
  height: number;
}

/** 只读文件头取尺寸；不认识返回 undefined。 */
export function imageSize(buf: Buffer, mimeType: string): ImageSize | undefined {
  try {
    if (mimeType === "image/png" && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mimeType === "image/gif" && buf.length >= 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mimeType === "image/jpeg") return jpegSize(buf);
    if (mimeType === "image/webp") return webpSize(buf);
  } catch {
    return undefined;
  }
  return undefined;
}

function jpegSize(buf: Buffer): ImageSize | undefined {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1] ?? 0;
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return undefined;
}

function webpSize(buf: Buffer): ImageSize | undefined {
  if (buf.length < 30 || buf.toString("ascii", 0, 4) !== "RIFF") return undefined;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return undefined;
}

function error(message: string): ToolResult {
  return { content: message, isError: true };
}

/** `cat -n` 形状。 */
export function numberLines(lines: readonly string[], firstLine: number): string {
  return lines.map((line, i) => `${String(firstLine + i).padStart(6)}\t${line}`).join("\n");
}

async function readImage(
  abs: string,
  shown: string,
  mimeType: string,
  ctx: ToolContext,
  options: ReadToolOptions,
): Promise<ToolResult> {
  const buf = await readFile(abs);
  const size = imageSize(buf, mimeType);
  const dims = size ? `${size.width}x${size.height}, ` : "";
  const caption = `Image: ${shown} (${dims}${mimeType}, ${formatSize(buf.length)})`;
  ctx.markRead(abs);
  const details = { path: abs, mimeType, bytes: buf.length, ...(size ? { size } : {}) };
  if (options.supportsImages && !options.supportsImages(ctx)) {
    return { content: `${caption}\n[The current model does not accept image input.]`, details };
  }
  const blocks: ContentBlock[] = [
    { type: "text", text: caption },
    { type: "image", data: buf.toString("base64"), mimeType },
  ];
  return { content: blocks, details };
}

export async function executeRead(
  input: ReadInput,
  ctx: ToolContext,
  options: ReadToolOptions = {},
): Promise<ToolResult> {
  const abs = resolvePath(input.path, ctx.cwd);
  const shown = displayPath(abs, ctx.cwd);
  let info;
  try {
    info = await stat(abs);
  } catch {
    return error(`File not found: ${shown}`);
  }
  if (info.isDirectory()) return error(`${shown} is a directory; use the ls tool instead`);

  const mimeType = IMAGE_MIME[extname(abs).toLowerCase()];
  if (mimeType !== undefined) return readImage(abs, shown, mimeType, ctx, options);

  const buf = await readFile(abs);
  if (isBinary(buf)) return error(`${shown} appears to be a binary file; refusing to read it`);

  const { text } = splitBom(buf.toString("utf8"));
  const normalized = normalizeToLF(text);
  const allLines = normalized === "" ? [] : normalized.replace(/\n$/, "").split("\n");
  ctx.markRead(abs);
  if (allLines.length === 0) {
    return { content: `(${shown} is empty)`, details: { path: abs, totalLines: 0 } };
  }

  const offset = input.offset ?? 1;
  if (!Number.isInteger(offset) || offset < 1) return error("offset must be an integer ≥ 1");
  if (offset > allLines.length) {
    return error(`offset ${offset} is beyond the end of ${shown} (${allLines.length} lines)`);
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
    return error("limit must be an integer ≥ 1");
  }
  const end = input.limit === undefined ? allLines.length : offset - 1 + input.limit;
  const selected = allLines.slice(offset - 1, end);
  const numbered = numberLines(selected, offset);
  const cut = truncateHead(numbered, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  const lastShown = offset - 1 + cut.outputLines;
  let content = cut.content;
  if (lastShown < allLines.length) {
    const reason = cut.truncated
      ? ` (output limit ${cut.truncatedBy === "bytes" ? formatSize(DEFAULT_MAX_BYTES) : `${DEFAULT_MAX_LINES} lines`} reached)`
      : "";
    content += `\n\n[Showing lines ${offset}-${lastShown} of ${allLines.length}${reason}. Use offset=${lastShown + 1} to continue.]`;
  }
  return {
    content,
    details: {
      path: abs,
      totalLines: allLines.length,
      firstLine: offset,
      lastLine: lastShown,
      truncated: cut.truncated,
    },
  };
}

export function createReadTool(options: ReadToolOptions = {}): ToolDefinition<ReadInput> {
  return {
    name: "read",
    label: "Read",
    description:
      "Read a file. Text is returned with line numbers (cat -n format); output is limited to " +
      `${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}, use offset/limit to page. ` +
      "Images (png, jpg, gif, webp) are returned as attachments.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to cwd" },
        offset: { type: "integer", description: "First line to read (1-based)" },
        limit: { type: "integer", description: "Maximum number of lines to read" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    permission: "read",
    executionMode: "parallel",
    annotations: { readOnly: true },
    promptSnippet: "read: read file contents (text with line numbers, images as attachments)",
    execute: (input, ctx) => executeRead(input, ctx, options),
  };
}
