/**
 * 图片大小上限（docs/history/wave5-plan.md §4、D11；R1 §3.2）。[W5-I]
 *
 * 各家的上限都按 **base64 后**的字节数计算：`base64Bytes = ceil(bytes / 3) * 4`。
 *
 * | 端点                                   | 单图     | 单请求总量（按协议）            |
 * | -------------------------------------- | -------- | ------------------------------- |
 * | 官方 Anthropic（api.anthropic.com）    | 10 MB    | anthropic-messages 32 MB        |
 * | 官方 Gemini（generativelanguage…）     | 20 MB    | google-generative-ai 20 MB      |
 * | 官方 OpenAI（api.openai.com）          | 20 MB    | 其它协议 20 MB                  |
 * | 中转（内置供应商改了 baseUrl）/ 未知   | 5 MB     | 同上，按协议                    |
 *
 * 中转背后常是 Bedrock / Vertex（单图 5 MB），所以只认官方主机，其余一律按 5 MB。
 * 尺寸：任一边 > 8000 px 拒绝；单请求超过 20 张图时每边 ≤ 2000 px（Anthropic）。
 */

import type { Api } from "./types.js";

export const MB = 1024 * 1024;

/** 单图任一边上限（像素）。 */
export const MAX_IMAGE_EDGE = 8000;
/** 单请求图片数超过这个数时，每张图的边长上限收紧为 `MANY_IMAGES_EDGE`。 */
export const MANY_IMAGES_COUNT = 20;
export const MANY_IMAGES_EDGE = 2000;

/** 未知端点 / 中转的单图上限（base64 后）。 */
export const DEFAULT_IMAGE_BASE64_LIMIT = 5 * MB;

export interface ImageLimits {
  /** 单张图片 base64 后的上限（字节）。 */
  perImageBase64: number;
  /** 单次请求全部图片 base64 后的总量预算（字节）。 */
  perRequestBase64: number;
}

export type ImageEndpoint = "anthropic" | "gemini" | "openai" | "other";

/** 判断端点只需要地址与协议。 */
export interface ImageModelInfo {
  baseUrl?: string | undefined;
  api: Api;
}

/** 原始字节数 → base64 后的字节数。 */
export function base64Size(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

const OFFICIAL_HOSTS: Readonly<Record<string, ImageEndpoint>> = {
  "api.anthropic.com": "anthropic",
  "generativelanguage.googleapis.com": "gemini",
  "api.openai.com": "openai",
};

const PER_IMAGE: Readonly<Record<ImageEndpoint, number>> = {
  anthropic: 10 * MB,
  gemini: 20 * MB,
  openai: 20 * MB,
  other: DEFAULT_IMAGE_BASE64_LIMIT,
};

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** 按 baseUrl 的主机判断是不是官方端点；中转与未知主机都是 `other`。 */
export function imageEndpoint(model: Pick<ImageModelInfo, "baseUrl">): ImageEndpoint {
  const host = hostOf(model.baseUrl);
  return (host !== undefined ? OFFICIAL_HOSTS[host] : undefined) ?? "other";
}

/** 单请求图片总量预算按协议：Anthropic 32 MB，其余（含 Gemini）20 MB。 */
export function requestImageBudget(api: Api): number {
  return api === "anthropic-messages" ? 32 * MB : 20 * MB;
}

export function imageLimits(model: ImageModelInfo, api: Api = model.api): ImageLimits {
  return {
    perImageBase64: PER_IMAGE[imageEndpoint(model)],
    perRequestBase64: requestImageBudget(api),
  };
}

/** 文案用：`10 MB`、`3.8 MB`。 */
export function formatMb(bytes: number): string {
  const mb = bytes / MB;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}
