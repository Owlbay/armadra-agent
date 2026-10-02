/**
 * 档二摘要（设计 §9「档二」「模板」）。[B2]
 *
 * `prepareCompaction()` 在投影上找切点，得到「要摘要的消息」与 `firstKeptEntryId`；
 * `runCompaction()` 请模型按模板写摘要，split turn 时历史与回合前缀各一份再合并；
 * `<read-files>` / `<modified-files>` 与上一份 compaction 的 details 累计。失败抛
 * `AmaError{code:"compaction_failed"}`，abort 抛 `aborted`。
 *
 * [W3-C1b] 会话前缀续写（第三波 §1.8）：调用方给出 `continuation.prefix`（与上一次真实请求
 * 逐字节同前缀的完整转录）时，请求 = 前缀 + 一条摘要指令（「只摘要第 1–N 条，第 N+1 条起
 * 保留原文」+ 首行引文），`toolChoice: "none"`、`cacheRetention: "short"`、`purpose: "summary"`，
 * 按读价计费；响应为空 / 被截断 / 含工具调用 / 请求出错 → 回落现行独立请求（序列化转录、
 * `cacheRetention: "none"`）并经 `onFallback` 记 warning。
 */

import type {
  ApiImplementation,
  AssistantMessage,
  Model,
  StreamOptions,
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

/** 续写指令的首句（测试据此识别摘要请求）。 */
export const SUMMARY_CONTINUATION_PREAMBLE =
  "Stop here: do not continue the conversation, do not answer questions from it and do not call any tools.";

const TURN_PREFIX_PROMPT = `The record above is the BEGINNING of the current turn; the rest of the turn is kept verbatim after this summary. Summarize only what the agent was asked to do in this turn and what it has done so far, in a short "## Turn So Far" section followed by "## Critical Context".`;

const TURN_PREFIX_CONTINUATION_PROMPT = `These messages are the BEGINNING of the current turn; the rest of the turn is kept verbatim after this summary. Summarize only what the agent was asked to do in this turn and what it has done so far, in a short "## Turn So Far" section followed by "## Critical Context".`;

export interface CompactionPlan {
  /** 要摘要的消息（不含 system 与上一份摘要）。 */
  toSummarize: AgentMessage[];
  /** split turn 时：回合前缀（同时也在 toSummarize 的末尾之后，不重叠）。 */
  turnPrefix: AgentMessage[];
  firstKeptEntryId: string;
  cut: CutPointResult;
  previousSummary: string | undefined;
  previousDetails: FileOpsDetails | undefined;
  /**
   * [W3-C1b] 续写用的位置：转录里（不计 system）历史段结束前、保留区开始前各有多少条
   * 消息，以及紧随其后那条消息的首行引文。
   */
  anchors: { historyEnd: number; keptStart: number; historyExcerpt: string; keptExcerpt: string };
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
  /** [W3-C1b] 会话前缀续写的前缀与流选项（缺省 / 回落时走独立请求）。 */
  continuation?: SummaryContinuation | undefined;
  /** 续写失败回落独立请求时调用（记 warning）。 */
  onFallback?(reason: string): void;
}

export interface SummaryContinuation {
  /** 与上一次真实请求逐字节同前缀的完整转录（system 补丁 + 全部消息）。 */
  prefix: TranscriptContext;
  /** 沿用上一次真实请求的选项（apiKey、sessionId、thinkingLevel 等）。 */
  streamOptions?: Partial<Omit<StreamOptions, "signal">>;
}

export interface ContinuationInput {
  /** 与上一次真实请求逐字节相同的转录（system 补丁 + 全部消息，直到最后一条真实请求为止）。 */
  prefix: TranscriptContext;
  /** 摘要到第 index 条为止（不计 system）；excerpt 是第 index + 1 条的首行引文。 */
  keepFrom: { index: number; excerpt: string };
  /** 只摘要第 from + 1 条起（split turn 的回合前缀、分支摘要）；缺省从头。 */
  from?: number;
  /** SUMMARY_TEMPLATE / 回合前缀提示 / 分支摘要模板。 */
  instruction: string;
}

/** 转录里（不计 system）实际发给模型的消息数：失败 / 中断的助手消息连同其工具结果不回放。 */
export function countLlmMessages(messages: readonly AgentMessage[]): number {
  let count = 0;
  let skipping = false;
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "toolResult" && skipping) continue;
    skipping =
      message.role === "assistant" &&
      (message.stopReason === "error" || message.stopReason === "aborted");
    if (!skipping) count++;
  }
  return count;
}

/** 消息首行引文（≤ 80 字符）。 */
export function excerptOf(message: AgentMessage | undefined): string {
  if (message === undefined || message.role === "system") return "";
  let text: string;
  if (message.role === "compactionSummary" || message.role === "branchSummary")
    text = message.summary;
  else if (message.role === "assistant")
    text = message.content
      .map((block) =>
        block.type === "text" ? block.text : block.type === "toolCall" ? `[${block.name}]` : "",
      )
      .join(" ");
  else if (typeof message.content === "string") text = message.content;
  else text = message.content.map((block) => (block.type === "text" ? block.text : "")).join(" ");
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
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
  const messages = items.map((item) => item.message);
  const anchors = {
    historyEnd: countLlmMessages(messages.slice(0, historyEnd)),
    keptStart: countLlmMessages(messages.slice(0, cut.firstKeptIndex)),
    historyExcerpt: excerptOf(messages[historyEnd]),
    keptExcerpt: excerptOf(keptItem.message),
  };
  return {
    anchors,
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
  return checkSummary(message, options.signal);
}

function checkSummary(
  message: AssistantMessage,
  signal: AbortSignal,
): { text: string; usage: Usage } {
  if (message.stopReason === "aborted" || signal.aborted) {
    throw new AmaError("aborted", "compaction aborted");
  }
  if (message.stopReason === "error") {
    throw new AmaError("compaction_failed", message.errorMessage ?? "summary request failed");
  }
  const text = assistantText(message);
  if (text === "") throw new AmaError("compaction_failed", "summary model returned no text");
  return { text, usage: message.usage };
}

function continuationPrompt(
  input: ContinuationInput,
  total: number,
  instructions: string | undefined,
): string {
  const { index, excerpt } = input.keepFrom;
  const from = input.from ?? 0;
  const parts = [SUMMARY_CONTINUATION_PREAMBLE];
  const range = from + 1 === index ? `message ${index}` : `messages ${from + 1}–${index}`;
  parts.push(
    `Write a summary of ${range} of the conversation above ` +
      "(count user, assistant and tool-result messages from the start of the conversation; " +
      "a summary of earlier history at the start counts as a message and must be merged in).",
  );
  if (index < total && excerpt !== "") {
    parts.push(
      `Message ${index + 1} begins with: «${excerpt}». It and everything after it stay in the context verbatim, so do not summarize them.`,
    );
  }
  parts.push(input.instruction);
  if (instructions !== undefined && instructions.trim() !== "") {
    parts.push(`Additional instructions:\n${instructions.trim()}`);
  }
  return parts.join("\n\n");
}

/**
 * 会话前缀续写：前缀 + 一条摘要指令，`toolChoice: "none"`。空 / 截断 / 含工具调用 / 出错
 * 抛 `compaction_failed`（调用方回落），abort 抛 `aborted`。
 */
export async function completeByContinuation(
  options: SummarizerOptions,
  input: ContinuationInput,
): Promise<{ text: string; usage: Usage }> {
  const total = input.prefix.messages.filter((message) => message.role !== "system").length;
  const prompt = continuationPrompt(input, total, options.customInstructions);
  const context: TranscriptContext = {
    messages: [...input.prefix.messages, { role: "user", content: prompt, timestamp: Date.now() }],
  };
  const base = options.continuation?.streamOptions ?? {};
  const streamOptions: StreamOptions = {
    ...base,
    signal: options.signal,
    maxTokens:
      base.maxTokens ?? Math.min(options.maxTokens ?? SUMMARY_MAX_TOKENS, options.model.maxTokens),
    toolChoice: "none",
    cacheRetention: "short",
    purpose: "summary",
  };
  if (options.apiKey !== undefined) streamOptions.apiKey = options.apiKey;
  let message: AssistantMessage;
  try {
    message = await options.stream(options.model, context, streamOptions).result();
  } catch (error) {
    if (options.signal.aborted) throw new AmaError("aborted", "compaction aborted");
    throw new AmaError("compaction_failed", `summary request failed: ${String(error)}`);
  }
  if (message.stopReason === "length")
    throw new AmaError("compaction_failed", "summary was truncated");
  if (message.content.some((block) => block.type === "toolCall"))
    throw new AmaError("compaction_failed", "summary response called a tool");
  return checkSummary(message, options.signal);
}

/** 先试续写，失败（非 abort）回落独立请求。 */
export async function summarizeWithFallback(
  options: SummarizerOptions,
  continuation: Omit<ContinuationInput, "prefix"> | undefined,
  independentPrompt: () => string,
): Promise<{ text: string; usage: Usage }> {
  const prefix = options.continuation?.prefix;
  if (prefix !== undefined && continuation !== undefined) {
    try {
      return await completeByContinuation(options, { ...continuation, prefix });
    } catch (error) {
      if (options.signal.aborted || (error instanceof AmaError && error.code === "aborted"))
        throw error;
      options.onFallback?.(error instanceof Error ? error.message : String(error));
    }
  }
  return completeText(options, independentPrompt());
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
  const { anchors } = plan;
  if (plan.toSummarize.length > 0 || plan.previousSummary !== undefined) {
    const history = await summarizeWithFallback(
      options,
      {
        keepFrom: { index: anchors.historyEnd, excerpt: anchors.historyExcerpt },
        instruction: SUMMARY_TEMPLATE,
      },
      () =>
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
    const prefix = await summarizeWithFallback(
      { ...options, customInstructions: undefined },
      {
        from: anchors.historyEnd,
        keepFrom: { index: anchors.keptStart, excerpt: anchors.keptExcerpt },
        instruction: TURN_PREFIX_CONTINUATION_PROMPT,
      },
      () =>
        buildPrompt(
          serializeConversation(plan.turnPrefix),
          undefined,
          undefined,
          TURN_PREFIX_PROMPT,
        ),
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
