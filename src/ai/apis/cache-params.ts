/**
 * 协议层缓存参数（第三波 §1.3）：缓存兼容开关的端点推断、保留层级解析、亲和头。
 *
 * 推断只看最终请求的主机名（不看 provider id：`OPENAI_BASE_URL` 把 openai 指到中转时按中转处理）：
 * - `sendPromptCacheKey`、`supportsLongCacheRetention`：按 `HOST_CACHE_CAPABILITIES`（[W5-M2]，官方
 *   文档写明支持的主机才开；其余主机——含全部中转——缺省关）。`sendPromptCacheKey` 只对 OpenAI 两条线有意义；
 * - `sendSessionAffinityHeaders`、`supportsExplicitPromptCacheMode`：缺省一律关（实测中转都接受
 *   但未见命中提升，OpenRouter 未实测，见 docs/providers.md「缓存」）；
 * - `cacheReporting`：`auto`。
 * 显式 `model.compat`（registry 已把 provider.compat 合进来）逐字段覆盖推断。
 *
 * 400 自动剥离（`postWithCacheFallback`）：端点以 400 拒收并点名 prompt_cache_* / cache_control 时，
 * 把 `${provider}/${model}` 记入进程级 `strippedCacheParams`，去掉这些字段在 `start` 之前重发一次，
 * 并提示一次（实测：某中转的 Responses 对 DeepSeek 拒收 prompt_cache_retention / _options）。
 */

import { HttpError, postJson, type PostOptions } from "../http.js";
import type { Api, CacheRetention, Model, PromptCacheCompat } from "../types.js";

const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  "anthropic-messages": "https://api.anthropic.com",
  "openai-completions": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
};

/**
 * 按主机的缓存能力（精确主机名；docs/research/R1-models-protocols.md §2.1 的官方文档为据）：
 * - OpenAI：`prompt_cache_key` 路由 + `prompt_cache_retention: "24h"`；
 * - Anthropic：`ttl: "1h"`；
 * - xAI、Mistral、Kimi：官方推荐 `prompt_cache_key`（Kimi 的 `prompt_cache_options.ttl` 形状不同，不开）；
 * - 腾讯 TokenHub：Anthropic 线 `cache_control` 支持 `ttl: "1h"`，OpenAI 线自动缓存 + `prompt_cache_key`。
 * 通义 Messages 只有 5m（不开长保留）；Groq 的 Responses 不认 `prompt_cache_key`（不开）。
 */
export const HOST_CACHE_CAPABILITIES: Readonly<
  Record<
    string,
    Partial<Pick<PromptCacheCompat, "sendPromptCacheKey" | "supportsLongCacheRetention">>
  >
> = {
  "api.openai.com": { sendPromptCacheKey: true, supportsLongCacheRetention: true },
  "api.anthropic.com": { supportsLongCacheRetention: true },
  "api.x.ai": { sendPromptCacheKey: true },
  "api.mistral.ai": { sendPromptCacheKey: true },
  "api.moonshot.cn": { sendPromptCacheKey: true },
  "api.moonshot.ai": { sendPromptCacheKey: true },
  "tokenhub.tencentmaas.com": { sendPromptCacheKey: true, supportsLongCacheRetention: true },
};

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
  const name = endpointHost(model, api);
  const host = Object.hasOwn(HOST_CACHE_CAPABILITIES, name)
    ? HOST_CACHE_CAPABILITIES[name]
    : undefined;
  const out: PromptCacheCompat = {
    sendPromptCacheKey: host?.sendPromptCacheKey === true && api !== "anthropic-messages",
    sendSessionAffinityHeaders: false,
    supportsLongCacheRetention: host?.supportsLongCacheRetention === true,
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

// ---------------------------------------------------------------------------
// 400 自动剥离：端点拒收缓存参数时去掉它们重发一次（仍在 start 之前，流契约不变）
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const CACHE_PARAM_PATTERN =
  /prompt_cache_key|prompt_cache_retention|prompt_cache_options|cache_control/i;
const TOP_LEVEL_PARAMS = ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"];
/** 工具 schema 与调用参数原样保留（里面的同名属性是用户数据，不是缓存参数）。 */
const SCHEMA_KEYS = new Set(["parameters", "input_schema", "input", "arguments"]);

/** 遇到过拒收的 `${provider}/${model}`：进程内之后的请求直接不带缓存参数。 */
export const strippedCacheParams = new Set<string>();

const SUGGESTION: Readonly<Record<string, string>> = {
  prompt_cache_key: "compat.sendPromptCacheKey: false",
  prompt_cache_retention: "compat.supportsLongCacheRetention: false",
  prompt_cache_options: "compat.supportsExplicitPromptCacheMode: false",
  cache_control: 'compat.cacheControlFormat: "none"',
};

let warn: (message: string) => void = (message) => {
  if ((process.env["AMA_LOG"] ?? "warn") !== "error")
    process.stderr.write(`ama: [warn] ${message}\n`);
};

/** 替换剥离提示的输出（宿主 / 测试用）；返回原来的函数。 */
export function setCacheParamWarn(next: (message: string) => void): (message: string) => void {
  const previous = warn;
  warn = next;
  return previous;
}

/** HTTP 400 且错误体点名了缓存参数 → 返回被拒字段名（小写）；否则 undefined。 */
export function isCacheParamRejection(error: unknown): string | undefined {
  if (!(error instanceof HttpError) || error.status !== 400) return undefined;
  return CACHE_PARAM_PATTERN.exec(`${error.body}\n${error.message}`)?.[0].toLowerCase();
}

function stripInto(value: unknown, removed: { count: number }): unknown {
  if (Array.isArray(value)) return value.map((item) => stripInto(item, removed));
  if (typeof value !== "object" || value === null) return value;
  const out: Json = {};
  for (const [key, inner] of Object.entries(value as Json)) {
    if (key === "cache_control") removed.count++;
    else out[key] = SCHEMA_KEYS.has(key) ? inner : stripInto(inner, removed);
  }
  return out;
}

function stripWithCount(body: unknown): { body: unknown; removed: number } {
  const removed = { count: 0 };
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { body, removed: 0 };
  const out = stripInto(body, removed) as Json;
  for (const key of TOP_LEVEL_PARAMS) {
    if (key in out) {
      delete out[key];
      removed.count++;
    }
  }
  return { body: out, removed: removed.count };
}

/** 去掉顶层 prompt_cache_* 与任意层级的 cache_control（返回新对象，不改入参）。 */
export function stripCacheParams(body: Json): Json {
  return stripWithCount(body).body as Json;
}

/**
 * `postJson` 加缓存参数兜底：已记入 `strippedCacheParams` 的模型直接剥离后发；否则照发，
 * 遇到点名缓存参数的 400 且请求里确有可剥离字段 → 记入集合、提示一次、剥离后重发一次。
 */
export async function postWithCacheFallback(
  model: Pick<Model, "provider" | "id">,
  url: string,
  options: PostOptions,
): Promise<Response> {
  const key = `${model.provider}/${model.id}`;
  const body = strippedCacheParams.has(key) ? stripWithCount(options.body).body : options.body;
  try {
    return await postJson(url, { ...options, body });
  } catch (error) {
    const field = isCacheParamRejection(error);
    const stripped = field && !options.signal.aborted ? stripWithCount(body) : undefined;
    if (!field || !stripped || stripped.removed === 0) throw error;
    strippedCacheParams.add(key);
    warn(
      `${key}：该端点不支持 ${field}，已自动去掉缓存参数重发；可在 config 里设 ${SUGGESTION[field] ?? "相应的 compat 开关"}`,
    );
    return postJson(url, { ...options, body: stripped.body });
  }
}
