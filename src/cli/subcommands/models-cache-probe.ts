/**
 * `ama models cache-probe <provider/model>`（第三波 §1.11）：这个端点报不报缓存。[W3-C2]
 *
 * 固定前缀（system 一段确定性的编号句子，按字符 / 4 估到 `--tokens`，缺省 2048）+ user
 * `Reply with: ok`，`maxTokens` 16、`cacheRetention: "short"`、`purpose: "probe"`，相隔 `--gap-ms`
 * 发两次。判定：第二次 cacheRead ≥ 第一次前缀的 50% → `reported`；两次读写都是 0 → `silent`
 * （字段缺失或恒 0）；其余（读到一点、只有写入）→ `inconclusive`（粒度或 TTL 问题）。
 *
 * 计费动作：执行前打印预估（两次 × `--tokens` × 目录输入价，无价 `$?`）；非 TTY 必须 `--yes`
 * （否则退出 2），TTY 下方向键选一次「继续 / 取消」（choice-prompt.ts）。`--json` 时预估写 stderr，stdout 只有一个结果对象。
 * 协议层不保留原始响应，「usage 字段」列的是该协议解析时读取的字段名。
 */

import { priceTokens } from "../../ai/cost.js";
import type { Api, Message, Model, Usage } from "../../ai/types.js";
import { UsageError } from "../args.js";
import { confirmContinue } from "../choice-prompt.js";
import { ExitCode } from "../exit-codes.js";
import type { ModelsAction, ModelsActionContext } from "./models.js";
import { msg } from "../../i18n/index.js";

export const PROBE_DEFAULT_TOKENS = 2048;
export const PROBE_DEFAULT_GAP_MS = 3000;
export const PROBE_REQUEST_TIMEOUT_MS = 60_000;

export type ProbeVerdict = "reported" | "silent" | "inconclusive";

export interface ProbeSample {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** 原始响应里出现过缓存字段（含 0）；协议没给出时 undefined。 */
  cacheReported: boolean | undefined;
  promptTokens: number;
}

/** 各协议解析缓存用量时读取的字段（`parseOpenAIUsage` 等）。 */
export const USAGE_FIELDS: Readonly<Partial<Record<Api, readonly string[]>>> = {
  "openai-completions": [
    "prompt_tokens_details.cached_tokens",
    "prompt_cache_hit_tokens",
    "cached_tokens",
    "prompt_tokens_details.cache_write_tokens",
  ],
  "openai-responses": ["input_tokens_details.cached_tokens"],
  "anthropic-messages": ["cache_read_input_tokens", "cache_creation_input_tokens"],
  "google-generative-ai": ["usageMetadata.cachedContentTokenCount"],
};

/** 确定性前缀：编号句子，字符数 ≈ tokens × 4。 */
export function probePrefix(tokens: number): string {
  const lines: string[] = [];
  let chars = 0;
  for (let i = 1; chars < tokens * 4; i++) {
    const line = `Reference line ${i}: cache probe filler text that stays byte-identical between requests.`;
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.join("\n");
}

export function sampleOf(usage: Usage): ProbeSample {
  return {
    input: usage.input,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cacheReported: usage.cacheReported,
    promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
  };
}

export function judgeProbe(first: ProbeSample, second: ProbeSample): ProbeVerdict {
  if (first.promptTokens > 0 && second.cacheRead >= first.promptTokens * 0.5) return "reported";
  const any = first.cacheRead + first.cacheWrite + second.cacheRead + second.cacheWrite;
  return any === 0 ? "silent" : "inconclusive";
}

export function probeAdvice(
  verdict: ProbeVerdict,
  model: Model,
  samples: readonly ProbeSample[] = [],
): string | undefined {
  const t = msg().subcommands.cacheProbe;
  if (verdict === "silent") {
    // 实测：同一中转的 Kimi 间隔 3 s 两次都是 0、间隔更久才命中——字段存在时提示写入延迟的可能
    const present = samples.some((s) => s.cacheReported === true);
    return t.adviceSilent(model.provider, present);
  }
  if (verdict === "inconclusive") return t.adviceInconclusive;
  if (model.promptCache === undefined) return t.advicePromptCache(model.provider, model.id);
  return undefined;
}

function intOption(ctx: ModelsActionContext, name: string, fallback: number, min: number): number {
  const raw = ctx.values.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min)
    throw new UsageError(msg().subcommands.cacheProbe.intAtLeast(name, min));
  return value;
}

function sampleLine(index: number, s: ProbeSample): string {
  const t = msg().subcommands.cacheProbe;
  const field = s.cacheReported === undefined ? "?" : s.cacheReported ? t.yes : t.no;
  return t.sample(index, s.input, s.cacheRead, s.cacheWrite, field);
}

async function run(ctx: ModelsActionContext): Promise<number> {
  const { io, registry } = ctx;
  const ref = ctx.args[0] ?? "";
  const tokens = intOption(ctx, "tokens", PROBE_DEFAULT_TOKENS, 1);
  const gapMs = intOption(ctx, "gap-ms", PROBE_DEFAULT_GAP_MS, 0);
  const json = ctx.flags.has("json");
  const found = registry.findModel(ref);
  if (!found.ok) {
    io.stderr(msg().subcommands.common.modelNotFound(ref));
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
  const estimate = priceTokens(model, { input: tokens * 2, output: 32 });
  const name = `${provider.id}/${model.id}`;
  const t = msg().subcommands.cacheProbe;
  const cost = estimate === undefined ? "$?" : `$${estimate.toFixed(4)}`;
  const head = t.head(name, model.api, tokens, gapMs, cost);
  (json ? io.stderr : io.stdout)(head);
  if (!ctx.flags.has("yes")) {
    if (!io.stdinIsTTY) {
      io.stderr(t.needsYes);
      return ExitCode.Usage;
    }
    if (!(await confirmContinue({ env: io.env }))) {
      io.stderr(msg().subcommands.common.cancelled);
      return ExitCode.Ok;
    }
  }
  const messages: Message[] = [
    { role: "system", sections: { probe: probePrefix(tokens) }, timestamp: 0 },
    { role: "user", content: "Reply with: ok", timestamp: 0 },
  ];
  const samples: ProbeSample[] = [];
  for (let i = 0; i < 2; i++) {
    if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    const message = await api
      .stream(
        model,
        { messages },
        {
          signal: AbortSignal.timeout(PROBE_REQUEST_TIMEOUT_MS),
          ...(key.apiKey !== undefined ? { apiKey: key.apiKey } : {}),
          maxTokens: 16,
          cacheRetention: "short",
          purpose: "probe",
        },
      )
      .result();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      io.stderr(t.requestFailed(i + 1, message.errorMessage ?? message.stopReason));
      return ExitCode.RuntimeError;
    }
    samples.push(sampleOf(message.usage));
  }
  const [first, second] = samples as [ProbeSample, ProbeSample];
  const verdict = judgeProbe(first, second);
  const advice = probeAdvice(verdict, model, samples);
  const fields = USAGE_FIELDS[model.api] ?? [];
  if (json) {
    const result = {
      model: name,
      api: model.api,
      tokens,
      gapMs,
      estimatedCostUsd: estimate ?? null,
      requests: samples,
      usageFields: fields,
      verdict,
      ...(advice !== undefined ? { advice } : {}),
    };
    io.stdout(`${JSON.stringify(result)}\n`);
    return ExitCode.Ok;
  }
  const share =
    first.promptTokens > 0
      ? t.share(Math.round((second.cacheRead / first.promptTokens) * 100))
      : "";
  io.stdout(
    [
      sampleLine(1, first),
      sampleLine(2, second),
      ...(fields.length > 0 ? [t.usageFields(model.api, fields)] : []),
      t.verdict(verdict, share),
      ...(advice !== undefined ? [t.advice(advice)] : []),
    ].join("\n") + "\n",
  );
  return ExitCode.Ok;
}

export const CACHE_PROBE_ACTION: ModelsAction = {
  usage: "ama models cache-probe <provider/id> [--tokens 2048] [--gap-ms 3000] [--json] [--yes]",
  required: "<provider/id>",
  valueOptions: ["tokens", "gap-ms"],
  flagOptions: ["json", "yes"],
  run,
};
