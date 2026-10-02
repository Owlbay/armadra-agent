/**
 * `ama providers add|refresh --probe` 的逐渠道探测：任务是「模型 × 渠道」，有界并发执行（见
 * probe-runner.ts）；每个模型的所有渠道探完后按模型顺序打印一行，不按完成顺序。
 */

import { withCustomDefaults } from "../../ai/providers/catalog.js";
import { materializeModel } from "../../ai/providers/registry.js";
import type { ProviderData, ProviderRegistryApi } from "../../ai/types.js";
import type { CliIo } from "../deps.js";
import type { CandidateChannel } from "./providers-plan.js";
import { ProbeProgress, ProbeScheduler, type ProbeOutcome } from "./probe-runner.js";

export interface ChannelProbeResult {
  /** 探测成功的渠道（按渠道尝试顺序）。 */
  ok: string[];
  /** 最后一个失败渠道的原因（首行，≤ 120 字符）。 */
  error?: string;
}

export interface ChannelProbeInput {
  io: Pick<CliIo, "stdout" | "stderr" | "stdoutIsTTY">;
  providerId: string;
  ids: readonly string[];
  /** 每个模型要试的渠道名（顺序即输出顺序）。 */
  channelsFor: (id: string) => readonly string[];
  candidates: readonly CandidateChannel[];
  registry: ProviderRegistryApi;
  apiKey: string | undefined;
  concurrency: number;
  timeoutMs: number;
  /** 测试用：429 重试前的退避。 */
  retryDelayMs?: number;
}

/** 渠道的探测用供应商数据（key 由调用方传入）。 */
function probeProvider(id: string, channel: CandidateChannel): ProviderData {
  return {
    id,
    name: id,
    api: channel.api,
    baseUrl: channel.baseUrl,
    envKeys: [],
    models: [],
    requiresApiKey: true,
    builtin: false,
  };
}

const firstLine = (error: string): string => error.split("\n")[0]?.slice(0, 120) ?? error;

/**
 * 探测全部「模型 × 渠道」。返回有结论的模型（全部渠道探完，或因停止没探完但已有成功渠道）与停止原因。
 */
export async function probeChannels(
  input: ChannelProbeInput,
): Promise<{ results: Map<string, ChannelProbeResult>; stopped?: string }> {
  const { io } = input;
  const tasks = input.ids.flatMap((id) => input.channelsFor(id).map((name) => ({ id, name })));
  const pending = new Map(input.ids.map((id) => [id, input.channelsFor(id).length]));
  const outcomes = new Map<string, ProbeOutcome>();
  const results = new Map<string, ChannelProbeResult>();
  const progress = new ProbeProgress(io.stdout, io.stdoutIsTTY, tasks.length);
  const scheduler = new ProbeScheduler(input.registry, input.apiKey, {
    concurrency: input.concurrency,
    timeoutMs: input.timeoutMs,
    retryDelayMs: input.retryDelayMs,
    onThrottle: (n) => progress.line(`  遇到 429 限流，并发降到 ${n}，稍后重试一次\n`),
    onRecover: (n) => progress.line(`  一段时间没再限流，并发回升到 ${n}\n`),
  });
  let printed = 0;
  /** 按模型顺序输出：前面的模型都探完才输出后面的。 */
  const flush = (final: boolean): void => {
    while (printed < input.ids.length) {
      const id = input.ids[printed] as string;
      if (!final && (pending.get(id) ?? 0) > 0) return;
      printed++;
      const result: ChannelProbeResult = { ok: [] };
      const failed: string[] = [];
      let complete = true;
      for (const name of input.channelsFor(id)) {
        const outcome = outcomes.get(`${id}\n${name}`);
        if (outcome === undefined || outcome.aborted) complete = false;
        else if (outcome.error === undefined) result.ok.push(name);
        else {
          result.error = firstLine(outcome.error);
          failed.push(`${name}：${result.error}`);
        }
      }
      if (!complete && result.ok.length === 0) continue;
      results.set(id, result);
      progress.line(
        `  ${id}  ${result.ok.length > 0 ? result.ok.join(", ") : "全部失败"}` +
          `${failed.length > 0 ? `（失败 ${failed.join("；")}）` : ""}` +
          `${complete ? "" : "（探测提前停止，部分渠道未探）"}\n`,
      );
    }
  };
  await scheduler.run(
    tasks.length,
    async (index) => {
      const { id, name } = tasks[index] as { id: string; name: string };
      const channel = input.candidates.find((c) => c.name === name) as CandidateChannel;
      const provider = probeProvider(input.providerId, channel);
      const model = materializeModel(
        withCustomDefaults({ id }, input.providerId, channel.api),
        provider,
      );
      return scheduler.probe(model);
    },
    (index, outcome) => {
      const { id, name } = tasks[index] as { id: string; name: string };
      outcomes.set(`${id}\n${name}`, outcome);
      pending.set(id, (pending.get(id) ?? 1) - 1);
      if (!outcome.aborted) progress.tick();
      flush(false);
    },
  );
  flush(true);
  progress.finish();
  const stopped = scheduler.stopped;
  return { results, ...(stopped !== undefined ? { stopped } : {}) };
}
