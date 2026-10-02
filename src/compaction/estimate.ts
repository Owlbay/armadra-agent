/**
 * 上下文 token 估算（设计 §9「估算」）。[B2]
 *
 * `contextTokens` = 最后一条非 error / aborted 助手消息的 `totalTokens`（缺则
 * `input + output + cacheRead + cacheWrite`，**含 output**）+ 其后消息的估算（图片 1 600）。
 * 若该 usage 之后活动分支上出现过 `context_edit` 或 `compaction`，usage 不再可信，按投影全量重估。
 *
 * [W5-H1] 文本估算按脚本区分（wave5 D28 / C10）：CJK 统一表意文字（含扩展区与兼容区）、假名、
 * 谚文、CJK 符号与全角形式每字 1 token，其余字符合计 / 4 向上取整。「字符 / 4」对中文低估 3–4 倍，
 * 中文会话会晚触发直至溢出；所有阈值（档一、档二、保留区）都用这个口径。
 */

import type { ContentBlock, Usage } from "../ai/types.js";
import type { ContextItem } from "../session/projection.js";
import type { AgentMessage, SessionEntry } from "../session/types.js";

export const IMAGE_TOKENS = 1600;
const CHARS_PER_TOKEN = 4;

/** 按 1 token / 字计的码位（BMP 内）。 */
function isWideCode(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意文字
    (code >= 0x3040 && code <= 0x30ff) || // 平假名、片假名
    (code >= 0x31f0 && code <= 0x31ff) || // 片假名音标扩展
    (code >= 0xac00 && code <= 0xd7af) || // 谚文音节
    (code >= 0x1100 && code <= 0x11ff) || // 谚文字母
    (code >= 0x3130 && code <= 0x318f) || // 谚文兼容字母
    (code >= 0x3000 && code <= 0x303f) || // CJK 符号与标点
    (code >= 0xff00 && code <= 0xffef) // 半角与全角形式
  );
}

/** 文本的 token 估算：CJK / 假名 / 谚文每字 1，其余字符 / 4（向上取整）。 */
export function estimateTextTokens(text: string): number {
  return tokensOf(countText(text, { wide: 0, narrow: 0 }));
}

interface CharCount {
  wide: number;
  narrow: number;
}

function countText(text: string, into: CharCount): CharCount {
  let wide = 0;
  let narrow = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x1100) narrow++;
    else if (code >= 0xd840 && code <= 0xd87f) {
      // 补充平面 CJK 扩展 B–F（U+20000–U+2FFFF）的代理对：整对算 1 个字
      wide++;
      i++;
    } else if (isWideCode(code)) wide++;
    else narrow++;
  }
  into.wide += wide;
  into.narrow += narrow;
  return into;
}

function tokensOf(count: CharCount): number {
  return count.wide + Math.ceil(count.narrow / CHARS_PER_TOKEN);
}

export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens > 0
    ? usage.totalTokens
    : usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** 内容的估算（文本按脚本，图片每张 1 600）。 */
export function estimateContentTokens(content: string | readonly ContentBlock[]): number {
  if (typeof content === "string") return estimateTextTokens(content);
  const count: CharCount = { wide: 0, narrow: 0 };
  let images = 0;
  for (const block of content) {
    if (block.type === "text") countText(block.text, count);
    else images++;
  }
  return tokensOf(count) + images * IMAGE_TOKENS;
}

/** 单条消息的估算（文本按脚本区分，图片每张 1 600）。 */
export function estimateMessageTokens(message: AgentMessage): number {
  const count: CharCount = { wide: 0, narrow: 0 };
  switch (message.role) {
    case "system":
      for (const text of Object.values(message.sections)) countText(text ?? "", count);
      if (message.toolsAdded !== undefined) countText(JSON.stringify(message.toolsAdded), count);
      break;
    case "user":
    case "toolResult":
    case "custom":
      return estimateContentTokens(message.content);
    case "assistant":
      for (const block of message.content) {
        if (block.type === "text") countText(block.text, count);
        else if (block.type === "thinking") countText(block.thinking, count);
        else countText(block.name + JSON.stringify(block.arguments), count);
      }
      break;
    case "compactionSummary":
    case "branchSummary":
      countText(message.summary, count);
      break;
  }
  return tokensOf(count);
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
