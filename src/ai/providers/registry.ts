/**
 * ProviderRegistry（设计 §3.2–§3.5）：内置供应商 + 目录 + config.json 合并、模型查找、
 * `provider/model` 解析、key 解析、协议实现查找。实现 B0 契约 `ProviderRegistryApi`。
 *
 * 合并顺序：内置（builtin.ts + catalog）← config.json `providers.<id>`（字段覆盖；`headers` /
 * `compat` 合并；`models[]` 同 id 整条替换、新 id 追加；`modelOverrides[]` 只改元数据；两者都可带
 * 模型级 `api`，缺省沿用供应商的协议）←
 * auth.json 条目的 `baseUrl`。内置 openai / anthropic 的 baseUrl 还可来自 `OPENAI_BASE_URL` /
 * `ANTHROPIC_BASE_URL`（第三波 §2.3，优先级最低，`baseUrlEnv(id)` 报告是否生效）。之后「物化」每个模型：补 baseUrl / headers / compat /
 * authHeader / requiresApiKey，让协议实现只看 Model 就能发请求。
 *
 * 模型引用：`provider/model-id`（model id 自身可含斜杠，如 `openrouter/anthropic/claude-…`）；
 * 前缀不是供应商 id 时整串当 model id。无供应商前缀时全局唯一匹配；多家同名时只留已配置 key
 * 的；仍不唯一 → ambiguous 并列出候选。模型表为空的供应商（ollama、lmstudio、未列模型的
 * 自定义供应商）与 baseUrl 被改到非官方主机的内置供应商（中转站）接受任意 model id，按自定义
 * 缺省合成；后者 compat 未显式配置 `sendPromptCacheKey` 时置 false。
 *
 * 渠道（channels.ts）：有 `channels` 的供应商，模型按首选渠道物化；`provider/model@channel` 换渠道
 * 重新物化（协议、地址、headers、compat 取渠道的，模型级 api / baseUrl 仍覆盖）；渠道 key 经
 * `resolveApiKey(provider, channel)`。没有 `channels` 的供应商行为不变。
 *
 * 内置渠道（[W5-M2]，builtin.ts）：用户 `channels` 同名字段级覆盖、新名追加，`defaultChannel` 用户优先
 * （也可只写 `defaultChannel`，或只写 `api` 选同协议的内置渠道）；目录模型缺省挂全部渠道、缺省渠道在前。
 * 用户（config / auth.json / `*_BASE_URL`）改了供应商级 baseUrl 而没写自己的 `channels` 时，内置渠道作废，
 * 按单渠道回落（`api` 取用户写的或内置的回落协议）。
 *
 * models.dev（enrich.ts）：config 里缺元数据的自定义模型与合成模型，用传入的索引（只读缓存）补
 * contextWindow / maxTokens / input / reasoning / cost，来源记在 `modelMetadata()`；内置目录按同一索引
 * （快照 ⊕ `ama models refresh` 的覆盖）在 catalog.ts 合并，缺字段的条目退回内置快照。
 */

import type { AmaConfig, ProviderConfig } from "../../config/types.js";
import { ApiRegistry, createDefaultApiRegistry } from "../apis/api.js";
import { fakeProviderData } from "../fake/fake-provider.js";
import { mergeHeaders } from "../http.js";
import type {
  Api,
  ApiImplementation,
  ApiKeyResolution,
  Model,
  ModelLookup,
  ProviderChannel,
  ProviderData,
  ProviderRegistryApi,
} from "../types.js";
import { ApiKeyResolver, type KeyResolverOptions } from "./auth.js";
import { BUILTIN_PROVIDERS, fallbackEnvKey, isRelayedBaseUrl } from "./builtin.js";
import { applyModelOverride, loadBuiltinCatalog, toModel, withCustomDefaults } from "./catalog.js";
import {
  catalogChannels,
  channelKeyId,
  dropChannels,
  materializeModel,
  pickBuiltinChannel,
  modelChannels,
  parseChannels,
  splitChannelRef,
} from "./channels.js";
import {
  catalogMetadata,
  enrichEntry,
  lazyIndex,
  type ModelMetadata,
  type ModelsDevSource,
} from "./enrich.js";
import type { ModelsDevIndex } from "./models-dev.js";
import { closest } from "./suggest.js";

export { materializeModel } from "./channels.js";

export type ModelSource = "builtin" | "config" | "discovered";

export interface ProviderRegistryOptions {
  config?: AmaConfig | undefined;
  /** 缺省 createDefaultApiRegistry()。 */
  apis?: ApiRegistry | undefined;
  /** key 发现选项；`configKeys` 缺省取自 config.providers.*.apiKey。 */
  keys?: KeyResolverOptions | undefined;
  /** 注册 `fake` 供应商（缺省 true）。 */
  includeFake?: boolean | undefined;
  onWarning?: ((message: string) => void) | undefined;
  /**
   * models.dev 索引（或惰性加载函数，只读缓存不联网）：给 config 里缺元数据的自定义模型补
   * contextWindow / maxTokens / input / reasoning / cost。
   */
  modelsDev?: ModelsDevSource;
}

export interface ModelEntry {
  model: Model;
  provider: ProviderData;
  source: ModelSource;
}

function configKeysOf(config: AmaConfig | undefined): Record<string, string | undefined> {
  const keys: Record<string, string | undefined> = {};
  for (const [id, provider] of Object.entries(config?.providers ?? {})) {
    keys[id] = provider.apiKey;
    for (const [name, channel] of Object.entries(provider.channels ?? {})) {
      if (channel?.apiKey !== undefined) keys[channelKeyId(id, name)] = channel.apiKey;
    }
  }
  return keys;
}

/** 物化前的模型与它的显式协议 / 地址（渠道切换时重新物化用）。 */
interface RawModel {
  model: Model;
  explicit: { api?: Api; baseUrl?: string };
}

export class ProviderRegistry implements ProviderRegistryApi {
  readonly warnings: string[] = [];
  private readonly providers = new Map<string, ProviderData>();
  private readonly sources = new Map<string, ModelSource>();
  /** baseUrl 来自环境变量的供应商 → 变量名（被 config / auth.json 覆盖后删除）。 */
  private readonly envBaseUrls = new Map<string, string>();
  /** baseUrl 指向非官方主机的内置供应商：接受目录外的 model id。 */
  private readonly relayed = new Set<string>();
  /** 模型表只来自发现缓存的供应商：表外的 id 照样合成（与空表相同）。 */
  private readonly openTables = new Set<string>();
  /** config 里写了自己 `channels` 的供应商（内置渠道不因改 baseUrl 作废）。 */
  private readonly userChannels = new Set<string>();
  /** config 里写了供应商级 `api` 的供应商（单渠道回落时目录模型跟它走）。 */
  private readonly userApi = new Set<string>();
  /** `provider/model` → 物化前的模型（多渠道供应商切换渠道时重新物化）。 */
  private readonly raw = new Map<string, RawModel>();
  /** `provider/model` → 元数据来源与 models.dev 匹配。 */
  private readonly metadata = new Map<string, ModelMetadata>();
  private readonly modelsDev: () => ModelsDevIndex | undefined;
  private readonly apis: ApiRegistry;
  private readonly keys: ApiKeyResolver;
  private readonly onWarning: ((message: string) => void) | undefined;

  constructor(options: ProviderRegistryOptions = {}) {
    this.onWarning = options.onWarning;
    this.modelsDev = lazyIndex(options.modelsDev);
    this.apis = options.apis ?? createDefaultApiRegistry();
    this.keys = new ApiKeyResolver({
      ...options.keys,
      configKeys: options.keys?.configKeys ?? configKeysOf(options.config),
      onWarning: (message) => this.warn(message),
    });
    const catalog = this.loadCatalog();
    const env = options.keys?.useEnv === false ? {} : (options.keys?.env ?? process.env);
    for (const { baseUrlEnv, catalogApi: _catalogApi, ...base } of BUILTIN_PROVIDERS) {
      const models = (catalog.get(base.id) ?? []).map((entry) => {
        const api = (entry as { api?: Api }).api ?? base.api;
        this.sources.set(`${base.id}/${entry.id}`, "builtin");
        const model = toModel(entry, base.id, api);
        this.metadata.set(`${base.id}/${entry.id}`, catalogMetadata(model));
        if ((entry as { api?: Api }).api !== undefined)
          this.raw.set(`${base.id}/${entry.id}`, { model, explicit: { api } });
        return model;
      });
      const fromEnv = baseUrlEnv !== undefined ? env[baseUrlEnv]?.trim() : undefined;
      if (baseUrlEnv !== undefined && fromEnv) this.envBaseUrls.set(base.id, baseUrlEnv);
      const provider: ProviderData = { ...structuredClone(base), models, builtin: true };
      if (fromEnv) {
        provider.baseUrl = fromEnv;
        dropChannels(provider);
      }
      this.providers.set(base.id, provider);
    }
    for (const [id, config] of Object.entries(options.config?.providers ?? {})) {
      this.applyConfig(id, config);
    }
    for (const provider of this.providers.values()) {
      const baseUrl = this.keys.authEntry(provider.id)?.entry.baseUrl;
      if (baseUrl) {
        provider.baseUrl = baseUrl;
        this.envBaseUrls.delete(provider.id);
        if (provider.builtin && !this.userChannels.has(provider.id)) dropChannels(provider);
      }
      if (provider.builtin && isRelayedBaseUrl(provider.id, provider.baseUrl)) {
        this.relayed.add(provider.id);
        if (provider.compat?.sendPromptCacheKey === undefined)
          provider.compat = { ...provider.compat, sendPromptCacheKey: false };
      }
    }
    if (options.includeFake !== false && !this.providers.has("fake")) {
      const fake = fakeProviderData();
      for (const model of fake.models) this.sources.set(`fake/${model.id}`, "builtin");
      this.providers.set(fake.id, fake);
    }
    for (const provider of this.providers.values()) {
      if (provider.builtin) this.settleBuiltinChannels(provider);
      provider.models = provider.models.map((model) => this.materialize(provider, model));
    }
  }

  /** 内置目录（快照 ⊕ 用户刷新）；刷新数据出任何问题都退回内置快照，不让启动失败。 */
  private loadCatalog(): ReturnType<typeof loadBuiltinCatalog> {
    try {
      return loadBuiltinCatalog(this.modelsDev());
    } catch (error) {
      this.warn(`models.dev refresh data ignored: ${(error as Error).message}`);
      return loadBuiltinCatalog();
    }
  }

  /**
   * 内置供应商定渠道：供应商级 api / baseUrl 取缺省渠道的（discover 等单地址的用法看它）；用户没指定渠道的
   * 模型挂全部渠道（缺省在前）。渠道已作废的去掉模型上残留的 `channels`。
   */
  private settleBuiltinChannels(provider: ProviderData): void {
    const channels = provider.channels;
    if (channels === undefined || channels.length === 0) {
      // 单渠道回落：没有模型级协议的目录模型走 catalogApi（用户改了 api 时走用户的）
      const builtin = BUILTIN_PROVIDERS.find((p) => p.id === provider.id);
      const api =
        builtin === undefined || this.userApi.has(provider.id)
          ? provider.api
          : (builtin.catalogApi ?? builtin.api);
      for (const model of provider.models) {
        delete model.channels;
        const key = `${provider.id}/${model.id}`;
        if (this.sources.get(key) === "builtin" && this.raw.get(key)?.explicit.api === undefined)
          model.api = api;
      }
      return;
    }
    const first = channels.find((c) => c.name === provider.defaultChannel) ?? channels[0];
    if (first === undefined) return;
    provider.defaultChannel = first.name;
    provider.api = first.api;
    provider.baseUrl = first.baseUrl;
    for (const model of provider.models) {
      if (this.sources.get(`${provider.id}/${model.id}`) === "builtin" || !model.channels)
        model.channels = catalogChannels(model.channels, channels, first.name);
    }
  }

  private warn(message: string): void {
    this.warnings.push(message);
    this.onWarning?.(message);
  }

  /** 物化并记下原始模型；多渠道供应商用模型的首选渠道。 */
  private materialize(provider: ProviderData, model: Model, channelName?: string): Model {
    const key = `${provider.id}/${model.id}`;
    const raw = this.raw.get(key) ?? { model, explicit: {} };
    if (!this.raw.has(key)) {
      if (model.baseUrl !== undefined) raw.explicit.baseUrl = model.baseUrl;
      this.raw.set(key, raw);
    }
    if (provider.channels === undefined || provider.channels.length === 0)
      return materializeModel(raw.model, provider);
    const name = channelName ?? raw.model.channels?.[0] ?? provider.defaultChannel;
    const channel = provider.channels.find((c) => c.name === name) ?? provider.channels[0];
    return materializeModel(raw.model, provider, channel, raw.explicit);
  }

  private applyConfig(id: string, config: ProviderConfig): void {
    const existing = this.providers.get(id);
    const builtinChannels = existing?.builtin ? existing.channels : undefined;
    const parsed =
      config.channels !== undefined
        ? parseChannels(
            id,
            config,
            builtinChannels && {
              channels: builtinChannels,
              defaultChannel: existing?.defaultChannel,
            },
          )
        : undefined;
    if (config.channels !== undefined) this.userChannels.add(id);
    for (const warning of parsed?.warnings ?? []) this.warn(warning);
    const first = parsed?.channels.find((c) => c.name === parsed.defaultChannel);
    if (!existing && !config.baseUrl && first === undefined) {
      this.warn(`provider "${id}" in config.json has no baseUrl; ignored`);
      return;
    }
    const provider: ProviderData = existing ?? {
      id,
      name: config.name ?? id,
      api: config.api ?? first?.api ?? "openai-completions",
      baseUrl: config.baseUrl ?? first?.baseUrl ?? "",
      envKeys: [fallbackEnvKey(id)],
      models: [],
      requiresApiKey: true,
      builtin: false,
    };
    if (config.name !== undefined) provider.name = config.name;
    if (config.api !== undefined) {
      provider.api = config.api;
      this.userApi.add(id);
    }
    if (config.baseUrl !== undefined) {
      provider.baseUrl = config.baseUrl;
      this.envBaseUrls.delete(id);
    }
    if (builtinChannels !== undefined && parsed === undefined)
      pickBuiltinChannel(provider, config, (m) => this.warn(m));
    if (parsed !== undefined && first !== undefined) {
      // 有渠道时供应商级 api / baseUrl 取首选渠道的（discover 等单地址的用法看它）。
      provider.channels = parsed.channels;
      provider.defaultChannel = first.name;
      provider.api = first.api;
      provider.baseUrl = first.baseUrl;
      this.envBaseUrls.delete(id);
    }
    if (config.envKeys !== undefined) {
      provider.envKeys = [
        ...config.envKeys,
        ...provider.envKeys.filter((k) => !config.envKeys?.includes(k)),
      ];
    }
    if (config.authHeader !== undefined) provider.authHeader = config.authHeader;
    if (config.headers) provider.headers = mergeHeaders(provider.headers, config.headers);
    if (config.compat) provider.compat = { ...provider.compat, ...config.compat };
    if (config.requiresApiKey !== undefined) provider.requiresApiKey = config.requiresApiKey;
    const channelsOf = (wanted: readonly string[] | undefined, modelId: string): string[] =>
      modelChannels(wanted, provider.channels ?? [], provider.defaultChannel ?? "", (name) =>
        this.warn(`model "${id}/${modelId}" channel "${name}" not found; ignored`),
      );
    for (const entry of config.models ?? []) {
      // 模型级 api（第三波 §2.3）：同一中转下不同模型走不同协议；缺省沿用供应商（或渠道）的。
      const { entry: filled, metadata } = enrichEntry(entry, this.modelsDev);
      if (typeof entry.modelsDev === "string" && metadata.looked && metadata.match === undefined)
        this.warn(`modelsDev "${entry.modelsDev}" for "${id}/${entry.id}" not found`);
      const model = withCustomDefaults(filled, id, entry.api ?? provider.api);
      // 内置供应商上没写 channels 的模型：定渠道时挂全部渠道（settleBuiltinChannels）
      if (provider.channels !== undefined && (entry.channels !== undefined || !provider.builtin))
        model.channels = channelsOf(entry.channels, entry.id);
      const index = provider.models.findIndex((m) => m.id === entry.id);
      if (index >= 0) provider.models[index] = model;
      else provider.models.push(model);
      const key = `${id}/${entry.id}`;
      this.raw.set(key, {
        model,
        explicit: {
          ...(entry.api !== undefined ? { api: entry.api } : {}),
          ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
        },
      });
      this.sources.set(key, "config");
      this.metadata.set(key, metadata);
    }
    for (const override of config.modelOverrides ?? []) {
      const index = provider.models.findIndex((m) => m.id === override.id);
      const current = provider.models[index];
      if (!current) {
        this.warn(`modelOverrides: "${id}/${override.id}" not found; ignored`);
        continue;
      }
      const { channels, modelsDev: _md, ...fields } = override;
      let next = applyModelOverride(current, fields);
      if (override.api !== undefined) next = { ...next, api: override.api };
      if (channels !== undefined && provider.channels !== undefined)
        next.channels = channelsOf(channels, override.id);
      provider.models[index] = next;
      const key = `${id}/${override.id}`;
      const raw = this.raw.get(key);
      this.raw.set(key, {
        model: next,
        explicit: {
          ...raw?.explicit,
          ...(override.api !== undefined ? { api: override.api } : {}),
          ...(override.baseUrl !== undefined ? { baseUrl: override.baseUrl } : {}),
        },
      });
      const meta = this.metadata.get(key);
      if (meta !== undefined)
        for (const field of Object.keys(meta.sources) as (keyof ModelMetadata["sources"])[])
          if (fields[field] !== undefined) meta.sources[field] = "config";
    }
    this.providers.set(id, provider);
  }

  /** baseUrl 来自哪个环境变量（未生效返回 undefined）。 */
  baseUrlEnv(providerId: string): string | undefined {
    return this.envBaseUrls.get(providerId);
  }

  /** 内置供应商的 baseUrl 指向非官方主机（中转站）。 */
  isRelayed(providerId: string): boolean {
    return this.relayed.has(providerId);
  }

  /** 模型元数据的来源与 models.dev 匹配（`ama models list` / `config show` / providers 表格）。 */
  modelMetadata(providerId: string, modelId: string): ModelMetadata | undefined {
    return this.metadata.get(`${providerId}/${modelId}`);
  }

  list(): readonly ProviderData[] {
    return [...this.providers.values()];
  }

  get(providerId: string): ProviderData | undefined {
    return this.providers.get(providerId);
  }

  listModels(): ModelEntry[] {
    const out: ModelEntry[] = [];
    for (const provider of this.providers.values()) {
      for (const model of provider.models) {
        out.push({ model, provider, source: this.modelSource(provider.id, model.id) });
      }
    }
    return out;
  }

  modelSource(providerId: string, modelId: string): ModelSource {
    return this.sources.get(`${providerId}/${modelId}`) ?? "config";
  }

  /** 追加 / 替换模型（例如本地枚举得到的 ollama 模型）。 */
  addModels(
    providerId: string,
    models: readonly Model[],
    source: ModelSource = "discovered",
  ): void {
    const provider = this.providers.get(providerId);
    if (!provider) return;
    if (source === "discovered" && provider.models.length === 0 && provider.requiresApiKey)
      this.openTables.add(providerId);
    for (const raw of models) {
      this.raw.delete(`${providerId}/${raw.id}`);
      const model = this.materialize(provider, { ...raw, provider: providerId });
      const index = provider.models.findIndex((m) => m.id === model.id);
      if (index >= 0) provider.models[index] = model;
      else provider.models.push(model);
      this.sources.set(`${providerId}/${model.id}`, source);
    }
  }

  private synthesize(provider: ProviderData, modelId: string, channel?: string): Model {
    const key = `${provider.id}/${modelId}`;
    const { entry, metadata } = enrichEntry({ id: modelId }, this.modelsDev);
    if (!this.metadata.has(key)) this.metadata.set(key, metadata);
    const model = withCustomDefaults(entry, provider.id, provider.api);
    if (provider.channels !== undefined) model.channels = [provider.defaultChannel ?? ""];
    const channelData = provider.channels?.find((c) => c.name === (channel ?? model.channels?.[0]));
    return materializeModel(model, provider, channelData);
  }

  /** 按渠道取模型：渠道不在模型的 channels 里 → channel_not_found，列出可用渠道。 */
  private withChannel(provider: ProviderData, model: Model, channel: string): ModelLookup {
    const available = model.channels ?? [];
    if (!available.includes(channel) || !provider.channels?.some((c) => c.name === channel)) {
      return {
        ok: false,
        reason: "channel_not_found",
        candidates: available.filter(Boolean).map((c) => `${provider.id}/${model.id}@${c}`),
      };
    }
    const picked = channel === model.channel ? model : this.materialize(provider, model, channel);
    return { ok: true, model: { ...picked, channelPinned: true }, provider };
  }

  /**
   * `provider/model`、`provider/model@渠道` 或裸模型 id。`@` 先按渠道解析（id 里本来就带 `@` 且已登记的
   * 模型除外），中转供应商的「未登记即合成」不会把 `@渠道` 吞进模型 id。失败的 reason：供应商不存在 →
   * provider_not_found（候选是编辑距离最近的供应商）；渠道不存在 → channel_not_found；模型不存在 →
   * not_found（候选是最接近的模型）。
   */
  findModel(ref: string): ModelLookup {
    const trimmed = ref.trim();
    const split = splitChannelRef(trimmed);
    if (split === undefined) return this.findPlain(trimmed);
    const exact = this.findPlain(trimmed, undefined, false);
    if (exact.ok) return exact;
    const base = this.findPlain(split.base, split.channel);
    if (!base.ok) return base;
    return this.withChannel(base.provider, base.model, split.channel);
  }

  private findPlain(trimmed: string, channel?: string, synthesize = true): ModelLookup {
    const slash = trimmed.indexOf("/");
    if (slash > 0) {
      const provider = this.providers.get(trimmed.slice(0, slash));
      if (provider) {
        const id = trimmed.slice(slash + 1);
        const model = provider.models.find((m) => m.id === id);
        if (model) return { ok: true, model, provider };
        const open = this.relayed.has(provider.id) || this.openTables.has(provider.id);
        const relayed = provider.models.length === 0 || open;
        if (synthesize && relayed && id.length > 0) {
          // 按所要的渠道直接物化（先按缺省渠道物化再换渠道会留下缺省渠道的地址与 compat）
          const known = provider.channels?.some((c) => c.name === channel) ? channel : undefined;
          const synthesized = this.synthesize(provider, id, known);
          if (known) synthesized.channels = [...new Set([...(synthesized.channels ?? []), known])];
          return { ok: true, model: synthesized, provider };
        }
        return { ok: false, reason: "not_found", candidates: this.similar(id, provider.id) };
      }
    }
    const matches = this.listModels().filter((entry) => entry.model.id === trimmed);
    if (matches.length === 0 && slash > 0) {
      const ids = [...this.providers.keys()];
      return {
        ok: false,
        reason: "provider_not_found",
        candidates: closest(trimmed.slice(0, slash), ids),
      };
    }
    if (matches.length === 1 && matches[0]) {
      return { ok: true, model: matches[0].model, provider: matches[0].provider };
    }
    if (matches.length === 0) {
      return { ok: false, reason: "not_found", candidates: this.similar(trimmed) };
    }
    const configured = matches.filter((entry) => this.keys.hasConfiguredKey(entry.provider));
    if (configured.length === 1 && configured[0]) {
      return { ok: true, model: configured[0].model, provider: configured[0].provider };
    }
    return {
      ok: false,
      reason: "ambiguous",
      candidates: (configured.length > 0 ? configured : matches).map(
        (entry) => `${entry.provider.id}/${entry.model.id}`,
      ),
    };
  }

  /** 最接近的模型（包含关系优先，其次编辑距离），`provider/id` 形式。 */
  private similar(id: string, providerId?: string): string[] {
    const entries = this.listModels().filter(
      (entry) => providerId === undefined || entry.provider.id === providerId,
    );
    return closest(id, entries, 5, (entry) => entry.model.id).map(
      (entry) => `${entry.provider.id}/${entry.model.id}`,
    );
  }

  hasConfiguredKey(providerId: string): boolean {
    const provider = this.providers.get(providerId);
    return provider ? this.keys.hasConfiguredKey(provider) : false;
  }

  async resolveApiKey(providerId: string, channel?: string): Promise<ApiKeyResolution> {
    const provider = this.providers.get(providerId);
    if (!provider) return { apiKey: undefined, source: "none" };
    if (channel !== undefined && provider.channels?.some((c) => c.name === channel)) {
      const own = await this.keys.resolve({
        id: channelKeyId(provider.id, channel),
        envKeys: [],
        requiresApiKey: provider.requiresApiKey,
      });
      if (own.apiKey !== undefined) return own;
    }
    return this.keys.resolve(provider);
  }

  getApi(api: Api): ApiImplementation | undefined {
    return this.apis.get(api);
  }
}

/** 注册表若是 ProviderRegistry（或同形状），报告 baseUrl 来自的环境变量；否则 undefined。 */
export function baseUrlEnvOf(
  registry: ProviderRegistryApi,
  providerId: string,
): string | undefined {
  const r = registry as Partial<Pick<ProviderRegistry, "baseUrlEnv">>;
  return typeof r.baseUrlEnv === "function" ? r.baseUrlEnv(providerId) : undefined;
}

/**
 * 模型枚举：本地服务（`ama models list --provider ollama|lmstudio`）与 `ama models discover`
 * （第三波 §2.3）共用。ollama 走 `/api/tags`，其它走 OpenAI 兼容的 `GET {baseUrl}/models`；
 * `url` / `headers` 由调用方给出时原样使用（远端中转要带鉴权头）。失败抛错由调用方展示。
 */
export async function discoverLocalModels(
  provider: ProviderData,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    url?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Model[]> {
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(options.timeoutMs ?? 5000),
  ]);
  const base = provider.baseUrl.replace(/\/+$/, "");
  const isOllama =
    options.url === undefined && (provider.id === "ollama" || base.includes(":11434"));
  const url =
    options.url ?? (isOllama ? `${base.replace(/\/v1$/, "")}/api/tags` : `${base}/models`);
  const response = await fetch(url, {
    signal,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  });
  if (!response.ok) throw new Error(`${response.status} listing models from ${url}`);
  const body = (await response.json()) as {
    models?: { name?: unknown }[];
    data?: { id?: unknown }[];
  };
  const ids = isOllama
    ? (body.models ?? []).map((m) => m.name)
    : (body.data ?? []).map((m) => m.id);
  return [
    ...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0)),
  ].map((id) => withCustomDefaults({ id }, provider.id, provider.api));
}
