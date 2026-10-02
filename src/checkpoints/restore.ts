/**
 * 恢复代码（docs/rewind-plan.md §3.2）。[RW-A]
 *
 * 对每个已跟踪文件，取目标检查点里的记录，没有则取该文件最早的记录：
 * 1. 记录 `skipped` → 报告 too_large / not_regular；
 *    （目标当前是符号链接 / 非普通文件时无法比较内容，直接按第 4 步报告 symlink / not_regular）
 * 2. 当前内容与记录相同 → 跳过（不计入）；
 * 3. 冲突：当前 sha256 ∉ {lastWritten，最近检查点的记录} → skip 时列入 conflicts 不动；
 * 4. 安全检查：nlink > 1、父目录 realpath ≠ realParentDir → skipped；备份 blob 不在 → backup_missing；
 * 5. `blob: null` → 删除（只删普通文件）；
 * 6. 写回：Windows 以外用 O_NOFOLLOW 打开，fstat 与 lstat 的 dev / ino 一致才写；清空后写入并恢复 mode；
 *    目标不存在时建父目录并再次校验；
 * 7. 被恢复 / 删除的绝对路径作为 `touched` 返回，由调用方从 readFiles 移除。
 *
 * 单文件的 1–6 是 `restoreFile`，结果汇总是 `settleFile`；影子 git（`shadow-restore.ts`）复用二者，
 * 只换掉「目标内容从哪来」（`load`）与「当前内容算不算已知」（`isKnown`）。
 *
 * `dryRun` 只做 1–4，并用行级 diff 计 insertions / deletions（复用 tools/edit 的 unifiedDiff）。
 */

import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { unifiedDiff } from "../tools/edit.js";
import {
  DEFAULT_MAX_FILE_BYTES,
  hashFile,
  isNotFound,
  keyToPath,
  readBlob,
  realParentOf,
} from "./blobs.js";
import { readGitHead } from "./git-head.js";
import { latestCheckpoint, type LoadedCheckpoints } from "./replay.js";
import type { CheckpointData, CodeRestoreResult, FileRecord, RewindSkipReason } from "./types.js";

export interface RestoreOptions {
  cwd: string;
  dataDir: string;
  /** 重放 / tracker 的状态（提供已跟踪文件、最早记录与最近检查点）。 */
  state: LoadedCheckpoints;
  /** 回滚目标。 */
  target: CheckpointData;
  /** ama 最后写入的内容哈希（绝对路径 → sha256）。 */
  lastWritten?: ReadonlyMap<string, string>;
  dryRun?: boolean;
  onConflict?: "skip" | "overwrite";
  /** 超过它的当前文件不读内容算行数（缺省 5 MiB）。 */
  maxDiffBytes?: number;
  /** 只处理这些路径键（缺省全部已跟踪文件）。 */
  keys?: Iterable<string>;
}

export interface RestoreOutcome {
  result: CodeRestoreResult;
  /** 被恢复 / 删除的绝对路径（dryRun 时为空）；调用方从 readFiles 移除。 */
  touched: string[];
}

/** 单文件不恢复的原因（安全检查不通过等）；`settleFile` 把它记进 `skipped`。 */
export class RestoreSkip extends Error {
  constructor(readonly reason: RewindSkipReason) {
    super(reason);
  }
}
const Skip = RestoreSkip;

const IS_WINDOWS = process.platform === "win32";
/** Windows 没有 O_NOFOLLOW（为 undefined）；只靠 lstat 与 fstat 的 dev / ino 比较。 */
const NOFOLLOW = IS_WINDOWS ? 0 : (constants.O_NOFOLLOW ?? 0);

/** 没有可恢复内容时的结果。 */
export function emptyCodeResult(): CodeRestoreResult {
  return {
    restored: [],
    deleted: [],
    conflicts: [],
    skipped: [],
    failed: [],
    insertions: 0,
    deletions: 0,
  };
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function toText(bytes: Buffer | undefined): string {
  return bytes === undefined ? "" : bytes.toString("utf8");
}

/** 行级增删数（current → target）。 */
export function countLineChanges(
  current: string,
  target: string,
): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  const diff = unifiedDiff(current, target, "f", 0);
  const lines = diff === "" ? [] : diff.split("\n").slice(2);
  for (const line of lines) {
    if (line.startsWith("+")) insertions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { insertions, deletions };
}

/** 恢复到目标检查点（§3.2）。 */
export async function restoreCheckpoint(options: RestoreOptions): Promise<RestoreOutcome> {
  const result = emptyCodeResult();
  const touched: string[] = [];
  const latest = latestCheckpoint(options.state);
  const maxDiff = options.maxDiffBytes ?? DEFAULT_MAX_FILE_BYTES;
  const only = options.keys === undefined ? undefined : new Set(options.keys);
  for (const [key, earliest] of options.state.earliest) {
    if (only !== undefined && !only.has(key)) continue;
    const record = options.target.files[key] ?? earliest;
    const abs = keyToPath(options.cwd, key);
    const known = new Set<string | null>();
    const written = options.lastWritten?.get(abs);
    if (written !== undefined) known.add(written);
    const latestRecord = latest?.files[key];
    if (latestRecord !== undefined && latestRecord.skipped === undefined) {
      known.add(latestRecord.blob);
    }
    await settleFile(result, touched, key, abs, options, () =>
      restoreFile(abs, record, {
        dataDir: options.dataDir,
        ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
        ...(options.onConflict !== undefined ? { onConflict: options.onConflict } : {}),
        maxDiff,
        isKnown: (hash) => known.has(hash),
      }),
    );
  }
  return { result, touched };
}

/** 单文件恢复的环境。 */
export interface FileRestoreContext {
  dataDir: string;
  dryRun?: boolean;
  onConflict?: "skip" | "overwrite";
  /** 超过它的当前文件不读内容算行数。 */
  maxDiff: number;
  /** 当前内容（sha256；不存在为 null）是 ama 写的或最近检查点记录的 → 不算冲突（§3.2 第 3 步）。 */
  isKnown(currentHash: string | null): boolean;
  /** 取目标内容；缺省按 `record.blob` 读备份。返回 undefined → backup_missing。 */
  load?(record: FileRecord): Promise<Buffer | undefined>;
}

export interface FileOutcome {
  deleted: boolean;
  conflict: boolean;
  insertions: number;
  deletions: number;
}

/** 执行单文件恢复并把结果并进 `result` / `touched`（RestoreSkip → skipped，其它错误 → failed）。 */
export async function settleFile(
  result: CodeRestoreResult,
  touched: string[],
  key: string,
  abs: string,
  options: { dryRun?: boolean; onConflict?: "skip" | "overwrite" },
  work: () => Promise<FileOutcome | undefined>,
): Promise<void> {
  try {
    const outcome = await work();
    if (outcome === undefined) return;
    if (outcome.conflict) result.conflicts.push(key);
    if (outcome.conflict && options.onConflict !== "overwrite") return;
    result.insertions += outcome.insertions;
    result.deletions += outcome.deletions;
    if (outcome.deleted) result.deleted.push(key);
    else result.restored.push(key);
    if (options.dryRun !== true) touched.push(abs);
  } catch (error) {
    if (error instanceof RestoreSkip) result.skipped.push({ path: key, reason: error.reason });
    else
      result.failed.push({
        path: key,
        message: error instanceof Error ? error.message : String(error),
      });
  }
}

/** §3.2 的 1–6（单个文件）；内容相同返回 undefined。 */
export async function restoreFile(
  abs: string,
  record: FileRecord,
  options: FileRestoreContext,
): Promise<FileOutcome | undefined> {
  // 1. 记录时就没备份
  if (record.skipped !== undefined) throw new Skip(record.skipped);
  // 当前状态
  const info = await lstatOrUndefined(abs);
  if (info?.isSymbolicLink() === true) throw new Skip("symlink");
  if (info !== undefined && !info.isFile()) throw new Skip("not_regular");
  const currentHash = info === undefined ? null : await hashFile(abs);
  // 2. 内容相同
  if (currentHash === record.blob) return undefined;
  // 3. 冲突
  const conflict = !options.isKnown(currentHash);
  if (conflict && options.onConflict !== "overwrite") {
    return { deleted: record.blob === null, conflict, insertions: 0, deletions: 0 };
  }
  // 4. 安全检查
  if (info !== undefined && info.nlink > 1) throw new Skip("hardlink");
  await checkParent(abs, record);
  const targetBytes =
    record.blob === null
      ? undefined
      : await (options.load ?? ((r) => readBlob(options.dataDir, r.blob as string)))(record);
  if (record.blob !== null && targetBytes === undefined) throw new Skip("backup_missing");
  const currentBytes =
    info !== undefined && info.size <= options.maxDiff ? await readFile(abs) : undefined;
  const counted =
    info !== undefined && currentBytes === undefined
      ? { insertions: 0, deletions: 0 }
      : countLineChanges(toText(currentBytes), toText(targetBytes));
  const outcome: FileOutcome = { deleted: record.blob === null, conflict, ...counted };
  if (options.dryRun === true) return outcome;
  if (record.blob === null) {
    // 5. 删除（当前一定存在：不存在时第 2 步已跳过）
    await removeRegular(abs, info as Stats);
  } else {
    // 6. 写回
    await writeBack(abs, targetBytes as Buffer, record, info);
  }
  return outcome;
}

async function checkParent(abs: string, record: FileRecord): Promise<void> {
  if (record.realParentDir === undefined) return;
  const real = await realParentOf(abs);
  if (real !== undefined && real !== record.realParentDir) throw new Skip("parent_moved");
}

async function removeRegular(abs: string, before: Stats): Promise<void> {
  const now = await lstatOrUndefined(abs);
  if (now === undefined) return;
  if (now.isSymbolicLink()) throw new Skip("symlink");
  if (!now.isFile()) throw new Skip("not_regular");
  if (now.nlink > 1) throw new Skip("hardlink");
  if (now.dev !== before.dev || now.ino !== before.ino) throw new Error("文件在恢复期间被替换");
  await unlink(abs);
}

async function writeBack(
  abs: string,
  bytes: Buffer,
  record: FileRecord,
  before: Stats | undefined,
): Promise<void> {
  if (before === undefined) {
    const parent = dirname(abs);
    await mkdir(parent, { recursive: true });
    if (record.realParentDir !== undefined && (await realpath(parent)) !== record.realParentDir) {
      throw new Skip("parent_moved");
    }
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
    const handle = await open(abs, flags, record.mode ?? 0o644);
    try {
      await handle.writeFile(bytes);
      if (record.mode !== undefined) await handle.chmod(record.mode);
    } finally {
      await handle.close();
    }
    return;
  }
  let handle;
  try {
    handle = await open(abs, constants.O_WRONLY | NOFOLLOW);
  } catch (error) {
    // O_NOFOLLOW 打开符号链接：ELOOP（Linux / macOS）或 EMLINK（FreeBSD）
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") throw new Skip("symlink");
    throw error;
  }
  try {
    const opened = await handle.stat();
    const now = await lstat(abs);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      now.dev !== opened.dev ||
      now.ino !== opened.ino
    ) {
      throw new Error("文件在恢复期间被替换");
    }
    if (opened.nlink > 1) throw new Skip("hardlink");
    await handle.truncate(0);
    await handle.write(bytes, 0, bytes.length, 0);
    if (record.mode !== undefined) await handle.chmod(record.mode);
  } finally {
    await handle.close();
  }
}

/** 记录的 HEAD 与当前不同时给出（只提示，不操作 git）。 */
export async function gitHintFor(
  cwd: string,
  target: CheckpointData,
): Promise<{ recordedHead: string; currentHead: string } | undefined> {
  if (target.git === undefined) return undefined;
  const current = await readGitHead(cwd);
  if (current === undefined || current.head === target.git.head) return undefined;
  return { recordedHead: target.git.head, currentHead: current.head };
}
