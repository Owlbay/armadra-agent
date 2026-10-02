/**
 * 分支摘要（设计 §8「branch_summary」、§1.2 branch-summary.ts）：`/tree` 离开分支时总结被离开的那段。[B2]
 *
 * 找新旧叶子的最深公共祖先 → 收集旧叶子到祖先之间（不含祖先）的上下文消息 → 从新到旧按预算截取 →
 * 用同一模板（止于 Next Steps）生成摘要。调用方把结果作为 `branch_summary` 追加在新位置
 * （parentId = 新叶子，fromId = 旧叶子）。
 *
 * [W3-C1b] 调用方给出续写前缀（离开前的完整转录）时同压缩一样走会话前缀续写：「只摘要最后 K 条」，
 * 失败回落独立请求（第三波 §1.8）。
 */

import type { Usage } from "../ai/types.js";
import { entryToMessage } from "../session/projection.js";
import { commonAncestor, entriesBetween, type EntryIndex } from "../session/tree.js";
import type { AgentMessage, FileOpsDetails } from "../session/types.js";
import { estimateMessageTokens } from "./estimate.js";
import {
  collectFileOps,
  createFileOps,
  fileOpsDetails,
  formatFileOps,
  serializeConversation,
} from "./serialize.js";
import {
  countLlmMessages,
  summarizeWithFallback,
  type SummarizerOptions,
} from "./summarize-tier.js";

export const BRANCH_SUMMARY_BUDGET_TOKENS = 20_000;

export const BRANCH_SUMMARY_TEMPLATE = `The record above is a branch of the session that the user is now leaving to continue from an earlier point. Summarize what was tried on this branch so the agent can benefit from it, using EXACTLY this format:

## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps

Keep it concise; preserve exact file paths and error messages.`;

export interface BranchSummaryPlan {
  fromId: string;
  commonAncestorId: string | null;
  messages: AgentMessage[];
}

export interface BranchSummaryDraft {
  fromId: string;
  summary: string;
  usage: Usage;
  details: FileOpsDetails;
}

/** 旧叶子与新叶子在同一路径上（无被离开的内容）时返回 undefined。 */
export function prepareBranchSummary(
  index: EntryIndex,
  oldLeafId: string | null,
  newLeafId: string | null,
  budgetTokens = BRANCH_SUMMARY_BUDGET_TOKENS,
): BranchSummaryPlan | undefined {
  if (oldLeafId === null) return undefined;
  const ancestor = commonAncestor(index, oldLeafId, newLeafId);
  const abandoned = entriesBetween(index, ancestor, oldLeafId);
  const all: AgentMessage[] = [];
  for (const entry of abandoned) {
    const message = entryToMessage(entry);
    if (message !== undefined && message.role !== "system") all.push(message);
  }
  if (all.length === 0) return undefined;
  const picked: AgentMessage[] = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const message = all[i] as AgentMessage;
    const cost = estimateMessageTokens(message);
    if (picked.length > 0 && used + cost > budgetTokens) break;
    picked.unshift(message);
    used += cost;
  }
  return { fromId: oldLeafId, commonAncestorId: ancestor, messages: picked };
}

export async function runBranchSummary(
  plan: BranchSummaryPlan,
  options: SummarizerOptions,
): Promise<BranchSummaryDraft> {
  const prefix = options.continuation?.prefix;
  const total =
    prefix === undefined ? 0 : prefix.messages.filter((m) => m.role !== "system").length;
  const from = Math.max(0, total - countLlmMessages(plan.messages));
  const { text, usage } = await summarizeWithFallback(
    options,
    {
      from,
      keepFrom: { index: total, excerpt: "" },
      instruction: `Messages ${from + 1}–${total} are the branch being left.\n\n${BRANCH_SUMMARY_TEMPLATE}`,
    },
    () => {
      const parts = [`<conversation>\n${serializeConversation(plan.messages)}\n</conversation>`];
      parts.push(BRANCH_SUMMARY_TEMPLATE);
      if (options.customInstructions !== undefined && options.customInstructions.trim() !== "") {
        parts.push(`Additional instructions:\n${options.customInstructions.trim()}`);
      }
      return parts.join("\n\n");
    },
  );
  const details = fileOpsDetails(collectFileOps(plan.messages, createFileOps()));
  const files = formatFileOps(details);
  return {
    fromId: plan.fromId,
    summary: files === "" ? text : `${text}\n\n${files}`,
    usage,
    details,
  };
}
