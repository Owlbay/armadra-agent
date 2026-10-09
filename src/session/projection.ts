/**
 * 投影（设计 §8、§9）：活动分支 → 进上下文的消息。[B2]
 *
 * - `buildContextEntries(branch)`：若路径上有 compaction，取最新一条：先放 compaction，再放
 *   `firstKeptEntryId` 到 compaction 之间的非 system 条目，再放 compaction 之后的条目。
 * - `buildProjection(branch)`：对上一步的条目套用 `context_edit`（同一目标在活动分支上最新一条赢；
 *   `null` 剔除，字符串只换内容、保留角色与元数据），并把每个条目映射为 `AgentMessage`。
 *   有 compaction 时（[ME-B] D4「开头只写一次」）：检查点只重放**对话开始前**（首条非 system
 *   条目之前）的 system 消息，与压缩前请求的开头逐字节相同；此后到 compaction 之间的补丁合并成一条
 *   合成补丁放在摘要之后，由 normalizeContext 渲染为尾部提醒。合成补丁的 `toolsAdded` 按首次出现
 *   的顺序、用首次发送的声明，工具表与压缩前一致；多次压缩递归成立（都从原始条目重放）。
 *   会话条目里不另存检查点与合成补丁，重放即可得到。
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

/**
 * 依次应用转录里的 system 消息（首条全量，之后是补丁）；没有 system 消息 → undefined。
 * 工具「保留原位、只换内容」（与 normalizeContext 一致）；同一条里先加后删（`diffSystem` 的补丁两者
 * 不相交，只有压缩的合成补丁会对同名既加又删：声明过、现已移除）。
 */
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
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
    for (const name of message.toolsRemoved ?? []) tools.delete(name);
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

function sameDecl(a: ToolDecl, b: ToolDecl): boolean {
  return (
    a.description === b.description && JSON.stringify(a.parameters) === JSON.stringify(b.parameters)
  );
}

/**
 * 压缩的合成补丁：`head`（对话开始前的状态）→ 之后全部补丁重放的结果。节按差异给；工具先列对话中
 * 首次出现的新名字（首次发送的声明，normalizeContext 冻结的就是它），再列内容有更新的（只更新重放
 * 状态，不改请求工具表）；移除 = 声明过而现在不在。无差异 → undefined。
 */
export function synthesizeSystemPatch(
  head: SystemState,
  later: readonly SystemMessage[],
  timestamp: number,
): SystemMessage | undefined {
  const full = replaySystem([systemCheckpoint(head, timestamp), ...later]) ?? head;
  const sections: Record<string, string | null> = {};
  for (const [name, text] of Object.entries(full.sections))
    if (head.sections[name] !== text) sections[name] = text;
  for (const name of Object.keys(head.sections))
    if (!(name in full.sections)) sections[name] = null;
  const sent = new Map(head.tools.map((tool) => [tool.name, tool]));
  const added: ToolDecl[] = [];
  for (const message of later)
    for (const tool of message.toolsAdded ?? []) {
      if (sent.has(tool.name)) continue;
      sent.set(tool.name, tool);
      added.push(tool);
    }
  const now = new Map(full.tools.map((tool) => [tool.name, tool]));
  for (const [name, tool] of sent) {
    const current = now.get(name);
    if (current !== undefined && !sameDecl(current, tool)) added.push(current);
  }
  const removed = [...sent.keys()].filter((name) => !now.has(name));
  if (Object.keys(sections).length === 0 && added.length === 0 && removed.length === 0)
    return undefined;
  const patch: SystemMessage = { role: "system", sections, timestamp };
  if (added.length > 0) patch.toolsAdded = added.map((tool) => ({ ...tool }));
  if (removed.length > 0) patch.toolsRemoved = removed;
  return patch;
}

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

/** 对话开始：首条进上下文且不是 system 的条目（custom_message 算；custom / usage 等不算）。 */
function startsConversation(entry: SessionEntry): boolean {
  const message = entryToMessage(entry);
  return message !== undefined && message.role !== "system";
}

function systemMessagesOf(entries: readonly SessionEntry[]): SystemMessage[] {
  const out: SystemMessage[] = [];
  for (const entry of entries)
    if (entry.type === "message" && entry.message.role === "system") out.push(entry.message);
  return out;
}

/** 压缩之前的 system 状态：开头检查点（对话开始前）+ 合成补丁（之后的全部补丁）。 */
function compactedSystem(
  before: readonly SessionEntry[],
  timestamp: number,
): { checkpoint?: SystemMessage; patch?: SystemMessage } {
  let headEnd = before.findIndex(startsConversation);
  if (headEnd < 0) headEnd = before.length;
  const head = replaySystem(systemMessagesOf(before.slice(0, headEnd)));
  const later = systemMessagesOf(before.slice(headEnd));
  const out: { checkpoint?: SystemMessage; patch?: SystemMessage } = {};
  if (head !== undefined) out.checkpoint = systemCheckpoint(head, timestamp);
  if (later.length === 0) return out;
  const patch = synthesizeSystemPatch(head ?? { sections: {}, tools: [] }, later, timestamp);
  if (patch !== undefined) out.patch = patch;
  return out;
}

export function buildProjection(branch: readonly SessionEntry[]): Projection {
  const edits = collectContextEdits(branch);
  const at = latestCompactionIndex(branch);
  const compaction = at >= 0 ? (branch[at] as CompactionEntry) : undefined;
  const items: ContextItem[] = [];

  const system =
    compaction === undefined
      ? {}
      : compactedSystem(branch.slice(0, at), parseTime(compaction.timestamp));
  if (compaction !== undefined && system.checkpoint !== undefined)
    items.push({ entry: compaction, message: system.checkpoint });

  for (const entry of buildContextEntries(branch)) {
    let message = entryToMessage(entry);
    if (message !== undefined) {
      const edit = edits.get(entry.id);
      if (edit === undefined) items.push({ entry, message });
      else if (edit.replacement !== null)
        items.push({ entry, message: applyReplacement(message, edit.replacement) });
    }
    if (entry === compaction && system.patch !== undefined)
      items.push({ entry: compaction, message: system.patch });
  }
  return { items, messages: items.map((item) => item.message), compaction };
}

export function buildContext(branch: readonly SessionEntry[]): ProjectedContext {
  let model: ModelRef | undefined;
  let thinkingLevel: ModelThinkingLevel | undefined;
  for (const entry of branch) {
    if (entry.type === "model_change")
      model = {
        provider: entry.provider,
        id: entry.modelId,
        ...(entry.channel !== undefined ? { channel: entry.channel } : {}),
      };
    else if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
  }
  return { messages: buildProjection(branch).messages, model, thinkingLevel };
}
