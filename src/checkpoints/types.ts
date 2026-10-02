/**
 * 检查点与回滚契约（docs/rewind-plan.md §1、§3）。契约文件，实现归 RW-A（`src/checkpoints/**`）
 * 与 RW-B（`src/agent/session-rewind.ts`）。
 *
 * - 会话条目两类，均为 `custom`（不进上下文）：`ama.checkpoint`（新回合的用户消息之后）与
 *   `ama.checkpoint-track`（回合中途第一次碰某文件，补进本回合检查点）。
 * - 备份按内容 sha256 存 `<dataDir>/file-history/blobs/<前 2 位>/<全长>`，会话只记哈希。
 * - 路径键：cwd 内为相对路径（`/` 分隔），cwd 外为绝对路径。
 */

import type { ImageBlock } from "../ai/types.js";

export const CHECKPOINT_CUSTOM_TYPE = "ama.checkpoint";
export const CHECKPOINT_TRACK_CUSTOM_TYPE = "ama.checkpoint-track";
export const REWIND_NOTE_CUSTOM_TYPE = "ama.rewind-note";

export type CheckpointMode = "tools" | "shadow-git" | "off";

export interface FileRecord {
  /** 内容 sha256；null = 当时文件不存在（回滚时删除）。 */
  blob: string | null;
  /** 普通文件的权限位。 */
  mode?: number;
  size?: number;
  /** 记录时父目录的 realpath；恢复时校验没被移动。 */
  realParentDir?: string;
  /** 记录时取不到内容的原因；回滚时报告「无法恢复」。 */
  skipped?: "too_large" | "not_regular";
}

export interface CheckpointData {
  v: 1;
  /** 这个检查点属于哪条用户消息：记的是「这条消息发出前」的状态。 */
  userEntryId: string;
  files: Record<string, FileRecord>;
  /** 直接读 .git/HEAD 得到；cwd 不在 git 仓库里时省略。 */
  git?: { head: string; branch?: string };
  /** `checkpoints.mode: "shadow-git"` 时的影子仓库提交 id（RW-D）。 */
  shadowCommit?: string;
}

export interface CheckpointTrackData {
  v: 1;
  userEntryId: string;
  path: string;
  record: FileRecord;
}

/** 交给工具的接口：edit / write 写文件前后各调一次。可选——宿主或内存会话没有时为 undefined。 */
export interface CheckpointHooks {
  /** 写之前：文件第一次被跟踪时备份当前内容。失败只记 warn，不抛。 */
  beforeWrite(absolutePath: string): Promise<void>;
  /** 写之后：记下 ama 最后写入的内容（冲突检测用）。 */
  afterWrite(absolutePath: string, content: Uint8Array | string): void;
}

export type RewindMode = "both" | "conversation" | "code";

export interface RewindPoint {
  entryId: string;
  text: string;
  timestamp: number;
  /** 没有检查点（内存会话、检查点关闭、超出保留数）时只能仅对话。 */
  hasCheckpoint: boolean;
}

export interface RewindRequest {
  entryId: string;
  mode: RewindMode;
  /** 只返回预览，不改任何东西。 */
  dryRun?: boolean;
  /** 冲突文件的处理；缺省 skip。 */
  onConflict?: "skip" | "overwrite";
}

export type RewindSkipReason =
  "symlink" | "hardlink" | "not_regular" | "parent_moved" | "too_large" | "backup_missing";

export interface CodeRestoreResult {
  restored: string[];
  deleted: string[];
  /** 冲突文件：skip 时未动，overwrite 时已覆盖。 */
  conflicts: string[];
  skipped: { path: string; reason: RewindSkipReason }[];
  failed: { path: string; message: string }[];
  insertions: number;
  deletions: number;
}

export interface RewindResult {
  conversation?: {
    leafId: string | null;
    draft: { text: string; images?: ImageBlock[] };
  };
  code?: CodeRestoreResult;
  /** 记录的 HEAD 与当前不同时给出；只提示，不操作 git。 */
  gitHint?: { recordedHead: string; currentHead: string };
}
