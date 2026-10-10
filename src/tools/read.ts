/**
 * `read` 工具（设计 §5.2）。[B3]
 *
 * 文本按 `cat -n` 形状返回（行号右对齐 6 位 + Tab）；头截断 2000 行 / 字节上限先到者（50 KB 与
 * 会话结果上限减余量取小，[ME-D] 一次截到位），末尾提示 `offset` 续读；NUL 嗅探判二进制并拒绝；
 * png / jpg / gif / webp 作为 ImageBlock 返回（MIME 按文件头，
 * 与 `--image` / `@图片` 共用 image-file.ts；模型不支持图片、超过当前端点的单图上限（base64 后，
 * [W5-I] 按端点分档）或任一边 > 8000 px 时只给路径与尺寸）；成功后 `ctx.markRead(abs)`。
 * [M-E] 超过 1 MiB 的文本按字节窗口读（read-lines.ts），输出与整读逐字节相同。
 */

import { readFile, stat } from "node:fs/promises";
import { internImage } from "../ai/image-intern.js";
import type { ContentBlock } from "../ai/types.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { displayPath, resolvePath } from "./paths.js";
import { DEFAULT_MAX_LINES, formatSize, toolOutputBytes, truncateHead } from "./truncate.js";
import { normalizeToLF, splitBom } from "./edit-fuzzy.js";
import { STREAM_READ_THRESHOLD, readHeadAsync, readLineWindowAsync } from "./read-lines.js";
import {
  MAX_IMAGE_FILE_BYTES,
  fitImage,
  imageMimeFromPath,
  imageSize,
  sniffImageMime,
  type ImageFitOptions,
} from "./image-file.js";

export { imageSize, type ImageSize } from "./image-file.js";

export interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadToolOptions {
  /** 当前模型是否接受图片输入；缺省 true。 */
  supportsImages?(ctx: ToolContext): boolean;
  /** [W5-I] 当前模型的单图上限与缩放设置；缺省 5 MB（base64 后）。 */
  imageOptions?(ctx: ToolContext): ImageFitOptions;
  /** [M-E] 超过这个字节数的文本文件走字节窗口；缺省 `STREAM_READ_THRESHOLD`，测试注入 0 / Infinity。 */
  streamThreshold?: number;
}

const SNIFF_BYTES = 8000;

export function isBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
}

const binaryMessage = (shown: string): string =>
  `${shown} appears to be a binary file; refusing to read it`;

function error(message: string): ToolResult {
  return { content: message, isError: true };
}

/**
 * [S-A] read 收到目录时的下一步提示：只指向模型当前真能调用的工具（docs/search-plan.md §4.2）。
 * 活动集未知（宿主自建上下文）时沿用旧文案。
 */
export function directoryHint(shown: string, ctx: Pick<ToolContext, "activeTools">): string {
  const active = ctx.activeTools;
  if (active === undefined || active.has("ls")) return "use the ls tool instead";
  if (active.has("glob")) {
    if (shown === ".") return 'use glob (e.g. pattern "*")';
    // cwd 外（绝对路径）或目录名含 glob 元字符时改用 path 参数，模式保持 `*`
    if (shown.startsWith("/") || /^[A-Za-z]:/.test(shown) || /[*?[\]{}!\\]/.test(shown)) {
      return `use glob (e.g. path ${JSON.stringify(shown)}, pattern "*")`;
    }
    return `use glob (e.g. pattern ${JSON.stringify(`${shown}/*`)})`;
  }
  return "read a file inside it";
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
  if (buf.length > MAX_IMAGE_FILE_BYTES) {
    return { content: `${caption}\n[Image file is too large to attach.]`, details };
  }
  const fit = await fitImage(buf, mimeType, options.imageOptions?.(ctx) ?? {}, abs);
  if (!fit.ok) return { content: `${caption}\n[${fit.note}]`, details };
  const note =
    fit.resized !== undefined && fit.size !== undefined
      ? `\n[Resized to ${fit.size.width}x${fit.size.height} to fit the attachment limit.]`
      : "";
  const blocks: ContentBlock[] = [
    { type: "text", text: caption + note },
    internImage({ type: "image", data: fit.buf.toString("base64"), mimeType: fit.mimeType }),
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
  if (info.isDirectory()) return error(`${shown} is a directory; ${directoryHint(shown, ctx)}`);

  if (imageMimeFromPath(abs) !== undefined) return readImage(abs, shown, ctx, options);

  const offset = input.offset ?? 1;
  const badOffset = !Number.isInteger(offset) || offset < 1;
  const badLimit = input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1);
  const maxBytes = toolOutputBytes(ctx.maxResultChars);
  let totalLines: number;
  let selected: string[];
  if (info.size > (options.streamThreshold ?? STREAM_READ_THRESHOLD)) {
    // [M-E] 大文件按字节窗口读：只解码要显示的行，结果与整读逐字节相同（D1）
    if (isBinary(await readHeadAsync(abs, SNIFF_BYTES))) return error(binaryMessage(shown));
    const want = Math.min(input.limit ?? Infinity, DEFAULT_MAX_LINES + 1);
    const win = await readLineWindowAsync(
      abs,
      badOffset ? 1 : offset,
      badOffset || badLimit ? 0 : want,
      maxBytes,
    );
    totalLines = win.totalLines;
    selected = win.lines;
  } else {
    const buf = await readFile(abs);
    if (isBinary(buf)) return error(binaryMessage(shown));
    const { text } = splitBom(buf.toString("utf8"));
    const normalized = normalizeToLF(text);
    const allLines = normalized === "" ? [] : normalized.replace(/\n$/, "").split("\n");
    totalLines = allLines.length;
    const end = input.limit === undefined ? undefined : offset - 1 + input.limit;
    selected = badOffset || badLimit ? [] : allLines.slice(offset - 1, end);
  }
  ctx.markRead(abs);
  if (totalLines === 0) {
    return { content: `(${shown} is empty)`, details: { path: abs, totalLines: 0 } };
  }

  if (badOffset) return error("offset must be an integer ≥ 1");
  if (offset > totalLines) {
    return error(`offset ${offset} is beyond the end of ${shown} (${totalLines} lines)`);
  }
  if (badLimit) return error("limit must be an integer ≥ 1");
  const numbered = numberLines(selected, offset);
  const cut = truncateHead(numbered, { maxLines: DEFAULT_MAX_LINES, maxBytes });
  const lastShown = offset - 1 + cut.outputLines;
  let content = cut.content;
  if (lastShown < totalLines) {
    const reason = cut.truncated
      ? ` (output limit ${cut.truncatedBy === "bytes" ? formatSize(maxBytes) : `${DEFAULT_MAX_LINES} lines`} reached)`
      : "";
    content += `\n\n[Showing lines ${offset}-${lastShown} of ${totalLines}${reason}. Use offset=${lastShown + 1} to continue.]`;
  }
  return {
    content,
    details: {
      path: abs,
      totalLines,
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
      "Read a file with line numbers (cat -n); page with offset/limit, a cut result says where " +
      "to continue. Images (png, jpg, gif, webp) come as attachments.",
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
