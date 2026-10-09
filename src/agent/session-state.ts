/**
 * SessionState 快照与统计（设计 §1.2 session-state.ts、§12.6 状态栏）。[B2]
 *
 * 统计口径：活动分支上的全部条目（不是投影）——被压缩 / 剔除的消息仍计入用量与成本；
 * 压缩与分支摘要请求的 usage 也计入；`usage` 条目（缓存保温等不进上下文的请求，第三波 §1.7）
 * 计入 token 与费用但不算消息。上下文 % 用投影感知估算（§9）；`context` 标明估算来源（usage / 全量估算 /
 * 启动前缀基线）与自动压缩阈值。
 */

import { modelRefOf } from "../ai/providers/channels.js";
import type { Model, ModelThinkingLevel, Usage } from "../ai/types.js";
import type { PermissionMode } from "../permissions/types.js";
import type { SessionManager } from "../session/manager.js";
import type { SessionEntry } from "../session/types.js";
import type { Agent } from "./agent.js";
import type {
  SessionCacheStats,
  SessionContextStats,
  SessionState,
  SessionStats,
} from "./types.js";
import type { QuotaUpdateEvent, SubscriptionStats } from "./types-w6.js";

export interface StateInput {
  agent: Agent;
  manager: SessionManager;
  model: Model;
  thinkingLevel: ModelThinkingLevel;
  permissionMode: PermissionMode;
  isCompacting: boolean;
  isRetrying: boolean;
  autoCompaction: boolean;
  autoRetry: boolean;
}

export function buildSessionState(input: StateInput): SessionState {
  const { agent, manager, model } = input;
  return {
    isStreaming: agent.isRunning,
    isCompacting: input.isCompacting,
    isRetrying: input.isRetrying,
    model: modelRefOf(model),
    thinkingLevel: input.thinkingLevel,
    permissionMode: input.permissionMode,
    sessionId: manager.id,
    sessionFile: manager.file(),
    cwd: manager.cwd,
    sessionName: manager.name(),
    messageCount: agent.messages.filter((message) => message.role !== "system").length,
    pendingMessageCount: agent.steeringQueue.size + agent.followUpQueue.size,
    steeringMode: agent.steeringQueue.mode,
    followUpMode: agent.followUpQueue.mode,
    autoCompaction: input.autoCompaction,
    autoRetry: input.autoRetry,
  };
}

export interface StatsInput {
  sessionId: string;
  sessionFile: string | undefined;
  branch: readonly SessionEntry[];
  contextTokens?: number | undefined;
  /** 会话的上下文估算（CompactionController.contextStats，含来源与阈值）；给了以它的 tokens 为准。 */
  context?: { tokens: number; detail: SessionContextStats };
  contextWindow: number | undefined;
  /** [W3-C1b] 会话层缓存控制器的统计（未接线时缺省）。 */
  cache?: SessionCacheStats;
  /** [W6-O] 最近一次 `quota_update`。 */
  quota?: QuotaUpdateEvent | undefined;
}

function addUsage(totals: SessionStats["tokens"], usage: Usage): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.total +=
    usage.totalTokens > 0
      ? usage.totalTokens
      : usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** [W6-O] 订阅计费（`billing: "subscription"`）的请求单列，不折算美元。 */
function addSubscription(
  stats: { subscription?: SubscriptionStats },
  provider: string,
  usage: Usage,
): void {
  if (usage.billing !== "subscription") return;
  const sub = (stats.subscription ??= { requests: 0, byProvider: {} });
  sub.requests++;
  const row = (sub.byProvider[provider] ??= { requests: 0, input: 0, output: 0, cacheRead: 0 });
  row.requests++;
  row.input += usage.input;
  row.output += usage.output;
  row.cacheRead += usage.cacheRead;
}

export function computeStats(input: StatsInput): SessionStats {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const sub: { subscription?: SubscriptionStats } = {};
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let cost: number | undefined = 0;
  const addCost = (usage: Usage): void => {
    if (cost === undefined) return;
    cost = usage.cost === undefined ? undefined : cost + usage.cost.total;
  };
  for (const entry of input.branch) {
    if (entry.type === "message") {
      const { message } = entry;
      if (message.role === "user") userMessages++;
      else if (message.role === "toolResult") toolResults++;
      else if (message.role === "assistant") {
        assistantMessages++;
        toolCalls += message.content.filter((block) => block.type === "toolCall").length;
        addUsage(tokens, message.usage);
        addCost(message.usage);
        addSubscription(sub, message.provider, message.usage);
      }
    } else if (entry.type === "usage") {
      addUsage(tokens, entry.usage);
      addCost(entry.usage);
      addSubscription(sub, entry.provider, entry.usage);
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
      addUsage(tokens, entry.usage);
      addCost(entry.usage);
    }
  }
  const contextTokens = input.context?.tokens ?? input.contextTokens;
  const contextPercent =
    input.contextWindow === undefined || contextTokens === undefined || input.contextWindow <= 0
      ? undefined
      : Math.min(100, Math.round((contextTokens / input.contextWindow) * 1000) / 10);
  const stats: SessionStats = {
    sessionId: input.sessionId,
    sessionFile: input.sessionFile,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    tokens,
    cost,
    contextTokens,
    contextWindow: input.contextWindow,
    contextPercent,
  };
  if (input.context !== undefined) stats.context = { ...input.context.detail };
  const rate = cacheHitRate(tokens);
  if (rate !== undefined) stats.cacheHitRate = rate;
  if (input.cache !== undefined) stats.cache = input.cache;
  if (sub.subscription !== undefined) {
    stats.subscription = sub.subscription;
    if (input.quota !== undefined) stats.subscription.quota = input.quota;
  }
  return stats;
}

/** 缓存命中率 = cacheRead /（input + cacheRead + cacheWrite）；分母为 0 → undefined（设计 §9.1）。 */
export function cacheHitRate(
  tokens: Pick<SessionStats["tokens"], "input" | "cacheRead" | "cacheWrite">,
): number | undefined {
  const denominator = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return denominator > 0 ? tokens.cacheRead / denominator : undefined;
}

/** 最后一条有文本的助手消息（error / aborted 也算，供 UI 显示失败原因前的部分输出）。 */
export function lastAssistantText(branch: readonly SessionEntry[]): string | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    const text = entry.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.trim() !== "") return text;
  }
  return null;
}
