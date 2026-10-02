/**
 * 检查点运行时状态（docs/rewind-plan.md §1.3、§2）。[RW-A]
 *
 * - `beforeWrite`：文件在任何检查点里都没出现过 → 备份当前内容、追加 `ama.checkpoint-track`、
 *   加入已跟踪；出现过则什么都不做。失败只 warn，不抛（检查点是辅助，不能让编辑失败）。
 * - `afterWrite`：记 `lastWritten`（ama 最后写入内容的 sha256，冲突检测用；只在内存）。
 * - `snapshot(userEntryId)`：新回合用户消息落盘后，对每个已跟踪文件按 §2 第一行的规则重拍，追加
 *   `ama.checkpoint`。沿用判断：size / mode 与上一条一致且 mtime 早于记录时间减去
 *   `MTIME_GRANULARITY_MS`（文件系统时间戳粒度的余量）；否则算哈希，相同仍沿用。
 * - 只经注入的 `append(customType, data)` 写条目，不依赖会话实现。
 */

import { lstat, readFile } from "node:fs/promises";
import { readGitHead } from "./git-head.js";
import {
  DEFAULT_MAX_FILE_BYTES,
  hashBytes,
  isNotFound,
  keyToPath,
  pathKey,
  putBlob,
  realParentOf,
  recordFile,
  type RecordedFile,
} from "./blobs.js";
import { applyCheckpoint, applyTrack, emptyCheckpoints, type LoadedCheckpoints } from "./replay.js";
import {
  CHECKPOINT_CUSTOM_TYPE,
  CHECKPOINT_TRACK_CUSTOM_TYPE,
  type CheckpointData,
  type CheckpointHooks,
  type CheckpointTrackData,
  type FileRecord,
} from "./types.js";
import { msg } from "../i18n/index.js";

/** mtime 粒度余量（FAT 2 s；其它文件系统更细）。 */
export const MTIME_GRANULARITY_MS = 2_000;

export interface CheckpointTrackerOptions {
  cwd: string;
  dataDir: string;
  /** 缺省 5 MiB。 */
  maxFileBytes?: number;
  /** 追加 custom 条目（`ama.checkpoint` / `ama.checkpoint-track`）。 */
  append(customType: string, data: unknown): void;
  /** 当前回合的用户消息 id；不给时用最近一次 `snapshot` 的 id。 */
  currentTurn?(): string | undefined;
  warn?(message: string): void;
  /** 从会话条目重放的状态（`loadCheckpoints`）；缺省为空。 */
  initial?: LoadedCheckpoints;
  /** 测试用。 */
  now?(): number;
  /** 测试用：读 HEAD（缺省 `readGitHead`）。 */
  readHead?(cwd: string): Promise<{ head: string; branch?: string } | undefined>;
}

export class CheckpointTracker implements CheckpointHooks {
  readonly state: LoadedCheckpoints;
  /** ama 最后一次写入后的内容哈希（绝对路径 → sha256）。 */
  readonly lastWritten = new Map<string, string>();
  private readonly cwd: string;
  private readonly dataDir: string;
  private readonly maxFileBytes: number;
  private readonly options: CheckpointTrackerOptions;
  private readonly inflight = new Map<string, Promise<void>>();
  /** 记录的真实时间（键 → 毫秒）；覆盖条目时间（条目时间晚于读取，不能用于沿用判断以外）。 */
  private readonly recordedAt = new Map<string, number>();
  private lastSnapshotId: string | undefined;

  constructor(options: CheckpointTrackerOptions) {
    this.options = options;
    this.cwd = options.cwd;
    this.dataDir = options.dataDir;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.state = options.initial ?? emptyCheckpoints();
    this.lastSnapshotId = this.state.order[this.state.order.length - 1];
  }

  /** 已跟踪文件的绝对路径。 */
  get trackedFiles(): ReadonlySet<string> {
    return new Set([...this.state.earliest.keys()].map((key) => keyToPath(this.cwd, key)));
  }

  isTracked(absolutePath: string): boolean {
    return this.state.earliest.has(pathKey(this.cwd, absolutePath));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private warn(message: string): void {
    this.options.warn?.(message);
  }

  private currentTurn(): string | undefined {
    return this.options.currentTurn !== undefined
      ? this.options.currentTurn()
      : this.lastSnapshotId;
  }

  async beforeWrite(absolutePath: string): Promise<void> {
    const key = pathKey(this.cwd, absolutePath);
    if (this.state.earliest.has(key)) return;
    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending;
    const work = this.track(key, absolutePath).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private async track(key: string, absolutePath: string): Promise<void> {
    try {
      const { record, at } = await recordFile(absolutePath, {
        dataDir: this.dataDir,
        maxFileBytes: this.maxFileBytes,
      });
      if (this.state.earliest.has(key)) return;
      const turn = this.currentTurn();
      if (turn !== undefined) {
        const data: CheckpointTrackData = { v: 1, userEntryId: turn, path: key, record };
        this.options.append(CHECKPOINT_TRACK_CUSTOM_TYPE, data);
        applyTrack(this.state, data, at);
      } else {
        // 没有回合（宿主未接 snapshot）：只在内存里跟踪，下一次 snapshot 会把它收进检查点。
        this.state.earliest.set(key, record);
        this.state.latest.set(key, { record, at });
      }
      this.recordedAt.set(key, at);
    } catch (error) {
      this.warn(msg().session.checkpoints.backupFailed(key, describe(error)));
    }
  }

  afterWrite(absolutePath: string, content: Uint8Array | string): void {
    try {
      this.lastWritten.set(absolutePath, hashBytes(content));
    } catch (error) {
      this.warn(msg().session.checkpoints.recordFailed(absolutePath, describe(error)));
    }
  }

  /** 新回合：重拍全部已跟踪文件，追加 `ama.checkpoint`，返回它。`extra.shadowCommit` 来自影子 git。 */
  async snapshot(
    userEntryId: string,
    extra: { shadowCommit?: string } = {},
  ): Promise<CheckpointData> {
    this.lastSnapshotId = userEntryId;
    const files: Record<string, FileRecord> = {};
    const times = new Map<string, number>();
    for (const key of [...this.state.earliest.keys()]) {
      const previous = this.state.latest.get(key);
      const prev =
        previous === undefined
          ? undefined
          : { record: previous.record, at: this.recordedAt.get(key) ?? previous.at };
      try {
        const next = await this.snapshotFile(keyToPath(this.cwd, key), prev);
        files[key] = next.record;
        times.set(key, next.at);
      } catch (error) {
        this.warn(msg().session.checkpoints.snapshotFailed(key, describe(error)));
      }
    }
    const data: CheckpointData = { v: 1, userEntryId, files };
    if (extra.shadowCommit !== undefined) data.shadowCommit = extra.shadowCommit;
    try {
      const git = await (this.options.readHead ?? readGitHead)(this.cwd);
      if (git !== undefined) data.git = git;
    } catch {
      // 读不到 HEAD 不影响检查点
    }
    this.options.append(CHECKPOINT_CUSTOM_TYPE, data);
    applyCheckpoint(this.state, data, this.now());
    for (const [key, at] of times) this.recordedAt.set(key, at);
    return data;
  }

  private async snapshotFile(
    absolutePath: string,
    prev: RecordedFile | undefined,
  ): Promise<RecordedFile> {
    const at = this.now();
    let info;
    try {
      info = await lstat(absolutePath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (prev !== undefined && prev.record.blob === null && prev.record.skipped === undefined)
        return prev;
      const realParentDir = await realParentOf(absolutePath);
      return {
        record: { blob: null, ...(realParentDir !== undefined ? { realParentDir } : {}) },
        at,
      };
    }
    if (!info.isFile()) {
      if (prev?.record.skipped === "not_regular") return prev;
      return { record: { blob: null, skipped: "not_regular" }, at };
    }
    const mode = info.mode & 0o7777;
    const p = prev?.record;
    const sameMeta = p !== undefined && p.blob !== null && p.size === info.size && p.mode === mode;
    if (sameMeta && prev !== undefined && info.mtimeMs <= prev.at - MTIME_GRANULARITY_MS)
      return prev;
    const realParentDir = await realParentOf(absolutePath);
    const base = {
      mode,
      size: info.size,
      ...(realParentDir !== undefined ? { realParentDir } : {}),
    };
    if (info.size > this.maxFileBytes) {
      if (p?.skipped === "too_large" && p.size === info.size && p.mode === mode)
        return prev as RecordedFile;
      return { record: { blob: null, ...base, skipped: "too_large" }, at };
    }
    const bytes = await readFile(absolutePath);
    const hash = hashBytes(bytes);
    if (
      p !== undefined &&
      p.blob === hash &&
      p.mode === mode &&
      p.realParentDir === realParentDir
    ) {
      return { record: p, at };
    }
    await putBlob(this.dataDir, bytes, hash);
    return { record: { blob: hash, ...base, size: bytes.length }, at };
  }
}

export function createCheckpointTracker(options: CheckpointTrackerOptions): CheckpointTracker {
  return new CheckpointTracker(options);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
