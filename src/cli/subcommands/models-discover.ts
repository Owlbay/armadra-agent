/**
 * `ama models discover <provider>`（第三波 §2.3）：问中转站有哪些模型。[W3-B12]
 *
 * GET `{baseUrl}/models`（anthropic-messages 且 baseUrl 不以 `/v1` 结尾时为 `{baseUrl}/v1/models`），
 * 带供应商的鉴权头，打印 id 列表并标出已配置的条目。
 *
 * `--probe`：同一中转下不同模型支持的协议不同，对每个 id 依次试供应商协议 → completions →
 * responses → messages（去重），各发一次最小请求（`ama models check` 同款，maxTokens 16），
 * 记第一个成功的协议；每模型最多 3 次请求，`--limit`（缺省 30）限制探测的模型数，执行前打印
 * 预估；401 / 403 / 429 立即停止（key 无效或被限流，继续只会浪费请求）。
 *
 * `--write`：新条目合并进用户级 config.json 的 `providers.<id>.models`——已有同 id 不覆盖；只写
 * `id` 与探到的 `api`（与供应商协议相同时省略）；带 `--probe` 时只写探测成功的模型。不猜
 * `contextWindow`（自动压缩随之关闭，输出 warning）。写前备份为 `config.json.bak`。
 *
 * models.dev：列表之后按需刷新缓存（24 小时内不重拉），每个模型标出上下文、输出、图片、工具调用与
 * 匹配结果；`--write` 跳过 models.dev 标明不支持工具调用的模型。元数据不写进配置——运行时从缓存补。
 */

import { authHeaders, mergeHeaders } from "../../ai/http.js";
import { discoverLocalModels, materializeModel } from "../../ai/providers/registry.js";
import { withCustomDefaults } from "../../ai/providers/catalog.js";
import { describeRefresh, refreshModelsDev } from "../../ai/providers/models-dev-cache.js";
import { matchLabel, modelsDevFields } from "../../ai/providers/models-dev.js";
import type { Api, Model, ProviderData, ProviderRegistryApi } from "../../ai/types.js";
import { existsSync } from "node:fs";
import { loadConfigFile } from "../../config/load.js";
import type { AmaConfig, ModelConfig } from "../../config/types.js";
import { writeConfigFile } from "../../config/write.js";
import { UsageError } from "../args.js";
import { ExitCode } from "../exit-codes.js";
import { compactTokens } from "./model-meta.js";
import type { ModelsAction, ModelsActionContext } from "./models.js";

export const DISCOVER_TIMEOUT_MS = 15_000;
export const PROBE_TIMEOUT_MS = 30_000;
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

export function probeOrder(provider: ProviderData): Api[] {
  return PROBE_APIS.includes(provider.api)
    ? [provider.api, ...PROBE_APIS.filter((api) => api !== provider.api)]
    : [...PROBE_APIS];
}

export interface ProbeOptions {
  timeoutMs?: number;
  /** 每次请求后回调。 */
  onAttempt?: (id: string, api: Api, error: string | undefined) => void;
  /** 每个模型探完回调（进度输出）。 */
  onResult?: (id: string, api: Api | undefined) => void;
  /** 因鉴权失败或限流提前停止时回调。 */
  onStop?: (reason: string) => void;
}

export const FATAL_STATUS = /^(?:HTTP )?(?:401|403|429)\b/;

/** 返回已探测模型 → 第一个成功的协议（都失败为 undefined）；超出 `limit` 或提前停止的不在表里。 */
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
  for (const id of ids.slice(0, Math.max(0, limit))) {
    const known = provider.models.find((m) => m.id === id);
    let found: Api | undefined;
    for (const api of order) {
      const model: Model =
        known !== undefined
          ? { ...known, api }
          : materializeModel(withCustomDefaults({ id }, provider.id, api), provider);
      const error = await attempt(registry, model, key.apiKey, options.timeoutMs);
      options.onAttempt?.(id, api, error);
      if (error === undefined) {
        found = api;
        break;
      }
      if (FATAL_STATUS.test(error)) {
        options.onStop?.(error);
        return result;
      }
    }
    result.set(id, found);
    options.onResult?.(id, found);
  }
  return result;
}

/** 一次最小请求；成功返回 undefined，失败返回错误文本（`ama providers add --probe` 也用）。 */
export async function attempt(
  registry: ProviderRegistryApi,
  model: Model,
  apiKey: string | undefined,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<string | undefined> {
  const impl = registry.getApi(model.api);
  if (impl === undefined) return `协议 ${model.api} 尚未实现`;
  try {
    const message = await impl
      .stream(
        model,
        { messages: [{ role: "user", content: "Reply with: ok", timestamp: Date.now() }] },
        {
          signal: AbortSignal.timeout(timeoutMs),
          ...(apiKey !== undefined ? { apiKey } : {}),
          maxTokens: 16,
          cacheRetention: "none",
        },
      )
      .result();
    if (message.stopReason === "error" || message.stopReason === "aborted")
      return message.errorMessage ?? message.stopReason;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PROBE_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--limit 需要正整数：${raw}`);
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
  const path = ctx.level.userConfigPath;
  const config: AmaConfig = structuredClone(
    loadConfigFile("config", path)?.value ?? { version: 1 },
  );
  const providers = (config.providers ??= {});
  if (providers[provider.id] === undefined && !provider.builtin) {
    io.stderr(`ama: ${provider.id} 不在用户级配置（${path}）里，未写入\n`);
    return 0;
  }
  const target = (providers[provider.id] ??= {});
  const models = (target.models ??= []);
  const existing = new Set([...models.map((m) => m.id), ...provider.models.map((m) => m.id)]);
  const added = entries.filter((entry) => !existing.has(entry.id));
  const kept = entries.length - added.length;
  if (added.length === 0) {
    io.stdout(`\n没有新模型要写入${kept > 0 ? `（${kept} 个已存在，未覆盖）` : ""}\n`);
    return 0;
  }
  models.push(...added);
  const backup = existsSync(path);
  writeConfigFile(path, config, { backup: true });
  io.stdout(
    `\n已写入 ${path}：${provider.id} 新增 ${added.length} 个模型` +
      `${kept > 0 ? `，${kept} 个已存在未覆盖` : ""}${backup ? `（原文件备份为 ${path}.bak）` : ""}\n`,
  );
  if (notes.noTools.size > 0)
    io.stdout(`跳过不支持工具调用的模型（models.dev）：${[...notes.noTools].join(", ")}\n`);
  const blind = added.filter((entry) => notes.unmatched.has(entry.id)).map((entry) => entry.id);
  if (blind.length > 0)
    io.stderr(
      `ama: 警告：${blind.join(", ")} 在 models.dev 未匹配，没有 contextWindow，自动压缩关闭；` +
        `需要时在 config.json 里补上或写 modelsDev\n`,
    );
  return added.length;
}

async function run(ctx: ModelsActionContext): Promise<number> {
  const { io, registry } = ctx;
  const id = ctx.args[0] ?? "";
  const limit = parseLimit(ctx.values.get("limit"));
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
  const md = await refreshModelsDev({ dataDir: ctx.level.dataDir, env: io.env });
  io.stdout(`${describeRefresh(md)}\n`);
  if (md.warning !== undefined) io.stderr(`ama: 警告：${md.warning}\n`);
  const noTools = new Set<string>();
  const unmatched = new Set<string>();
  for (const model of found) {
    const known = configured.get(model.id);
    const match = md.index?.match(model.id);
    const fields = match !== undefined ? modelsDevFields(match.model) : undefined;
    if (fields?.toolCall === false) noTools.add(model.id);
    if (match === undefined) unmatched.add(model.id);
    const meta =
      fields === undefined
        ? "  models.dev 未匹配"
        : `  ctx ${compactTokens(fields.contextWindow)} · out ${compactTokens(fields.maxTokens)}` +
          `${fields.input?.includes("image") ? " · 图片" : ""}${fields.reasoning ? " · 思考" : ""}` +
          `${fields.toolCall === false ? " · 不支持工具调用" : ""} · ${matchLabel(match)}`;
    io.stdout(`  ${model.id}${known !== undefined ? `  已配置（${known.api}）` : ""}${meta}\n`);
  }
  const write = ctx.flags.has("write");
  if (!ctx.flags.has("probe")) {
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
  io.stdout(
    `\n探测协议：${count} 个模型（${order.join(" → ")}），最多 ${count * order.length} 次请求` +
      `${ids.length > count ? `；另有 ${ids.length - count} 个超出 --limit ${limit}，未探测` : ""}\n`,
  );
  let stopped: string | undefined;
  const probed = await probeModelApis(registry, provider, ids, limit, {
    onResult: (modelId, api) => io.stdout(`  ${modelId}  ${api ?? "不可用（三种协议均失败）"}\n`),
    onStop: (reason) => (stopped = reason),
  });
  if (write) {
    const entries: ModelConfig[] = [];
    for (const [modelId, api] of probed) {
      if (api !== undefined && !noTools.has(modelId))
        entries.push(api === provider.api ? { id: modelId } : { id: modelId, api });
    }
    writeEntries(ctx, provider, entries, { noTools, unmatched });
  }
  if (stopped !== undefined) {
    io.stderr(`ama: 探测提前停止（${stopped}）\n`);
    return ExitCode.RuntimeError;
  }
  return ExitCode.Ok;
}

export const DISCOVER_ACTION: ModelsAction = {
  usage: "ama models discover <provider> [--probe] [--write] [--limit <n>]",
  required: "<provider>",
  valueOptions: ["limit"],
  flagOptions: ["probe", "write"],
  run,
};
