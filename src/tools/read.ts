/**
 * `read` 工具（设计 §5.2）。[B3]
 *
 * 文本按 `cat -n` 形状返回（行号右对齐 6 位 + Tab）；头截断 2000 行 / 50 KB 先到者，末尾提示
 * `offset` 续读；NUL 嗅探判二进制并拒绝；png / jpg / gif / webp 作为 ImageBlock 返回（MIME 按文件头，
 * 与 `--image` / `@图片` 共用 image-file.ts；模型不支持图片或超过 5 MB 时只给路径与尺寸）；成功后
 * `ctx.markRead(abs)`。
 */

import { readFile, stat } from "node:fs/promises";
import type { ContentBlock } from "../ai/types.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { displayPath, resolvePath } from "./paths.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js";
import { normalizeToLF, splitBom } from "./edit-fuzzy.js";
import { MAX_IMAGE_BYTES, imageMimeFromPath, imageSize, sniffImageMime } from "./image-file.js";

export { imageSize, type ImageSize } from "./image-file.js";

export interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadToolOptions {
  /** 当前模型是否接受图片输入；缺省 true。 */
  supportsImages?(ctx: ToolContext): boolean;
}

const SNIFF_BYTES = 8000;

export function isBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
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
  ctx: ToolContext,
  options: ReadToolOptions,
): Promise<ToolResult> {
  const buf = await readFile(abs);
  const mimeType = sniffImageMime(buf) ?? imageMimeFromPath(abs) ?? "application/octet-stream";
  const size = imageSize(buf, mimeType);
  const dims = size ? `${size.width}x${size.height}, ` : "";
  const caption = `Image: ${shown} (${dims}${mimeType}, ${formatSize(buf.length)})`;
  ctx.markRead(abs);
  const details = { path: abs, mimeType, bytes: buf.length, ...(size ? { size } : {}) };
  if (options.supportsImages && !options.supportsImages(ctx)) {
    return { content: `${caption}\n[The current model does not accept image input.]`, details };
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    return {
      content: `${caption}\n[Image exceeds the ${formatSize(MAX_IMAGE_BYTES)} attachment limit; not attached.]`,
      details,
    };
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

  if (imageMimeFromPath(abs) !== undefined) return readImage(abs, shown, ctx, options);

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
      "Read a file. Text comes with line numbers (cat -n), limited to " +
      `${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; page with offset/limit. ` +
      "Images (png, jpg, gif, webp) come as attachments.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative to cwd" },
        offset: { type: "integer", description: "First line (1-based)" },
        limit: { type: "integer", description: "Max lines" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    permission: "read",
    executionMode: "parallel",
    annotations: { readOnly: true },
    promptSnippet: "read: read files (text or images)",
    execute: (input, ctx) => executeRead(input, ctx, options),
  };
}
