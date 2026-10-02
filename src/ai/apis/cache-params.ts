/**
 * 协议层缓存参数（第三波 §1.3）：缓存兼容开关的端点推断、保留层级解析、亲和头。
 *
 * 推断只看最终请求的主机名（不看 provider id：`OPENAI_BASE_URL` 把 openai 指到中转时按中转处理）：
 * - `sendPromptCacheKey`、`supportsLongCacheRetention`：只有官方端点（api.openai.com /
 *   api.anthropic.com）缺省开；
 * - `sendSessionAffinityHeaders`、`supportsExplicitPromptCacheMode`：缺省一律关（实测中转都接受
 *   但未见命中提升，OpenRouter 未实测，见 docs/providers.md「缓存」）；
 * - `cacheReporting`：`auto`。
 * 显式 `model.compat`（registry 已把 provider.compat 合进来）逐字段覆盖推断。
 */

import type { Api, CacheRetention, Model, PromptCacheCompat } from "../types.js";

const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  "anthropic-messages": "https://api.anthropic.com",
  "openai-completions": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
};

const OFFICIAL_HOSTS = new Set(["api.openai.com", "api.anthropic.com"]);

const PROMPT_CACHE_KEYS = [
  "sendPromptCacheKey",
  "sendSessionAffinityHeaders",
  "supportsLongCacheRetention",
  "supportsExplicitPromptCacheMode",
  "cacheReporting",
] as const satisfies readonly (keyof PromptCacheCompat)[];

/** 请求实际发往的主机名（小写）；baseUrl 不可解析时返回空串。 */
export function endpointHost(model: Pick<Model, "baseUrl">, api: Api): string {
  const baseUrl = model.baseUrl ?? DEFAULT_BASE_URLS[api] ?? "";
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 解析后的缓存兼容开关：端点推断 ← `model.compat`。 */
export function resolvePromptCacheCompat(
  model: Pick<Model, "baseUrl" | "compat">,
  api: Api,
): PromptCacheCompat {
  const official = OFFICIAL_HOSTS.has(endpointHost(model, api));
  const out: PromptCacheCompat = {
    sendPromptCacheKey: official && api !== "anthropic-messages",
    sendSessionAffinityHeaders: false,
    supportsLongCacheRetention: official,
    supportsExplicitPromptCacheMode: false,
    cacheReporting: "auto",
  };
  for (const key of PROMPT_CACHE_KEYS) {
    const value = model.compat?.[key];
    if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

const RETENTIONS: readonly CacheRetention[] = ["none", "short", "long"];

/**
 * 本次请求的保留层级：显式 `options.cacheRetention` 优先；否则 `AMA_CACHE_RETENTION`
 * （none | short | long，非法值忽略）；都没有 → short。
 */
export function resolveCacheRetention(
  retention: CacheRetention | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CacheRetention {
  if (retention !== undefined) return retention;
  const fromEnv = env["AMA_CACHE_RETENTION"]?.trim().toLowerCase();
  return RETENTIONS.find((value) => value === fromEnv) ?? "short";
}

/** `long` 在不支持长保留的端点上降为 `short`。 */
export function effectiveRetention(
  retention: CacheRetention,
  compat: Pick<PromptCacheCompat, "supportsLongCacheRetention">,
): CacheRetention {
  return retention === "long" && !compat.supportsLongCacheRetention ? "short" : retention;
}

/**
 * 会话亲和头（`sendSessionAffinityHeaders`）：OpenRouter 用 `x-session-id`，其余
 * `x-session-affinity` + 每请求一个 `x-client-request-id`。无 sessionId 或 retention 为 none 时不发。
 */
export function affinityHeaders(
  model: Pick<Model, "baseUrl" | "compat">,
  api: Api,
  sessionId: string | undefined,
  retention: CacheRetention,
  newId: () => string = () => crypto.randomUUID(),
): Record<string, string> {
  if (!sessionId || retention === "none") return {};
  if (!resolvePromptCacheCompat(model, api).sendSessionAffinityHeaders) return {};
  if (endpointHost(model, api).endsWith("openrouter.ai")) return { "x-session-id": sessionId };
  return { "x-session-affinity": sessionId, "x-client-request-id": newId() };
}
