/**
 * 投影（设计 §8、§9）：活动分支 → 进上下文的消息。[B2]
 *
 * - `buildContextEntries(branch)`：若路径上有 compaction，取最新一条：先放 compaction，再放
 *   `firstKeptEntryId` 到 compaction 之间的非 system 条目，再放 compaction 之后的条目。
 * - `buildProjection(branch)`：对上一步的条目套用 `context_edit`（同一目标在活动分支上最新一条赢；
 *   `null` 剔除，字符串只换内容、保留角色与元数据），并把每个条目映射为 `AgentMessage`。
 *   有 compaction 时，compaction 之前的全部 system 消息折成一条完整的 system 检查点放在最前
 *   （会话条目里不另存检查点，重放即可得到）。
 * - `buildContext(branch)`：投影消息 + 路径上最近的模型 / 思考级别选择。
 */

import type {
  AssistantMessage,
  Message,
  ModelRef,
  ModelThinkingLevel,
  SystemMessage,
  ToolDecl,
} from "../ai/types.js";
import type { AgentMessage, CompactionEntry, ContextEditEntry, SessionEntry } from "./types.js";

export interface ContextItem {
  /** 来源条目（system 检查点的来源是 compaction 条目）。 */
  entry: SessionEntry;
  message: AgentMessage;
}

export interface Projection {
  items: ContextItem[];
  messages: AgentMessage[];
  /** 生效的最新 compaction。 */
  compaction: CompactionEntry | undefined;
}

export interface ProjectedContext {
  messages: AgentMessage[];
  model: ModelRef | undefined;
  thinkingLevel: ModelThinkingLevel | undefined;
}

function parseTime(iso: string): number {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 条目 → 上下文消息；不进上下文的条目返回 undefined（model_change、label、custom、
 * 第三波的 `usage` 条目等）。
 */
export function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
  switch (entry.type) {
    case "message":
      return entry.message;
    case "custom_message": {
      const message: AgentMessage = {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        timestamp: parseTime(entry.timestamp),
      };
      if (entry.details !== undefined) message.details = entry.details;
      return message;
    }
    case "branch_summary":
      return {
        role: "branchSummary",
        summary: entry.summary,
        fromId: entry.fromId,
        timestamp: parseTime(entry.timestamp),
      };
    case "compaction":
      return {
        role: "compactionSummary",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp: parseTime(entry.timestamp),
      };
    case "usage":
    default:
      return undefined;
  }
}

function isSystemEntry(entry: SessionEntry): boolean {
  return entry.type === "message" && entry.message.role === "system";
}

function latestCompactionIndex(branch: readonly SessionEntry[]): number {
  for (let i = branch.length - 1; i >= 0; i--) if (branch[i]?.type === "compaction") return i;
  return -1;
}

export function buildContextEntries(branch: readonly SessionEntry[]): SessionEntry[] {
  const at = latestCompactionIndex(branch);
  if (at < 0) return [...branch];
  const compaction = branch[at] as CompactionEntry;
  const keptStart = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  const kept =
    keptStart >= 0 && keptStart < at
      ? branch.slice(keptStart, at).filter((entry) => !isSystemEntry(entry))
      : [];
  return [compaction, ...kept, ...branch.slice(at + 1)];
}

/** 活动分支上每个目标最新的 context_edit。 */
export function collectContextEdits(
  branch: readonly SessionEntry[],
): Map<string, ContextEditEntry> {
  const edits = new Map<string, ContextEditEntry>();
  for (const entry of branch) if (entry.type === "context_edit") edits.set(entry.targetId, entry);
  return edits;
}

/** 用替换文本换掉消息内容，保留角色与元数据。 */
export function applyReplacement(message: AgentMessage, text: string): AgentMessage {
  switch (message.role) {
    case "user":
    case "toolResult":
    case "custom":
      return { ...message, content: text };
    case "assistant": {
      const replaced: AssistantMessage = { ...message, content: [{ type: "text", text }] };
      return replaced;
    }
    case "compactionSummary":
    case "branchSummary":
      return { ...message, summary: text };
    case "system":
      return message;
  }
}

// ---------------------------------------------------------------------------
// system 重放
// ---------------------------------------------------------------------------

export interface SystemState {
  /** 节名 → 文本，按首次出现顺序。 */
  sections: Record<string, string>;
  tools: ToolDecl[];
}

/** 依次应用转录里的 system 消息（首条全量，之后是补丁）；没有 system 消息 → undefined。 */
export function replaySystem(messages: Iterable<AgentMessage | Message>): SystemState | undefined {
  let found = false;
  const sections = new Map<string, string>();
  const tools = new Map<string, ToolDecl>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    found = true;
    for (const [name, text] of Object.entries(message.sections)) {
      if (text === null) sections.delete(name);
      else sections.set(name, text);
    }
    for (const name of message.toolsRemoved ?? []) tools.delete(name);
    for (const tool of message.toolsAdded ?? []) {
      tools.delete(tool.name);
      tools.set(tool.name, tool);
    }
  }
  if (!found) return undefined;
  return { sections: Object.fromEntries(sections), tools: [...tools.values()] };
}

/** 把重放结果写成一条完整的 system 消息。 */
export function systemCheckpoint(state: SystemState, timestamp: number): SystemMessage {
  const message: SystemMessage = { role: "system", sections: { ...state.sections }, timestamp };
  if (state.tools.length > 0) message.toolsAdded = state.tools.map((tool) => ({ ...tool }));
  return message;
}

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

export function buildProjection(branch: readonly SessionEntry[]): Projection {
  const edits = collectContextEdits(branch);
  const at = latestCompactionIndex(branch);
  const compaction = at >= 0 ? (branch[at] as CompactionEntry) : undefined;
  const items: ContextItem[] = [];

  if (compaction !== undefined) {
    const before: Message[] = [];
    for (const entry of branch.slice(0, at)) {
      if (entry.type === "message" && entry.message.role === "system") before.push(entry.message);
    }
    const state = replaySystem(before);
    if (state !== undefined) {
      items.push({
        entry: compaction,
        message: systemCheckpoint(state, parseTime(compaction.timestamp)),
      });
    }
  }

  for (const entry of buildContextEntries(branch)) {
    let message = entryToMessage(entry);
    if (message === undefined) continue;
    const edit = edits.get(entry.id);
    if (edit !== undefined) {
      if (edit.replacement === null) continue;
      message = applyReplacement(message, edit.replacement);
    }
    items.push({ entry, message });
  }
  return { items, messages: items.map((item) => item.message), compaction };
}

export function buildContext(branch: readonly SessionEntry[]): ProjectedContext {
  let model: ModelRef | undefined;
  let thinkingLevel: ModelThinkingLevel | undefined;
  for (const entry of branch) {
    if (entry.type === "model_change") model = { provider: entry.provider, id: entry.modelId };
    else if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
  }
  return { messages: buildProjection(branch).messages, model, thinkingLevel };
}
