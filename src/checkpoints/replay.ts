/**
 * 从会话条目重建检查点（docs/history/rewind-plan.md §1.2）。[RW-A]
 *
 * - 按文件顺序重放全部条目（不限活动分支）里的 `ama.checkpoint` 与 `ama.checkpoint-track`；
 *   track 并入对应 userEntryId 的检查点（检查点里已有该文件时不覆盖）。
 * - 每个文件的第一条记录永久作为回退（`earliest`）；最近一条记录与其条目时间（`latest`）给快照沿用判断。
 * - 形状不对的条目跳过（不抛）：会话文件可能来自更新的版本。
 */

import { isBlobHash } from "./blobs.js";
import {
  CHECKPOINT_CUSTOM_TYPE,
  CHECKPOINT_TRACK_CUSTOM_TYPE,
  type CheckpointData,
  type CheckpointTrackData,
  type FileRecord,
} from "./types.js";

/** 重放需要的最小条目形状（SessionEntry 满足）。 */
export interface CheckpointEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
  /** ISO 8601。 */
  timestamp?: string;
}

export interface LoadedCheckpoints {
  /** userEntryId → 检查点（含并入的 track）。 */
  byUserEntry: Map<string, CheckpointData>;
  /** userEntryId，按第一次出现的顺序（从旧到新）。 */
  order: string[];
  /** 路径键 → 该文件最早的记录。 */
  earliest: Map<string, FileRecord>;
  /** 路径键 → 最近一条记录与其条目时间（毫秒；条目无时间时 0）。 */
  latest: Map<string, { record: FileRecord; at: number }>;
}

export function emptyCheckpoints(): LoadedCheckpoints {
  return { byUserEntry: new Map(), order: [], earliest: new Map(), latest: new Map() };
}

const SKIP_REASONS = new Set(["too_large", "not_regular"]);

/** 校验并规整一条 FileRecord；不合法返回 undefined。 */
export function parseFileRecord(value: unknown): FileRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const blob = v["blob"];
  if (blob !== null && !isBlobHash(blob)) return undefined;
  const record: FileRecord = { blob };
  if (typeof v["mode"] === "number") record.mode = v["mode"];
  if (typeof v["size"] === "number") record.size = v["size"];
  if (typeof v["realParentDir"] === "string") record.realParentDir = v["realParentDir"];
  const skipped = v["skipped"];
  if (typeof skipped === "string" && SKIP_REASONS.has(skipped)) {
    record.skipped = skipped as NonNullable<FileRecord["skipped"]>;
  }
  return record;
}

function parseCheckpoint(data: unknown): CheckpointData | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (d["v"] !== 1 || typeof d["userEntryId"] !== "string") return undefined;
  const files: Record<string, FileRecord> = {};
  const rawFiles = d["files"];
  if (typeof rawFiles === "object" && rawFiles !== null) {
    for (const [key, raw] of Object.entries(rawFiles)) {
      const record = parseFileRecord(raw);
      if (record !== undefined) files[key] = record;
    }
  }
  const out: CheckpointData = { v: 1, userEntryId: d["userEntryId"], files };
  const git = d["git"] as Record<string, unknown> | undefined;
  if (typeof git === "object" && git !== null && typeof git["head"] === "string") {
    out.git = {
      head: git["head"],
      ...(typeof git["branch"] === "string" ? { branch: git["branch"] } : {}),
    };
  }
  if (typeof d["shadowCommit"] === "string") out.shadowCommit = d["shadowCommit"];
  return out;
}

function parseTrack(data: unknown): CheckpointTrackData | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (d["v"] !== 1 || typeof d["userEntryId"] !== "string" || typeof d["path"] !== "string") {
    return undefined;
  }
  const record = parseFileRecord(d["record"]);
  if (record === undefined) return undefined;
  return { v: 1, userEntryId: d["userEntryId"], path: d["path"], record };
}

function timeOf(entry: CheckpointEntryLike): number {
  const t = entry.timestamp === undefined ? NaN : Date.parse(entry.timestamp);
  return Number.isFinite(t) ? t : 0;
}

/** 把一条检查点并进已加载状态（重放与运行时追加共用）。 */
export function applyCheckpoint(state: LoadedCheckpoints, data: CheckpointData, at: number): void {
  const existing = state.byUserEntry.get(data.userEntryId);
  if (existing === undefined) {
    state.byUserEntry.set(data.userEntryId, { ...data, files: { ...data.files } });
    state.order.push(data.userEntryId);
  } else {
    // 同一回合的检查点重复出现（重试快照等）：以后来的为准，保留已并入的 track。
    existing.files = { ...existing.files, ...data.files };
    if (data.git !== undefined) existing.git = data.git;
    if (data.shadowCommit !== undefined) existing.shadowCommit = data.shadowCommit;
  }
  for (const [key, record] of Object.entries(data.files)) noteRecord(state, key, record, at);
}

/** 把一条 track 并进已加载状态。 */
export function applyTrack(state: LoadedCheckpoints, track: CheckpointTrackData, at: number): void {
  let checkpoint = state.byUserEntry.get(track.userEntryId);
  if (checkpoint === undefined) {
    checkpoint = { v: 1, userEntryId: track.userEntryId, files: {} };
    state.byUserEntry.set(track.userEntryId, checkpoint);
    state.order.push(track.userEntryId);
  }
  if (checkpoint.files[track.path] === undefined) checkpoint.files[track.path] = track.record;
  noteRecord(state, track.path, track.record, at);
}

function noteRecord(state: LoadedCheckpoints, key: string, record: FileRecord, at: number): void {
  if (!state.earliest.has(key)) state.earliest.set(key, record);
  state.latest.set(key, { record, at });
}

/** 重放会话条目（全文件，不限活动分支）。 */
export function loadCheckpoints(entries: Iterable<CheckpointEntryLike>): LoadedCheckpoints {
  const state = emptyCheckpoints();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === CHECKPOINT_CUSTOM_TYPE) {
      const data = parseCheckpoint(entry.data);
      if (data !== undefined) applyCheckpoint(state, data, timeOf(entry));
    } else if (entry.customType === CHECKPOINT_TRACK_CUSTOM_TYPE) {
      const track = parseTrack(entry.data);
      if (track !== undefined) applyTrack(state, track, timeOf(entry));
    }
  }
  return state;
}

export const DEFAULT_CHECKPOINT_KEEP = 100;

/** 仍可作为回滚点的 userEntryId（最近 `keep` 个检查点，§1.3）。 */
export function rewindableIds(
  state: LoadedCheckpoints,
  keep = DEFAULT_CHECKPOINT_KEEP,
): Set<string> {
  const n = Math.max(0, Math.floor(keep));
  return new Set(n === 0 ? [] : state.order.slice(-n));
}

/** 该用户消息是否有可用检查点（含 keep 上限）。 */
export function isRewindable(
  state: LoadedCheckpoints,
  userEntryId: string,
  keep = DEFAULT_CHECKPOINT_KEEP,
): boolean {
  if (!state.byUserEntry.has(userEntryId)) return false;
  const index = state.order.lastIndexOf(userEntryId);
  return index >= 0 && index >= state.order.length - Math.max(0, Math.floor(keep));
}

/** 文件顺序上最后一个检查点（冲突检测的「最近检查点」）。 */
export function latestCheckpoint(state: LoadedCheckpoints): CheckpointData | undefined {
  const id = state.order[state.order.length - 1];
  return id === undefined ? undefined : state.byUserEntry.get(id);
}

/** 全部出现过的路径键（= 已跟踪文件）。 */
export function trackedKeys(state: LoadedCheckpoints): string[] {
  return [...state.earliest.keys()];
}
