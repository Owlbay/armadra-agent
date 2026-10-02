/**
 * `ama models discover <provider>`（第三波 §2.3）：问中转站有哪些模型。[W3-B12]
 *
 * GET `{baseUrl}/models`（anthropic-messages 且 baseUrl 不以 `/v1` 结尾时为 `{baseUrl}/v1/models`），
 * 带供应商的鉴权头，打印 id 列表并标出已配置的条目。
 */

import { authHeaders, mergeHeaders } from "../../ai/http.js";
import { discoverLocalModels } from "../../ai/providers/registry.js";
import type { Model, ProviderData } from "../../ai/types.js";
import { ExitCode } from "../exit-codes.js";
import type { ModelsAction, ModelsActionContext } from "./models.js";

export const DISCOVER_TIMEOUT_MS = 15_000;
const ANTHROPIC_VERSION = "2023-06-01";

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

async function run(ctx: ModelsActionContext): Promise<number> {
  const { io, registry } = ctx;
  const id = ctx.args[0] ?? "";
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
  return ExitCode.Ok;
}

export const DISCOVER_ACTION: ModelsAction = {
  usage: "ama models discover <provider>",
  required: "<provider>",
  run,
};
