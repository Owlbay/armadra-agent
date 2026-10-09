/**
 * 启动基线：系统消息落盘之前（第一次请求前）的上下文估算。
 *
 * 系统提示与工具表在第一次请求前才作为首条 `system` 消息写进分支，在此之前投影里没有它们，
 * 状态栏会一直显示 0。这里按「将要发送的那一份」估算：命名节文本 + 工具声明 JSON，与
 * `estimateMessageTokens` 对 `system` 消息的口径一致（CJK 每字 1，其余字符 / 4）。
 *
 * 只用于统计：不写分支、不改请求体，前缀缓存不受影响；压缩阈值也不看它（摘要压不掉这部分）。
 */

import type { SystemMessage, ToolDecl } from "../ai/types.js";
import type { ContextEstimate } from "./estimate.js";
import { estimateMessageTokens } from "./estimate.js";

/** 系统提示（已装配的命名节）+ 工具声明的估算。 */
export function estimatePrefixTokens(
  sections: Readonly<Record<string, string>>,
  tools: readonly ToolDecl[],
): number {
  const message: SystemMessage = { role: "system", sections: { ...sections }, timestamp: 0 };
  if (tools.length > 0) message.toolsAdded = [...tools];
  return estimateMessageTokens(message);
}

/** 上下文估算的来源（`SessionStats.context.source`）。 */
export type ContextSource = "usage" | "estimate" | "prefix";

export interface SourcedEstimate extends ContextEstimate {
  source: ContextSource;
}

/**
 * 给投影估算标来源；投影里还没有系统消息时把前缀基线加进去（`prefix` 懒算，只在需要时调用）。
 * 有 usage 时照旧（usage 已经包含系统提示与工具表）。
 */
export function withPrefixBaseline(
  estimate: ContextEstimate,
  hasSystemMessage: boolean,
  prefix: () => number,
): SourcedEstimate {
  if (estimate.usageTokens > 0) return { ...estimate, source: "usage" };
  if (hasSystemMessage) return { ...estimate, source: "estimate" };
  const base = prefix();
  return {
    ...estimate,
    tokens: estimate.tokens + base,
    trailingTokens: estimate.trailingTokens + base,
    source: "prefix",
  };
}
