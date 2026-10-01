/**
 * `ama models list [--provider <id>]`、`ama models check <provider/id>`（设计 §1.2、R6）。[B5]
 *
 * 注册表经 RuntimeDeps.providers 注入（B1）。check 发一次最小调用（一条 user 消息、
 * maxTokens 16、超时 30 s），只报告成败与 stopReason，不输出 key。
 */

import type { ProviderRegistryApi } from "../../ai/types.js";
import { parseSubArgs, UsageError } from "../args.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { ExitCode } from "../exit-codes.js";
import { buildRegistry, loadUserLevel } from "./context.js";

export const MODELS_USAGE = `用法：ama models list [--provider <id>]
      ama models check <provider/id>
`;

export const CHECK_TIMEOUT_MS = 30_000;

function compact(n: number | undefined): string {
  if (n === undefined) return "?";
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

async function list(
  io: CliIo,
  registry: ProviderRegistryApi,
  only: string | undefined,
): Promise<number> {
  const providers = registry.list().filter((p) => only === undefined || p.id === only);
  if (only !== undefined && providers.length === 0) {
    io.stderr(`ama: 供应商不存在：${only}\n`);
    return ExitCode.NoModel;
  }
  for (const provider of providers) {
    const key = await registry.resolveApiKey(provider.id);
    const keyText =
      key.apiKey !== undefined
        ? `key：${key.source}${key.origin !== undefined ? `（${key.origin}）` : ""}`
        : provider.requiresApiKey
          ? "无 key"
          : "无需 key";
    io.stdout(`${provider.id}  ${provider.api}  ${keyText}\n`);
    for (const model of provider.models) {
      const flags = [
        `ctx ${compact(model.contextWindow)}`,
        `out ${compact(model.maxTokens)}`,
        model.reasoning ? "思考" : undefined,
        model.input.includes("image") ? "图片" : undefined,
      ].filter((x) => x !== undefined);
      io.stdout(`  ${provider.id}/${model.id}  ${flags.join(" · ")}\n`);
    }
  }
  return ExitCode.Ok;
}

async function check(io: CliIo, registry: ProviderRegistryApi, ref: string): Promise<number> {
  const found = registry.findModel(ref);
  if (!found.ok) {
    const hint =
      found.candidates.length > 0 ? `；候选：${found.candidates.slice(0, 10).join(", ")}` : "";
    io.stderr(`ama: 模型不存在：${ref}${hint}\n`);
    return ExitCode.NoModel;
  }
  const { model, provider } = found;
  const key = await registry.resolveApiKey(provider.id);
  if (key.apiKey === undefined && provider.requiresApiKey) {
    io.stderr(`ama: ${provider.id} 没有 API key（ama auth set ${provider.id}）\n`);
    return ExitCode.NoModel;
  }
  const api = registry.getApi(model.api);
  if (api === undefined) {
    io.stderr(`ama: 协议 ${model.api} 尚未实现\n`);
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
      `ama: ${provider.id}/${model.id} 失败（${ms} ms）：${message.errorMessage ?? message.stopReason}\n`,
    );
    return ExitCode.RuntimeError;
  }
  io.stdout(`${provider.id}/${model.id} 可用（${ms} ms，stopReason ${message.stopReason}）\n`);
  return ExitCode.Ok;
}

export async function runModels(
  argv: readonly string[],
  io: CliIo,
  deps: Pick<RuntimeDeps, "providers"> | undefined,
): Promise<number> {
  const { positionals, values, flags } = parseSubArgs(argv, ["provider", "profile", "auth-file"]);
  const action = positionals[0];
  if (flags.has("help") || action === undefined) {
    io.stdout(MODELS_USAGE);
    return flags.has("help") ? ExitCode.Ok : ExitCode.Usage;
  }
  if (action !== "list" && action !== "check")
    throw new UsageError(`未知的 models 子命令：${action}`);
  const ref = positionals[1];
  if (action === "check" && ref === undefined)
    throw new UsageError("ama models check 需要 <provider/id>");
  if (deps === undefined) {
    io.stderr("ama: models 尚未装配（供应商注册表由集成批次注入）\n");
    return ExitCode.RuntimeError;
  }
  const level = loadUserLevel(io, {
    profile: values.get("profile"),
    authFile: values.get("auth-file"),
  });
  for (const warning of level.warnings) io.stderr(`ama: 警告：${warning}\n`);
  const registry = await buildRegistry(level, io, deps);
  return action === "list"
    ? list(io, registry, values.get("provider"))
    : check(io, registry, ref ?? "");
}
