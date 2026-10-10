/**
 * 渠道（docs/guides/providers.md「渠道」）：一个供应商下的多种接口（协议 + 地址 + 可选 key / headers / compat）。
 *
 * - 没有 `channels` 的供应商按单渠道处理：供应商级 `api` + `baseUrl` 就是隐式的 `default` 渠道，
 *   模型上不出现 `channel` / `channels` 字段，行为与引入渠道之前完全相同。
 * - 有 `channels` 时：模型 `channels[0]` 是首选，缺省 `defaultChannel`；模型级 `api` / `baseUrl`
 *   覆盖在所选渠道之上（等价于匿名渠道）。
 * - 模型引用 `provider/model@channel`：`@` 之后是该供应商的渠道名才当渠道，否则整串仍是 model id。
 * - 渠道自己的 key 以 `<provider>@<channel>` 为键进 key 解析（config 的 `channels.<c>.apiKey` 或
 *   auth.json 的同名条目），没有时用供应商的 key。
 */

import type { ChannelConfig, ProviderConfig } from "../../config/types.js";
import { CHANNEL_NAME_PATTERN } from "../../config/types.js";
import { mergeHeaders } from "../http.js";
import type { Api, Model, ProviderChannel, ProviderData } from "../types.js";

/** 隐式渠道名（单渠道供应商）。 */
export const DEFAULT_CHANNEL = "default";

/** 渠道 key 在 key 解析里的键。 */
export function channelKeyId(providerId: string, channel: string): string {
  return `${providerId}@${channel}`;
}

/**
 * 内置渠道 ⊕ 用户渠道（[W5-M2]）：同名按字段覆盖（`headers` / `compat` 再合并一层）、新名追加在后。
 */
export function mergeChannels(
  base: readonly ProviderChannel[],
  user: readonly ProviderChannel[],
): ProviderChannel[] {
  const out = base.map((c) => structuredClone(c));
  for (const channel of user) {
    const index = out.findIndex((c) => c.name === channel.name);
    const current = out[index];
    if (current === undefined) {
      out.push(channel);
      continue;
    }
    const next: ProviderChannel = { ...current, ...channel };
    if (current.headers && channel.headers)
      next.headers = { ...current.headers, ...channel.headers };
    if (current.compat && channel.compat) next.compat = { ...current.compat, ...channel.compat };
    out[index] = next;
  }
  return out;
}

/**
 * config 的 `channels` → 物化渠道表（跳过名字非法或缺 api / baseUrl 的，返回警告）。给了 `builtin`
 * （内置供应商的内置渠道）时与之合并：同名渠道可只写要改的字段；`defaultChannel` 用户优先，其次内置。
 */
export function parseChannels(
  providerId: string,
  config: ProviderConfig,
  builtin?: { channels: readonly ProviderChannel[]; defaultChannel: string | undefined },
): { channels: ProviderChannel[]; defaultChannel: string | undefined; warnings: string[] } {
  const warnings: string[] = [];
  const own: ProviderChannel[] = [];
  const known = new Set((builtin?.channels ?? []).map((c) => c.name));
  for (const [name, raw] of Object.entries(config.channels ?? {})) {
    const c = raw as Partial<ChannelConfig> | undefined;
    const partial = known.has(name);
    if (!CHANNEL_NAME_PATTERN.test(name) || !c || (!partial && (!c.api || !c.baseUrl))) {
      warnings.push(`provider "${providerId}" channel "${name}" is invalid; ignored`);
      continue;
    }
    const channel = { name } as ProviderChannel;
    if (c.api) channel.api = c.api;
    if (c.baseUrl) channel.baseUrl = c.baseUrl;
    if (c.authHeader !== undefined) channel.authHeader = c.authHeader;
    if (c.headers !== undefined) channel.headers = { ...c.headers };
    if (c.compat !== undefined) channel.compat = { ...c.compat };
    own.push(channel);
  }
  const channels = mergeChannels(builtin?.channels ?? [], own);
  let defaultChannel = config.defaultChannel;
  if (defaultChannel !== undefined && !channels.some((c) => c.name === defaultChannel)) {
    warnings.push(`provider "${providerId}" defaultChannel "${defaultChannel}" not found`);
    defaultChannel = undefined;
  }
  const fallback = channels.some((c) => c.name === builtin?.defaultChannel)
    ? builtin?.defaultChannel
    : channels[0]?.name;
  return { channels, defaultChannel: defaultChannel ?? fallback, warnings };
}

/**
 * 内置供应商目录模型的渠道表：目录条目写了 `channels` 就用它（去掉不存在的），否则挂全部渠道；
 * 缺省渠道在表里时排到首位（首个 = 首选）。
 */
export function catalogChannels(
  wanted: readonly string[] | undefined,
  known: readonly ProviderChannel[],
  defaultChannel: string,
): string[] {
  const names = known.map((c) => c.name);
  const list = wanted === undefined ? names : wanted.filter((name) => names.includes(name));
  const out = list.includes(defaultChannel)
    ? [defaultChannel, ...list.filter((name) => name !== defaultChannel)]
    : [...list];
  return out.length > 0 ? out : [defaultChannel];
}

/** 模型的渠道表：去掉不存在的；空 → [defaultChannel]。 */
export function modelChannels(
  wanted: readonly string[] | undefined,
  known: readonly ProviderChannel[],
  defaultChannel: string,
  onUnknown: (name: string) => void,
): string[] {
  const names = new Set(known.map((c) => c.name));
  const out: string[] = [];
  for (const name of wanted ?? []) {
    if (!names.has(name)) onUnknown(name);
    else if (!out.includes(name)) out.push(name);
  }
  return out.length > 0 ? out : [defaultChannel];
}

/**
 * 拆 `provider/model@channel` 末尾的渠道：只看最后一个 `/` 之后的部分；渠道名不合法时返回 undefined。
 * 是否真的是渠道由调用方结合供应商的渠道表判断。
 */
export function splitChannelRef(ref: string): { base: string; channel: string } | undefined {
  const at = ref.lastIndexOf("@");
  if (at <= 0 || at < ref.lastIndexOf("/")) return undefined;
  const channel = ref.slice(at + 1);
  if (!CHANNEL_NAME_PATTERN.test(channel)) return undefined;
  return { base: ref.slice(0, at), channel };
}

/** `provider/model` 或 `provider/model@channel`（channel 为空时不带后缀）。 */
export function formatModelRef(ref: { provider: string; id: string; channel?: string }): string {
  return `${ref.provider}/${ref.id}${ref.channel !== undefined ? `@${ref.channel}` : ""}`;
}

/** Model / ModelRef → ModelRef（带上渠道，没有渠道时不出现该键）。 */
export function modelRefOf(model: { provider: string; id: string; channel?: string | undefined }): {
  provider: string;
  id: string;
  channel?: string;
} {
  return {
    provider: model.provider,
    id: model.id,
    ...(model.channel !== undefined ? { channel: model.channel } : {}),
  };
}

/** 协议的短名（表格用）。 */
export function apiShortName(api: Api): string {
  switch (api) {
    case "openai-completions":
      return "chat";
    case "openai-responses":
      return "responses";
    case "anthropic-messages":
      return "messages";
    case "google-generative-ai":
      return "gemini";
    default:
      return api;
  }
}

/**
 * 物化：模型补齐供应商级字段（不可变：返回新对象）。给了 `channel` 时协议与地址取渠道的（模型级
 * `explicit` 覆盖优先），headers / compat 按 供应商 ← 渠道 ← 模型 合并，并记下渠道名。
 */
export function materializeModel(
  model: Model,
  provider: ProviderData,
  channel?: ProviderChannel,
  explicit?: { api?: Api | undefined; baseUrl?: string | undefined },
): Model {
  const out: Model = {
    ...model,
    provider: provider.id,
    baseUrl: model.baseUrl ?? provider.baseUrl,
  };
  if (channel !== undefined) {
    out.api = explicit?.api ?? channel.api;
    out.baseUrl = explicit?.baseUrl ?? channel.baseUrl;
    out.channel = channel.name;
  }
  if (provider.headers || channel?.headers || model.headers)
    out.headers = mergeHeaders(provider.headers, channel?.headers, model.headers);
  if (provider.compat || channel?.compat || model.compat)
    out.compat = { ...provider.compat, ...channel?.compat, ...model.compat };
  const authHeader = channel?.authHeader ?? provider.authHeader;
  if (authHeader !== undefined) out.authHeader = model.authHeader ?? authHeader;
  out.requiresApiKey = provider.requiresApiKey;
  return out;
}

/** 内置渠道作废：按供应商级 api / baseUrl 单渠道处理。 */
export function dropChannels(provider: ProviderData): void {
  delete provider.channels;
  delete provider.defaultChannel;
}

/**
 * 内置渠道 + 用户只改供应商级字段：改了 baseUrl → 内置渠道作废（单渠道回落）；只写 `api` → 选同协议的
 * 内置渠道作缺省（没有就作废）；`defaultChannel` 必须是内置渠道名。
 */
export function pickBuiltinChannel(
  provider: ProviderData,
  config: ProviderConfig,
  warn: (message: string) => void,
): void {
  if (config.baseUrl !== undefined) {
    dropChannels(provider);
    return;
  }
  const channels = provider.channels ?? [];
  if (config.defaultChannel !== undefined) {
    if (channels.some((c) => c.name === config.defaultChannel))
      provider.defaultChannel = config.defaultChannel;
    else warn(`provider "${provider.id}" defaultChannel "${config.defaultChannel}" not found`);
  } else if (config.api !== undefined) {
    const same = channels.find((c) => c.api === config.api);
    if (same !== undefined) provider.defaultChannel = same.name;
    else dropChannels(provider);
  }
}
