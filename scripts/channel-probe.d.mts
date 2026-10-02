/** scripts/channel-probe.mjs 的类型（测试用）。 */

export const MAX_REQUESTS_PER_MODEL: number;

export interface ProbeStep {
  status: "pass" | "fail" | "skip" | "n/a";
  note?: string;
  ids?: string[];
  thinkingBlocks?: number;
  signed?: number;
  cacheRead?: number;
  prefixTokens?: number;
  firstWrite?: number;
  reported?: boolean;
}

export interface ProbeResult {
  ref: string;
  channel: string | undefined;
  api: string | undefined;
  host: string | undefined;
  check: ProbeStep;
  tools: ProbeStep;
  thinking: ProbeStep;
  cache: ProbeStep;
  toolIds: string[];
  idsUnique: boolean | undefined;
  requests: number;
  usd: number;
  pass: boolean;
  error: string | undefined;
}

export interface ProbeRegistry {
  findModel(ref: string): unknown;
  resolveApiKey(provider: string, channel?: string): Promise<{ apiKey: string | undefined }>;
  getApi(api: string): unknown;
}

export function probeModel(options: {
  registry: ProbeRegistry;
  ref: string;
  gapMs?: number;
  maxRequests?: number;
  budget?: { usd: number; budgetUsd: number };
  timeoutMs?: number;
}): Promise<ProbeResult>;

export function renderTable(results: readonly ProbeResult[]): string;
export function fixedPrefix(tokens?: number): string;
export function usageUsd(usage: unknown): number;
