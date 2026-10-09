/**
 * fetch 包装（设计 §1.2 ai/http.ts）：超时、头合并（值为 null 删除）、错误体读取。
 *
 * 代理：Node 的全局 fetch 缺省不读 HTTP(S)_PROXY。CLI 启动时由 cli/proxy.ts 调 Node 内置的
 * `http.setGlobalProxyFromEnv()`（等价于 `NODE_USE_ENV_PROXY=1`）；SDK 嵌入方自行决定。
 * 本模块不自行实现代理。
 *
 * 超时：`timeoutMs` 只管到拿到响应头为止；`idleTimeoutMs`（缺省 300 s，0 关闭）管等响应头；
 * `streamIdleTimeoutMs`（缺省 180 s，0 关闭）管流式读取期间两次收到数据之间的间隔（每收到一块字节
 * 即重新计时，见 sse.ts）。[ME-C] D18 空闲超时抛 `IdleTimeoutError`，文案含 `idle timeout`，会话层按
 * 可重试错误处理。
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

/** 等响应头的空闲超时缺省值：与 `request.idleTimeoutMs` / `AMA_IDLE_TIMEOUT_MS` 的缺省一致。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
/** 流中两块数据之间的空闲超时缺省值：与 `request.streamIdleTimeoutMs` 的缺省一致。 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000;

const positive = (value: number): number | undefined =>
  Number.isFinite(value) && value > 0 ? value : undefined;

/** 请求选项里等响应头的空闲超时；未给出用缺省值，0 或负数表示关闭（返回 undefined）。 */
export function idleTimeoutOf(options: { idleTimeoutMs?: number | undefined }): number | undefined {
  return positive(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
}

/** 请求选项里流中的空闲超时；未给出用缺省值，0 或负数表示关闭（返回 undefined）。 */
export function streamIdleTimeoutOf(options: {
  streamIdleTimeoutMs?: number | undefined;
}): number | undefined {
  return positive(options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS);
}

function formatDuration(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

/**
 * 服务端在空闲上限内没有任何字节：`response` = 发出请求后迟迟没有响应头（`idleTimeoutMs`），
 * `stream` = 流读到一半停住（`streamIdleTimeoutMs`）。文案含 `idle timeout`（重试分类据此判为可重试），
 * 并点名对应的配置键与环境变量。
 */
export class IdleTimeoutError extends Error {
  readonly idleTimeoutMs: number;
  readonly phase: "response" | "stream";

  constructor(idleTimeoutMs: number, phase: "response" | "stream") {
    const what =
      phase === "response"
        ? `No response from the server within ${formatDuration(idleTimeoutMs)}`
        : `Stream stalled: no data from the server for ${formatDuration(idleTimeoutMs)}`;
    const knob =
      phase === "response"
        ? "request.idleTimeoutMs or AMA_IDLE_TIMEOUT_MS"
        : "request.streamIdleTimeoutMs or AMA_STREAM_IDLE_TIMEOUT_MS";
    super(`${what} (idle timeout; adjust with ${knob})`);
    this.name = "IdleTimeoutError";
    this.idleTimeoutMs = idleTimeoutMs;
    this.phase = phase;
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
  /** 等响应头的空闲上限（`timeoutMs` 未给时生效）；undefined 不限。流中的空闲见 `readSseEvents`。 */
  idleTimeoutMs?: number | undefined;
  onResponse?: ((status: number, headers: Headers) => void) | undefined;
}

/**
 * POST JSON 并返回 2xx 响应（body 是 SSE 字节流）。非 2xx → HttpError；超时 → RequestTimeoutError
 * （`timeoutMs`）或 IdleTimeoutError（`idleTimeoutMs`）；调用方的 signal 中止 → 原样抛 AbortError
 * （调用方据 signal.aborted 判 aborted）。超时只覆盖到拿到响应头为止，流式读取期间的空闲由
 * `readSseEvents` 的空闲上限（`streamIdleTimeoutOf`）控制。
 */
export async function postJson(url: string, options: PostOptions): Promise<Response> {
  const explicit = options.timeoutMs !== undefined && options.timeoutMs > 0;
  const timeout = explicit ? options.timeoutMs : options.idleTimeoutMs;
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
      throw explicit ? new RequestTimeoutError(timeout) : new IdleTimeoutError(timeout, "response");
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
