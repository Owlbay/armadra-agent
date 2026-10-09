/**
 * 上下文分类明细（`/context`）：把投影消息按类别拆开估算。纯函数，只读，不改请求体。
 *
 * 口径与 `estimateMessagesTokens` 一致：每条消息先按 `estimateMessageTokens` 求总量，再把这个总量
 * 分到消息内各部分（文本部分取 `wide + floor(narrow / 4)`，余下的 0–3 个 token 按最大余数补给
 * 字符余数最大的部分；图片每张 `IMAGE_TOKENS`），所以各类别之和恰好等于整组消息的估算。
 *
 * 系统提示与工具声明来自活动分支上的 `system` 消息（首条全量、之后是补丁，补丁也计入——与估算口径
 * 相同）：按节名、按工具名汇总；工具表数组的括号与逗号计入工具声明但不归到具体工具。首次请求前
 * 分支上还没有 `system` 消息，这两类为 0（`hasSystem: false`）。
 *
 * 只产出数字与名字（节名、工具名、custom 类型），不带任何正文。
 */

import { countText, estimateMessageTokens, IMAGE_TOKENS } from "./estimate.js";
import type { ContentBlock } from "../ai/types.js";
import type { AgentMessage } from "../session/types.js";

/** 与 estimate.ts 的字符口径相同（非宽字符每 4 个 1 token）。 */
const CHARS_PER_TOKEN = 4;

export const BREAKDOWN_CATEGORIES = [
  "system",
  "tools",
  "user",
  "assistant",
  "reasoning",
  "toolCalls",
  "toolResults",
  "images",
  "summaries",
  "custom",
] as const;

export type BreakdownCategory = (typeof BREAKDOWN_CATEGORIES)[number];

export interface BreakdownPart {
  /** 节名 / 工具名 / `compaction`·`branch` / custom 类型 / 图片来源角色。 */
  name: string;
  tokens: number;
}

export interface BreakdownEntry {
  category: BreakdownCategory;
  tokens: number;
  /** 计入本类的块数（消息、块、节、图片）。 */
  count: number;
  /** 按名字汇总，从大到小；没有名字的部分（如工具表的括号）只进 `tokens`。 */
  parts: BreakdownPart[];
}

export interface ToolResultSize {
  /** 在投影里第几个工具结果（从 1 开始）。 */
  ordinal: number;
  toolName: string;
  tokens: number;
}

export interface ContextBreakdown {
  /** 固定顺序（`BREAKDOWN_CATEGORIES`）。 */
  entries: BreakdownEntry[];
  /** = `estimateMessagesTokens(messages)`。 */
  total: number;
  /** 系统提示 + 工具声明。 */
  prefixTokens: number;
  /** 分支上已有 `system` 消息（首次请求后）。 */
  hasSystem: boolean;
  /** 每个工具结果的大小，按出现顺序。 */
  toolResults: ToolResultSize[];
}

interface Piece {
  category: BreakdownCategory;
  name: string | undefined;
  wide: number;
  narrow: number;
  /** 固定 token（图片）；不参与余数分配。 */
  fixed: number;
}

function textPiece(category: BreakdownCategory, name: string | undefined, text: string): Piece {
  const count = countText(text, { wide: 0, narrow: 0 });
  return { category, name, wide: count.wide, narrow: count.narrow, fixed: 0 };
}

function imagePiece(name: string): Piece {
  return { category: "images", name, wide: 0, narrow: 0, fixed: IMAGE_TOKENS };
}

function contentPieces(
  content: string | readonly ContentBlock[],
  category: BreakdownCategory,
  name: string | undefined,
  imageSource: string,
): Piece[] {
  if (typeof content === "string") return [textPiece(category, name, content)];
  return content.map((block) =>
    block.type === "text" ? textPiece(category, name, block.text) : imagePiece(imageSource),
  );
}

/** 一条消息拆成的部分（字符合计与 `estimateMessageTokens` 的计数完全相同）。 */
function messagePieces(message: AgentMessage): Piece[] {
  switch (message.role) {
    case "system": {
      const pieces = Object.entries(message.sections).map(([name, text]) =>
        textPiece("system", name, text ?? ""),
      );
      const tools = message.toolsAdded;
      if (tools !== undefined) {
        for (const tool of tools) pieces.push(textPiece("tools", tool.name, JSON.stringify(tool)));
        // JSON.stringify(数组) 比各元素多出 `[`、`]` 与元素间的逗号
        pieces.push({
          category: "tools",
          name: undefined,
          wide: 0,
          narrow: 2 + Math.max(0, tools.length - 1),
          fixed: 0,
        });
      }
      return pieces;
    }
    case "user":
      return contentPieces(message.content, "user", undefined, "user");
    case "toolResult":
      return contentPieces(message.content, "toolResults", message.toolName, "toolResult");
    case "custom":
      return contentPieces(message.content, "custom", message.customType, "custom");
    case "assistant":
      return message.content.map((block) =>
        block.type === "text"
          ? textPiece("assistant", undefined, block.text)
          : block.type === "thinking"
            ? textPiece("reasoning", undefined, block.thinking)
            : textPiece("toolCalls", block.name, block.name + JSON.stringify(block.arguments)),
      );
    case "compactionSummary":
      return [textPiece("summaries", "compaction", message.summary)];
    case "branchSummary":
      return [textPiece("summaries", "branch", message.summary)];
  }
}

/** 把消息总量分到各部分（最大余数法），返回与 pieces 对齐的 token 数。 */
function allocate(pieces: readonly Piece[], total: number): number[] {
  const tokens = pieces.map((p) => p.fixed + p.wide + Math.floor(p.narrow / CHARS_PER_TOKEN));
  let left = total - tokens.reduce((sum, n) => sum + n, 0);
  const order = pieces
    .map((p, i) => ({ i, rest: p.narrow % CHARS_PER_TOKEN }))
    .filter((x) => x.rest > 0)
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    tokens[i] = (tokens[i] ?? 0) + 1;
    left--;
  }
  // 理论上不会剩；保险起见补到最大的部分，保证合计与估算一致
  if (left !== 0 && tokens.length > 0) {
    let max = 0;
    for (let i = 1; i < tokens.length; i++) if ((tokens[i] ?? 0) > (tokens[max] ?? 0)) max = i;
    tokens[max] = (tokens[max] ?? 0) + left;
  }
  return tokens;
}

/** 消息 → 分类明细（各类别之和 = `estimateMessagesTokens(messages)`）。 */
export function breakdownMessages(messages: readonly AgentMessage[]): ContextBreakdown {
  const totals = new Map<BreakdownCategory, { tokens: number; count: number }>();
  const parts = new Map<BreakdownCategory, Map<string, number>>();
  for (const category of BREAKDOWN_CATEGORIES) {
    totals.set(category, { tokens: 0, count: 0 });
    parts.set(category, new Map());
  }
  const toolResults: ToolResultSize[] = [];
  let total = 0;
  let hasSystem = false;
  for (const message of messages) {
    const messageTokens = estimateMessageTokens(message);
    total += messageTokens;
    if (message.role === "system") hasSystem = true;
    if (message.role === "toolResult") {
      toolResults.push({
        ordinal: toolResults.length + 1,
        toolName: message.toolName,
        tokens: messageTokens,
      });
    }
    const pieces = messagePieces(message);
    const allocated = allocate(pieces, messageTokens);
    pieces.forEach((piece, i) => {
      const tokens = allocated[i] ?? 0;
      const entry = totals.get(piece.category);
      if (entry === undefined) return;
      entry.tokens += tokens;
      if (piece.name !== undefined || piece.category !== "tools") entry.count++;
      if (piece.name !== undefined) {
        const named = parts.get(piece.category);
        named?.set(piece.name, (named.get(piece.name) ?? 0) + tokens);
      }
    });
  }
  const entries = BREAKDOWN_CATEGORIES.map((category): BreakdownEntry => {
    const entry = totals.get(category) ?? { tokens: 0, count: 0 };
    const named = [...(parts.get(category) ?? new Map<string, number>())]
      .map(([name, tokens]) => ({ name, tokens }))
      .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
    return { category, tokens: entry.tokens, count: entry.count, parts: named };
  });
  const prefixTokens = entries
    .filter((e) => e.category === "system" || e.category === "tools")
    .reduce((sum, e) => sum + e.tokens, 0);
  return { entries, total, prefixTokens, hasSystem, toolResults };
}

/** 最大的 n 个工具结果（大小相同按出现顺序）。 */
export function largestToolResults(breakdown: ContextBreakdown, n: number): ToolResultSize[] {
  return [...breakdown.toolResults]
    .sort((a, b) => b.tokens - a.tokens || a.ordinal - b.ordinal)
    .slice(0, Math.max(0, n));
}
