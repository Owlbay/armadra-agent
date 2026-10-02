/**
 * `ama stats` 的单文件摘要（只读、按行）。[W4-D]
 *
 * 一个会话文件 → 若干「桶」：按（本地日期、请求来源 kind、provider、model、channel）累加。
 * - 请求来源：assistant 消息 = `turn`；`usage` 条目用自己的 `kind`（cache_warm、permission_classify…）；
 *   `compaction` / `branch_summary` 带的 usage 记为同名 kind（模型取最近一条 assistant 的）。
 * - token：input（不含缓存）/ output / cacheRead / cacheWrite；费用只累加有 `usage.cost` 的请求，
 *   `costed` 记有价请求数，展示层据此区分「有价」「部分无价」「全无价」。
 * - 缓存三态：桶记下是否出现过 cacheRead > 0 或 cacheWrite > 0（`cacheSeen`）；汇总时同一端点
 *   （provider/model@channel）任一桶出现过即算报告缓存，其余端点不进命中率分母（同会话层三态）。
 * - 回合：非 `steer` 的用户消息开始一个回合，到下一个回合开始为止；回合计入首条 assistant 的桶，
 *   耗时 = 最后一条 assistant 条目时间 − 用户消息条目时间（都是落盘时间戳）。没有 assistant 的回合不计。
 * - 工具调用：assistant 内容里的 toolCall 块按名字计（codemode 内层调用不展开）。
 * - 重试：`context_edit{reason:"retry"}` 计入当时最近一条 assistant 的桶；`stopReason:"error"` 计错误。
 * - toolResult、custom、label 等行按前缀跳过、不解析；末尾半行忽略；中间坏行跳过并计数。
 * - channel：最近一条 `model_change` 与该请求同 provider / model 时取它的 channel。
 */

import type { Usage } from "../ai/types.js";
import { forEachLine, lineType } from "./scan.js";

export interface StatsBucket {
  /** 本地日期 YYYY-MM-DD。 */
  day: string;
  kind: string;
  provider: string;
  model: string;
  channel?: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 有价请求的费用合计（美元）。 */
  cost: number;
  /** 有价请求数。 */
  costed: number;
  /** 出现过 cacheRead > 0 或 cacheWrite > 0。 */
  cacheSeen: boolean;
  errors: number;
  retries: number;
  turns: number;
  /** 有耗时的回合的耗时合计与个数。 */
  turnMs: number;
  timedTurns: number;
}

export interface FileStatsSummary {
  id: string;
  cwd: string;
  buckets: StatsBucket[];
  /** `[日期, 工具名, 次数]`。 */
  tools: Array<[string, string, number]>;
  /** 跳过的坏行数。 */
  badLines: number;
}

const SKIP_TYPES = new Set([
  "custom",
  "custom_message",
  "label",
  "leaf",
  "session_info",
  "thinking_level_change",
]);

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** ISO → 本地日期；不可解析 → undefined。 */
export function localDay(iso: unknown): string | undefined {
  if (typeof iso !== "string") return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

interface Turn {
  start: number;
  day: string;
  bucket?: StatsBucket;
  end?: number;
}

export function summarizeSessionFile(file: string): FileStatsSummary | undefined {
  let header: Rec | undefined;
  const buckets = new Map<string, StatsBucket>();
  const tools = new Map<string, number>();
  let badLines = 0;
  let channel: { provider: string; model: string; channel?: string } | undefined;
  let lastAssistant: { provider: string; model: string; channel?: string } | undefined;
  let lastBucket: StatsBucket | undefined;
  let turn: Turn | undefined;

  const bucketOf = (
    day: string,
    kind: string,
    ref: { provider: string; model: string; channel?: string },
  ): StatsBucket => {
    const key = `${day}\u0000${kind}\u0000${ref.provider}\u0000${ref.model}\u0000${ref.channel ?? ""}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        day,
        kind,
        provider: ref.provider,
        model: ref.model,
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        costed: 0,
        cacheSeen: false,
        errors: 0,
        retries: 0,
        turns: 0,
        turnMs: 0,
        timedTurns: 0,
      };
      if (ref.channel !== undefined) bucket.channel = ref.channel;
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const addUsage = (bucket: StatsBucket, usage: unknown): void => {
    bucket.requests++;
    if (!isRec(usage)) return;
    const u = usage as Partial<Usage>;
    bucket.input += num(u.input);
    bucket.output += num(u.output);
    bucket.cacheRead += num(u.cacheRead);
    bucket.cacheWrite += num(u.cacheWrite);
    if (num(u.cacheRead) > 0 || num(u.cacheWrite) > 0) bucket.cacheSeen = true;
    if (isRec(u.cost) && typeof u.cost["total"] === "number") {
      bucket.cost += num(u.cost["total"]);
      bucket.costed++;
    }
  };

  const refFor = (provider: string, model: string): { provider: string; model: string } => {
    const ref: { provider: string; model: string; channel?: string } = { provider, model };
    if (
      channel?.channel !== undefined &&
      channel.provider === provider &&
      channel.model === model
    ) {
      ref.channel = channel.channel;
    }
    return ref;
  };

  const closeTurn = (): void => {
    if (turn?.bucket !== undefined) {
      turn.bucket.turns++;
      if (turn.end !== undefined && turn.end >= turn.start) {
        turn.bucket.turnMs += turn.end - turn.start;
        turn.bucket.timedTurns++;
      }
    }
    turn = undefined;
  };

  try {
    forEachLine(file, (line, index, last) => {
      if (index > 0) {
        const quick = lineType(line);
        if (quick !== undefined) {
          if (SKIP_TYPES.has(quick.type)) return;
          if (quick.type === "message" && quick.role === "toolResult") return;
          if (quick.type === "message" && quick.role === "system") return;
        }
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        if (!last) badLines++;
        return;
      }
      if (!isRec(value)) return;
      if (index === 0) {
        if (value["type"] !== "session" || typeof value["cwd"] !== "string") return false;
        header = value;
        return;
      }
      const ts = value["timestamp"];
      const day = localDay(ts);
      if (day === undefined) return;
      switch (value["type"]) {
        case "model_change": {
          const ref: { provider: string; model: string; channel?: string } = {
            provider: String(value["provider"]),
            model: String(value["modelId"]),
          };
          if (typeof value["channel"] === "string") ref.channel = value["channel"];
          channel = ref;
          return;
        }
        case "message": {
          const message = value["message"];
          if (!isRec(message)) return;
          if (message["role"] === "user") {
            if (message["origin"] === "steer" && turn !== undefined) return;
            closeTurn();
            turn = { start: Date.parse(ts as string), day };
            return;
          }
          if (message["role"] !== "assistant") return;
          const ref = refFor(String(message["provider"]), String(message["model"]));
          lastAssistant = ref;
          const bucket = bucketOf(day, "turn", ref);
          lastBucket = bucket;
          addUsage(bucket, message["usage"]);
          if (message["stopReason"] === "error") bucket.errors++;
          const content = message["content"];
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                isRec(block) &&
                block["type"] === "toolCall" &&
                typeof block["name"] === "string"
              ) {
                const key = `${day}\u0000${block["name"]}`;
                tools.set(key, (tools.get(key) ?? 0) + 1);
              }
            }
          }
          if (turn !== undefined) {
            if (turn.bucket === undefined) turn.bucket = bucketOf(turn.day, "turn", ref);
            turn.end = Date.parse(ts as string);
          }
          return;
        }
        case "usage": {
          const ref = refFor(String(value["provider"]), String(value["model"]));
          addUsage(bucketOf(day, String(value["kind"] ?? "usage"), ref), value["usage"]);
          return;
        }
        case "compaction":
        case "branch_summary": {
          if (value["usage"] === undefined) return;
          const ref = lastAssistant ?? { provider: "?", model: "?" };
          addUsage(bucketOf(day, value["type"], ref), value["usage"]);
          return;
        }
        case "context_edit":
          if (value["reason"] === "retry" && lastBucket !== undefined) lastBucket.retries++;
          return;
        default:
          return;
      }
    });
  } catch {
    return undefined;
  }
  closeTurn();
  if (header === undefined) return undefined;
  return {
    id: String(header["id"]),
    cwd: String(header["cwd"]),
    buckets: [...buckets.values()],
    tools: [...tools].map(([key, count]) => {
      const [day = "", name = ""] = key.split("\u0000");
      return [day, name, count];
    }),
    badLines,
  };
}
