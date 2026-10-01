/**
 * fetch 包装（设计 §1.2 ai/http.ts）：超时、头合并（值为 null 删除）、错误体读取。
 *
 * 代理：Node 的全局 fetch 缺省不读 HTTP(S)_PROXY。Node ≥ 24 设 `NODE_USE_ENV_PROXY=1`
 * 即可让 fetch 走环境变量代理；Node 22 需在启动参数里加 `--use-env-proxy`（22.21+）。
 * 本模块不自行实现代理，env 原样透传给运行时处理。
 *
 * 协议层自身**不重试**（重试在会话层，§3.6）。
 */

import { AMA_VERSION } from "../version.js";
import type { AuthHeader } from "./types.js";

export type HeaderSource = Readonly<Record<string, string | null | undefined>> | undefined;

/** 大小写不敏感地合并头；后者覆盖前者；值为 null 表示删除该头。键保留最后一次出现的写法。 */
export function mergeHeaders(...sources: HeaderSource[]): Record<string, string> {
  const merged = new Map<string, { name: string; value: string }>();
  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) {
      const key = name.toLowerCase();
      if (value === null) merged.delete(key);
      else if (value !== undefined) merged.set(key, { name, value });
    }
  }
  const out: Record<string, string> = {};
  for (const { name, value } of merged.values()) out[name] = value;
  return out;
}

export function hasHeader(headers: HeaderSource, name: string): boolean {
  if (!headers) return false;
  const wanted = name.toLowerCase();
  return Object.entries(headers).some(
    ([key, value]) => key.toLowerCase() === wanted && typeof value === "string" && value.length > 0,
  );
}

/** 头里已经带了鉴权（调用方自管 key）时，流函数不再要求 apiKey。 */
export function hasAuthHeader(headers: HeaderSource): boolean {
  return (
    hasHeader(headers, "authorization") ||
    hasHeader(headers, "x-api-key") ||
    hasHeader(headers, "x-goog-api-key")
  );
}

/** 按 AuthHeader 形状生成鉴权头；无 key 时返回空对象。 */
export function authHeaders(
  apiKey: string | undefined,
  shape: AuthHeader | undefined,
  fallback: AuthHeader,
): Record<string, string> {
  if (!apiKey) return {};
  const resolved = shape ?? fallback;
  if (resolved === "authorization-bearer") return { Authorization: `Bearer ${apiKey}` };
  if (resolved === "x-api-key") return { "x-api-key": apiKey };
  if (resolved === "x-goog-api-key") return { "x-goog-api-key": apiKey };
  return { [resolved.header]: `${resolved.prefix ?? ""}${apiKey}` };
}

export const USER_AGENT = `ama/${AMA_VERSION}`;

/** baseUrl 与路径拼接（去掉多余斜杠）。 */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** 非 2xx 响应；`message` 已是可展示、可被 overflow / 重试分类器匹配的文本。 */
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, message: string, body: string, retryAfterMs?: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`);
    this.name = "RequestTimeoutError";
  }
}

const MAX_ERROR_BODY = 4000;

/**
 * 从错误体提取文本：识别 `{error:{type,message,code}}`、`{error:"..."}`、`{message}`、
 * `{detail}` 等常见形状；不是 JSON 则截断原文。结果形如 `429 rate_limit_error: ...`。
 */
export function formatErrorBody(status: number, statusText: string, body: string): string {
  const trimmed = body.trim();
  let detail = "";
  if (trimmed.length > 0) {
    try {
      detail = describeErrorJson(JSON.parse(trimmed)) ?? trimmed;
    } catch {
      detail = trimmed;
    }
  }
  if (detail.length > MAX_ERROR_BODY) detail = `${detail.slice(0, MAX_ERROR_BODY)}…`;
  const head = statusText ? `${status} ${statusText}` : `${status}`;
  return detail ? `${status} ${detail}` : `${head} (no body)`;
}

/** 识别 JSON 错误体；无法识别返回 undefined。也用于 SSE 流内的 error 事件。 */
export function describeErrorJson(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const inner = record["error"];
  if (typeof inner === "string") return inner;
  if (typeof inner === "object" && inner !== null) {
    const err = inner as Record<string, unknown>;
    const kind = pickString(err["type"]) ?? pickString(err["code"]) ?? pickString(err["status"]);
    const message = pickString(err["message"]) ?? JSON.stringify(err);
    const metadata = err["metadata"];
    const raw =
      typeof metadata === "object" && metadata !== null
        ? pickString((metadata as Record<string, unknown>)["raw"])
        : undefined;
    const base = kind && !message.startsWith(kind) ? `${kind}: ${message}` : message;
    return raw && !base.includes(raw) ? `${base}\n${raw}` : base;
  }
  const message = pickString(record["message"]) ?? pickString(record["detail"]);
  if (message) {
    const code = pickString(record["code"]) ?? pickString(record["type"]);
    return code && !message.startsWith(code) ? `${code}: ${message}` : message;
  }
  return undefined;
}

function pickString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export interface PostOptions {
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  timeoutMs?: number | undefined;
  onResponse?: ((status: number, headers: Headers) => void) | undefined;
}

/**
 * POST JSON 并返回 2xx 响应（body 是 SSE 字节流）。非 2xx → HttpError；超时 → RequestTimeoutError；
 * 调用方的 signal 中止 → 原样抛 AbortError（调用方据 signal.aborted 判 aborted）。
 * 超时只覆盖到拿到响应头为止，流式读取期间由调用方的 signal 控制。
 */
export async function postJson(url: string, options: PostOptions): Promise<Response> {
  const timeout = options.timeoutMs;
  const timer = new AbortController();
  const handle =
    timeout !== undefined && timeout > 0 ? setTimeout(() => timer.abort(), timeout) : undefined;
  const signal = AbortSignal.any([options.signal, timer.signal]);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify(options.body),
      signal,
    });
  } catch (error) {
    if (timer.signal.aborted && !options.signal.aborted && timeout !== undefined) {
      throw new RequestTimeoutError(timeout);
    }
    throw normalizeNetworkError(error);
  } finally {
    if (handle) clearTimeout(handle);
  }
  options.onResponse?.(response.status, response.headers);
  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    throw new HttpError(
      response.status,
      formatErrorBody(response.status, response.statusText, body),
      body,
      parseRetryAfter(response.headers),
    );
  }
  if (!response.body) throw new Error("Response has no body");
  return response;
}

/** undici 的 `fetch failed` 把真正原因藏在 cause 里；拼出来便于重试分类与排错。 */
export function normalizeNetworkError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (error.name === "AbortError") return error;
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && !error.message.includes(cause.message)) {
    const code = (cause as { code?: unknown }).code;
    const suffix = typeof code === "string" ? `${code} ${cause.message}` : cause.message;
    return new Error(`${error.message}: ${suffix}`, { cause });
  }
  return error;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
