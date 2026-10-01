/**
 * 上下文 token 估算（设计 §9「估算」）。[B2]
 *
 * `contextTokens` = 最后一条非 error / aborted 助手消息的 `totalTokens`（缺则
 * `input + output + cacheRead + cacheWrite`，**含 output**）+ 其后消息的估算（字符 / 4，图片 1 600）。
 * 若该 usage 之后活动分支上出现过 `context_edit` 或 `compaction`，usage 不再可信，按投影全量重估。
 */

import type { ContentBlock, Usage } from "../ai/types.js";
import type { ContextItem } from "../session/projection.js";
import type { AgentMessage, SessionEntry } from "../session/types.js";

export const IMAGE_TOKENS = 1600;
const CHARS_PER_TOKEN = 4;

export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens > 0
    ? usage.totalTokens
    : usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function contentChars(content: string | readonly ContentBlock[]): {
  chars: number;
  images: number;
} {
  if (typeof content === "string") return { chars: content.length, images: 0 };
  let chars = 0;
  let images = 0;
  for (const block of content) {
    if (block.type === "text") chars += block.text.length;
    else images++;
  }
  return { chars, images };
}

/** 单条消息的估算（字符 / 4 向上取整，图片每张 1 600）。 */
export function estimateMessageTokens(message: AgentMessage): number {
  let chars = 0;
  let images = 0;
  switch (message.role) {
    case "system":
      for (const text of Object.values(message.sections)) chars += text?.length ?? 0;
      if (message.toolsAdded !== undefined) chars += JSON.stringify(message.toolsAdded).length;
      break;
    case "user":
    case "toolResult":
    case "custom": {
      const counted = contentChars(message.content);
      chars = counted.chars;
      images = counted.images;
      break;
    }
    case "assistant":
      for (const block of message.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else chars += block.name.length + JSON.stringify(block.arguments).length;
      }
      break;
    case "compactionSummary":
    case "branchSummary":
      chars = message.summary.length;
      break;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

function usableUsage(message: AgentMessage): Usage | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
  return calculateContextTokens(message.usage) > 0 ? message.usage : undefined;
}

export interface ContextEstimate {
  tokens: number;
  /** 来自 usage 的部分（0 = 全量估算）。 */
  usageTokens: number;
  trailingTokens: number;
  /** 被采信的 usage 所在消息下标。 */
  lastUsageIndex: number | null;
}

/** 只看消息：最后一条可用 usage + 其后估算；无 usage 则全量估算。 */
export function estimateContextTokens(messages: readonly AgentMessage[]): ContextEstimate {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const usage = message === undefined ? undefined : usableUsage(message);
    if (usage === undefined) continue;
    const usageTokens = calculateContextTokens(usage);
    const trailingTokens = estimateMessagesTokens(messages.slice(i + 1));
    return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: i };
  }
  const tokens = estimateMessagesTokens(messages);
  return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

/**
 * 投影感知的估算：usage 所在条目之后若有 context_edit / compaction，按投影全量重估。
 * `items` 是 buildProjection(branch).items，`branch` 是同一活动分支。
 */
export function estimateProjectedTokens(
  items: readonly ContextItem[],
  branch: readonly SessionEntry[],
): ContextEstimate {
  const messages = items.map((item) => item.message);
  const estimate = estimateContextTokens(messages);
  if (estimate.lastUsageIndex !== null) {
    const usageEntryId = items[estimate.lastUsageIndex]?.entry.id;
    const usageAt = branch.findIndex((entry) => entry.id === usageEntryId);
    let invalidatedAt = -1;
    for (let i = branch.length - 1; i >= 0; i--) {
      const type = branch[i]?.type;
      if (type === "context_edit" || type === "compaction") {
        invalidatedAt = i;
        break;
      }
    }
    if (usageAt > invalidatedAt) return estimate;
  }
  const tokens = estimateMessagesTokens(messages);
  return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}
