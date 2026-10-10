/**
 * `ama providers add|list|channels|remove|refresh`（docs/guides/providers.md「一键接入」「渠道」）。
 *
 * - add：只给 baseUrl 与 key，列出中转的模型（`GET /models`）、用 models.dev 补元数据、可选逐渠道
 *   探测，把渠道与模型追加进用户级 config.json（先备份）；key 从 stdin 读（不回显）存 auth.json，
 *   或 `--key-env VAR` 写 `"apiKey": "$VAR"`。对已存在的供应商只追加，不改已有条目。
 * - refresh：重拉 `/models` 与 models.dev，只追加新模型；已下架的只提示。
 * - list / channels：供应商 → 渠道 → 模型数与 key 来源（从不显示 key）。remove：删配置与 auth.json 条目。
 *
 * 计费：`--probe` 每模型每渠道一次最小请求（并发执行，见到首个流事件即判可用并断开，见
 * probe-runner.ts）；执行前打印预估，TTY 下方向键选「继续 / 取消」（choice-prompt.ts，y / n 直选），非 TTY 必须 `--yes`。
 */

import { existsSync } from "node:fs";
import { describeModelsDev, loadModelsDevIndex } from "../../ai/providers/models-dev-cache.js";
import { modelsDevFields, type ModelsDevIndex } from "../../ai/providers/models-dev.js";
import type { ProviderRegistryApi } from "../../ai/types.js";
import { PROVIDER_ID_PATTERN, setAuthKey } from "../../config/auth-file.js";
import { loadConfigFile } from "../../config/load.js";
import type { AmaConfig, ProviderConfig } from "../../config/types.js";
import { CONFIG_FILE_VERSION } from "../../config/types.js";
import { writeConfigFile } from "../../config/write.js";
import { parseSubArgs, UsageError } from "../args.js";
import { confirmContinue } from "../choice-prompt.js";
import { pickByPrice } from "../default-model.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { ExitCode } from "../exit-codes.js";
import { extractKey } from "./auth.js";
import { listChannels, listProviders, removeProvider } from "./providers-list.js";
import { buildRegistry, loadUserLevel, type UserLevel } from "./context.js";
import { DISCOVER_TIMEOUT_MS } from "./models-discover.js";
import { describeProbePlan, parseProbeTuning } from "./probe-runner.js";
import { probeChannels, type ChannelProbeResult } from "./providers-probe.js";
import {
  DEFAULT_PREFER,
  capRequests,
  defaultChannels,
  hintedChannels,
  listingTarget,
  mergeProvider,
  orderChannels,
  parseChannelSpec,
  parseModelList,
  probeSelection,
  renderTable,
  type CandidateChannel,
  type ListedModel,
  type ModelPlan,
} from "./providers-plan.js";
import { msg } from "../../i18n/index.js";

export const DEFAULT_MAX_REQUESTS = 60;
export const DEFAULT_LIMIT = 30;

export function providersUsage(): string {
  return msg().subcommands.providers.usage;
}

const VALUE_OPTIONS = [
  "base-url",
  "api",
  "key-env",
  "limit",
  "probe-models",
  "max-requests",
  "concurrency",
  "probe-timeout",
  "prefer",
  "name",
  "profile",
  "auth-file",
];
const FLAG_OPTIONS = ["probe", "include-no-tools", "yes"];

export interface Ctx {
  io: CliIo;
  deps: Pick<RuntimeDeps, "providers">;
  level: UserLevel;
  values: ReadonlyMap<string, string>;
  flags: ReadonlySet<string>;
  channelSpecs: string[];
}

function intValue(ctx: Ctx, name: string, fallback: number): number {
  const raw = ctx.values.get(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new UsageError(msg().subcommands.providers.positiveInt(name, raw));
  return n;
}

function list(raw: string | undefined): string[] | undefined {
  return raw
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function userConfig(level: UserLevel): AmaConfig {
  return structuredClone(
    loadConfigFile("config", level.userConfigPath)?.value ?? { version: CONFIG_FILE_VERSION },
  );
}

async function confirm(io: CliIo, question: string): Promise<boolean> {
  io.stderr(question);
  return confirmContinue({ env: io.env });
}

/** --yes / TTY 确认；非 TTY 且没有 --yes 返回 false 并提示（调用方退出 2）。 */
async function approved(ctx: Ctx, what: string): Promise<boolean | "usage"> {
  if (ctx.flags.has("yes")) return true;
  if (!ctx.io.stdinIsTTY) {
    ctx.io.stderr(msg().subcommands.providers.needsYes(what));
    return "usage";
  }
  return confirm(ctx.io, `${what}\n`);
}

/**
 * `GET /models`。OpenAI 系带 `Authorization: Bearer`；Anthropic 形状的渠道先试 Bearer（中转多半只认它），
 * 401 / 403 再试 `x-api-key` + `anthropic-version`（官方形状）。
 */
async function fetchModelList(
  target: { channel: CandidateChannel; url: string },
  apiKey: string | undefined,
): Promise<ListedModel[]> {
  const get = (headers: Record<string, string>): Promise<Response> =>
    fetch(target.url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
    });
  let response = await get(apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : {});
  if (
    (response.status === 401 || response.status === 403) &&
    apiKey !== undefined &&
    target.channel.api === "anthropic-messages"
  )
    response = await get({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${target.url}`);
  return parseModelList(await response.json());
}

function channelsOfConfig(config: ProviderConfig): CandidateChannel[] {
  if (config.channels !== undefined)
    return Object.entries(config.channels).map(([name, c]) => ({
      name,
      api: c.api,
      baseUrl: c.baseUrl,
    }));
  if (config.baseUrl === undefined) return [];
  const api = config.api ?? "openai-completions";
  return [{ name: "default", api, baseUrl: config.baseUrl }];
}

interface PlanInput {
  id: string;
  candidates: CandidateChannel[];
  listed: ListedModel[];
  index: ModelsDevIndex | undefined;
  existingIds: ReadonlySet<string>;
  apiKey: string | undefined;
  registry: ProviderRegistryApi;
  probe: boolean;
}

/** 逐模型定渠道（含探测）；返回各模型的计划与是否因鉴权 / 限流提前停止。 */
async function plan(
  ctx: Ctx,
  input: PlanInput,
): Promise<{ plans: ModelPlan[]; stopped?: string; cancelled?: number }> {
  const { io } = ctx;
  const prefer = list(ctx.values.get("prefer")) ?? [...DEFAULT_PREFER];
  const byId = new Map(input.listed.map((m) => [m.id, m]));
  const fresh = input.listed.filter((m) => !input.existingIds.has(m.id));
  const hint = (id: string): string[] | undefined => {
    const listed = byId.get(id);
    return listed !== undefined ? hintedChannels(listed, input.candidates) : undefined;
  };
  const tryChannels = (id: string): string[] =>
    orderChannels(hint(id) ?? input.candidates.map((c) => c.name), prefer);
  const probeable = (id: string): boolean => tryChannels(id).length > 0;
  const results = new Map<string, ChannelProbeResult>();
  let stopped: string | undefined;
  if (input.probe) {
    const only = list(ctx.values.get("probe-models"));
    const selected = probeSelection(
      fresh.map((m) => m.id).filter(probeable),
      intValue(ctx, "limit", DEFAULT_LIMIT),
      only,
    );
    const max = intValue(ctx, "max-requests", DEFAULT_MAX_REQUESTS);
    const capped = capRequests(selected, tryChannels, max);
    const tuning = parseProbeTuning(ctx.values);
    io.stdout(
      msg().subcommands.providers.probePlan(
        capped.ids.length,
        capped.requests,
        max,
        capped.dropped,
      ) + `${describeProbePlan(capped.requests, tuning.concurrency, tuning.timeoutMs)}\n`,
    );
    const ok = await approved(
      ctx,
      msg().subcommands.providers.confirmProbe(capped.requests, ctx.level.userConfigPath),
    );
    if (ok === "usage") return { plans: [], cancelled: ExitCode.Usage };
    if (!ok) return { plans: [], cancelled: ExitCode.Ok };
    const probed = await probeChannels({
      io,
      providerId: input.id,
      ids: capped.ids,
      channelsFor: tryChannels,
      candidates: input.candidates,
      registry: input.registry,
      apiKey: input.apiKey,
      ...tuning,
    });
    for (const [id, result] of probed.results) results.set(id, result);
    stopped = probed.stopped;
  }
  const includeNoTools = ctx.flags.has("include-no-tools");
  const plans: ModelPlan[] = input.listed.map((listed) => {
    const match = input.index?.match(listed.id);
    const fields = match !== undefined ? modelsDevFields(match.model) : {};
    const base = { id: listed.id, fields, match };
    if (input.existingIds.has(listed.id)) return { ...base, channels: [], status: "existing" };
    const probed = results.get(listed.id);
    if (probed !== undefined) {
      if (probed.ok.length === 0)
        return {
          ...base,
          channels: [],
          status: "failed",
          ...(probed.error ? { error: probed.error } : {}),
        };
      return { ...base, channels: orderChannels(probed.ok, prefer), status: "ok" };
    }
    const hinted = hint(listed.id);
    if (hinted !== undefined && hinted.length === 0)
      return { ...base, channels: [], status: "no-channel" };
    const channels =
      hinted !== undefined
        ? orderChannels(hinted, prefer)
        : orderChannels(
            input.candidates.map((c) => c.name),
            prefer,
          ).slice(0, 1);
    if (fields.toolCall === false && !includeNoTools)
      return { ...base, channels, status: "no-tools" };
    return { ...base, channels, status: "unprobed" };
  });
  for (const p of plans)
    if (p.status === "ok" && p.fields.toolCall === false && !includeNoTools) p.status = "no-tools";
  return { plans, ...(stopped !== undefined ? { stopped } : {}) };
}

async function obtainKey(
  ctx: Ctx,
  id: string,
  registry: ProviderRegistryApi,
): Promise<{ apiKey: string | undefined; configValue?: string; store?: string }> {
  const keyEnv = ctx.values.get("key-env");
  if (keyEnv !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv))
      throw new UsageError(msg().subcommands.providers.invalidKeyEnv(keyEnv));
    const value = ctx.io.env[keyEnv]?.trim();
    if (!value) ctx.io.stderr(msg().subcommands.providers.keyEnvUnset(keyEnv));
    return { apiKey: value || undefined, configValue: `$${keyEnv}` };
  }
  if (registry.get(id) !== undefined) {
    const existing = await registry.resolveApiKey(id);
    if (existing.apiKey !== undefined) return { apiKey: existing.apiKey };
  }
  if (ctx.io.stdinIsTTY) ctx.io.stderr(msg().subcommands.providers.keyPrompt(id));
  const key = extractKey(await ctx.io.readStdin());
  if (ctx.io.stdinIsTTY) ctx.io.stderr("\n");
  if (key === "") throw new UsageError(msg().subcommands.providers.noKeyOnStdin);
  return { apiKey: key, store: key };
}

async function add(ctx: Ctx, id: string, refresh: boolean): Promise<number> {
  const { io, level } = ctx;
  const m = msg().subcommands.providers;
  if (!PROVIDER_ID_PATTERN.test(id) || id.includes("@")) throw new UsageError(m.invalidId(id));
  const config = userConfig(level);
  const existing = config.providers?.[id];
  if (refresh && existing === undefined) {
    io.stderr(m.missingInConfig(level.userConfigPath, id));
    return ExitCode.Usage;
  }
  const registry = await buildRegistry(level, io, ctx.deps);
  let candidates: CandidateChannel[];
  if (refresh) candidates = channelsOfConfig(existing as ProviderConfig);
  else if (ctx.channelSpecs.length > 0) candidates = ctx.channelSpecs.map(parseChannelSpec);
  else {
    const baseUrl = ctx.values.get("base-url");
    if (baseUrl === undefined) throw new UsageError(m.needsBaseUrl);
    if (!/^https?:\/\//.test(baseUrl)) throw new UsageError(m.baseUrlNotHttp(baseUrl));
    candidates = defaultChannels(baseUrl, ctx.values.get("api"));
  }
  const target = listingTarget(candidates);
  if (target === undefined) throw new UsageError(m.noChannel(id));
  const key = await obtainKey(ctx, id, registry);
  let listed: ListedModel[];
  try {
    listed = await fetchModelList(target, key.apiKey);
  } catch (error) {
    io.stderr(m.listFailed(id, (error as Error).message));
    return ExitCode.RuntimeError;
  }
  io.stdout(m.discovered(id, listed.length, target.url));
  // models.dev 只读本地（快照 ⊕ `ama models refresh` 的覆盖），不联网。
  const mdIndex = loadModelsDevIndex(level.dataDir);
  io.stdout(`${describeModelsDev(level.dataDir)}\n`);
  io.stdout(m.candidates(candidates));
  const existingIds = new Set((existing?.models ?? []).map((m) => m.id));
  const result = await plan(ctx, {
    id,
    candidates,
    listed,
    index: mdIndex,
    existingIds,
    apiKey: key.apiKey,
    registry,
    probe: ctx.flags.has("probe"),
  });
  if (result.cancelled !== undefined) return result.cancelled;
  io.stdout(`\n${renderTable(result.plans)}`);
  if (refresh) {
    const gone = [...existingIds].filter((m) => !listed.some((l) => l.id === m));
    if (gone.length > 0) io.stdout(m.goneUpstream(gone));
  }
  const writable = result.plans.filter((p) => p.status === "ok" || p.status === "unprobed");
  const legacy = existing !== undefined && existing.channels === undefined;
  const merged =
    legacy && refresh
      ? legacyMerge(
          existing,
          writable.map((p) => p.id),
        )
      : mergeProvider(legacy ? asChannels(existing) : existing, {
          ...(ctx.values.get("name") !== undefined
            ? { name: ctx.values.get("name") as string }
            : {}),
          ...(key.configValue !== undefined ? { apiKey: key.configValue } : {}),
          channels: candidates,
          models: writable,
          prefer: list(ctx.values.get("prefer")) ?? [...DEFAULT_PREFER],
        });
  // 还没有缺省模型时按价格规则挑一个写进 defaultModel（default-model.ts 的 pickByPrice）；
  // 探测过时只在探测通过的模型里挑
  const verified = writable.filter((p) => p.status === "ok");
  const defaultPick =
    level.merged.config.defaultModel === undefined && config.defaultModel === undefined
      ? pickByPrice(
          (verified.length > 0 ? verified : writable).map((p) => ({
            id: p.id,
            contextWindow: p.fields.contextWindow,
            inputCost: p.fields.cost?.input,
            toolCall: p.fields.toolCall,
          })),
        )
      : undefined;
  io.stdout(
    m.writeSummary({
      path: level.userConfigPath,
      id,
      channels: merged.addedChannels,
      models: merged.addedModels.length,
      authFile: key.store !== undefined ? level.authFile : undefined,
      defaultModel: defaultPick !== undefined ? `${id}/${defaultPick.id}` : undefined,
    }),
  );
  if (defaultPick !== undefined) io.stdout(m.defaultPick(defaultPick.id, defaultPick.reason));
  else if (level.merged.config.defaultModel === undefined && writable.length > 0)
    io.stdout(m.noDefaultPick);
  if (
    merged.addedModels.length === 0 &&
    merged.addedChannels.length === 0 &&
    key.store === undefined
  ) {
    io.stdout(m.nothingToWrite);
    return result.stopped !== undefined ? ExitCode.RuntimeError : ExitCode.Ok;
  }
  if (!ctx.flags.has("probe")) {
    const ok = await approved(ctx, m.confirmWrite);
    if (ok === "usage") return ExitCode.Usage;
    if (!ok) {
      io.stderr(msg().subcommands.common.cancelled);
      return ExitCode.Ok;
    }
  }
  const providers = (config.providers ??= {});
  providers[id] = merged.config;
  if (defaultPick !== undefined) config.defaultModel = `${id}/${defaultPick.id}`;
  const backup = existsSync(level.userConfigPath);
  writeConfigFile(level.userConfigPath, config, { backup: true });
  if (key.store !== undefined) setAuthKey(level.authFile, id, key.store);
  io.stdout(m.written(level.userConfigPath, backup));
  const sample =
    defaultPick?.id ??
    result.plans.find((p) => p.status === "ok" && merged.addedModels.includes(p.id))?.id ??
    merged.addedModels[0];
  if (sample !== undefined) io.stdout(m.tryIt(`${id}/${sample}`));
  if (result.stopped !== undefined) {
    io.stderr(m.probeStopped(result.stopped));
    return ExitCode.RuntimeError;
  }
  return ExitCode.Ok;
}

/** 旧写法（无 channels）的供应商：先把供应商级 api + baseUrl 变成 `default` 渠道。 */
function asChannels(config: ProviderConfig): ProviderConfig {
  const { api, baseUrl, ...rest } = structuredClone(config);
  if (baseUrl === undefined) return rest;
  return {
    ...rest,
    channels: { default: { api: api ?? "openai-completions", baseUrl } },
    defaultChannel: "default",
  };
}

/** 旧写法供应商的 refresh：只追加 `{ id }`。 */
function legacyMerge(
  config: ProviderConfig,
  ids: readonly string[],
): ReturnType<typeof mergeProvider> {
  const next = structuredClone(config);
  const models = (next.models ??= []);
  const known = new Set(models.map((m) => m.id));
  const addedModels = ids.filter((id) => !known.has(id));
  for (const id of addedModels) models.push({ id });
  return { config: next, addedChannels: [], addedModels };
}

/** `--channel` 可重复：先从 argv 里取出来，其余交给 parseSubArgs。 */
function takeChannels(argv: readonly string[]): { rest: string[]; specs: string[] } {
  const rest: string[] = [];
  const specs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--channel") {
      const value = argv[++i];
      if (value === undefined || value === "")
        throw new UsageError(msg().subcommands.providers.channelNeedsValue);
      specs.push(value);
    } else if (token.startsWith("--channel=")) specs.push(token.slice("--channel=".length));
    else rest.push(token);
  }
  return { rest, specs };
}

export async function runProviders(
  argv: readonly string[],
  io: CliIo,
  deps: Pick<RuntimeDeps, "providers"> | undefined,
): Promise<number> {
  const { rest, specs } = takeChannels(argv);
  const { positionals, values, flags } = parseSubArgs(rest, VALUE_OPTIONS, FLAG_OPTIONS);
  const action = positionals[0];
  if (flags.has("help") || action === undefined) {
    io.stdout(providersUsage());
    return flags.has("help") ? ExitCode.Ok : ExitCode.Usage;
  }
  if (deps === undefined) {
    io.stderr(msg().subcommands.common.notAssembled("providers"));
    return ExitCode.RuntimeError;
  }
  const level = loadUserLevel(io, {
    profile: values.get("profile"),
    authFile: values.get("auth-file"),
  });
  for (const warning of level.warnings) io.stderr(msg().subcommands.common.warning(warning));
  const ctx: Ctx = { io, deps, level, values, flags, channelSpecs: specs };
  const target = positionals[1];
  const need = (): string => {
    if (target === undefined)
      throw new UsageError(msg().subcommands.common.needsArg(`ama providers ${action}`, "<id>"));
    if (positionals.length > 2)
      throw new UsageError(msg().subcommands.common.extraArgs(positionals.slice(2).join(" ")));
    return target;
  };
  switch (action) {
    case "add":
      return add(ctx, need(), false);
    case "refresh":
      return add(ctx, need(), true);
    case "list":
      return listProviders(ctx);
    case "channels":
      return listChannels(ctx, need());
    case "remove":
      return removeProvider(ctx, need());
    default:
      throw new UsageError(msg().subcommands.common.unknownSubcommand("providers", action));
  }
}
