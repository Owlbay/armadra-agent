/**
 * `ama providers add|refresh` 的纯计算部分（docs/providers.md「一键接入」）：候选渠道、模型列表的
 * 协议提示、探测结果 → 模型渠道、渠道收敛、追加式合并进配置、表格。
 *
 * 不读写文件、不联网（`fetchModelList` 除外，它只是一次 GET）；命令流程在 providers.ts。
 */

import { apiShortName } from "../../ai/providers/channels.js";
import {
  matchLabel,
  type ModelsDevFields,
  type ModelsDevMatch,
} from "../../ai/providers/models-dev.js";
import type { Api } from "../../ai/types.js";
import type { ChannelConfig, ModelConfig, ProviderConfig } from "../../config/types.js";
import { CHANNEL_NAME_PATTERN } from "../../config/types.js";
import { padToWidth, visibleWidth } from "../../tui/ansi.js";
import { UsageError } from "../args.js";
import { compactTokens } from "./model-meta.js";
import { msg } from "../../i18n/index.js";

export const PROBE_APIS: readonly Api[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
];

export const DEFAULT_PREFER: readonly string[] = ["chat", "responses", "messages"];

export interface CandidateChannel {
  name: string;
  api: Api;
  baseUrl: string;
}

const API_CHOICES: readonly string[] = [...PROBE_APIS, "google-generative-ai"];

/** `--channel name=api@baseUrl`。 */
export function parseChannelSpec(spec: string): CandidateChannel {
  const m = /^([^=]+)=([^@]+)@(.+)$/.exec(spec.trim());
  if (!m) throw new UsageError(msg().subcommands.providersPlan.channelSpec(spec));
  const [, name = "", api = "", baseUrl = ""] = m;
  if (!CHANNEL_NAME_PATTERN.test(name))
    throw new UsageError(msg().subcommands.providersPlan.channelName(name));
  if (!API_CHOICES.includes(api))
    throw new UsageError(msg().subcommands.providersPlan.channelApi(API_CHOICES, api));
  if (!/^https?:\/\//.test(baseUrl))
    throw new UsageError(msg().subcommands.providersPlan.channelUrl(baseUrl));
  return { name, api: api as Api, baseUrl: baseUrl.replace(/\/+$/, "") };
}

/** 从 `--base-url` 推出候选渠道；`api` 给定（非 auto）时只留对应的一个。 */
export function defaultChannels(baseUrl: string, api?: string): CandidateChannel[] {
  const base = baseUrl.replace(/\/+$/, "");
  const root = base.replace(/\/v1$/, "");
  const all: CandidateChannel[] = [
    { name: "chat", api: "openai-completions", baseUrl: base },
    { name: "responses", api: "openai-responses", baseUrl: base },
    { name: "messages", api: "anthropic-messages", baseUrl: root },
  ];
  if (api === undefined || api === "auto") return all;
  if (!API_CHOICES.includes(api))
    throw new UsageError(
      msg().subcommands.common.invalidChoice("--api", [...PROBE_APIS, "auto"], api),
    );
  const one = all.find((c) => c.api === api);
  return [one ?? { name: apiShortName(api as Api), api: api as Api, baseUrl: base }];
}

export interface ListedModel {
  id: string;
  /** new-api 一类中转的 `supported_endpoint_types`。 */
  endpoints?: string[];
}

const ENDPOINT_APIS: Readonly<Record<string, Api>> = {
  openai: "openai-completions",
  "openai-response": "openai-responses",
  "openai-responses": "openai-responses",
  responses: "openai-responses",
  anthropic: "anthropic-messages",
  gemini: "google-generative-ai",
};

/**
 * 模型列表的提示 → 候选渠道名。没有提示（或提示里没有认识的协议）返回 undefined；有提示但候选渠道
 * 一个都不支持返回 []（该模型在这些渠道上不可用）。
 */
export function hintedChannels(
  listed: ListedModel,
  candidates: readonly CandidateChannel[],
): string[] | undefined {
  if (listed.endpoints === undefined || listed.endpoints.length === 0) return undefined;
  const apis = new Set(
    listed.endpoints.map((e) => ENDPOINT_APIS[e.toLowerCase()]).filter((a) => a !== undefined),
  );
  if (apis.size === 0) return undefined;
  return candidates.filter((c) => apis.has(c.api)).map((c) => c.name);
}

/** 按 `prefer` 排序（不在 prefer 里的保持原顺序排在后面）。 */
export function orderChannels(names: readonly string[], prefer: readonly string[]): string[] {
  const rank = (n: string): number => {
    const i = prefer.indexOf(n);
    return i < 0 ? prefer.length : i;
  };
  return [...new Set(names)].sort((a, b) => rank(a) - rank(b));
}

/** 解析 `GET /models` 的响应体。 */
export function parseModelList(body: unknown): ListedModel[] {
  const data = (body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: ListedModel[] = [];
  for (const item of data) {
    const id = (item as { id?: unknown })?.id;
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    const endpoints = (item as { supported_endpoint_types?: unknown }).supported_endpoint_types;
    const listed: ListedModel = { id };
    if (Array.isArray(endpoints))
      listed.endpoints = endpoints.filter((e): e is string => typeof e === "string");
    out.push(listed);
  }
  return out;
}

/** 列模型用的渠道与 URL：第一个 OpenAI 系渠道 `{baseUrl}/models`；只有 Messages 时 `/v1/models`。 */
export function listingTarget(
  candidates: readonly CandidateChannel[],
): { channel: CandidateChannel; url: string } | undefined {
  const openai = candidates.find(
    (c) => c.api === "openai-completions" || c.api === "openai-responses",
  );
  const channel = openai ?? candidates[0];
  if (channel === undefined) return undefined;
  const base = channel.baseUrl.replace(/\/+$/, "");
  const url =
    channel.api === "anthropic-messages" && !/\/v1$/.test(base)
      ? `${base}/v1/models`
      : `${base}/models`;
  return { channel, url };
}

export type ModelStatus = "ok" | "unprobed" | "failed" | "no-tools" | "no-channel" | "existing";

export interface ModelPlan {
  id: string;
  channels: string[];
  status: ModelStatus;
  fields: ModelsDevFields;
  match: ModelsDevMatch | undefined;
  /** 探测失败的原因（最后一次）。 */
  error?: string;
}

/** 要探测的模型：`--probe-models` 给出的（保持顺序），否则按 id 字母序（不分大小写）取前 limit 个。 */
export function probeSelection(
  ids: readonly string[],
  limit: number,
  only: readonly string[] | undefined,
): string[] {
  if (only !== undefined) return only.filter((id) => ids.includes(id));
  return [...ids].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).slice(0, limit);
}

/**
 * 按请求上限截断：每个模型要试的渠道数相加超过 `max` 时丢掉后面的模型。返回保留的模型与请求数。
 */
export function capRequests(
  selected: readonly string[],
  channelsFor: (id: string) => readonly string[],
  max: number,
): { ids: string[]; requests: number; dropped: number } {
  const ids: string[] = [];
  let requests = 0;
  for (const id of selected) {
    const n = channelsFor(id).length;
    if (requests + n > max) break;
    ids.push(id);
    requests += n;
  }
  return { ids, requests, dropped: selected.length - ids.length };
}

/**
 * 合并进已有的供应商配置（追加式）：已有渠道定义与模型条目一字不改，只加新渠道与新模型；
 * 新模型只写 `id` 与 `channels`。返回新的配置与新增数。
 */
export function mergeProvider(
  existing: ProviderConfig | undefined,
  input: {
    name?: string;
    apiKey?: string;
    channels: readonly CandidateChannel[];
    models: readonly { id: string; channels: readonly string[] }[];
    prefer: readonly string[];
  },
): { config: ProviderConfig; addedChannels: string[]; addedModels: string[] } {
  const config: ProviderConfig = structuredClone(existing ?? {});
  if (input.name !== undefined && config.name === undefined) config.name = input.name;
  if (input.apiKey !== undefined && config.apiKey === undefined) config.apiKey = input.apiKey;
  const channels: Record<string, ChannelConfig> = config.channels ?? {};
  const used = new Set(input.models.flatMap((m) => m.channels));
  const addedChannels: string[] = [];
  for (const c of input.channels) {
    if (channels[c.name] !== undefined || !used.has(c.name)) continue;
    channels[c.name] = { api: c.api, baseUrl: c.baseUrl };
    addedChannels.push(c.name);
  }
  config.channels = channels;
  if (config.defaultChannel === undefined || channels[config.defaultChannel] === undefined) {
    const first = orderChannels(Object.keys(channels), input.prefer)[0];
    if (first !== undefined) config.defaultChannel = first;
  }
  const models: ModelConfig[] = config.models ?? [];
  const known = new Set(models.map((m) => m.id));
  const addedModels: string[] = [];
  for (const m of input.models) {
    if (known.has(m.id) || m.channels.length === 0) continue;
    models.push({ id: m.id, channels: [...m.channels] });
    known.add(m.id);
    addedModels.push(m.id);
  }
  config.models = models;
  return { config, addedChannels, addedModels };
}

function statusText(status: ModelStatus): string {
  const t = msg().subcommands.providersPlan.status;
  return status === "no-tools" ? t.noTools : status === "no-channel" ? t.noChannel : t[status];
}

function cost(fields: ModelsDevFields): string {
  return fields.cost !== undefined ? `$${fields.cost.input}/${fields.cost.output}` : "—";
}

function yesNo(value: boolean | undefined): string {
  const t = msg().subcommands.providersPlan;
  return value === undefined ? "?" : value ? t.yes : t.no;
}

/** 表格：id、渠道、上下文、输出、图像、推理、工具、价格（$/M 入/出）、状态、models.dev 匹配。 */
export function renderTable(plans: readonly ModelPlan[]): string {
  const h = msg().subcommands.providersPlan.head;
  const head = [
    h.model,
    h.channel,
    h.context,
    h.output,
    h.image,
    h.reasoning,
    h.tools,
    h.price,
    h.status,
    "models.dev",
  ];
  const rows = plans.map((p) => [
    p.id,
    p.channels.length > 0 ? p.channels.join(",") : "—",
    compactTokens(p.fields.contextWindow),
    compactTokens(p.fields.maxTokens),
    p.fields.input === undefined ? "?" : yesNo(p.fields.input.includes("image")),
    yesNo(p.fields.reasoning),
    yesNo(p.fields.toolCall),
    cost(p.fields),
    statusText(p.status),
    matchLabel(p.match),
  ]);
  const widths = head.map((h, i) =>
    Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[i] ?? ""))),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : padToWidth(cell, widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [line(head), ...rows.map(line)].join("\n") + "\n";
}
