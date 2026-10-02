/**
 * 图片文件（`read` 工具、`ama -p --image`、界面里的 `@图片路径` 共用）：MIME 检测、尺寸、大小上限。
 *
 * - MIME 以文件头为准（PNG / JPEG / GIF / WebP），文件头认不出时退回扩展名；
 * - 单张上限 5 MB（各家图片上限里最小的 Anthropic）；
 * - 不解码像素，只读文件头取尺寸。
 */

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { AmaError } from "../errors.js";
import type { ImageBlock } from "../ai/types.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

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
  bytes: number;
  size?: ImageSize;
}

/**
 * 读一张图片作为附件。文件不存在、不是图片、超过上限 → AmaError（`invalid_arguments`），文案给用户看。
 */
export async function loadImageFile(path: string): Promise<LoadedImage> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new AmaError("invalid_arguments", `图片不存在：${path}`);
  }
  if (!info.isFile()) throw new AmaError("invalid_arguments", `不是文件：${path}`);
  if (info.size > MAX_IMAGE_BYTES)
    throw new AmaError(
      "invalid_arguments",
      `图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB 上限：${path}（${(info.size / 1024 / 1024).toFixed(1)} MB）`,
    );
  const buf = await readFile(path);
  const mimeType = sniffImageMime(buf) ?? imageMimeFromPath(path);
  if (mimeType === undefined)
    throw new AmaError("invalid_arguments", `不是支持的图片（PNG / JPEG / GIF / WebP）：${path}`);
  const size = imageSize(buf, mimeType);
  return {
    block: { type: "image", data: buf.toString("base64"), mimeType },
    path,
    mimeType,
    bytes: buf.length,
    ...(size ? { size } : {}),
  };
}
