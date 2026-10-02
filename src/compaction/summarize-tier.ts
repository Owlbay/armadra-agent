/**
 * 档二摘要（设计 §9「档二」「模板」）。[B2]
 *
 * `prepareCompaction()` 在投影上找切点，得到「要摘要的消息」与 `firstKeptEntryId`；
 * `runCompaction()` 序列化后请模型按模板写摘要（`cacheRetention: "none"`、maxTokens 4 096），
 * split turn 时历史与回合前缀各一份再合并；`<read-files>` / `<modified-files>` 与上一份
 * compaction 的 details 累计。失败抛 `AmaError{code:"compaction_failed"}`，abort 抛 `aborted`。
 */

import type {
  ApiImplementation,
  AssistantMessage,
  Model,
  TranscriptContext,
  Usage,
} from "../ai/types.js";
import { AmaError } from "../errors.js";
import type { ContextItem, Projection } from "../session/projection.js";
import type { AgentMessage, FileOpsDetails } from "../session/types.js";
import { findCutPoint, summarizableStart, type CutPointResult } from "./cut-point.js";
import {
  collectFileOps,
  createFileOps,
  fileOpsDetails,
  formatFileOps,
  serializeConversation,
} from "./serialize.js";

export type StreamFn = ApiImplementation["stream"];

export const SUMMARY_MAX_TOKENS = 4096;

export const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant. You read a record of a coding session between a " +
  "user and an AI coding agent and write a structured checkpoint that another instance of the " +
  "agent will use to continue the work. Do not continue the conversation and do not answer " +
  "questions found in the record; only output the summary.";

export const SUMMARY_TEMPLATE = `Write the checkpoint summary using EXACTLY this format:

## Goal
[What the user is trying to accomplish; several items if the session covers several tasks.]

## Constraints & Preferences
- [Constraints, preferences, or requirements stated by the user, or "(none)"]

## Progress
### Done
- [x] [Completed tasks and changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Short rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Data, file paths, identifiers, error messages, or references needed to continue, or "(none)"]

Keep every section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_PROMPT = `The record above is the BEGINNING of the current turn; the rest of the turn is kept verbatim after this summary. Summarize only what the agent was asked to do in this turn and what it has done so far, in a short "## Turn So Far" section followed by "## Critical Context".`;

export interface CompactionPlan {
  /** 要摘要的消息（不含 system 与上一份摘要）。 */
  toSummarize: AgentMessage[];
  /** split turn 时：回合前缀（同时也在 toSummarize 的末尾之后，不重叠）。 */
  turnPrefix: AgentMessage[];
  firstKeptEntryId: string;
  cut: CutPointResult;
  previousSummary: string | undefined;
  previousDetails: FileOpsDetails | undefined;
}

export interface CompactionDraft {
  summary: string;
  firstKeptEntryId: string;
  usage: Usage | undefined;
  details: FileOpsDetails;
}

export interface SummarizerOptions {
  stream: StreamFn;
  model: Model;
  apiKey?: string | undefined;
  signal: AbortSignal;
  customInstructions?: string | undefined;
  maxTokens?: number;
}

/** 无可摘要内容时返回 undefined。 */
export function prepareCompaction(
  projection: Projection,
  keepRecentTokens: number,
): CompactionPlan | undefined {
  const items: readonly ContextItem[] = projection.items;
  const start = summarizableStart(items);
  const cut = findCutPoint(items, start, keepRecentTokens);
  if (cut.firstKeptIndex <= start) return undefined;
  const keptItem = items[cut.firstKeptIndex];
  if (keptItem === undefined) return undefined;
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptIndex;
  const pick = (from: number, to: number): AgentMessage[] =>
    items
      .slice(from, to)
      .map((item) => item.message)
      .filter((message) => message.role !== "system");
  const previous = projection.compaction;
  return {
    toSummarize: pick(start, historyEnd),
    turnPrefix: cut.isSplitTurn ? pick(cut.turnStartIndex, cut.firstKeptIndex) : [],
    firstKeptEntryId: keptItem.entry.id,
    cut,
    previousSummary: previous?.summary,
    previousDetails: previous?.details,
  };
}

function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (a === undefined) return { ...b };
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/** 一次无工具的文本补全；错误 / 取消 / 空输出抛错。 */
export async function completeText(
  options: SummarizerOptions,
  userText: string,
): Promise<{ text: string; usage: Usage }> {
  const context: TranscriptContext = {
    messages: [
      {
        role: "system",
        sections: { preamble: SUMMARIZATION_SYSTEM_PROMPT },
        timestamp: Date.now(),
      },
      { role: "user", content: userText, timestamp: Date.now() },
    ],
  };
  const maxTokens = Math.min(options.maxTokens ?? SUMMARY_MAX_TOKENS, options.model.maxTokens);
  let message: AssistantMessage;
  try {
    const streamOptions: Parameters<StreamFn>[2] = {
      signal: options.signal,
      maxTokens,
      cacheRetention: "none",
      purpose: "summary",
    };
    if (options.apiKey !== undefined) streamOptions.apiKey = options.apiKey;
    const stream = options.stream(options.model, context, streamOptions);
    message = await stream.result();
  } catch (error) {
    if (options.signal.aborted) throw new AmaError("aborted", "compaction aborted");
    throw new AmaError("compaction_failed", `summary request failed: ${String(error)}`, {
      cause: error,
    });
  }
  if (message.stopReason === "aborted" || options.signal.aborted) {
    throw new AmaError("aborted", "compaction aborted");
  }
  if (message.stopReason === "error") {
    throw new AmaError("compaction_failed", message.errorMessage ?? "summary request failed");
  }
  const text = assistantText(message);
  if (text === "") throw new AmaError("compaction_failed", "summary model returned no text");
  return { text, usage: message.usage };
}

function buildPrompt(
  conversation: string,
  previousSummary: string | undefined,
  instructions: string | undefined,
  tail: string,
): string {
  const parts: string[] = [];
  if (previousSummary !== undefined) {
    parts.push(`<previous-summary>\n${previousSummary}\n</previous-summary>`);
    parts.push(
      "The previous summary covers the session before the record below. Merge it with the new record into ONE updated summary.",
    );
  }
  parts.push(`<conversation>\n${conversation}\n</conversation>`);
  parts.push(tail);
  if (instructions !== undefined && instructions.trim() !== "") {
    parts.push(`Additional instructions:\n${instructions.trim()}`);
  }
  return parts.join("\n\n");
}

export async function runCompaction(
  plan: CompactionPlan,
  options: SummarizerOptions,
): Promise<CompactionDraft> {
  let usage: Usage | undefined;
  let summary: string;
  if (plan.toSummarize.length > 0 || plan.previousSummary !== undefined) {
    const history = await completeText(
      options,
      buildPrompt(
        serializeConversation(plan.toSummarize),
        plan.previousSummary,
        options.customInstructions,
        SUMMARY_TEMPLATE,
      ),
    );
    usage = addUsage(usage, history.usage);
    summary = history.text;
  } else {
    summary = "## Goal\n(no earlier history)";
  }
  if (plan.turnPrefix.length > 0) {
    const prefix = await completeText(
      options,
      buildPrompt(serializeConversation(plan.turnPrefix), undefined, undefined, TURN_PREFIX_PROMPT),
    );
    usage = addUsage(usage, prefix.usage);
    summary = `${summary}\n\n---\n\n${prefix.text}`;
  }
  const ops = collectFileOps(
    [...plan.toSummarize, ...plan.turnPrefix],
    createFileOps(plan.previousDetails),
  );
  const details = fileOpsDetails(ops);
  const files = formatFileOps(details);
  if (files !== "") summary = `${summary}\n\n${files}`;
  return { summary, firstKeptEntryId: plan.firstKeptEntryId, usage, details };
}
