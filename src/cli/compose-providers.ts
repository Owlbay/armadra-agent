/**
 * 组装根：供应商注册表（实施计划 §1.1 `providers.create`）。[B6]
 *
 * - `ProviderBuildInput` → `ProviderRegistry`：auth.json（`--auth-file` 或用户级缺省，已由 bootstrap
 *   解析成一个路径，所以 `userAuthFile: null`）、环境变量开关、`--api-key` 只作用于 `--model` 所属的
 *   供应商（无斜杠的模型名先用一个不带 cli key 的注册表解析出供应商）。
 * - `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`（第三波 §2.3）：与 key 同一份 `env`、同一个 `authEnv`
 *   开关进注册表，内置 openai / anthropic 指向中转站；profile.authEnv=false 时一并不读。
 * - SDK 追加的供应商（`ProviderData[]`）折成 `config.providers` 条目，走同一条合并路径。
 * - 零配置（设计 §10.0）：没有 `defaultModel`、也没有任何需要 key 的供应商配了 key 时，探测本地
 *   ollama / lmstudio（短超时），把枚举到的模型加进注册表，供 `pickDefaultModel` 选用。
 */

import type { ApiRegistry } from "../ai/apis/api.js";
import { ProviderRegistry, discoverLocalModels } from "../ai/providers/registry.js";
import type { ProviderData } from "../ai/types.js";
import type { AmaConfig, ModelConfig, ProviderConfig } from "../config/types.js";
import type { ProviderBuildInput } from "./deps.js";

export const LOCAL_PROBE_TIMEOUT_MS = 300;
export const NO_LOCAL_PROBE_ENV = "AMA_NO_LOCAL_PROBE";

export interface ProviderComposeOptions {
  /** 追加 / 覆盖的供应商（SDK）。 */
  providers?: readonly ProviderData[] | undefined;
  apis?: ApiRegistry | undefined;
  /** key 发现用的环境（缺省 process.env）。 */
  env?: NodeJS.ProcessEnv | undefined;
  /** 注册 fake 供应商（缺省 true：测试与 `--model fake/echo` 依赖）。 */
  includeFake?: boolean | undefined;
  /** 零配置时探测本地服务（缺省 true；`AMA_NO_LOCAL_PROBE=1` 关闭）。 */
  probeLocal?: boolean | undefined;
  probeTimeoutMs?: number | undefined;
  warn?: ((message: string) => void) | undefined;
}

/** 模型协议与供应商不同时保留模型级 `api`（同一中转下的模型可走不同协议）。 */
function modelConfigOf(model: ProviderData["models"][number], providerApi: string): ModelConfig {
  const { provider: _p, api, ...rest } = model;
  return api !== providerApi ? { ...rest, api } : rest;
}

export function providerConfigOf(provider: ProviderData): ProviderConfig {
  const config: ProviderConfig = {
    name: provider.name,
    api: provider.api,
    baseUrl: provider.baseUrl,
    envKeys: [...provider.envKeys],
    requiresApiKey: provider.requiresApiKey,
    models: provider.models.map((model) => modelConfigOf(model, provider.api)),
  };
  if (provider.authHeader !== undefined) config.authHeader = provider.authHeader;
  if (provider.headers !== undefined) config.headers = { ...provider.headers };
  if (provider.compat !== undefined) config.compat = { ...provider.compat };
  return config;
}

export function withExtraProviders(
  config: AmaConfig,
  providers: readonly ProviderData[] | undefined,
): AmaConfig {
  if (providers === undefined || providers.length === 0) return config;
  const merged = { ...(config.providers ?? {}) };
  for (const provider of providers) merged[provider.id] = providerConfigOf(provider);
  return { ...config, providers: merged };
}

export async function buildProviderRegistry(
  input: ProviderBuildInput,
  options: ProviderComposeOptions = {},
): Promise<ProviderRegistry> {
  const config = withExtraProviders(input.config, options.providers);
  const make = (cliApiKey?: { provider: string; apiKey: string }): ProviderRegistry =>
    new ProviderRegistry({
      config,
      apis: options.apis,
      includeFake: options.includeFake ?? true,
      keys: {
        cliApiKey,
        authFile: input.authFile,
        userAuthFile: null,
        useEnv: input.authEnv,
        env: options.env,
      },
      onWarning: options.warn,
    });
  let registry = make();
  const cli = input.cliApiKey;
  if (cli !== undefined) {
    let provider = cli.provider;
    if (provider === undefined) {
      const found = registry.findModel(cli.modelRef);
      if (found.ok) provider = found.provider.id;
    }
    if (provider !== undefined) registry = make({ provider, apiKey: cli.apiKey });
  }
  const env = options.env ?? process.env;
  const probe = options.probeLocal ?? env[NO_LOCAL_PROBE_ENV] !== "1";
  if (probe && config.defaultModel === undefined && !anyKeyConfigured(registry)) {
    await probeLocalProviders(registry, options.probeTimeoutMs ?? LOCAL_PROBE_TIMEOUT_MS);
  }
  return registry;
}

function anyKeyConfigured(registry: ProviderRegistry): boolean {
  return registry
    .list()
    .some((provider) => provider.requiresApiKey && registry.hasConfiguredKey(provider.id));
}

/** 本地服务（无需 key、模型表为空）的模型枚举；连不上静默跳过。 */
export async function probeLocalProviders(
  registry: ProviderRegistry,
  timeoutMs = LOCAL_PROBE_TIMEOUT_MS,
): Promise<string[]> {
  const local = registry
    .list()
    .filter((p) => !p.requiresApiKey && p.id !== "fake" && p.models.length === 0);
  const found: string[] = [];
  await Promise.all(
    local.map(async (provider) => {
      try {
        const models = await discoverLocalModels(provider, { timeoutMs });
        if (models.length === 0) return;
        registry.addModels(provider.id, models);
        found.push(provider.id);
      } catch {
        // 本地服务未运行：不是错误
      }
    }),
  );
  return found;
}
