/**
 * 消息目录：rewind（键名规范见 docs/guides/i18n.md）。[W6-C0 建空壳，归 W6-I2]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 *
 * 回滚列表、确认面板、结果通知与 `/rewind` 命令（`modes/interactive/rewind-*.ts`）。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

/** 跳过 / 无法恢复的原因码（`rewind-text.ts`）。 */
export type RewindSkipCode =
  | "symlink"
  | "hardlink"
  | "not_regular"
  | "parent_moved"
  | "too_large"
  | "backup_missing"
  | "conflict"
  | "failed";

const EN_SKIP: Record<RewindSkipCode, string> = {
  symlink: "symlink",
  hardlink: "hard link",
  not_regular: "not a regular file",
  parent_moved: "parent directory moved",
  too_large: "too large, not backed up",
  backup_missing: "backup missing",
  conflict: "conflict",
  failed: "failed",
};

const ZH_SKIP: Record<RewindSkipCode, string> = {
  symlink: "符号链接",
  hardlink: "硬链接",
  not_regular: "不是普通文件",
  parent_moved: "父目录被移动",
  too_large: "文件过大未备份",
  backup_missing: "备份缺失",
  conflict: "冲突",
  failed: "失败",
};

export const en = {
  skip: {
    reason: (code: RewindSkipCode) => EN_SKIP[code],
    failed: (message: string) => `failed: ${message}`,
    /** `conflict 1, symlink 1`。 */
    counts: (parts: readonly (readonly [RewindSkipCode, number])[]) =>
      parts.map(([code, n]) => `${EN_SKIP[code]} ${n}`).join(", "),
    detail: (path: string, reason: string) => `  ${path}: ${reason}`,
    more: (n: number) => `  … ${n} more`,
  },
  badge: {
    noCode: "no code changes",
    conflicts: (n: number) => plural(n, "conflict"),
    files: (n: number, stat: string) => `${plural(n, "file")} ${stat}`,
    conversationOnly: "conversation only",
  },
  restorePreview: {
    onlyConflicts: (n: number) => `Only ${plural(n, "conflicting file")} (skipped by default)`,
    files: (n: number, stat: string, conflicts: number) =>
      `Restores ${plural(n, "file")} ${stat}${conflicts > 0 ? `, ${plural(conflicts, "conflict")}` : ""}`,
  },
  result: {
    restored: (done: number) => `Restored ${plural(done, "file")}`,
    restoredSkipped: (done: number, skipped: number, why: string) =>
      `Restored ${plural(done, "file")}, skipped ${skipped} (${why})`,
    noneRestored: (skipped: number, why: string) =>
      `No files were restored; skipped ${skipped} (${why})`,
    unchanged: "Code unchanged",
  },
  gitHint: (change: string, brief: boolean) =>
    `git HEAD changed: ${change}${brief ? "" : " (ama does not touch git)"}`,
  error: {
    busy: "Running; cannot rewind (press Esc to interrupt first)",
    noCheckpoint: "This message has no code checkpoint; only the conversation can be restored",
    failedFiles: (files: readonly (readonly [string, string])[]) =>
      `No files were restored: ${files.map(([path, message]) => `${path}: ${message}`).join("; ")}`,
    failed: "No files were restored",
  },
  command: {
    usage: (forms: string) => `Usage: /rewind, ${forms}`,
    forms:
      "/rewind <n> [both|conversation|code] [overwrite], /rewind <n> summarize-from|summarize-up-to [instructions]",
    empty: "No messages to rewind yet",
    conversationOnly: "  [conversation only]",
    emptyText: "(empty)",
    pointsHeading: (forms: string) => `Rewind points (${forms}):`,
    noSuchPoint: (index: number, total: number) =>
      `No rewind point ${index} (${total} in total; /rewind to list)`,
    summarizedFrom: (text: string) =>
      `Forked from here; the part left behind became a summary. Original message: ${text}`,
    summarizedUpTo: (before: number, after: number | undefined) =>
      `Summarized up to here: ${before}${after !== undefined ? ` → ${after}` : ""} tokens`,
    conversationBack: (text: string) =>
      `Conversation is back before this message. Original message: ${text}`,
  },
  flow: {
    refilled: "The original message is back in the input box",
    refilledImages: (images: number) =>
      `The original message is back in the input box (${plural(images, "image")} will be sent with the next message)`,
    rewinding: "Rewinding…",
    conversationBack: (note: string) => `Conversation is back before this message; ${note}`,
    summarizingFrom: "Summarizing the part left behind…",
    summarizedFrom: (note: string) =>
      `Forked from here; the part left behind became a summary; ${note}`,
    summarizing: "Summarizing…",
    busy: "Running; cannot rewind (press Esc to interrupt first)",
    empty: "No messages to rewind yet",
    undone: (note: string) => `Withdrew the interrupted message; ${note}`,
  },
  list: {
    title: "Rewind to before which message",
  },
  panel: {
    title: "Rewind to before this message",
    optionBoth: "Restore code and conversation",
    optionConversation: "Restore conversation",
    optionCode: "Restore code",
    optionSummarizeFrom: "Summarize from here",
    optionSummarizeUpTo: "Summarize up to here",
    optionCancel: "Cancel",
    previewBoth: (restore: string) => `${restore} · conversation will fork`,
    previewConversationKeep: "Code unchanged (later edits kept) · conversation will fork",
    previewConversation: "Code unchanged · conversation will fork",
    previewCode: (restore: string) => `${restore} · conversation unchanged`,
    previewSummarizeFrom: "Conversation will fork; the part left behind becomes a summary",
    previewSummarizeUpTo: "Earlier conversation is compressed into a summary; later turns stay",
    conflictSkip: "Skip conflicting files, restore the rest",
    conflictOverwrite: "Overwrite conflicting files",
    conflictBack: "Back",
    conflictHead: (n: number) => `${plural(n, "file")} changed outside the turn:`,
    hintConflictCompact: (arrows: string) => `${arrows} Enter · Esc back`,
    hintConflict: (arrows: string) => `${arrows} select · 1-3 pick · Enter confirm · Esc back`,
    hintCompact: (arrows: string, n: number) => `${arrows} Enter · 1-${n} · Esc cancel`,
    hint: (arrows: string, n: number) =>
      `${arrows} select · 1-${n} run · Enter confirm · Esc cancel`,
    moreLines: (ellipsis: string, n: number) => `  ${ellipsis} ${plural(n, "more line")}`,
    instructions: (text: string) => `  instructions: ${text}`,
    instructionsHint: "  type instructions",
    /** 紧凑排版：标题与文件清单并成一行。 */
    tightList: (head: string, files: readonly string[]) => `${head} ${files.join(", ")}`,
    moreFiles: (ellipsis: string, n: number) => `  ${ellipsis} ${n} more`,
    noCheckpoint: "Conversation only: this message has no code checkpoint",
    previewFailed: (error: string) => `Code preview failed: ${error}`,
    conflictsTight: (n: number) => `${plural(n, "conflict")}:`,
    conflicts: (n: number) =>
      `${plural(n, "conflict")} (changed outside the turn; skipped by default):`,
    unrestorable: (n: number) => `${n} can't be restored:`,
    fileReason: (reason: string) => `: ${reason}`,
  },
};

export const zh = {
  skip: {
    reason: (code) => ZH_SKIP[code],
    failed: (message) => `失败：${message}`,
    counts: (parts) => parts.map(([code, n]) => `${ZH_SKIP[code]} ${n}`).join("、"),
    detail: (path, reason) => `  ${path}：${reason}`,
    more: (n) => `  … 另 ${n} 个`,
  },
  badge: {
    noCode: "无代码改动",
    conflicts: (n) => `冲突 ${n} 个`,
    files: (n, stat) => `${n} 文件 ${stat}`,
    conversationOnly: "仅对话",
  },
  restorePreview: {
    onlyConflicts: (n) => `只有冲突文件 ${n} 个（缺省跳过）`,
    files: (n, stat, conflicts) =>
      `将恢复 ${n} 个文件 ${stat}${conflicts > 0 ? `，冲突 ${conflicts} 个` : ""}`,
  },
  result: {
    restored: (done) => `已恢复 ${done} 个文件`,
    restoredSkipped: (done, skipped, why) => `已恢复 ${done} 个文件，跳过 ${skipped} 个（${why}）`,
    noneRestored: (skipped, why) => `没有文件被恢复，跳过 ${skipped} 个（${why}）`,
    unchanged: "代码没有变化",
  },
  gitHint: (change, brief) => `git HEAD 已变化：${change}${brief ? "" : "（ama 不动 git）"}`,
  error: {
    busy: "正在运行，不能回滚（先按 Esc 中断）",
    noCheckpoint: "这条消息没有代码检查点，只能恢复对话",
    failedFiles: (files) =>
      `没有文件被恢复：${files.map(([path, message]) => `${path}：${message}`).join("；")}`,
    failed: "没有文件被恢复",
  },
  command: {
    usage: (forms) => `用法：/rewind，${forms}`,
    forms:
      "/rewind <n> [both|conversation|code] [overwrite]，/rewind <n> summarize-from|summarize-up-to [说明]",
    empty: "还没有可回滚的消息",
    conversationOnly: "  [仅对话]",
    emptyText: "（空）",
    pointsHeading: (forms) => `回滚点（${forms}）：`,
    noSuchPoint: (index, total) => `没有第 ${index} 个回滚点（共 ${total} 个，/rewind 查看）`,
    summarizedFrom: (text) => `已从这里分叉，离开的部分写成了摘要；原消息：${text}`,
    summarizedUpTo: (before, after) =>
      `已摘要到这里：${before}${after !== undefined ? ` → ${after}` : ""} token`,
    conversationBack: (text) => `对话已回到这条消息之前；原消息：${text}`,
  },
  flow: {
    refilled: "原消息已放回输入框",
    refilledImages: (images) => `原消息已放回输入框（${images} 张图片随下一条消息发送）`,
    rewinding: "回滚中…",
    conversationBack: (note) => `对话已回到这条消息之前，${note}`,
    summarizingFrom: "正在为离开的部分写摘要…",
    summarizedFrom: (note) => `已从这里分叉，离开的部分写成了摘要；${note}`,
    summarizing: "正在摘要…",
    busy: "正在运行，不能回滚（先按 Esc 中断）",
    empty: "还没有可回滚的消息",
    undone: (note) => `已撤回被中断的消息，${note}`,
  },
  list: {
    title: "回滚到哪条消息之前",
  },
  panel: {
    title: "回滚到这条消息之前",
    optionBoth: "恢复代码和对话",
    optionConversation: "恢复对话",
    optionCode: "恢复代码",
    optionSummarizeFrom: "从这里摘要",
    optionSummarizeUpTo: "摘要到这里",
    optionCancel: "取消",
    previewBoth: (restore) => `${restore} · 对话将分叉`,
    previewConversationKeep: "代码不变（保留之后的修改）· 对话将分叉",
    previewConversation: "代码不变 · 对话将分叉",
    previewCode: (restore) => `${restore} · 对话不变`,
    previewSummarizeFrom: "对话将分叉，离开的部分写成摘要",
    previewSummarizeUpTo: "之前的对话压缩成摘要，之后的保留",
    conflictSkip: "跳过冲突文件，恢复其余",
    conflictOverwrite: "覆盖冲突文件",
    conflictBack: "返回",
    conflictHead: (n) => `${n} 个文件在回合外被改过：`,
    hintConflictCompact: (arrows) => `${arrows} Enter · Esc 返回`,
    hintConflict: (arrows) => `${arrows} 选择 · 1-3 直接选 · Enter 确认 · Esc 返回`,
    hintCompact: (arrows, n) => `${arrows} Enter · 1-${n} · Esc 取消`,
    hint: (arrows, n) => `${arrows} 选择 · 1-${n} 直接执行 · Enter 确认 · Esc 取消`,
    moreLines: (ellipsis, n) => `  ${ellipsis} 另 ${n} 行`,
    instructions: (text) => `  说明：${text}`,
    instructionsHint: "  可输入说明",
    tightList: (head, files) => `${head}${files.join("、")}`,
    moreFiles: (ellipsis, n) => `  ${ellipsis} 另 ${n} 个`,
    noCheckpoint: "仅对话：这条消息没有代码检查点",
    previewFailed: (error) => `代码预览失败：${error}`,
    conflictsTight: (n) => `冲突 ${n} 个：`,
    conflicts: (n) => `冲突 ${n} 个（回合外被改过，缺省跳过）：`,
    unrestorable: (n) => `无法恢复 ${n} 个：`,
    fileReason: (reason) => `：${reason}`,
  },
} satisfies Messages<typeof en>;
