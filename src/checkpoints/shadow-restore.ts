/**
 * 按影子提交恢复代码（docs/history/rewind-plan.md §6）。[RW-D]
 *
 * 1. 把当前工作区写成树，与目标提交做 `diff-tree`：只处理有差异的文件，被忽略的文件不在两边的树里，不会被碰。
 *    目标里有、当前树里没有但磁盘上还在的文件（现在被忽略了）跳过。
 * 2. 每个差异文件交给 `restore.ts` 的 `restoreFile`，冲突与安全检查语义与 tools 模式相同：
 *    - 「已知」= 当前内容等于最近一个影子提交里的内容，或等于 ama 最后写入的、最近检查点记录的；
 *      其余视为回合外的改动（冲突），缺省跳过。
 *    - 父目录应为 `realpath(cwd)/<相对目录>`（路径上有符号链接目录 → parent_moved）。
 *    - 目标是符号链接 / 子模块 → not_regular；目标 blob 超过 maxFileBytes → too_large。
 *    - 权限只在可执行位与目标不同时调整（git 只记 644 / 755），新建文件按目标的可执行位。
 * 3. edit / write 跟踪的文件不在影子树里（cwd 外、被忽略）时，按 tools 的记录恢复。
 */

import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DEFAULT_MAX_FILE_BYTES, hashBytes, keyToPath } from "./blobs.js";
import { latestCheckpoint, type LoadedCheckpoints } from "./replay.js";
import {
  emptyCodeResult,
  restoreCheckpoint,
  restoreFile,
  settleFile,
  type RestoreOptions,
  type RestoreOutcome,
} from "./restore.js";
import {
  MODE_ABSENT,
  MODE_EXECUTABLE,
  MODE_GITLINK,
  MODE_SYMLINK,
  type ShadowChange,
  type ShadowRepo,
} from "./shadow-git.js";
import type { CodeRestoreResult, FileRecord } from "./types.js";
import { msg } from "../i18n/index.js";

export interface ShadowRestoreOptions extends RestoreOptions {
  repo: ShadowRepo;
  /** 目标提交里超过它的文件报告 too_large（缺省 5 MiB）。 */
  maxFileBytes?: number;
}

const IS_WINDOWS = process.platform === "win32";

/** 文件顺序上最后一个带影子提交的检查点。 */
export function latestShadowCommit(state: LoadedCheckpoints): string | undefined {
  for (let i = state.order.length - 1; i >= 0; i--) {
    const commit = state.byUserEntry.get(state.order[i] as string)?.shadowCommit;
    if (commit !== undefined) return commit;
  }
  return undefined;
}

/** 目标检查点没有影子提交、或提交已不在影子仓库里时抛错（调用方回退到 tools）。 */
export async function restoreFromShadow(options: ShadowRestoreOptions): Promise<RestoreOutcome> {
  const { repo } = options;
  const target = options.target.shadowCommit;
  if (target === undefined) throw new Error(msg().session.checkpoints.noShadowCommit);
  if (!(await repo.hasCommit(target)))
    throw new Error(msg().session.checkpoints.shadowCommitMissing(target.slice(0, 12)));
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const current = await repo.currentTree();
  const changes = (await repo.diff(target, current)).filter(
    (c) => c.oldMode !== MODE_GITLINK && c.newMode !== MODE_GITLINK,
  );
  const baseline = latestShadowCommit(options.state);
  const changedSinceBaseline =
    baseline === undefined ? undefined : new Set((await repo.diff(baseline, current)).map(pathOf));
  const blobs = await repo.readBlobs(
    changes.filter((c) => isRegularMode(c.oldMode)).map((c) => c.oldOid),
    maxBytes,
  );
  const realCwd = await realpath(options.cwd);
  const latest = latestCheckpoint(options.state);
  const result = emptyCodeResult();
  const touched: string[] = [];

  for (const change of changes) {
    const key = change.path;
    const abs = keyToPath(options.cwd, key);
    const record = await targetRecord(change, abs, realCwd, blobs);
    if (record === undefined) continue;
    const known = new Set<string | null>();
    const written = options.lastWritten?.get(abs);
    if (written !== undefined) known.add(written);
    const latestRecord = latest?.files[key];
    if (latestRecord !== undefined && latestRecord.skipped === undefined) {
      known.add(latestRecord.blob);
    }
    const content = record.blob === null ? undefined : blobs.get(change.oldOid);
    await settleFile(result, touched, key, abs, options, () =>
      restoreFile(abs, record, {
        dataDir: options.dataDir,
        ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
        ...(options.onConflict !== undefined ? { onConflict: options.onConflict } : {}),
        maxDiff: options.maxDiffBytes ?? maxBytes,
        isKnown: (hash) =>
          (changedSinceBaseline !== undefined && !changedSinceBaseline.has(key)) || known.has(hash),
        load: async () => content,
      }),
    );
  }

  // edit / write 跟踪、但不在影子树里的文件（cwd 外、被忽略）：按 tools 的记录恢复
  const covered = new Set([...(await repo.paths(target)), ...(await repo.paths(current))]);
  const rest = [...options.state.earliest.keys()].filter((k) => isAbsolute(k) || !covered.has(k));
  if (rest.length > 0) {
    const extra = await restoreCheckpoint({ ...options, keys: rest });
    merge(result, extra.result);
    touched.push(...extra.touched);
  }
  return { result, touched };
}

function pathOf(change: ShadowChange): string {
  return change.path;
}

function isRegularMode(mode: string): boolean {
  return mode.startsWith("100");
}

/** 目标提交里这个路径应有的状态；undefined = 不处理。 */
async function targetRecord(
  change: ShadowChange,
  abs: string,
  realCwd: string,
  blobs: ReadonlyMap<string, Buffer>,
): Promise<FileRecord | undefined> {
  const slash = change.path.lastIndexOf("/");
  const realParentDir =
    slash < 0 ? realCwd : join(realCwd, ...change.path.slice(0, slash).split("/"));
  const info = await lstat(abs).catch(() => undefined);
  if (change.newMode === MODE_ABSENT && info !== undefined) {
    // 当前树里没有、磁盘上却有：现在被忽略了（或读不了），不碰
    return undefined;
  }
  if (change.oldMode === MODE_ABSENT) return { blob: null, realParentDir };
  if (change.oldMode === MODE_SYMLINK || !isRegularMode(change.oldMode)) {
    return { blob: null, skipped: "not_regular" };
  }
  const bytes = blobs.get(change.oldOid);
  if (bytes === undefined) return { blob: null, skipped: "too_large" };
  const record: FileRecord = { blob: hashBytes(bytes), size: bytes.length, realParentDir };
  const executable = change.oldMode === MODE_EXECUTABLE;
  if (!IS_WINDOWS) {
    if (info === undefined || !info.isFile()) record.mode = executable ? 0o755 : 0o644;
    else {
      const mode = info.mode & 0o7777;
      const isExec = (mode & 0o111) !== 0;
      if (isExec !== executable) {
        record.mode = executable ? mode | ((mode & 0o444) >> 2) : mode & ~0o111;
      }
    }
  }
  return record;
}

function merge(into: CodeRestoreResult, from: CodeRestoreResult): void {
  into.restored.push(...from.restored);
  into.deleted.push(...from.deleted);
  into.conflicts.push(...from.conflicts);
  into.skipped.push(...from.skipped);
  into.failed.push(...from.failed);
  into.insertions += from.insertions;
  into.deletions += from.deletions;
}
