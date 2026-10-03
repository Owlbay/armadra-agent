/**
 * `ama models list [--provider <id>]`、`ama models check <provider/id>`（设计 §1.2、R6）。[B5]
 *
 * 注册表经 RuntimeDeps.providers 注入（B1）。check 发一次最小调用（一条 user 消息、
 * maxTokens 16、超时 30 s），只报告成败与 stopReason，不输出 key。
 *
 * [W3-C0] 子命令分派改为动作表 `MODELS_ACTIONS`（第三波 §1.11 / §2.3）：新动作（C2 的
 * `cache-probe`、B12 的 `discover`）各写在自己的文件里，这里只加一行表项；用法文本、
 * 选项表与必填位置参数都从表里来。
 *
 * [W5-M1] `refresh`：models.dev 显式刷新（`refresh-catalog` 保留为别名）。
 *
 * `enable` / `disable` / `list --enabled`：模型选择器清单 `models.enabled`（models-enable.ts）。
 */

import { formatModelRef, modelRefOf } from "../../ai/providers/channels.js";
import {
  describeRefresh,
  modelsDevCachePath,
  refreshModelsDev,
} from "../../ai/providers/models-dev-cache.js";
import { snapshotMeta } from "../../ai/providers/models-dev-snapshot.js";
import type { ProviderRegistryApi } from "../../ai/types.js";
import { parseSubArgs, UsageError } from "../args.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { ExitCode } from "../exit-codes.js";
import { buildRegistry, loadUserLevel, type UserLevel } from "./context.js";
import { CACHE_PROBE_ACTION } from "./models-cache-probe.js";
import { DISCOVER_ACTION } from "./models-discover.js";
import { DISABLE_ACTION, ENABLE_ACTION, listEnabled } from "./models-enable.js";
import { metadataOf, modelFlags, sourcesLine } from "./model-meta.js";
import { msg } from "../../i18n/index.js";

/** 动作执行时拿到的上下文（参数已按表解析、注册表已构造）。 */
export interface ModelsActionContext {
  io: CliIo;
  registry: ProviderRegistryApi;
  /** 用户级（+ profile）配置；写配置的动作（`discover --write`）要用 `userConfigPath`。 */
  level: UserLevel;
  /** 动作名之后的位置参数。 */
  args: readonly string[];
  values: ReadonlyMap<string, string>;
  flags: ReadonlySet<string>;
}

export interface ModelsAction {
  /** 用法行（不含「ama models 」前缀之前的「用法：」）。 */
  usage: string;
  /** 带值选项（不含共用的 --profile / --auth-file）。 */
  valueOptions?: readonly string[];
  /** 布尔选项。 */
  flagOptions?: readonly string[];
  /** 必填的第一个位置参数，缺失时报「ama models <动作> 需要 <required>」。 */
  required?: string;
  run(ctx: ModelsActionContext): Promise<number>;
}

const COMMON_VALUE_OPTIONS = ["profile", "auth-file"] as const;

export const CHECK_TIMEOUT_MS = 30_000;

async function list(
  io: CliIo,
  registry: ProviderRegistryApi,
  only: string | undefined,
): Promise<number> {
  const providers = registry.list().filter((p) => only === undefined || p.id === only);
  if (only !== undefined && providers.length === 0) {
    io.stderr(msg().subcommands.common.providerNotFound(only));
    return ExitCode.NoModel;
  }
  for (const provider of providers) {
    const key = await registry.resolveApiKey(provider.id);
    const t = msg().subcommands.models;
    const keyText =
      key.apiKey !== undefined
        ? t.keyFrom(key.source, key.origin)
        : provider.requiresApiKey
          ? t.noKey
          : t.keyNotNeeded;
    io.stdout(`${provider.id}  ${provider.api}  ${keyText}\n`);
    for (const channel of provider.channels ?? [])
      io.stdout(`  @${channel.name}  ${channel.api}  ${channel.baseUrl}\n`);
    for (const model of provider.models) {
      io.stdout(`  ${provider.id}/${model.id}  ${modelFlags(model)}\n`);
      const sources = sourcesLine(metadataOf(registry, provider.id, model.id));
      if (sources !== undefined) io.stdout(`      ${sources}\n`);
    }
  }
  return ExitCode.Ok;
}

async function check(io: CliIo, registry: ProviderRegistryApi, ref: string): Promise<number> {
  const found = registry.findModel(ref);
  if (!found.ok) {
    io.stderr(msg().subcommands.common.modelNotFound(ref, found.candidates.slice(0, 10)));
    return ExitCode.NoModel;
  }
  const { model, provider } = found;
  const key = await registry.resolveApiKey(provider.id, model.channel);
  if (key.apiKey === undefined && provider.requiresApiKey) {
    io.stderr(msg().subcommands.common.noApiKey(provider.id));
    return ExitCode.NoModel;
  }
  const api = registry.getApi(model.api);
  if (api === undefined) {
    io.stderr(msg().subcommands.common.apiNotImplemented(model.api));
    return ExitCode.RuntimeError;
  }
  const started = Date.now();
  const stream = api.stream(
    model,
    { messages: [{ role: "user", content: "Reply with: ok", timestamp: Date.now() }] },
    {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      ...(key.apiKey !== undefined ? { apiKey: key.apiKey } : {}),
      maxTokens: 16,
      cacheRetention: "none",
    },
  );
  const message = await stream.result();
  const ms = Date.now() - started;
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    io.stderr(
      msg().subcommands.models.checkFailed(
        `${provider.id}/${model.id}`,
        ms,
        message.errorMessage ?? message.stopReason,
      ),
    );
    return ExitCode.RuntimeError;
  }
  const shown = formatModelRef(modelRefOf(model));
  io.stdout(msg().subcommands.models.checkOk(shown, model.api, ms, message.stopReason));
  return ExitCode.Ok;
}

/**
 * `ama models refresh [--provider <id>[,<id>…]]`：显式联网拉 models.dev，按内置快照的清单裁剪，
 * 写用户级覆盖 `<dataDir>/models-dev.json`（docs/providers.md「模型元数据」）。启动与其它命令不联网。
 */
const REFRESH_ACTION: ModelsAction = {
  usage: "ama models refresh [--provider <id>[,<id>…]]",
  valueOptions: ["provider"],
  run: async (ctx) => {
    const only = ctx.values.get("provider");
    const providers = only
      ?.split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    ctx.io.stdout(msg().subcommands.models.refreshing(snapshotMeta().fetchedAt));
    const result = await refreshModelsDev({
      dataDir: ctx.level.dataDir,
      env: ctx.io.env,
      ...(providers !== undefined && providers.length > 0 ? { providers } : {}),
    });
    if (result.warning !== undefined) ctx.io.stderr(`ama: ${result.warning}\n`);
    ctx.io.stdout(`${describeRefresh(result)}\n`);
    if (result.status === "failed") return ExitCode.RuntimeError;
    ctx.io.stdout(msg().subcommands.models.written(modelsDevCachePath(ctx.level.dataDir)));
    return ExitCode.Ok;
  },
};

/** 动作表：键是子命令名，顺序即用法文本顺序。 */
export const MODELS_ACTIONS: Readonly<Record<string, ModelsAction>> = Object.freeze({
  list: {
    usage: "ama models list [--provider <id>] [--enabled]",
    valueOptions: ["provider"],
    flagOptions: ["enabled"],
    run: (ctx) =>
      ctx.flags.has("enabled")
        ? listEnabled(ctx)
        : list(ctx.io, ctx.registry, ctx.values.get("provider")),
  },
  check: {
    usage: "ama models check <provider/id>",
    required: "<provider/id>",
    run: (ctx) => check(ctx.io, ctx.registry, ctx.args[0] ?? ""),
  },
  discover: DISCOVER_ACTION,
  "cache-probe": CACHE_PROBE_ACTION,
  refresh: REFRESH_ACTION,
  // 用法行按界面语言取，用 getter（模块级求值会按 import 时的语言定死）
  "refresh-catalog": {
    ...REFRESH_ACTION,
    get usage(): string {
      return msg().subcommands.models.refreshCatalogUsage;
    },
  },
  enable: ENABLE_ACTION,
  disable: DISABLE_ACTION,
});

export function modelsUsage(): string {
  return msg().subcommands.models.usage(Object.values(MODELS_ACTIONS).map((a) => a.usage));
}

function unique(lists: readonly (readonly string[] | undefined)[]): string[] {
  return [...new Set(lists.flatMap((l) => l ?? []))];
}

export async function runModels(
  argv: readonly string[],
  io: CliIo,
  deps: Pick<RuntimeDeps, "providers"> | undefined,
): Promise<number> {
  const actions = Object.values(MODELS_ACTIONS);
  const { positionals, values, flags } = parseSubArgs(
    argv,
    unique([...actions.map((a) => a.valueOptions), COMMON_VALUE_OPTIONS]),
    unique(actions.map((a) => a.flagOptions)),
  );
  const name = positionals[0];
  if (flags.has("help") || name === undefined) {
    io.stdout(modelsUsage());
    return flags.has("help") ? ExitCode.Ok : ExitCode.Usage;
  }
  const action = Object.hasOwn(MODELS_ACTIONS, name) ? MODELS_ACTIONS[name] : undefined;
  if (action === undefined)
    throw new UsageError(msg().subcommands.common.unknownSubcommand("models", name));
  // 选项按全部动作的并集解析；这里再拒绝不属于本动作的（如 `list --json`）。
  for (const option of [...values.keys(), ...flags]) {
    const own = [
      ...COMMON_VALUE_OPTIONS,
      ...(action.valueOptions ?? []),
      ...(action.flagOptions ?? []),
    ];
    if (!own.includes(option)) throw new UsageError(msg().subcommands.common.unknownOption(option));
  }
  const args = positionals.slice(1);
  if (action.required !== undefined && args[0] === undefined)
    throw new UsageError(msg().subcommands.common.needsArg(`ama models ${name}`, action.required));
  if (deps === undefined) {
    io.stderr(msg().subcommands.common.notAssembled("models"));
    return ExitCode.RuntimeError;
  }
  const level = loadUserLevel(io, {
    profile: values.get("profile"),
    authFile: values.get("auth-file"),
  });
  for (const warning of level.warnings) io.stderr(msg().subcommands.common.warning(warning));
  const registry = await buildRegistry(level, io, deps);
  return action.run({ io, registry, level, args, values, flags });
}
