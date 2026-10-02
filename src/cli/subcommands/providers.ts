/**
 * `ama providers add|list|channels|remove|refresh`（docs/providers.md「一键接入」「渠道」）。
 *
 * - add：只给 baseUrl 与 key，列出中转的模型（`GET /models`）、用 models.dev 补元数据、可选逐渠道
 *   探测，把渠道与模型追加进用户级 config.json（先备份）；key 从 stdin 读（不回显）存 auth.json，
 *   或 `--key-env VAR` 写 `"apiKey": "$VAR"`。对已存在的供应商只追加，不改已有条目。
 * - refresh：重拉 `/models` 与 models.dev，只追加新模型；已下架的只提示。
 * - list / channels：供应商 → 渠道 → 模型数与 key 来源（从不显示 key）。remove：删配置与 auth.json 条目。
 *
 * 计费：`--probe` 每模型每渠道一次最小请求（并发执行，见到首个流事件即判可用并断开，见
 * probe-runner.ts）；执行前打印预估，TTY 问 y/N，非 TTY 必须 `--yes`。
 */

import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { describeModelsDev, loadModelsDevIndex } from "../../ai/providers/models-dev-cache.js";
import { modelsDevFields, type ModelsDevIndex } from "../../ai/providers/models-dev.js";
import type { ProviderRegistryApi } from "../../ai/types.js";
import { PROVIDER_ID_PATTERN, setAuthKey } from "../../config/auth-file.js";
import { loadConfigFile } from "../../config/load.js";
import type { AmaConfig, ProviderConfig } from "../../config/types.js";
import { CONFIG_FILE_VERSION } from "../../config/types.js";
import { writeConfigFile } from "../../config/write.js";
import { parseSubArgs, UsageError } from "../args.js";
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

export const DEFAULT_MAX_REQUESTS = 60;
export const DEFAULT_LIMIT = 30;

export const PROVIDERS_USAGE = `用法：ama providers add <id> --base-url <url> [--channel <名字>=<协议>@<地址> …]
                         [--api openai-completions|openai-responses|anthropic-messages|auto]
                         [--key-env <VAR>] [--probe] [--limit N] [--probe-models a,b,…]
                         [--max-requests N] [--concurrency N] [--probe-timeout ms]
                         [--prefer chat,responses,messages] [--include-no-tools] [--yes]
      ama providers list
      ama providers channels <id>
      ama providers remove <id>
      ama providers refresh <id> [--probe] [--limit N] [--probe-models a,b,…] [--max-requests N]
                             [--concurrency N] [--probe-timeout ms] [--yes]
`;

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
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} 需要正整数：${raw}`);
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
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question("继续？[y/N] ")).trim());
  } finally {
    rl.close();
  }
}

/** --yes / TTY 确认；非 TTY 且没有 --yes 返回 false 并提示（调用方退出 2）。 */
async function approved(ctx: Ctx, what: string): Promise<boolean | "usage"> {
  if (ctx.flags.has("yes")) return true;
  if (!ctx.io.stdinIsTTY) {
    ctx.io.stderr(`ama: ${what}，非交互环境需加 --yes\n`);
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
      `\n探测：${capped.ids.length} 个模型、${capped.requests} 次最小请求（每模型每渠道 1 次，上限 ${max}）` +
        `${capped.dropped > 0 ? `；另有 ${capped.dropped} 个超出上限未探测` : ""}\n` +
        `${describeProbePlan(capped.requests, tuning.concurrency, tuning.timeoutMs)}\n`,
    );
    const ok = await approved(
      ctx,
      `将发 ${capped.requests} 次计费请求并写入 ${ctx.level.userConfigPath}`,
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
      throw new UsageError(`--key-env 不是合法的变量名：${keyEnv}`);
    const value = ctx.io.env[keyEnv]?.trim();
    if (!value) ctx.io.stderr(`ama: 警告：环境变量 ${keyEnv} 未设置，列模型与探测将不带 key\n`);
    return { apiKey: value || undefined, configValue: `$${keyEnv}` };
  }
  if (registry.get(id) !== undefined) {
    const existing = await registry.resolveApiKey(id);
    if (existing.apiKey !== undefined) return { apiKey: existing.apiKey };
  }
  if (ctx.io.stdinIsTTY) ctx.io.stderr(`输入 ${id} 的 API key（不回显），回车结束：`);
  const key = extractKey(await ctx.io.readStdin());
  if (ctx.io.stdinIsTTY) ctx.io.stderr("\n");
  if (key === "") throw new UsageError("没有从 stdin 读到 key（或用 --key-env <VAR>）");
  return { apiKey: key, store: key };
}

async function add(ctx: Ctx, id: string, refresh: boolean): Promise<number> {
  const { io, level } = ctx;
  if (!PROVIDER_ID_PATTERN.test(id) || id.includes("@"))
    throw new UsageError(`供应商 id 不合法：${id}`);
  const config = userConfig(level);
  const existing = config.providers?.[id];
  if (refresh && existing === undefined) {
    io.stderr(`ama: ${level.userConfigPath} 里没有供应商 ${id}（先 ama providers add）\n`);
    return ExitCode.Usage;
  }
  const registry = await buildRegistry(level, io, ctx.deps);
  let candidates: CandidateChannel[];
  if (refresh) candidates = channelsOfConfig(existing as ProviderConfig);
  else if (ctx.channelSpecs.length > 0) candidates = ctx.channelSpecs.map(parseChannelSpec);
  else {
    const baseUrl = ctx.values.get("base-url");
    if (baseUrl === undefined)
      throw new UsageError("ama providers add 需要 --base-url <url> 或 --channel");
    if (!/^https?:\/\//.test(baseUrl))
      throw new UsageError(`--base-url 应为 http(s) URL：${baseUrl}`);
    candidates = defaultChannels(baseUrl, ctx.values.get("api"));
  }
  const target = listingTarget(candidates);
  if (target === undefined) throw new UsageError(`${id} 没有可用的渠道`);
  const key = await obtainKey(ctx, id, registry);
  let listed: ListedModel[];
  try {
    listed = await fetchModelList(target, key.apiKey);
  } catch (error) {
    io.stderr(`ama: ${id} 模型列表获取失败：${(error as Error).message}\n`);
    return ExitCode.RuntimeError;
  }
  io.stdout(`${id}：发现 ${listed.length} 个模型（${target.url}）\n`);
  // models.dev 只读本地（快照 ⊕ `ama models refresh` 的覆盖），不联网。
  const mdIndex = loadModelsDevIndex(level.dataDir);
  io.stdout(`${describeModelsDev(level.dataDir)}\n`);
  io.stdout(
    `候选渠道：${candidates.map((c) => `${c.name}（${c.api} ${c.baseUrl}）`).join(" · ")}\n`,
  );
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
    if (gone.length > 0) io.stdout(`上游已不再列出（未删除）：${gone.join(", ")}\n`);
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
  const keyNote = key.store !== undefined ? `；key → ${level.authFile}（0600）` : "";
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
  const defaultNote = defaultPick !== undefined ? `；defaultModel → ${id}/${defaultPick.id}` : "";
  const summary =
    `\n将写入 ${level.userConfigPath}：${id} 新增渠道 ${merged.addedChannels.join(", ") || "无"}，` +
    `新增模型 ${merged.addedModels.length} 个${keyNote}${defaultNote}`;
  io.stdout(`${summary}\n`);
  if (defaultPick !== undefined) io.stdout(`  选 ${defaultPick.id}：${defaultPick.reason}\n`);
  else if (level.merged.config.defaultModel === undefined && writable.length > 0)
    io.stdout(
      "  未设置 defaultModel：没有同时支持工具调用、上下文 ≥ 64k 且有价格的模型；用 ama config edit 设置\n",
    );
  if (
    merged.addedModels.length === 0 &&
    merged.addedChannels.length === 0 &&
    key.store === undefined
  ) {
    io.stdout("没有要写入的内容\n");
    return result.stopped !== undefined ? ExitCode.RuntimeError : ExitCode.Ok;
  }
  if (!ctx.flags.has("probe")) {
    const ok = await approved(ctx, "确认写入");
    if (ok === "usage") return ExitCode.Usage;
    if (!ok) {
      io.stderr("ama: 已取消\n");
      return ExitCode.Ok;
    }
  }
  const providers = (config.providers ??= {});
  providers[id] = merged.config;
  if (defaultPick !== undefined) config.defaultModel = `${id}/${defaultPick.id}`;
  const backup = existsSync(level.userConfigPath);
  writeConfigFile(level.userConfigPath, config, { backup: true });
  if (key.store !== undefined) setAuthKey(level.authFile, id, key.store);
  io.stdout(`已写入 ${level.userConfigPath}${backup ? "（原文件备份为 config.json.bak）" : ""}\n`);
  const sample =
    defaultPick?.id ??
    result.plans.find((p) => p.status === "ok" && merged.addedModels.includes(p.id))?.id ??
    merged.addedModels[0];
  if (sample !== undefined) io.stdout(`试试：ama -p "hi" --model ${id}/${sample}\n`);
  if (result.stopped !== undefined) {
    io.stderr(`ama: 探测提前停止（${result.stopped}）\n`);
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
      if (value === undefined || value === "") throw new UsageError("--channel 需要一个值");
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
    io.stdout(PROVIDERS_USAGE);
    return flags.has("help") ? ExitCode.Ok : ExitCode.Usage;
  }
  if (deps === undefined) {
    io.stderr("ama: providers 尚未装配（供应商注册表由集成批次注入）\n");
    return ExitCode.RuntimeError;
  }
  const level = loadUserLevel(io, {
    profile: values.get("profile"),
    authFile: values.get("auth-file"),
  });
  for (const warning of level.warnings) io.stderr(`ama: 警告：${warning}\n`);
  const ctx: Ctx = { io, deps, level, values, flags, channelSpecs: specs };
  const target = positionals[1];
  const need = (): string => {
    if (target === undefined) throw new UsageError(`ama providers ${action} 需要 <id>`);
    if (positionals.length > 2)
      throw new UsageError(`多余的参数：${positionals.slice(2).join(" ")}`);
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
      throw new UsageError(`未知的 providers 子命令：${action}`);
  }
}
