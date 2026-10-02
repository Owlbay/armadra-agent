/**
 * 图片文件（`read` 工具、`ama -p --image`、界面里的 `@图片路径` 共用）：MIME 检测、尺寸、大小上限。
 *
 * - MIME 以文件头为准（PNG / JPEG / GIF / WebP），文件头认不出时退回扩展名；
 * - [W5-I] 单张上限按 **base64 后**计算，按端点分档（ai/image-limits.ts，缺省 5 MB）；任一边
 *   > 8000 px 拒绝；超限时按 `images.resize`（缺省 auto）用系统工具缩放（image-resize.ts），
 *   没有工具则拒绝并提示；
 * - 不解码像素，只读文件头取尺寸。
 */

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { AmaError } from "../errors.js";
import {
  DEFAULT_IMAGE_BASE64_LIMIT,
  MAX_IMAGE_EDGE,
  base64Size,
  formatMb,
} from "../ai/image-limits.js";
import type { ImageBlock } from "../ai/types.js";
import { resizeImage, type ResizeDeps } from "./image-resize.js";

/** 读进内存前的硬上限（原始字节）：再大的文件缩放也不现实，直接拒绝。 */
export const MAX_IMAGE_FILE_BYTES = 64 * 1024 * 1024;

export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** 按扩展名（不分大小写）；不是图片返回 undefined。 */
export function imageMimeFromPath(path: string): string | undefined {
  return IMAGE_EXTENSIONS[extname(path).toLowerCase()];
}

/** 按文件头识别；认不出返回 undefined。 */
export function sniffImageMime(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a)
    return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("ascii", 0, 6))) return "image/gif";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return undefined;
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

export interface LoadedImage {
  block: ImageBlock;
  path: string;
  mimeType: string;
  /** 实际附上的字节数（缩放后为缩放结果的大小）。 */
  bytes: number;
  size?: ImageSize;
}

export interface ImageFitOptions {
  /** 单张 base64 后的上限（字节）；缺省 5 MB（未知端点 / 中转）。 */
  maxBase64Bytes?: number;
  /** 超限时缩放：`auto`（缺省）找 sips / magick，`off` 从不缩放。 */
  resize?: "auto" | "off";
  /** 测试注入（平台、命令执行器）。 */
  resizeDeps?: ResizeDeps;
}

export type ImageFit =
  | {
      ok: true;
      buf: Buffer;
      mimeType: string;
      size?: ImageSize;
      /** 缩放过：用的工具与原尺寸。 */
      resized?: { tool: string; from?: ImageSize };
    }
  | {
      ok: false;
      mimeType: string;
      size?: ImageSize;
      reason: "too_large" | "too_wide";
      /** 给模型 / 日志的英文说明（read 工具原样放进结果）。 */
      note: string;
    };

function longEdge(size: ImageSize | undefined): number {
  return size === undefined ? 0 : Math.max(size.width, size.height);
}

function checkFit(buf: Buffer, mimeType: string, limit: number): ImageFit {
  const size = imageSize(buf, mimeType);
  const sized = size !== undefined ? { size } : {};
  if (longEdge(size) > MAX_IMAGE_EDGE) {
    return {
      ok: false,
      mimeType,
      ...sized,
      reason: "too_wide",
      note: `Image is larger than ${MAX_IMAGE_EDGE}px on a side; not attached.`,
    };
  }
  if (base64Size(buf.length) > limit) {
    return {
      ok: false,
      mimeType,
      ...sized,
      reason: "too_large",
      note: `Image exceeds the ${formatMb(limit)} attachment limit (base64); not attached.`,
    };
  }
  return { ok: true, buf, mimeType, ...sized };
}

/**
 * 检查一张图是否在上限内（base64 后大小、边长）；超限且给了 `path`、`resize` 不是 off 时先缩放再查。
 */
export async function fitImage(
  buf: Buffer,
  mimeType: string,
  options: ImageFitOptions = {},
  path?: string,
): Promise<ImageFit> {
  const limit = options.maxBase64Bytes ?? DEFAULT_IMAGE_BASE64_LIMIT;
  const fit = checkFit(buf, mimeType, limit);
  if (fit.ok || path === undefined || options.resize === "off") return fit;
  const resized = await resizeImage(
    path,
    { maxEdge: MAX_IMAGE_EDGE, maxBase64Bytes: limit, mimeType, size: fit.size },
    options.resizeDeps,
  );
  if (!resized.ok) {
    const hint =
      resized.reason === "no_tool"
        ? " (no resize tool found: install ImageMagick, or sips on macOS)"
        : " (resizing did not bring it under the limit)";
    return { ...fit, note: fit.note.replace(/; not attached\.$/, `${hint}; not attached.`) };
  }
  const again = checkFit(resized.buf, resized.mimeType, limit);
  if (!again.ok) return fit;
  return {
    ...again,
    resized: { tool: resized.tool, ...(fit.size !== undefined ? { from: fit.size } : {}) },
  };
}

function fitError(
  path: string,
  fit: Extract<ImageFit, { ok: false }>,
  limit: number,
  bytes: number,
  resizeOff: boolean,
): AmaError {
  const hint = resizeOff
    ? "（images.resize 为 off）"
    : fit.note.includes("no resize tool")
      ? "（没找到缩放工具：装 ImageMagick，macOS 自带 sips）"
      : fit.note.includes("resizing did not")
        ? "（缩放后仍超限）"
        : "";
  if (fit.reason === "too_wide") {
    const dims = fit.size !== undefined ? `（${fit.size.width}×${fit.size.height}）` : "";
    return new AmaError(
      "invalid_arguments",
      `图片任一边超过 ${MAX_IMAGE_EDGE} px：${path}${dims}${hint}`,
    );
  }
  return new AmaError(
    "invalid_arguments",
    `图片超过 ${formatMb(limit)} 上限（按 base64 后计算）：${path}（${formatMb(base64Size(bytes))}）${hint}`,
  );
}

/**
 * 读一张图片作为附件。文件不存在、不是图片、超过上限 → AmaError（`invalid_arguments`），文案给用户看。
 */
export async function loadImageFile(
  path: string,
  options: ImageFitOptions = {},
): Promise<LoadedImage> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new AmaError("invalid_arguments", `图片不存在：${path}`);
  }
  if (!info.isFile()) throw new AmaError("invalid_arguments", `不是文件：${path}`);
  const limit = options.maxBase64Bytes ?? DEFAULT_IMAGE_BASE64_LIMIT;
  if (info.size > MAX_IMAGE_FILE_BYTES)
    throw new AmaError(
      "invalid_arguments",
      `图片超过 ${formatMb(limit)} 上限（按 base64 后计算）：${path}（${formatMb(base64Size(info.size))}）`,
    );
  const buf = await readFile(path);
  const mimeType = sniffImageMime(buf) ?? imageMimeFromPath(path);
  if (mimeType === undefined)
    throw new AmaError("invalid_arguments", `不是支持的图片（PNG / JPEG / GIF / WebP）：${path}`);
  const fit = await fitImage(buf, mimeType, options, path);
  if (!fit.ok) throw fitError(path, fit, limit, buf.length, options.resize === "off");
  return {
    block: { type: "image", data: fit.buf.toString("base64"), mimeType: fit.mimeType },
    path,
    mimeType: fit.mimeType,
    bytes: fit.buf.length,
    ...(fit.size ? { size: fit.size } : {}),
  };
}
