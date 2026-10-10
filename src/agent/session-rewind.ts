/**
 * 会话回滚编排（docs/history/rewind-plan.md §2、§3.1、§3.3–§3.6）。[RW-B]
 *
 * - 回合起点：`runPrompt` 开启新回合的那条用户消息（steer / followUp 并入当前回合、Stop Hook 续跑
 *   的 `hook` 消息都不算）。本进程内落盘的按记录判断；恢复的会话以 `ama.checkpoint` 条目为准，
 *   没有检查点时退回「origin 为空的用户消息」。
 * - 检查点：回合起点落盘后调后端 `snapshot()`，首个模型请求前等它完成；ToolContext 的
 *   `checkpoint` 钩子指向后端（子会话指向父会话的后端，记到父会话当前回合）。内存会话不建。
 * - `rewind()`：代码（后端恢复）与对话（`navigate(parentId)`）；`readFiles` 按新路径上成功的
 *   read / write 调用重算，再去掉被恢复、删除或与目标检查点不一致的文件。
 * - 仅对话 / 仅代码时的一致性提示 `ama.rewind-note` 留到下一次提示前追加在末尾（§3.4、§7）。
 * - 「从这里摘要」= navigate(parentId, summarize)；「摘要到这里」= 以该消息为切点的档二压缩。
 * - 中断即撤回（§3.6）：本回合被 abort 且没有任何助手文本 / 工具调用 → 可撤回并回填原消息。
 */

import { isAbsolute, resolve } from "node:path";
import type { ImageBlock, UserMessage } from "../ai/types.js";
import type { CheckpointBackend } from "../checkpoints/index.js";
import {
  CHECKPOINT_CUSTOM_TYPE,
  REWIND_NOTE_CUSTOM_TYPE,
  type CheckpointHooks,
  type CodeRestoreResult,
  type RewindMode,
  type RewindPoint,
  type RewindRequest,
  type RewindResult,
} from "../checkpoints/types.js";
import { AmaError } from "../errors.js";
import type { BranchSummaryEntry, SessionEntry } from "../session/types.js";
import { resolvePath } from "../tools/paths.js";
import type { SessionCore } from "./session-core.js";
import { ABORTED_CUSTOM_TYPE } from "./session-run.js";
import type { CompactionResult, RewindDraftText } from "./types.js";

/** 提示里最多列出的文件数（§3.4）。 */
export const REWIND_NOTE_MAX_FILES = 20;

export type RewindDraft = RewindDraftText;

/** 「从这里摘要」的结果。 */
export interface SummarizeFromResult {
  leafId: string | null;
  draft: RewindDraft;
  summary?: BranchSummaryEntry;
}

/** 会话交给回滚控制器的能力（避免与 session.ts 循环 import）。 */
export interface RewindHost {
  readonly core: SessionCore;
  running(): boolean;
  navigate(
    targetId: string | null,
    options?: { summarize?: boolean; instructions?: string },
  ): Promise<BranchSummaryEntry | undefined>;
  /** 以 entryId 为切点的档二压缩（运行中 → busy）。 */
  compactAt(entryId: string, instructions: string | undefined): Promise<CompactionResult>;
}

function textOf(content: UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function draftOf(message: UserMessage): RewindDraft {
  const draft: RewindDraft = { text: textOf(message.content) };
  if (typeof message.content !== "string") {
    const images = message.content.filter((block): block is ImageBlock => block.type === "image");
    if (images.length > 0) draft.images = images;
  }
  return draft;
}

function userMessageOf(entry: SessionEntry | undefined): UserMessage | undefined {
  return entry?.type === "message" && entry.message.role === "user" ? entry.message : undefined;
}

/** 文件清单：最多 20 个，其余计数。 */
export function listFiles(files: readonly string[]): string {
  const shown = files.slice(0, REWIND_NOTE_MAX_FILES).map((file) => `- ${file}`);
  const rest = files.length - REWIND_NOTE_MAX_FILES;
  if (rest > 0) shown.push(`- … and ${rest} more`);
  return shown.join("\n");
}

export function conversationNote(files: readonly string[]): string {
  return (
    "The conversation was rewound to an earlier point, but these files keep the changes made " +
    `after that point (their content may differ from what you saw earlier):\n${listFiles(files)}`
  );
}

export function codeNote(files: readonly string[], index: number): string {
  return (
    `These files were restored to their state before user message #${index} of this ` +
    `conversation (read them again before editing):\n${listFiles(files)}`
  );
}

function changedFiles(result: CodeRestoreResult): string[] {
  return [...new Set([...result.restored, ...result.deleted, ...result.conflicts])];
}

/** 本回合有没有任何助手文本或工具调用。 */
function hasOutput(entry: SessionEntry): boolean {
  if (entry.type !== "message") return false;
  const message = entry.message;
  if (message.role === "toolResult" || message.role === "user") return true;
  if (message.role !== "assistant") return false;
  return message.content.some(
    (block) => block.type === "toolCall" || (block.type === "text" && block.text.trim().length > 0),
  );
}

export class RewindController {
  readonly backend: CheckpointBackend | undefined;
  private readonly host: RewindHost;
  /** 本进程内落盘的回合起点。 */
  private readonly turnStarts = new Set<string>();
  /** 本进程内落盘的全部用户消息（回合起点之外的不用回退规则判断）。 */
  private readonly seenUsers = new Set<string>();
  private expected: UserMessage | undefined;
  private turn: string | undefined;
  private pendingSnapshot: Promise<void> | undefined;
  private pendingNote: string | undefined;

  constructor(host: RewindHost) {
    this.host = host;
    const core = host.core;
    const factory = core.options.checkpoints;
    const persisted = core.manager.directory() !== undefined;
    this.backend =
      factory !== undefined && core.depth === 0 && persisted
        ? factory({
            cwd: core.cwd,
            entries: () => core.manager.entries(),
            appendCustom: (customType, data) => {
              core.appendEntry({ type: "custom", customType, data });
            },
            currentTurn: () => this.turn,
            log: (level, message) => core.log(level, message),
          })
        : undefined;
  }

  /** ToolContext.checkpoint：自己的后端，或子会话继承的父会话钩子。 */
  hooks(): CheckpointHooks | undefined {
    return this.backend?.hooks ?? this.host.core.options.checkpointHooks;
  }

  // -------------------------------------------------------------------------
  // 接线：runPrompt → 落盘 → snapshot → 首个请求前等待
  // -------------------------------------------------------------------------

  /** runPrompt 构造了开启新回合的用户消息；同时把待发的一致性提示追加在它之前。 */
  beginTurn(message: UserMessage): void {
    this.expected = message;
    if (this.pendingNote !== undefined) {
      const content = this.pendingNote;
      this.pendingNote = undefined;
      this.host.core.appendEntry({
        type: "custom_message",
        customType: REWIND_NOTE_CUSTOM_TYPE,
        content,
        display: false,
      });
      this.host.core.reloadMessages();
    }
  }

  /** 每条落盘的消息。 */
  onPersisted(entry: SessionEntry | undefined): void {
    const message = userMessageOf(entry);
    if (entry === undefined || message === undefined) return;
    this.seenUsers.add(entry.id);
    if (message !== this.expected) return;
    this.expected = undefined;
    this.turnStarts.add(entry.id);
    this.turn = entry.id;
    const backend = this.backend;
    if (backend === undefined) return;
    this.pendingSnapshot = backend.snapshot(entry.id).catch((error: unknown) => {
      this.host.core.log("warn", `checkpoint snapshot failed: ${String(error)}`);
    });
  }

  /** 首个模型请求前（beforeRequest）：等检查点拍完，工具才可能写文件。 */
  async ready(): Promise<void> {
    const pending = this.pendingSnapshot;
    this.pendingSnapshot = undefined;
    if (pending !== undefined) await pending;
  }

  // -------------------------------------------------------------------------
  // 回滚点
  // -------------------------------------------------------------------------

  private checkpointIds(): Set<string> {
    const ids = new Set<string>();
    for (const entry of this.host.core.manager.entries()) {
      if (entry.type !== "custom" || entry.customType !== CHECKPOINT_CUSTOM_TYPE) continue;
      const data = entry.data as { userEntryId?: unknown } | undefined;
      if (typeof data?.userEntryId === "string") ids.add(data.userEntryId);
    }
    return ids;
  }

  private turnEntries(): { entry: SessionEntry; message: UserMessage }[] {
    const recorded = this.checkpointIds();
    const out: { entry: SessionEntry; message: UserMessage }[] = [];
    for (const entry of this.host.core.manager.branch()) {
      const message = userMessageOf(entry);
      if (message === undefined) continue;
      const start = this.seenUsers.has(entry.id)
        ? this.turnStarts.has(entry.id)
        : recorded.has(entry.id) || message.origin === undefined;
      if (start) out.push({ entry, message });
    }
    return out;
  }

  points(): RewindPoint[] {
    return this.turnEntries().map(({ entry, message }) => ({
      entryId: entry.id,
      text: textOf(message.content),
      timestamp: message.timestamp,
      hasCheckpoint: this.backend?.hasCheckpoint(entry.id) ?? false,
    }));
  }

  private target(entryId: string): { entry: SessionEntry; message: UserMessage; index: number } {
    const turns = this.turnEntries();
    const index = turns.findIndex((turn) => turn.entry.id === entryId);
    const found = turns[index];
    if (found === undefined) {
      throw new AmaError(
        "invalid_arguments",
        `entry ${entryId} is not a rewind point on the active branch`,
      );
    }
    return { ...found, index: index + 1 };
  }

  // -------------------------------------------------------------------------
  // 回滚
  // -------------------------------------------------------------------------

  private assertIdle(): void {
    if (this.host.running()) throw new AmaError("busy", "cannot rewind while running");
  }

  async rewind(request: RewindRequest): Promise<RewindResult> {
    this.assertIdle();
    const { entry, message, index } = this.target(request.entryId);
    const mode: RewindMode = request.mode;
    const withCode = mode !== "conversation";
    const withConversation = mode !== "code";
    const backend = this.backend;
    const checkpointed = backend?.hasCheckpoint(entry.id) === true;
    if (withCode && (backend === undefined || !checkpointed)) {
      throw new AmaError(
        "no_checkpoint",
        "this message has no checkpoint; rewind the conversation only",
      );
    }
    const onConflict = request.onConflict ?? "skip";
    const result: RewindResult = {};
    if (checkpointed && backend !== undefined) {
      const hint = await backend.gitHint(entry.id);
      if (hint !== undefined) result.gitHint = hint;
    }

    if (request.dryRun === true) {
      if (checkpointed && backend !== undefined) {
        result.code = (await backend.restore(entry.id, { dryRun: true, onConflict })).result;
      }
      return result;
    }

    let touched: string[] = [];
    let divergent: string[] = [];
    if (withCode && backend !== undefined) {
      const restored = await backend.restore(entry.id, { dryRun: false, onConflict });
      const code = restored.result;
      if (code.failed.length > 0 && code.restored.length === 0 && code.deleted.length === 0) {
        throw new AmaError(
          "rewind_failed",
          `no files were restored: ${code.failed.map((f) => `${f.path}: ${f.message}`).join("; ")}`,
          { detail: code },
        );
      }
      result.code = code;
      touched = restored.touched;
    } else if (checkpointed && backend !== undefined) {
      // 仅对话：与目标检查点不一致的文件要告诉模型，并从 readFiles 去掉
      const preview = await backend.restore(entry.id, { dryRun: true, onConflict: "skip" });
      divergent = changedFiles(preview.result);
    }

    if (withConversation) {
      await this.host.navigate(entry.parentId);
      result.conversation = { leafId: entry.parentId, draft: draftOf(message) };
      this.recomputeReadFiles();
    }
    const core = this.host.core;
    for (const path of [...touched, ...divergent.map((file) => this.absolute(file))]) {
      core.readFiles.delete(path);
    }

    if (mode === "conversation") {
      this.pendingNote = divergent.length > 0 ? conversationNote(divergent) : undefined;
    } else if (mode === "code") {
      const files =
        result.code === undefined ? [] : [...result.code.restored, ...result.code.deleted];
      this.pendingNote = files.length > 0 ? codeNote(files, index) : undefined;
    } else this.pendingNote = undefined;

    this.announce(entry.id, mode, result.code);
    return result;
  }

  private absolute(file: string): string {
    return isAbsolute(file) ? file : resolve(this.host.core.cwd, file);
  }

  private announce(entryId: string, mode: RewindMode, code: CodeRestoreResult | undefined): void {
    const core = this.host.core;
    const restored = code?.restored ?? [];
    const deleted = code?.deleted ?? [];
    core.emit({
      type: "session_rewound",
      entryId,
      mode,
      restored,
      deleted,
      conflicts: code?.conflicts ?? [],
      skipped: code?.skipped ?? [],
    });
    void core.runHook("PostRewind", { entryId, mode, files: [...restored, ...deleted] });
  }

  /** 新路径上成功的 read / write 调用（与 markRead 的语义一致，不跨分支保留）。 */
  recomputeReadFiles(): void {
    const core = this.host.core;
    const calls = new Map<string, string>();
    const next = new Set<string>();
    for (const entry of core.manager.branch()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type !== "toolCall" || (block.name !== "read" && block.name !== "write"))
            continue;
          const path = block.arguments["path"];
          if (typeof path === "string") calls.set(block.id, resolvePath(path, core.cwd));
        }
      } else if (message.role === "toolResult" && message.isError !== true) {
        const path = calls.get(message.toolCallId);
        if (path !== undefined) next.add(path);
      }
    }
    core.readFiles.clear();
    for (const path of next) core.readFiles.add(path);
  }

  // -------------------------------------------------------------------------
  // 摘要两项（§3.5）
  // -------------------------------------------------------------------------

  async summarizeFrom(entryId: string, instructions?: string): Promise<SummarizeFromResult> {
    this.assertIdle();
    const { entry, message } = this.target(entryId);
    const options: { summarize: true; instructions?: string } = { summarize: true };
    if (instructions !== undefined) options.instructions = instructions;
    const summary = await this.host.navigate(entry.parentId, options);
    this.recomputeReadFiles();
    this.pendingNote = undefined;
    this.announce(entry.id, "conversation", undefined);
    const result: SummarizeFromResult = { leafId: entry.parentId, draft: draftOf(message) };
    if (summary !== undefined) result.summary = summary;
    return result;
  }

  async summarizeUpTo(entryId: string, instructions?: string): Promise<CompactionResult> {
    this.assertIdle();
    const { entry } = this.target(entryId);
    return this.host.compactAt(entry.id, instructions);
  }

  // -------------------------------------------------------------------------
  // 中断即撤回（§3.6）
  // -------------------------------------------------------------------------

  /** 空闲、开关开、最近一个回合被中断且还没有任何助手文本 / 工具调用。 */
  canUndoAbortedTurn(): boolean {
    if (this.host.running() || this.host.core.options.restoreOnCancel === false) return false;
    const last = this.turnEntries().at(-1);
    if (last === undefined) return false;
    const branch = this.host.core.manager.branch();
    const after = branch.slice(branch.findIndex((entry) => entry.id === last.entry.id) + 1);
    if (after.some(hasOutput)) return false;
    return after.some(
      (entry) => entry.type === "custom_message" && entry.customType === ABORTED_CUSTOM_TYPE,
    );
  }

  /** 撤回被中断的回合并返回原消息；不满足条件时 undefined。 */
  async undoAbortedTurn(): Promise<RewindDraft | undefined> {
    if (!this.canUndoAbortedTurn()) return undefined;
    const last = this.turnEntries().at(-1);
    if (last === undefined) return undefined;
    const result = await this.rewind({ entryId: last.entry.id, mode: "conversation" });
    return result.conversation?.draft;
  }
}
