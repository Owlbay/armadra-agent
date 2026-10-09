/**
 * 脚本化供应商的脚本形状与加载（设计 §1.2 ai/fake/fake-script.ts、D16）。
 *
 * 第 n 次调用取 `responses[n]`；用完后按 `whenExhausted` 处理（缺省 echo：回显最后一条用户消息）。
 *
 * ```json
 * { "version": 1, "responses": [
 *   { "steps": [{ "thinking": "先看文件" }, { "toolCall": { "name": "read", "arguments": { "path": "a.ts" } } }] },
 *   { "error": { "kind": "rate_limit" } },
 *   { "text": "完成", "usage": { "input": 1200, "output": 30 } },
 *   { "steps": [{ "text": "写到一半" }], "error": { "kind": "disconnect" } },
 *   { "delayMs": 500, "text": "慢响应", "stopReason": "length" }
 * ] }
 * ```
 *
 * 错误种类与文案（与真实协议的 errorMessage 同形，便于会话层用同一套分类器）：
 * rate_limit 429 / overloaded 529 / server 500 / auth 401 / overflow 400（溢出文案）/
 * network（连接失败）/ disconnect（已有内容后断流）/ custom（自定义 message 与 status）。
 * 除 disconnect 外都发生在 start 之前（与真实 HTTP 错误一致：只有一个 error 事件）。
 */

import { readFileSync } from "node:fs";
import { AmaError } from "../../errors.js";
import type { Usage } from "../types.js";

export type FakeStep =
  | { text: string; chunkSize?: number }
  | { thinking: string; signature?: string; chunkSize?: number }
  | {
      toolCall: { name: string; arguments?: Record<string, unknown>; id?: string };
      chunkSize?: number;
    }
  | { delayMs: number };

export type FakeErrorKind =
  | "rate_limit"
  | "overloaded"
  | "server"
  | "auth"
  | "overflow"
  | "network"
  | "disconnect"
  | "custom";

export interface FakeError {
  kind: FakeErrorKind;
  message?: string;
  status?: number;
  /** [ME-C] 模拟 `Retry-After`（毫秒）：写进失败消息的 `retryAfterMs`。 */
  retryAfterMs?: number;
}

export interface FakeResponse {
  /** 依次产出的块；与 `text` 简写二选一（都给时 text 在后）。 */
  steps?: FakeStep[];
  text?: string;
  /**
   * 缺省：有工具调用 → toolUse，否则 stop。`refusal` 模拟 Anthropic 的拒答：产出完 steps 后以
   * error 收尾、`rawStopReason: "refusal"`（与真实协议同形）。
   */
  stopReason?: "stop" | "length" | "toolUse" | "refusal";
  usage?: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>;
  error?: FakeError;
  /** start 之前的延迟（毫秒，可被 abort 打断）。 */
  delayMs?: number;
}

export type FakeExhaustedBehavior = "echo" | "repeat-last" | "error";

export interface FakeScript {
  version: 1;
  responses: FakeResponse[];
  whenExhausted?: FakeExhaustedBehavior;
}

const ERROR_KINDS: readonly FakeErrorKind[] = [
  "rate_limit",
  "overloaded",
  "server",
  "auth",
  "overflow",
  "network",
  "disconnect",
  "custom",
];

function fail(path: string, message: string): never {
  throw new AmaError("invalid_arguments", `fake script ${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkStep(step: unknown, path: string): FakeStep {
  if (!isRecord(step)) fail(path, "step must be an object");
  if (typeof step["text"] === "string") return step as FakeStep;
  if (typeof step["thinking"] === "string") return step as FakeStep;
  if (typeof step["delayMs"] === "number") return step as FakeStep;
  const call = step["toolCall"];
  if (isRecord(call) && typeof call["name"] === "string") {
    if (call["arguments"] !== undefined && !isRecord(call["arguments"])) {
      fail(`${path}.toolCall.arguments`, "must be an object");
    }
    return step as FakeStep;
  }
  return fail(path, "expected one of text / thinking / toolCall / delayMs");
}

function checkResponse(value: unknown, path: string): FakeResponse {
  if (!isRecord(value)) fail(path, "response must be an object");
  if (value["steps"] !== undefined) {
    if (!Array.isArray(value["steps"])) fail(`${path}.steps`, "must be an array");
    value["steps"].forEach((step, i) => checkStep(step, `${path}.steps[${i}]`));
  }
  if (value["text"] !== undefined && typeof value["text"] !== "string") {
    fail(`${path}.text`, "must be a string");
  }
  const stop = value["stopReason"];
  if (
    stop !== undefined &&
    stop !== "stop" &&
    stop !== "length" &&
    stop !== "toolUse" &&
    stop !== "refusal"
  ) {
    fail(`${path}.stopReason`, "must be stop / length / toolUse / refusal");
  }
  const error = value["error"];
  if (error !== undefined) {
    if (!isRecord(error) || !ERROR_KINDS.includes(error["kind"] as FakeErrorKind)) {
      fail(`${path}.error.kind`, `must be one of ${ERROR_KINDS.join(" / ")}`);
    }
  }
  return value as FakeResponse;
}

/** 校验脚本；接受完整脚本对象或响应数组简写。 */
export function parseFakeScript(value: unknown): FakeScript {
  const script = Array.isArray(value) ? { version: 1, responses: value } : value;
  if (!isRecord(script)) fail("$", "must be an object or an array of responses");
  if (script["version"] !== 1) fail("$.version", "must be 1");
  if (!Array.isArray(script["responses"])) fail("$.responses", "must be an array");
  script["responses"].forEach((r, i) => checkResponse(r, `$.responses[${i}]`));
  const exhausted = script["whenExhausted"];
  if (exhausted !== undefined && !["echo", "repeat-last", "error"].includes(exhausted as string)) {
    fail("$.whenExhausted", "must be echo / repeat-last / error");
  }
  return script as unknown as FakeScript;
}

export function loadFakeScript(path: string): FakeScript {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new AmaError("invalid_arguments", `cannot read fake script ${path}`, { cause: error });
  }
  try {
    return parseFakeScript(JSON.parse(raw));
  } catch (error) {
    if (error instanceof AmaError) throw error;
    throw new AmaError("invalid_arguments", `fake script ${path} is not valid JSON`, {
      cause: error,
    });
  }
}

/** 错误种类 → (HTTP 状态, errorMessage)。文案与 overflow.ts / 会话层重试分类器对齐。 */
export function describeFakeError(error: FakeError): { status: number; message: string } {
  const custom = (fallback: string): string => error.message ?? fallback;
  switch (error.kind) {
    case "rate_limit":
      return { status: 429, message: `429 rate_limit_error: ${custom("Rate limit exceeded")}` };
    case "overloaded":
      return { status: 529, message: `529 overloaded_error: ${custom("Overloaded")}` };
    case "server":
      return { status: 500, message: `500 api_error: ${custom("Internal server error")}` };
    case "auth":
      return {
        status: 401,
        message: `401 authentication_error: ${custom("invalid x-api-key")}`,
      };
    case "overflow":
      return {
        status: 400,
        message: `400 invalid_request_error: ${custom("prompt is too long: 250000 tokens > 200000 maximum")}`,
      };
    case "network":
      return { status: 0, message: `fetch failed: ${custom("ECONNRESET socket hang up")}` };
    case "disconnect":
      return { status: 200, message: custom("Stream ended before completion") };
    case "custom":
      return { status: error.status ?? 400, message: custom("fake error") };
  }
}
