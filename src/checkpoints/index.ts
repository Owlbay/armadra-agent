/**
 * 检查点（docs/rewind-plan.md）的对外入口。[RW-A]
 *
 * 会话接线（RW-B）用 `createCheckpointBackendFactory` + `resolveCheckpointSettings`；
 * 其余导出给 CLI（GC、占用）与测试。
 */

export * from "./types.js";
export {
  createCheckpointBackendFactory,
  type CheckpointBackend,
  type CheckpointBackendContext,
  type CheckpointBackendFactory,
  type CheckpointBackendSettings,
} from "./backend.js";
export { resolveCheckpointSettings, type CheckpointSettings } from "./settings.js";
export {
  CheckpointTracker,
  createCheckpointTracker,
  type CheckpointTrackerOptions,
} from "./tracker.js";
export {
  isRewindable,
  latestCheckpoint,
  loadCheckpoints,
  rewindableIds,
  trackedKeys,
  type CheckpointEntryLike,
  type LoadedCheckpoints,
} from "./replay.js";
export {
  countLineChanges,
  emptyCodeResult,
  gitHintFor,
  restoreCheckpoint,
  type RestoreOptions,
  type RestoreOutcome,
} from "./restore.js";
export {
  collectBlobRefs,
  formatBytes,
  gcBlobs,
  readSessionRoots,
  registerSessionRoot,
  type GcOptions,
  type GcResult,
} from "./gc.js";
export {
  blobPath,
  blobUsage,
  fileHistoryDir,
  hashBytes,
  keyToPath,
  pathKey,
  putBlob,
  readBlob,
  recordFile,
  type BlobUsage,
} from "./blobs.js";
export { readGitHead, type GitHead } from "./git-head.js";
export {
  SHADOW_MAX_FILES,
  SHADOW_MAX_SNAPSHOT_MS,
  ShadowRepo,
  shadowRepoDir,
  shadowUsage,
  type ShadowGitOptions,
} from "./shadow-git.js";
export { restoreFromShadow, type ShadowRestoreOptions } from "./shadow-restore.js";
