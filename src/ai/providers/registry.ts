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
  ProviderData,
  ProviderRegistryApi,
} from "../types.js";
import { ApiKeyResolver, type KeyResolverOptions } from "./auth.js";
import { BUILTIN_PROVIDERS, fallbackEnvKey, isRelayedBaseUrl } from "./builtin.js";
import { applyModelOverride, loadBuiltinCatalog, toModel, withCustomDefaults } from "./catalog.js";

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
}

export interface ModelEntry {
  model: Model;
  provider: ProviderData;
  source: ModelSource;
}

/** 物化：模型补齐供应商级字段（不可变：返回新对象）。 */
export function materializeModel(model: Model, provider: ProviderData): Model {
  const out: Model = {
    ...model,
    provider: provider.id,
    baseUrl: model.baseUrl ?? provider.baseUrl,
  };
  if (provider.headers || model.headers)
    out.headers = mergeHeaders(provider.headers, model.headers);
  if (provider.compat || model.compat) out.compat = { ...provider.compat, ...model.compat };
  if (provider.authHeader !== undefined) out.authHeader = model.authHeader ?? provider.authHeader;
  out.requiresApiKey = provider.requiresApiKey;
  return out;
}

function configKeysOf(config: AmaConfig | undefined): Record<string, string | undefined> {
  const keys: Record<string, string | undefined> = {};
  for (const [id, provider] of Object.entries(config?.providers ?? {})) keys[id] = provider.apiKey;
  return keys;
}

export class ProviderRegistry implements ProviderRegistryApi {
  readonly warnings: string[] = [];
  private readonly providers = new Map<string, ProviderData>();
  private readonly sources = new Map<string, ModelSource>();
  /** baseUrl 来自环境变量的供应商 → 变量名（被 config / auth.json 覆盖后删除）。 */
  private readonly envBaseUrls = new Map<string, string>();
  /** baseUrl 指向非官方主机的内置供应商：接受目录外的 model id。 */
  private readonly relayed = new Set<string>();
  private readonly apis: ApiRegistry;
  private readonly keys: ApiKeyResolver;
  private readonly onWarning: ((message: string) => void) | undefined;

  constructor(options: ProviderRegistryOptions = {}) {
    this.onWarning = options.onWarning;
    this.apis = options.apis ?? createDefaultApiRegistry();
    this.keys = new ApiKeyResolver({
      ...options.keys,
      configKeys: options.keys?.configKeys ?? configKeysOf(options.config),
      onWarning: (message) => this.warn(message),
    });
    const catalog = loadBuiltinCatalog();
    const env = options.keys?.useEnv === false ? {} : (options.keys?.env ?? process.env);
    for (const { baseUrlEnv, ...base } of BUILTIN_PROVIDERS) {
      const models = (catalog.get(base.id) ?? []).map((entry) => {
        const api = (entry as { api?: Api }).api ?? base.api;
        this.sources.set(`${base.id}/${entry.id}`, "builtin");
        return toModel(entry, base.id, api);
      });
      const fromEnv = baseUrlEnv !== undefined ? env[baseUrlEnv]?.trim() : undefined;
      if (baseUrlEnv !== undefined && fromEnv) this.envBaseUrls.set(base.id, baseUrlEnv);
      this.providers.set(base.id, {
        ...base,
        ...(fromEnv ? { baseUrl: fromEnv } : {}),
        models,
        builtin: true,
      });
    }
    for (const [id, config] of Object.entries(options.config?.providers ?? {})) {
      this.applyConfig(id, config);
    }
    for (const provider of this.providers.values()) {
      const baseUrl = this.keys.authEntry(provider.id)?.entry.baseUrl;
      if (baseUrl) {
        provider.baseUrl = baseUrl;
        this.envBaseUrls.delete(provider.id);
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
      provider.models = provider.models.map((model) => materializeModel(model, provider));
    }
  }

  private warn(message: string): void {
    this.warnings.push(message);
    this.onWarning?.(message);
  }

  private applyConfig(id: string, config: ProviderConfig): void {
    const existing = this.providers.get(id);
    if (!existing && !config.baseUrl) {
      this.warn(`provider "${id}" in config.json has no baseUrl; ignored`);
      return;
    }
    const provider: ProviderData = existing ?? {
      id,
      name: config.name ?? id,
      api: config.api ?? "openai-completions",
      baseUrl: config.baseUrl ?? "",
      envKeys: [fallbackEnvKey(id)],
      models: [],
      requiresApiKey: true,
      builtin: false,
    };
    if (config.name !== undefined) provider.name = config.name;
    if (config.api !== undefined) provider.api = config.api;
    if (config.baseUrl !== undefined) {
      provider.baseUrl = config.baseUrl;
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
    for (const entry of config.models ?? []) {
      // 模型级 api（第三波 §2.3）：同一中转下不同模型走不同协议；缺省沿用供应商的。
      const model = withCustomDefaults(entry, id, entry.api ?? provider.api);
      const index = provider.models.findIndex((m) => m.id === entry.id);
      if (index >= 0) provider.models[index] = model;
      else provider.models.push(model);
      this.sources.set(`${id}/${entry.id}`, "config");
    }
    for (const override of config.modelOverrides ?? []) {
      const index = provider.models.findIndex((m) => m.id === override.id);
      const current = provider.models[index];
      if (!current) {
        this.warn(`modelOverrides: "${id}/${override.id}" not found; ignored`);
        continue;
      }
      const next = applyModelOverride(current, override);
      provider.models[index] = override.api !== undefined ? { ...next, api: override.api } : next;
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
    for (const raw of models) {
      const model = materializeModel({ ...raw, provider: providerId }, provider);
      const index = provider.models.findIndex((m) => m.id === model.id);
      if (index >= 0) provider.models[index] = model;
      else provider.models.push(model);
      this.sources.set(`${providerId}/${model.id}`, source);
    }
  }

  private synthesize(provider: ProviderData, modelId: string): Model {
    return materializeModel(
      withCustomDefaults({ id: modelId }, provider.id, provider.api),
      provider,
    );
  }

  findModel(ref: string): ModelLookup {
    const trimmed = ref.trim();
    const slash = trimmed.indexOf("/");
    if (slash > 0) {
      const provider = this.providers.get(trimmed.slice(0, slash));
      if (provider) {
        const id = trimmed.slice(slash + 1);
        const model = provider.models.find((m) => m.id === id);
        if (model) return { ok: true, model, provider };
        if ((provider.models.length === 0 || this.relayed.has(provider.id)) && id.length > 0) {
          return { ok: true, model: this.synthesize(provider, id), provider };
        }
        return { ok: false, reason: "not_found", candidates: this.similar(id, provider.id) };
      }
    }
    const matches = this.listModels().filter((entry) => entry.model.id === trimmed);
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

  private similar(id: string, providerId?: string): string[] {
    const needle = id.toLowerCase();
    return this.listModels()
      .filter((entry) => providerId === undefined || entry.provider.id === providerId)
      .filter((entry) => {
        const candidate = entry.model.id.toLowerCase();
        return needle.length > 0 && (candidate.includes(needle) || needle.includes(candidate));
      })
      .slice(0, 10)
      .map((entry) => `${entry.provider.id}/${entry.model.id}`);
  }

  hasConfiguredKey(providerId: string): boolean {
    const provider = this.providers.get(providerId);
    return provider ? this.keys.hasConfiguredKey(provider) : false;
  }

  async resolveApiKey(providerId: string): Promise<ApiKeyResolution> {
    const provider = this.providers.get(providerId);
    if (!provider) return { apiKey: undefined, source: "none" };
    return this.keys.resolve(provider);
  }

  getApi(api: Api): ApiImplementation | undefined {
    return this.apis.get(api);
  }
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
