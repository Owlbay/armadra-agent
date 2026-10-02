/**
 * 零配置选模型（设计 §10.0、§11.1 第 11 步）：没有 `--model`、续会话的 model_change 与
 * `config.defaultModel` 时，按供应商顺序（内置 §3.3 在前，config 里的自定义供应商在后）选第一个
 * **可用**供应商，再在它的模型里挑一个：
 *
 * - 内置供应商：目录首条（目录按推荐顺序整理过）；
 * - 自定义供应商（中转站，模型表是上游 /v1/models 的顺序）：按 `pickByPrice` 的规则挑——
 *   models.dev 有价格（输入价 > 0）且支持工具调用、上下文 ≥ 64k 的模型里输入价最低的；同价取上下文
 *   大的，再同取列表靠前的。没有满足条件的才退回列表首条。`ama providers add` 写 defaultModel 用同一规则。
 *
 * 可用 = 有 key（`requiresApiKey`）或本地服务已探测到模型（ollama / lmstudio，组装根在
 * 无 key 时探测）。跳过 `fake`（测试供应商只能显式 `--model fake/…`）与协议尚未实现的供应商。
 */

import { compactTokens, metadataOf } from "./subcommands/model-meta.js";
import type { Model, ProviderData, ProviderRegistryApi } from "../ai/types.js";

/** 缺省模型的最小上下文（token）。 */
export const MIN_DEFAULT_CONTEXT = 64_000;

export interface PriceCandidate {
  id: string;
  contextWindow?: number | undefined;
  /** $/M 输入 token。 */
  inputCost?: number | undefined;
  /** models.dev 的 tool_call。 */
  toolCall?: boolean | undefined;
}

export interface PricePick {
  id: string;
  /** 为什么选它（一句话）。 */
  reason: string;
}

/** 规则说明（帮助与输出共用）。 */
export const PRICE_RULE = "支持工具调用、上下文 ≥ 64k 且有价格的模型里输入价最低";

/** 按价格挑缺省模型；没有满足条件的返回 undefined（规则见文件头）。 */
export function pickByPrice(candidates: readonly PriceCandidate[]): PricePick | undefined {
  let best: { c: PriceCandidate; index: number } | undefined;
  candidates.forEach((c, index) => {
    if (c.toolCall !== true) return;
    if (c.inputCost === undefined || !(c.inputCost > 0)) return;
    if ((c.contextWindow ?? 0) < MIN_DEFAULT_CONTEXT) return;
    if (best === undefined) {
      best = { c, index };
      return;
    }
    const a = best.c;
    const cheaper = c.inputCost < (a.inputCost as number);
    const same = c.inputCost === a.inputCost;
    if (cheaper || (same && (c.contextWindow ?? 0) > (a.contextWindow ?? 0))) best = { c, index };
  });
  if (best === undefined) return undefined;
  const { c } = best;
  return {
    id: c.id,
    reason: `${PRICE_RULE}（$${c.inputCost}/M 输入，上下文 ${compactTokens(c.contextWindow)}）`,
  };
}

export interface DefaultModelChoice {
  model: Model;
  provider: ProviderData;
  /** 选中原因：`key`（有 key，来源见 keySource）或 `local`（本地服务）。 */
  via: "key" | "local";
  keySource?: string;
  /** 为什么是这个模型（内置目录首条 / 价格规则 / 列表首条）。 */
  rule: string;
}

/** 供应商内挑模型：内置取目录首条；自定义按价格规则，挑不出再取首条。 */
export function pickProviderModel(
  registry: ProviderRegistryApi,
  provider: ProviderData,
): { model: Model; rule: string } | undefined {
  const usable = provider.models.filter((m) => registry.getApi(m.api) !== undefined);
  const first = usable[0];
  if (first === undefined) return undefined;
  if (provider.builtin) return { model: first, rule: "内置目录推荐的首个模型" };
  const picked = pickByPrice(
    usable.map((m) => ({
      id: m.id,
      contextWindow: m.contextWindow,
      inputCost: m.cost?.input,
      toolCall: metadataOf(registry, provider.id, m.id)?.toolCall,
    })),
  );
  const model = picked === undefined ? undefined : usable.find((m) => m.id === picked.id);
  if (picked !== undefined && model !== undefined) return { model, rule: picked.reason };
  return {
    model: first,
    rule: "列表首个模型（没有同时支持工具调用、上下文 ≥ 64k 且有价格的模型）",
  };
}

export async function pickDefaultModel(
  registry: ProviderRegistryApi,
): Promise<DefaultModelChoice | undefined> {
  for (const provider of registry.list()) {
    if (provider.id === "fake" && !provider.requiresApiKey) continue;
    const head = provider.models[0];
    if (head === undefined) continue;
    if (registry.getApi(head.api) === undefined) continue;
    let via: DefaultModelChoice["via"] = "local";
    let keySource: string | undefined;
    if (provider.requiresApiKey) {
      const key = await registry.resolveApiKey(provider.id);
      if (key.apiKey === undefined) continue;
      via = "key";
      keySource = key.source;
    }
    const picked = pickProviderModel(registry, provider);
    if (picked === undefined) continue;
    const choice: DefaultModelChoice = { model: picked.model, provider, via, rule: picked.rule };
    if (keySource !== undefined) choice.keySource = keySource;
    return choice;
  }
  return undefined;
}

/**
 * 没有可用模型时的引导（一行，选择器的说明行与报错共用）：列出前几个内置供应商的 key 环境变量，
 * 以及 `ama auth set` / `ama providers add`。
 */
export function noModelGuidance(registry: Pick<ProviderRegistryApi, "list">): string {
  const envs = registry
    .list()
    .filter((p) => p.builtin && p.requiresApiKey && p.id !== "fake")
    .map((p) => p.envKeys[0])
    .filter((name): name is string => name !== undefined);
  const shown = envs.slice(0, 3).join(" / ");
  const more = envs.length > 3 ? " 等" : "";
  return (
    `没有可用模型：设置 ${shown}${more}环境变量，或 \`ama auth set <provider>\` 保存 key，` +
    "或 `ama providers add <id> --base-url <url>` 接入中转站（也可 --model 指定）"
  );
}
