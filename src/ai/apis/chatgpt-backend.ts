/**
 * openai-responses 的 ChatGPT 订阅后端（compat `chatgptBackend`；docs/wave6-plan.md §4.1、§4.6、D14、D17）。[W6-O]
 *
 * - 请求体：强制 `store:false`、`stream:true`、`input` 数组；按后端删禁用字段（SIWC 15 个；codex 5 个，保留
 *   `prompt_cache_key`）；SIWC 不发 `role:"system"` item（改 developer）；`instructionsMode: "developer-message"`
 *   时系统提示改放 input 开头的 developer 消息；`toolsInNamespace` 时工具改放 `additional_tools` 输入项（形状待
 *   真账户实测）；`unsupported_capability` 报过的字段本进程内不再发；
 * - 请求头：两者 `Authorization: Bearer`；codex 另加 `ChatGPT-Account-ID`（来自活 token 登记）、`originator`（渠道
 *   headers，缺省 `codex_cli_rs`）、`session-id` / `x-client-request-id`；
 * - 出错恢复（每种至多一次）：401 → 强制刷新重试；SIWC 400 `subscription_sharing_unsupported_capability` → 删去
 *   `error.param` 重试；codex 400 `Instructions are not valid` → 本会话切 developer-message 重试；
 * - 错误映射（文案带码前缀，宿主按码判断）：429 配额 → `quota_exceeded`（不重试）；失效 → `auth_expired`；
 *   SIWC 403 `subscription_sharing_user_not_eligible` → `not_eligible`（i18n 文案列出原因）；503 留给会话层现有重试；
 * - 渠道跟随登录方式由会话层做（auth/chatgpt/follow.ts）；到这里仍不符说明用户显式写了 `@渠道`，报
 *   `chatgpt_flavor_mismatch`（i18n）；
 * - 用量：`cost = 0`、`billing: "subscription"`。
 */

import { liveToken, type LiveToken } from "../../auth/oauth/live.js";
import { authExpiredError } from "../../auth/oauth/refresh.js";
import { msg } from "../../i18n/index.js";
import type { HttpError } from "../http.js";
import type { Model, OpenAIResponsesCompat, StreamOptions, Usage } from "../types.js";
import {
  parseQuotaHeaders,
  parseRateLimitEvent,
  quotaFromLimitError,
  type QuotaSnapshot,
} from "./chatgpt-rate-limits.js";

type Json = Record<string, unknown>;
export type ChatGptBackend = "siwc" | "codex";

export const SIWC_FORBIDDEN_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
] as const;

export const CODEX_FORBIDDEN_FIELDS = [
  "max_output_tokens",
  "temperature",
  "top_p",
  "prompt_cache_retention",
  "prompt_cache_options",
] as const;

/** 本会话已切 developer-message 的会话键；`unsupported_capability` 报过的 `provider/model` → 字段。 */
const developerMode = new Set<string>();
const strippedFields = new Map<string, Set<string>>();

export function sessionKeyOf(model: Model, options: StreamOptions): string {
  return options.sessionId ?? `${model.provider}/${model.id}`;
}

/** 测试用。 */
export function resetChatGptState(): void {
  developerMode.clear();
  strippedFields.clear();
}

export function instructionsModeOf(
  model: Model,
  compat: OpenAIResponsesCompat,
  options: StreamOptions,
): "native" | "developer-message" {
  return developerMode.has(sessionKeyOf(model, options))
    ? "developer-message"
    : (compat.instructionsMode ?? "native");
}

export function transformChatGptBody(
  body: Json,
  model: Model,
  compat: OpenAIResponsesCompat,
  options: StreamOptions,
): Json {
  const backend = compat.chatgptBackend as ChatGptBackend;
  const out: Json = { ...body };
  const forbidden: readonly string[] =
    backend === "siwc" ? SIWC_FORBIDDEN_FIELDS : CODEX_FORBIDDEN_FIELDS;
  for (const field of forbidden) delete out[field];
  for (const field of strippedFields.get(`${model.provider}/${model.id}`) ?? []) delete out[field];
  out["store"] = false;
  out["stream"] = true;
  let input = Array.isArray(out["input"]) ? [...(out["input"] as Json[])] : [];
  if (backend === "siwc")
    input = input.map((item) =>
      item["role"] === "system" ? { ...item, role: "developer" } : item,
    );
  if (
    instructionsModeOf(model, compat, options) === "developer-message" &&
    typeof out["instructions"] === "string"
  ) {
    input.unshift({ role: "developer", content: out["instructions"] });
    delete out["instructions"];
  }
  if (compat.toolsInNamespace === true && Array.isArray(out["tools"])) {
    input.unshift({ type: "additional_tools", tools: out["tools"] });
    delete out["tools"];
  }
  out["input"] = input;
  return out;
}

/**
 * 发请求前：needsLogin 直接报 auth_expired；登录 flavor 与渠道不符报错（没写 `@渠道` 的模型会话层已改到登录的
 * 渠道，走到这里的是显式指定了另一渠道）。
 */
export function chatgptPrecheck(
  model: Model,
  compat: OpenAIResponsesCompat,
  apiKey?: string,
): void {
  const live = liveToken(apiKey);
  if (live === undefined) return;
  if (live.needsLogin === true) throw authExpiredError(live.provider);
  if (live.flavor !== compat.chatgptBackend) {
    const pinned = String(compat.chatgptBackend);
    const ref = `${model.provider}/${model.id}@${pinned}`;
    throw new Error(
      `chatgpt_flavor_mismatch: ${msg().auth.request.flavorMismatch(live.flavor, ref, pinned)}`,
    );
  }
}

export function chatgptHeaders(
  compat: OpenAIResponsesCompat,
  options: StreamOptions,
  apiKey: string | undefined,
): Record<string, string> {
  if (compat.chatgptBackend !== "codex") return {};
  const headers: Record<string, string> = {};
  const accountId = liveToken(apiKey)?.accountId;
  if (accountId !== undefined) headers["ChatGPT-Account-ID"] = accountId;
  if (options.sessionId !== undefined) {
    headers["session-id"] = options.sessionId;
    headers["x-client-request-id"] = options.sessionId;
  }
  return headers;
}

/** 包一层 onResponse：解析响应头里的配额。 */
export function quotaOnResponse(
  compat: OpenAIResponsesCompat,
  options: StreamOptions,
): ((status: number, headers: Headers) => void) | undefined {
  if (compat.chatgptBackend !== "codex" || options.onQuota === undefined) return options.onResponse;
  return (status, headers) => {
    options.onResponse?.(status, headers);
    const quota = parseQuotaHeaders(headers);
    if (quota !== undefined) emitQuota(options, quota);
  };
}

function emitQuota(options: StreamOptions, quota: QuotaSnapshot): void {
  try {
    options.onQuota?.(quota);
  } catch {
    // 观察者出错不影响请求
  }
}

/** SSE 里的 `codex.rate_limits`：处理了返回 true。 */
export function handleChatGptEvent(data: Json, options: StreamOptions): boolean {
  const quota = parseRateLimitEvent(data);
  if (quota === undefined) return data["type"] === "codex.rate_limits";
  emitQuota(options, quota);
  return true;
}

/** 订阅计费：按零价计成本（cost 全 0），用量标 `billing: "subscription"`。 */
export function subscriptionModel(model: Model, usage: Usage): Model {
  usage.billing = "subscription";
  return { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

export type Recovery =
  | { kind: "refresh"; live: LiveToken }
  | { kind: "retry" }
  | { kind: "fail"; error: Error }
  | { kind: "none" };

function errorBody(body: string): Json {
  try {
    const value = JSON.parse(body) as Json;
    const error = value["error"];
    if (typeof error === "object" && error !== null) return error as Json;
    return value;
  } catch {
    return {};
  }
}

function codeOf(error: Json): string {
  const code = error["code"] ?? error["type"];
  return typeof code === "string" ? code : "";
}

/** 订阅配额耗尽（不重试）；其余 429（普通限流）留给会话层的退避重试。 */
const QUOTA_CODES = new Set([
  "subscription_sharing_usage_limit_exceeded",
  "usage_limit_reached",
  "usage_not_included",
  "insufficient_quota",
]);

function resetText(quota: QuotaSnapshot | undefined): string {
  const at = quota?.primary?.resetsAt;
  return at === undefined ? "" : ` (resets at ${new Date(at).toISOString()})`;
}

/**
 * HTTP 错误 → 恢复动作或映射后的错误。`tried`：本次请求已用过的恢复（每种至多一次）。
 */
export function recoverChatGptError(
  error: HttpError,
  model: Model,
  compat: OpenAIResponsesCompat,
  options: StreamOptions,
  apiKey: string | undefined,
  tried: Set<string>,
): Recovery {
  const backend = compat.chatgptBackend as ChatGptBackend;
  const body = errorBody(error.body);
  const code = codeOf(body);
  const provider = model.provider;
  if (error.status === 429 && QUOTA_CODES.has(code)) {
    const quota = quotaFromLimitError(body);
    emitQuota(options, quota);
    const what =
      code === "usage_not_included"
        ? "your ChatGPT plan does not include this usage"
        : "ChatGPT plan usage limit reached";
    return {
      kind: "fail",
      error: new Error(
        `quota_exceeded: ${what}; quota exceeded${resetText(quota)}; see https://chatgpt.com/settings/usage`,
      ),
    };
  }
  if (error.status === 401) {
    const live = liveToken(apiKey);
    if (live !== undefined && !tried.has("refresh")) {
      tried.add("refresh");
      return { kind: "refresh", live };
    }
    return { kind: "fail", error: authExpiredError(provider) };
  }
  if (
    backend === "siwc" &&
    error.status === 403 &&
    code === "subscription_sharing_user_not_eligible"
  )
    return {
      kind: "fail",
      error: new Error(`not_eligible: ${msg().auth.request.notEligible}`),
    };
  if (
    backend === "siwc" &&
    error.status === 400 &&
    code === "subscription_sharing_unsupported_capability" &&
    !tried.has("strip")
  ) {
    const param = typeof body["param"] === "string" ? body["param"].split(/[.[]/)[0] : undefined;
    if (param !== undefined && param !== "" && param !== "input" && param !== "model") {
      tried.add("strip");
      const key = `${model.provider}/${model.id}`;
      const set = strippedFields.get(key) ?? new Set<string>();
      set.add(param);
      strippedFields.set(key, set);
      return { kind: "retry" };
    }
  }
  if (
    backend === "codex" &&
    error.status === 400 &&
    /instructions are not valid/i.test(error.body) &&
    !tried.has("instructions")
  ) {
    tried.add("instructions");
    developerMode.add(sessionKeyOf(model, options));
    return { kind: "retry" };
  }
  return { kind: "none" };
}
