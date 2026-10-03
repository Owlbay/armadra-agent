/**
 * `ama models discover <provider>`（第三波 §2.3）：问中转站有哪些模型。[W3-B12]
 *
 * GET `{baseUrl}/models`（anthropic-messages 且 baseUrl 不以 `/v1` 结尾时为 `{baseUrl}/v1/models`），
 * 带供应商的鉴权头，打印 id 列表并标出已配置的条目。
 *
 * `--probe`：同一中转下不同模型支持的协议不同，对每个 id 依次试供应商协议 → completions →
 * responses → messages（去重），各发一次最小请求（maxTokens 16，见到首个流事件即判可用并断开），
 * 记第一个成功的协议；模型之间并发（`--concurrency`，缺省 6），单次超时 `--probe-timeout`（缺省
 * 15 s）。每模型最多 3 次请求，`--limit`（缺省 30）限制探测的模型数，执行前打印预估；401 / 403 立即
 * 停止，429 降并发并重试一次、仍 429 停止（见 probe-runner.ts）。
 *
 * `--write`：新条目合并进用户级 config.json 的 `providers.<id>.models`——已有同 id 不覆盖；只写
 * `id` 与探到的 `api`（与供应商协议相同时省略）；带 `--probe` 时只写探测成功的模型。不猜
 * `contextWindow`（自动压缩随之关闭，输出 warning）。写前备份为 `config.json.bak`。
 *
 * models.dev：列表之后按需刷新缓存（24 小时内不重拉），每个模型标出上下文、输出、图片、工具调用与
 * 匹配结果；`--write` 跳过 models.dev 标明不支持工具调用的模型。元数据不写进配置——运行时从缓存补。
 *
 * [W6-O] `chatgpt`：按登录的 flavor 调对应后端的模型列表（SIWC `GET /v1/models` 筛 `visibility: list`；codex
 * `GET /models?client_version=<codexClientVersion>`，另带上下文窗口 / 输入模态 / 推理强度），取 slug 与显示名；
 * `--probe` 不适用（订阅后端只有一种协议）。结果另写进发现缓存 `<dataDir>/models/discovered/chatgpt.json`
 * （discovered-cache.ts，0 个也写），`/model` 选择器由此列出；codex 返回 0 个时提示 codexClientVersion 可能过旧。
 * 后端给了上下文窗口就显示它（标「后端」），注册表同样以它为准；没给的列出来，说明改用 models.dev。
 */

import { authHeaders, mergeHeaders } from "../../ai/http.js";
import { listChatGptModels } from "../../auth/chatgpt/backend-client.js";
import { CHATGPT_PROVIDER_ID, codexClientVersion } from "../../auth/chatgpt/presets.js";
import { liveToken } from "../../auth/oauth/live.js";
import { discoverLocalModels, materializeModel } from "../../ai/providers/registry.js";
import {
  thinkingMapOf,
  writeDiscoveredCache,
  type DiscoveredCacheModel,
} from "../../ai/providers/discovered-cache.js";
import { withCustomDefaults } from "../../ai/providers/catalog.js";
import { describeModelsDev, loadModelsDevIndex } from "../../ai/providers/models-dev-cache.js";
import { matchLabel, modelsDevFields } from "../../ai/providers/models-dev.js";
import type { Api, Model, ProviderData, ProviderRegistryApi } from "../../ai/types.js";
import { existsSync } from "node:fs";
import { loadConfigFile } from "../../config/load.js";
import type { AmaConfig, ModelConfig } from "../../config/types.js";
import { writeConfigFile } from "../../config/write.js";
import { UsageError } from "../args.js";
import { msg } from "../../i18n/index.js";
import { ExitCode } from "../exit-codes.js";
import { compactTokens } from "./model-meta.js";
import {
  describeProbePlan,
  parseProbeTuning,
  ProbeProgress,
  ProbeScheduler,
} from "./probe-runner.js";
import type { ModelsAction, ModelsActionContext } from "./models.js";

export const DISCOVER_TIMEOUT_MS = 15_000;
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
  options: { timeoutMs?: number; codexClientVersion?: string } = {},
): Promise<Model[]> {
  const timeoutMs = options.timeoutMs ?? DISCOVER_TIMEOUT_MS;
  if (provider.id === CHATGPT_PROVIDER_ID && apiKey !== undefined) {
    const live = liveToken(apiKey);
    const flavor = live?.flavor ?? (provider.defaultChannel === "codex" ? "codex" : "siwc");
    const channel = provider.channels?.find((c) => c.name === flavor);
    const models = await listChatGptModels(fetch, channel?.baseUrl ?? provider.baseUrl, {
      flavor,
      accessToken: apiKey,
      accountId: live?.accountId,
      originator: channel?.headers?.["originator"],
      clientVersion: options.codexClientVersion,
    });
    return models.map((m) => {
      const model = withCustomDefaults({ id: m.id }, provider.id, provider.api);
      if (m.name !== undefined) model.name = m.name;
      if (m.contextWindow !== undefined) model.contextWindow = m.contextWindow;
      if (m.input !== undefined) model.input = m.input;
      if (m.reasoningLevels?.some((x) => x !== "none") === true) {
        model.reasoning = true;
        model.thinkingLevelMap = thinkingMapOf(m.reasoningLevels);
      }
      return model;
    });
  }
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
  /** 同时在途的模型数（每个模型内按协议顺序依次试）；缺省 6。 */
  concurrency?: number;
  /** 测试用：429 重试前的退避。 */
  retryDelayMs?: number;
  /** 每次请求后回调。 */
  onAttempt?: (id: string, api: Api, error: string | undefined) => void;
  /** 每个模型探完立即回调（按完成顺序，进度用）。 */
  onSettled?: () => void;
  /** 每个模型探完回调，按模型顺序（不按完成顺序）。 */
  onResult?: (id: string, api: Api | undefined) => void;
  /** 因鉴权失败或限流提前停止时回调。 */
  onStop?: (reason: string) => void;
}

/**
 * 返回已探测模型 → 第一个成功的协议（都失败为 undefined）；超出 `limit` 或因提前停止没探完的不在表里。
 * 模型之间并发（有界），同一模型内按协议顺序依次试，第一个成功即停。
 */
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
  const selected = ids.slice(0, Math.max(0, limit));
  const scheduler = new ProbeScheduler(registry, key.apiKey, {
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    retryDelayMs: options.retryDelayMs,
  });
  type Found = { complete: boolean; api: Api | undefined };
  const done: (Found | undefined)[] = [];
  let printed = 0;
  await scheduler.run(
    selected.length,
    async (index): Promise<Found> => {
      const id = selected[index] as string;
      const known = provider.models.find((m) => m.id === id);
      for (const api of order) {
        const model: Model =
          known !== undefined
            ? { ...known, api }
            : materializeModel(withCustomDefaults({ id }, provider.id, api), provider);
        const outcome = await scheduler.probe(model);
        if (outcome.aborted) return { complete: false, api: undefined };
        options.onAttempt?.(id, api, outcome.error);
        if (outcome.error === undefined) return { complete: true, api };
        if (scheduler.stopped !== undefined) return { complete: false, api: undefined };
      }
      return { complete: true, api: undefined };
    },
    (index, found) => {
      done[index] = found;
      options.onSettled?.();
      // 按模型顺序交出结果：前面的都完成了才输出
      while (printed < selected.length && done[printed] !== undefined) {
        const entry = done[printed] as Found;
        const id = selected[printed] as string;
        if (entry.complete) {
          result.set(id, entry.api);
          options.onResult?.(id, entry.api);
        }
        printed++;
      }
    },
  );
  if (scheduler.stopped !== undefined) options.onStop?.(scheduler.stopped);
  return result;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PROBE_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new UsageError(msg().subcommands.discover.limitPositive(raw));
  return n;
}

/** 把新条目合并进用户级 config.json；返回写入条数。 */
function writeEntries(
  ctx: ModelsActionContext,
  provider: ProviderData,
  entries: ModelConfig[],
  notes: { noTools: ReadonlySet<string>; unmatched: ReadonlySet<string> },
): number {
  const { io } = ctx;
  const m = msg().subcommands.discover;
  const path = ctx.level.userConfigPath;
  const config: AmaConfig = structuredClone(
    loadConfigFile("config", path)?.value ?? { version: 1 },
  );
  const providers = (config.providers ??= {});
  if (providers[provider.id] === undefined && !provider.builtin) {
    io.stderr(m.notInUserConfig(provider.id, path));
    return 0;
  }
  const target = (providers[provider.id] ??= {});
  const models = (target.models ??= []);
  const existing = new Set([...models.map((m) => m.id), ...provider.models.map((m) => m.id)]);
  const added = entries.filter((entry) => !existing.has(entry.id));
  const kept = entries.length - added.length;
  if (added.length === 0) {
    io.stdout(m.nothingToWrite(kept));
    return 0;
  }
  models.push(...added);
  const backup = existsSync(path);
  writeConfigFile(path, config, { backup: true });
  io.stdout(m.written(path, provider.id, added.length, kept, backup));
  if (notes.noTools.size > 0) io.stdout(m.skippedNoTools([...notes.noTools].join(", ")));
  const blind = added.filter((entry) => notes.unmatched.has(entry.id)).map((entry) => entry.id);
  if (blind.length > 0) io.stderr(m.unmatchedWarning(blind.join(", ")));
  return added.length;
}

async function run(ctx: ModelsActionContext): Promise<number> {
  const { io, registry } = ctx;
  const m = msg().subcommands.discover;
  const id = ctx.args[0] ?? "";
  const limit = parseLimit(ctx.values.get("limit"));
  const provider = registry.get(id);
  if (provider === undefined) {
    io.stderr(msg().subcommands.common.providerNotFound(id));
    return ExitCode.NoModel;
  }
  const key = await registry.resolveApiKey(provider.id);
  if (key.apiKey === undefined && provider.requiresApiKey) {
    io.stderr(msg().subcommands.common.noApiKey(provider.id));
    return ExitCode.NoModel;
  }
  let found: Model[];
  try {
    found = await discoverModels(provider, key.apiKey, {
      codexClientVersion: codexClientVersion(ctx.level.merged.config.auth?.chatgpt, io.env),
    });
  } catch (error) {
    io.stderr(m.listFailed(provider.id, (error as Error).message));
    return ExitCode.RuntimeError;
  }
  const configured = new Map(provider.models.map((m) => [m.id, m]));
  io.stdout(m.found(provider.id, found.length, modelsUrl(provider)));
  if (provider.id === CHATGPT_PROVIDER_ID) cacheChatGpt(ctx, found, key.apiKey);
  // models.dev 只读本地（快照 ⊕ `ama models refresh` 的覆盖），不联网。
  const mdIndex = loadModelsDevIndex(ctx.level.dataDir);
  io.stdout(`${describeModelsDev(ctx.level.dataDir)}\n`);
  const noTools = new Set<string>();
  const unmatched = new Set<string>();
  for (const model of found) {
    const known = configured.get(model.id);
    const match = mdIndex.match(model.id);
    const fields = match !== undefined ? modelsDevFields(match.model) : undefined;
    if (fields?.toolCall === false) noTools.add(model.id);
    if (match === undefined) unmatched.add(model.id);
    // 后端给的上下文窗口优先于 models.dev（订阅后端的生效窗口可能远小于 API 版）
    const backendCtx =
      model.contextWindow !== undefined
        ? `  ctx ${compactTokens(model.contextWindow)}${m.fromBackend}`
        : undefined;
    const meta =
      fields === undefined
        ? `${backendCtx ?? ""}${m.unmatched}`
        : `${backendCtx ?? `  ctx ${compactTokens(fields.contextWindow)}`} · out ${compactTokens(fields.maxTokens)}` +
          `${fields.input?.includes("image") ? m.image : ""}${fields.reasoning ? m.reasoning : ""}` +
          `${fields.toolCall === false ? m.noTools : ""} · ${matchLabel(match)}`;
    io.stdout(`  ${model.id}${known !== undefined ? m.configured(known.api) : ""}${meta}\n`);
  }
  if (provider.id === CHATGPT_PROVIDER_ID) {
    const missing = found.filter((x) => x.contextWindow === undefined).map((x) => x.id);
    if (missing.length > 0) io.stdout(m.noBackendWindow(missing.join(", ")));
  }
  const write = ctx.flags.has("write");
  if (!ctx.flags.has("probe") || provider.id === CHATGPT_PROVIDER_ID) {
    if (write)
      writeEntries(
        ctx,
        provider,
        found.filter((m) => !noTools.has(m.id)).map((m) => ({ id: m.id })),
        { noTools, unmatched },
      );
    return ExitCode.Ok;
  }
  const ids = found.map((m) => m.id);
  const count = Math.min(limit, ids.length);
  const order = probeOrder(provider);
  const tuning = parseProbeTuning(ctx.values);
  io.stdout(
    m.probeHeader(count, order.join(" → "), count * order.length, ids.length - count, limit) +
      `${describeProbePlan(count * order.length, tuning.concurrency, tuning.timeoutMs)}\n`,
  );
  let stopped: string | undefined;
  const progress = new ProbeProgress(io.stdout, io.stdoutIsTTY, count);
  const probed = await probeModelApis(registry, provider, ids, limit, {
    ...tuning,
    onSettled: () => progress.tick(),
    onResult: (modelId, api) => progress.line(`  ${modelId}  ${api ?? m.unavailable}\n`),
    onStop: (reason) => (stopped = reason),
  });
  progress.finish();
  if (write) {
    const entries: ModelConfig[] = [];
    for (const [modelId, api] of probed) {
      if (api !== undefined && !noTools.has(modelId))
        entries.push(api === provider.api ? { id: modelId } : { id: modelId, api });
    }
    writeEntries(ctx, provider, entries, { noTools, unmatched });
  }
  if (stopped !== undefined) {
    io.stderr(m.probeStopped(stopped));
    return ExitCode.RuntimeError;
  }
  return ExitCode.Ok;
}

/** 发现得到的模型 → 缓存条目（后端给的元数据一并写入；推理强度由映射表还原）。 */
function cacheEntry(m: Model): DiscoveredCacheModel {
  const entry: DiscoveredCacheModel = { id: m.id };
  if (m.name !== m.id) entry.name = m.name;
  if (m.contextWindow !== undefined) entry.contextWindow = m.contextWindow;
  if (m.input.length !== 1 || m.input[0] !== "text") entry.input = [...m.input];
  if (m.reasoning && m.thinkingLevelMap !== undefined)
    entry.reasoningLevels = Object.entries(m.thinkingLevelMap).flatMap(([level, value]) =>
      typeof value !== "string" ? [] : level === "off" ? ["none"] : [level],
    );
  return entry;
}

/**
 * chatgpt 的发现结果写进发现缓存（选择器与注册表读它；0 个也写，免得残留另一 flavor 的缓存）；写失败不影响
 * 列表输出。codex 返回 0 个时提示 codexClientVersion 可能过旧。
 */
function cacheChatGpt(ctx: ModelsActionContext, found: Model[], apiKey: string | undefined): void {
  const flavor = liveToken(apiKey)?.flavor;
  try {
    const models = found.map(cacheEntry);
    const path = writeDiscoveredCache(ctx.level.dataDir, CHATGPT_PROVIDER_ID, { models, flavor });
    ctx.io.stdout(msg().subcommands.discover.cached(path));
  } catch (error) {
    ctx.io.stderr(`ama: ${(error as Error).message}\n`);
  }
  if (found.length === 0 && flavor === "codex") {
    const version = codexClientVersion(ctx.level.merged.config.auth?.chatgpt, ctx.io.env);
    ctx.io.stderr(`${msg().auth.login.codexNoModels(version)}\n`);
  }
}

export const DISCOVER_ACTION: ModelsAction = {
  usage:
    "ama models discover <provider> [--probe] [--write] [--limit <n>] [--concurrency <n>] [--probe-timeout <ms>]",
  required: "<provider>",
  valueOptions: ["limit", "concurrency", "probe-timeout"],
  flagOptions: ["probe", "write"],
  run,
};
