/**
 * 缓存单测的记录构造器（只供 *.test.ts 使用）。[W3-C1b]
 */

import { calculateCost } from "../../ai/cost.js";
import type { ModelCost, Usage } from "../../ai/types.js";
import type { PrefixFingerprint, RequestRecord } from "../../ai/cache/types.js";

export const SONNET_COST: ModelCost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

export const BASE_FINGERPRINT: PrefixFingerprint = {
  system: "aaaaaaaaaaaaaaaa",
  tools: "bbbbbbbbbbbbbbbb",
  model: "anthropic/claude-sonnet-5-5",
};

export interface RecordSpec {
  at?: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  cost?: ModelCost | null;
  cacheReported?: boolean;
  fingerprint?: Partial<PrefixFingerprint>;
  provider?: string;
  model?: string;
  baseUrl?: string;
  purpose?: RequestRecord["purpose"];
}

export function record(spec: RecordSpec = {}): RequestRecord {
  const usage: Usage = {
    input: spec.input ?? 0,
    output: spec.output ?? 10,
    cacheRead: spec.cacheRead ?? 0,
    cacheWrite: spec.cacheWrite ?? 0,
    totalTokens: 0,
  };
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  if (spec.cacheReported !== undefined) usage.cacheReported = spec.cacheReported;
  const cost = spec.cost === null ? undefined : (spec.cost ?? SONNET_COST);
  calculateCost(cost === undefined ? {} : { cost }, usage);
  const provider = spec.provider ?? "anthropic";
  const id = spec.model ?? "claude-sonnet-5-5";
  return {
    at: spec.at ?? 0,
    purpose: spec.purpose ?? "turn",
    model: { provider, id },
    api: "anthropic-messages",
    baseUrl: spec.baseUrl ?? "https://api.anthropic.com",
    fingerprint: { ...BASE_FINGERPRINT, model: `${provider}/${id}`, ...spec.fingerprint },
    promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    usage,
    contextRef: { messages: [] },
    options: {},
  };
}
