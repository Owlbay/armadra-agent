/**
 * `ama models discover <provider>`（第三波 §2.3）：问中转站有哪些模型。[W3-B12]
 *
 * GET `{baseUrl}/models`（anthropic-messages 且 baseUrl 不以 `/v1` 结尾时为 `{baseUrl}/v1/models`），
 * 带供应商的鉴权头，打印 id 列表并标出已配置的条目。
 *
 * `--probe`：同一中转下不同模型支持的协议不同，对每个 id 依次试供应商协议 → completions →
 * responses → messages（去重），各发一次最小请求（`ama models check` 同款，maxTokens 16），
 * 记第一个成功的协议；每模型最多 3 次请求，`--limit`（缺省 30）限制探测的模型数，执行前打印
 * 预估；401 / 403 / 429 立即停止（key 无效或被限流，继续只会浪费请求）。
 */

import { authHeaders, mergeHeaders } from "../../ai/http.js";
import { discoverLocalModels, materializeModel } from "../../ai/providers/registry.js";
import { withCustomDefaults } from "../../ai/providers/catalog.js";
import type { Api, Model, ProviderData, ProviderRegistryApi } from "../../ai/types.js";
import { UsageError } from "../args.js";
import { ExitCode } from "../exit-codes.js";
import type { ModelsAction, ModelsActionContext } from "./models.js";

export const DISCOVER_TIMEOUT_MS = 15_000;
export const PROBE_TIMEOUT_MS = 30_000;
export const DEFAULT_PROBE_LIMIT = 30;
const ANTHROPIC_VERSION = "2023-06-01";
/** 中转常见的三种协议，按此顺序探测（供应商协议排最前）。 */
export const PROBE_APIS: readonly Api[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
];

/** 模型列表的 URL：OpenAI 系是 `{baseUrl}/models`；Anthropic 官方形状的 baseUrl 不带 `/v1`。 */
export function modelsUrl(provider: ProviderData): string {
  const base = provider.baseUrl.replace(/\/+$/, "");
  if (provider.api === "anthropic-messages" && !/\/v1$/.test(base)) return `${base}/v1/models`;
  return `${base}/models`;
}

export async function discoverModels(
  provider: ProviderData,
  apiKey: string | undefined,
  options: { timeoutMs?: number } = {},
): Promise<Model[]> {
  const timeoutMs = options.timeoutMs ?? DISCOVER_TIMEOUT_MS;
  if (!provider.requiresApiKey && apiKey === undefined)
    return discoverLocalModels(provider, { timeoutMs });
  const anthropic = provider.api === "anthropic-messages";
  const headers = mergeHeaders(
    provider.headers,
    anthropic ? { "anthropic-version": ANTHROPIC_VERSION } : {},
    authHeaders(apiKey, provider.authHeader, anthropic ? "x-api-key" : "authorization-bearer"),
  );
  return discoverLocalModels(provider, { timeoutMs, url: modelsUrl(provider), headers });
}

export function probeOrder(provider: ProviderData): Api[] {
  return PROBE_APIS.includes(provider.api)
    ? [provider.api, ...PROBE_APIS.filter((api) => api !== provider.api)]
    : [...PROBE_APIS];
}

export interface ProbeOptions {
  timeoutMs?: number;
  /** 每次请求后回调。 */
  onAttempt?: (id: string, api: Api, error: string | undefined) => void;
  /** 每个模型探完回调（进度输出）。 */
  onResult?: (id: string, api: Api | undefined) => void;
  /** 因鉴权失败或限流提前停止时回调。 */
  onStop?: (reason: string) => void;
}

const FATAL_STATUS = /^(?:HTTP )?(?:401|403|429)\b/;

/** 返回已探测模型 → 第一个成功的协议（都失败为 undefined）；超出 `limit` 或提前停止的不在表里。 */
export async function probeModelApis(
  registry: ProviderRegistryApi,
  provider: ProviderData,
  ids: string[],
  limit: number,
  options: ProbeOptions = {},
): Promise<Map<string, Api | undefined>> {
  const result = new Map<string, Api | undefined>();
  const key = await registry.resolveApiKey(provider.id);
  const order = probeOrder(provider).filter((api) => registry.getApi(api) !== undefined);
  for (const id of ids.slice(0, Math.max(0, limit))) {
    const known = provider.models.find((m) => m.id === id);
    let found: Api | undefined;
    for (const api of order) {
      const model: Model =
        known !== undefined
          ? { ...known, api }
          : materializeModel(withCustomDefaults({ id }, provider.id, api), provider);
      const error = await attempt(registry, model, key.apiKey, options.timeoutMs);
      options.onAttempt?.(id, api, error);
      if (error === undefined) {
        found = api;
        break;
      }
      if (FATAL_STATUS.test(error)) {
        options.onStop?.(error);
        return result;
      }
    }
    result.set(id, found);
    options.onResult?.(id, found);
  }
  return result;
}

/** 一次最小请求；成功返回 undefined，失败返回错误文本。 */
async function attempt(
  registry: ProviderRegistryApi,
  model: Model,
  apiKey: string | undefined,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<string | undefined> {
  const impl = registry.getApi(model.api);
  if (impl === undefined) return `协议 ${model.api} 尚未实现`;
  try {
    const message = await impl
      .stream(
        model,
        { messages: [{ role: "user", content: "Reply with: ok", timestamp: Date.now() }] },
        {
          signal: AbortSignal.timeout(timeoutMs),
          ...(apiKey !== undefined ? { apiKey } : {}),
          maxTokens: 16,
          cacheRetention: "none",
        },
      )
      .result();
    if (message.stopReason === "error" || message.stopReason === "aborted")
      return message.errorMessage ?? message.stopReason;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PROBE_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--limit 需要正整数：${raw}`);
  return n;
}

async function run(ctx: ModelsActionContext): Promise<number> {
  const { io, registry } = ctx;
  const id = ctx.args[0] ?? "";
  const limit = parseLimit(ctx.values.get("limit"));
  const provider = registry.get(id);
  if (provider === undefined) {
    io.stderr(`ama: 供应商不存在：${id}\n`);
    return ExitCode.NoModel;
  }
  const key = await registry.resolveApiKey(provider.id);
  if (key.apiKey === undefined && provider.requiresApiKey) {
    io.stderr(`ama: ${provider.id} 没有 API key（ama auth set ${provider.id}）\n`);
    return ExitCode.NoModel;
  }
  let found: Model[];
  try {
    found = await discoverModels(provider, key.apiKey);
  } catch (error) {
    io.stderr(`ama: ${provider.id} 模型列表获取失败：${(error as Error).message}\n`);
    return ExitCode.RuntimeError;
  }
  const configured = new Map(provider.models.map((m) => [m.id, m]));
  io.stdout(`${provider.id}：发现 ${found.length} 个模型（${modelsUrl(provider)}）\n`);
  for (const model of found) {
    const known = configured.get(model.id);
    io.stdout(`  ${model.id}${known !== undefined ? `  已配置（${known.api}）` : ""}\n`);
  }
  if (!ctx.flags.has("probe")) return ExitCode.Ok;
  const ids = found.map((m) => m.id);
  const count = Math.min(limit, ids.length);
  const order = probeOrder(provider);
  io.stdout(
    `\n探测协议：${count} 个模型（${order.join(" → ")}），最多 ${count * order.length} 次请求` +
      `${ids.length > count ? `；另有 ${ids.length - count} 个超出 --limit ${limit}，未探测` : ""}\n`,
  );
  let stopped: string | undefined;
  await probeModelApis(registry, provider, ids, limit, {
    onResult: (modelId, api) => io.stdout(`  ${modelId}  ${api ?? "不可用（三种协议均失败）"}\n`),
    onStop: (reason) => (stopped = reason),
  });
  if (stopped !== undefined) {
    io.stderr(`ama: 探测提前停止（${stopped}）\n`);
    return ExitCode.RuntimeError;
  }
  return ExitCode.Ok;
}

export const DISCOVER_ACTION: ModelsAction = {
  usage: "ama models discover <provider> [--probe] [--limit <n>]",
  required: "<provider>",
  valueOptions: ["limit"],
  flagOptions: ["probe"],
  run,
};
