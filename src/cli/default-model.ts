/**
 * 零配置选模型（设计 §10.0、§11.1 第 11 步）：没有 `--model`、续会话的 model_change 与
 * `config.defaultModel` 时，按内置供应商顺序（§3.3）选第一个**可用**供应商的缺省模型（目录首条）。
 *
 * 可用 = 有 key（`requiresApiKey`）或本地服务已探测到模型（ollama / lmstudio，组装根在
 * 无 key 时探测）。跳过 `fake`（测试供应商只能显式 `--model fake/…`）与协议尚未实现的供应商。
 */

import type { Model, ProviderData, ProviderRegistryApi } from "../ai/types.js";

export interface DefaultModelChoice {
  model: Model;
  provider: ProviderData;
  /** 选中原因：`key`（有 key，来源见 keySource）或 `local`（本地服务）。 */
  via: "key" | "local";
  keySource?: string;
}

export async function pickDefaultModel(
  registry: ProviderRegistryApi,
): Promise<DefaultModelChoice | undefined> {
  for (const provider of registry.list()) {
    if (provider.id === "fake" && !provider.requiresApiKey) continue;
    const model = provider.models[0];
    if (model === undefined) continue;
    if (registry.getApi(model.api) === undefined) continue;
    if (!provider.requiresApiKey) return { model, provider, via: "local" };
    const key = await registry.resolveApiKey(provider.id);
    if (key.apiKey !== undefined) return { model, provider, via: "key", keySource: key.source };
  }
  return undefined;
}
