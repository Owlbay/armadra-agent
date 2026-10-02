/**
 * 渠道（docs/providers.md「渠道」）：一个供应商下的多种接口（协议 + 地址 + 可选 key / headers / compat）。
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
import type { Api, ProviderChannel } from "../types.js";

/** 隐式渠道名（单渠道供应商）。 */
export const DEFAULT_CHANNEL = "default";

/** 渠道 key 在 key 解析里的键。 */
export function channelKeyId(providerId: string, channel: string): string {
  return `${providerId}@${channel}`;
}

/** config 的 `channels` → 物化渠道表（跳过名字非法或缺 api / baseUrl 的，返回警告）。 */
export function parseChannels(
  providerId: string,
  config: ProviderConfig,
): { channels: ProviderChannel[]; defaultChannel: string | undefined; warnings: string[] } {
  const warnings: string[] = [];
  const channels: ProviderChannel[] = [];
  for (const [name, raw] of Object.entries(config.channels ?? {})) {
    const c = raw as Partial<ChannelConfig> | undefined;
    if (!CHANNEL_NAME_PATTERN.test(name) || !c || !c.api || !c.baseUrl) {
      warnings.push(`provider "${providerId}" channel "${name}" is invalid; ignored`);
      continue;
    }
    const channel: ProviderChannel = { name, api: c.api, baseUrl: c.baseUrl };
    if (c.authHeader !== undefined) channel.authHeader = c.authHeader;
    if (c.headers !== undefined) channel.headers = { ...c.headers };
    if (c.compat !== undefined) channel.compat = { ...c.compat };
    channels.push(channel);
  }
  let defaultChannel = config.defaultChannel;
  if (defaultChannel !== undefined && !channels.some((c) => c.name === defaultChannel)) {
    warnings.push(`provider "${providerId}" defaultChannel "${defaultChannel}" not found`);
    defaultChannel = undefined;
  }
  return { channels, defaultChannel: defaultChannel ?? channels[0]?.name, warnings };
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
