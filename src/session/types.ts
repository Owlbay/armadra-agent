/**
 * 会话 JSONL 树契约（设计 §8，格式沿用 v1 §5）。[B0] 契约文件，实现归 B2。
 *
 * 补全与偏差：
 * - `message` 条目只装 LLM 消息（`Message`：system / user / assistant / toolResult），
 *   这样 session 不必反向依赖 agent。
 * - 投影（projection.ts）产出的上下文消息 `AgentMessage` = `Message` + 三种非 LLM 角色
 *   （custom / compactionSummary / branchSummary），定义在这里，agent/types.ts 再导出；
 *   `convertToLlm` 负责把三种扩展角色转成 user 消息。
 * - `context_edit.reason` 在 v1 的 prune / abort / manual 之外加 `retry`（§3.6 失败尝试剔除）
 *   与 `overflow`（§9 溢出恢复剔除）。
 * - `compaction` / `branch_summary` 的 details 统一为 `FileOpsDetails`。
 * - 补全 `SessionTreeNode`、`SessionListItem` 与 B6 / B7 需要的 `SessionManagerApi`。
 *   `append()` 同步：返回带 id 的条目并把叶子移到它（落盘可延迟到首条提示，§11.1 第 16 步）。
 */

import type { ContentBlock, Message, ModelThinkingLevel, Usage } from "../ai/types.js";

export const SESSION_FORMAT_VERSION = 1 as const;

export interface SessionHeader {
  type: "session";
  version: typeof SESSION_FORMAT_VERSION;
  id: string;
  /** ISO 8601。 */
  timestamp: string;
  cwd: string;
  agent: { name: "ama"; version: string };
  /** fork / clone / task 的来源文件。 */
  parentSession?: string;
}

export interface EntryBase {
  id: string;
  parentId: string | null;
  /** ISO 8601。 */
  timestamp: string;
}

export interface FileOpsDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface MessageEntry extends EntryBase {
  type: "message";
  message: Message;
}

export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;
  details?: FileOpsDetails;
}

export interface BranchSummaryEntry extends EntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  usage?: Usage;
  details?: FileOpsDetails;
}

export type ContextEditReason = "prune" | "abort" | "retry" | "overflow" | "manual";

/** 同一目标最新一条赢；replacement 为 null 表示从上下文剔除。 */
export interface ContextEditEntry extends EntryBase {
  type: "context_edit";
  targetId: string;
  replacement: string | null;
  reason: ContextEditReason;
}

export interface ModelChangeEntry extends EntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface ThinkingLevelChangeEntry extends EntryBase {
  type: "thinking_level_change";
  thinkingLevel: ModelThinkingLevel;
}

/** 不进上下文（如 ama.todo、ama.task）。 */
export interface CustomEntry extends EntryBase {
  type: "custom";
  customType: string;
  data: unknown;
}

/** 进上下文（如 ama.aborted、Hook 的 additionalContext）。 */
export interface CustomMessageEntry extends EntryBase {
  type: "custom_message";
  customType: string;
  content: string | ContentBlock[];
  display: boolean;
  details?: unknown;
}

export interface LabelEntry extends EntryBase {
  type: "label";
  targetId: string;
  /** 缺省 = 清除标签。 */
  label?: string;
}

export interface SessionInfoEntry extends EntryBase {
  type: "session_info";
  name?: string;
}

export type SessionEntry =
  | MessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | ContextEditEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

export type SessionEntryType = SessionEntry["type"];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** `append()` 的入参：id / parentId / timestamp 由管理器填。 */
export type SessionEntryInput = DistributiveOmit<SessionEntry, keyof EntryBase>;

/** JSONL 一行：首行是头，其后是条目。 */
export type SessionLine = SessionHeader | SessionEntry;

// ---------------------------------------------------------------------------
// 投影后的上下文消息
// ---------------------------------------------------------------------------

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | ContentBlock[];
  display: boolean;
  details?: unknown;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}

export type AgentMessage =
  Message | CustomMessage | CompactionSummaryMessage | BranchSummaryMessage;

// ---------------------------------------------------------------------------
// 管理器（实现：session/manager.ts）
// ---------------------------------------------------------------------------

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
}

export interface SessionListItem {
  id: string;
  file: string;
  cwd: string;
  name?: string;
  /** ISO 8601。 */
  createdAt: string;
  modifiedAt: string;
  firstPrompt?: string;
  messageCount: number;
}

export interface SessionManagerApi {
  readonly id: string;
  readonly cwd: string;
  /** 未落盘（内存会话或首条提示前）为 undefined。 */
  file(): string | undefined;
  header(): SessionHeader;
  /** 全部条目（文件顺序）。 */
  entries(): readonly SessionEntry[];
  getEntry(id: string): SessionEntry | undefined;
  leafId(): string | null;
  /** 追加到当前叶子之后并把叶子移到新条目。 */
  append(input: SessionEntryInput): SessionEntry;
  /** `/tree`：同文件换叶子。 */
  setLeaf(id: string | null): void;
  /** 根 → 叶子的活动分支。 */
  branch(leafId?: string | null): SessionEntry[];
  /** 以 entry id 为游标（不含 since 本身）。 */
  getEntries(since?: string): { entries: SessionEntry[]; leafId: string | null };
  getTree(): SessionTreeNode[];
  name(): string | undefined;
  setName(name: string): void;
  /** 复制 root → entryId 的分支到新文件（parentSession 指回）。 */
  fork(entryId: string): SessionManagerApi;
}
