/**
 * 档二切点（设计 §9「档二」）。[B2]
 *
 * 在投影条目上从新往旧累计估算 token，到 `keepRecentTokens` 为止，切在其后最近的合法切点：
 * user / assistant / custom_message / branch_summary（**不切 toolResult**；切在带工具调用的
 * assistant 上时，它的结果随之保留）。system 消息不参与（它们折进 system 检查点，永不被摘要掉）。
 * 切点不是回合起点（user / custom / branch_summary）时为 split turn：被摘要段分成「历史」与
 * 「本回合前缀」两部分，各写一份摘要再合并。
 */

import type { ContextItem } from "../session/projection.js";
import type { AgentMessage } from "../session/types.js";
import { estimateMessageTokens } from "./estimate.js";

export interface CutPointResult {
  /** items 中保留区的起点。等于 startIndex 表示没有可摘要的内容。 */
  firstKeptIndex: number;
  /** split turn 时本回合起点；否则 -1。 */
  turnStartIndex: number;
  isSplitTurn: boolean;
}

export function isCutPoint(message: AgentMessage): boolean {
  return (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "custom" ||
    message.role === "branchSummary"
  );
}

export function isTurnStart(message: AgentMessage): boolean {
  return message.role === "user" || message.role === "custom" || message.role === "branchSummary";
}

/** 摘要区的起点：跳过开头的 system 检查点与上一份压缩摘要。 */
export function summarizableStart(items: readonly ContextItem[]): number {
  let i = 0;
  while (i < items.length) {
    const role = items[i]?.message.role;
    if (role !== "system" && role !== "compactionSummary") break;
    i++;
  }
  return i;
}

export function findCutPoint(
  items: readonly ContextItem[],
  startIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < items.length; i++) {
    const message = items[i]?.message;
    if (message !== undefined && isCutPoint(message)) cutPoints.push(i);
  }
  const none: CutPointResult = {
    firstKeptIndex: startIndex,
    turnStartIndex: -1,
    isSplitTurn: false,
  };
  if (cutPoints.length === 0) return none;

  let accumulated = 0;
  let cutIndex = startIndex;
  for (let i = items.length - 1; i >= startIndex; i--) {
    const message = items[i]?.message;
    if (message === undefined || message.role === "system") continue;
    accumulated += estimateMessageTokens(message);
    if (accumulated >= keepRecentTokens) {
      cutIndex = cutPoints.find((candidate) => candidate >= i) ?? (cutPoints.at(-1) as number);
      break;
    }
  }
  if (cutIndex <= startIndex) return none;

  const cutMessage = items[cutIndex]?.message;
  if (cutMessage === undefined || isTurnStart(cutMessage)) {
    return { firstKeptIndex: cutIndex, turnStartIndex: -1, isSplitTurn: false };
  }
  for (let i = cutIndex - 1; i >= startIndex; i--) {
    const message = items[i]?.message;
    if (message !== undefined && isTurnStart(message)) {
      return { firstKeptIndex: cutIndex, turnStartIndex: i, isSplitTurn: true };
    }
  }
  return { firstKeptIndex: cutIndex, turnStartIndex: -1, isSplitTurn: false };
}
