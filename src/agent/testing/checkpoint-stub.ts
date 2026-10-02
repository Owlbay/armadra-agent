/**
 * 检查点后端的内存桩（RW-B 测试用；RW-A 的真实现就绪后集成测试可换成它）。
 *
 * 语义按 rewind-plan §2 / §3.2 的最小子集：第一次 beforeWrite 记下文件原内容（记到当前回合），
 * snapshot 按当前磁盘内容重拍已跟踪文件；restore 取目标检查点里的记录，没有则取最早记录，
 * 与磁盘不同就写回或删除。备份内容只在内存。记录每次调用，供断言。
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { CHECKPOINT_CUSTOM_TYPE, type CodeRestoreResult } from "../../checkpoints/types.js";
import type {
  CheckpointBackend,
  CheckpointBackendContext,
  CheckpointBackendFactory,
} from "../../checkpoints/index.js";

type Content = string | null;

export interface StubCheckpointBackend extends CheckpointBackend {
  readonly ctx: CheckpointBackendContext;
  readonly snapshots: string[];
  readonly beforeWrites: { path: string; turn: string | undefined }[];
  readonly restores: { userEntryId: string; dryRun: boolean; onConflict: string }[];
  /** 设了就让每个文件的写回失败。 */
  failRestore: boolean;
  gitHintValue: { recordedHead: string; currentHead: string } | undefined;
}

function readOrNull(path: string): Content {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function stubCheckpoints(): {
  factory: CheckpointBackendFactory;
  backends: StubCheckpointBackend[];
} {
  const backends: StubCheckpointBackend[] = [];
  const factory: CheckpointBackendFactory = (ctx) => {
    const earliest = new Map<string, Content>();
    const checkpoints = new Map<string, Map<string, Content>>();
    const key = (path: string): string => relative(ctx.cwd, path).split(sep).join("/");
    const backend: StubCheckpointBackend = {
      ctx,
      snapshots: [],
      beforeWrites: [],
      restores: [],
      failRestore: false,
      gitHintValue: undefined,
      hooks: {
        beforeWrite: async (path) => {
          const turn = ctx.currentTurn();
          backend.beforeWrites.push({ path, turn });
          if (earliest.has(path)) return;
          const content = readOrNull(path);
          earliest.set(path, content);
          if (turn !== undefined) checkpoints.get(turn)?.set(path, content);
        },
        afterWrite: () => undefined,
      },
      snapshot: async (userEntryId) => {
        backend.snapshots.push(userEntryId);
        const files = new Map<string, Content>();
        for (const path of earliest.keys()) files.set(path, readOrNull(path));
        checkpoints.set(userEntryId, files);
        ctx.appendCustom(CHECKPOINT_CUSTOM_TYPE, { v: 1, userEntryId, files: {} });
      },
      hasCheckpoint: (userEntryId) => checkpoints.has(userEntryId),
      restore: async (userEntryId, options) => {
        backend.restores.push({ userEntryId, ...options });
        const result: CodeRestoreResult = {
          restored: [],
          deleted: [],
          conflicts: [],
          skipped: [],
          failed: [],
          insertions: 0,
          deletions: 0,
        };
        const touched: string[] = [];
        const target = checkpoints.get(userEntryId);
        for (const [path, first] of earliest) {
          const want = target?.has(path) === true ? (target.get(path) as Content) : first;
          const have = readOrNull(path);
          if (want === have) continue;
          if (backend.failRestore) {
            result.failed.push({ path: key(path), message: "EACCES" });
            continue;
          }
          if (want === null) result.deleted.push(key(path));
          else result.restored.push(key(path));
          result.insertions += want === null ? 0 : want.split("\n").length;
          result.deletions += have === null ? 0 : have.split("\n").length;
          if (options.dryRun) continue;
          if (want === null) rmSync(path);
          else writeFileSync(path, want);
          touched.push(path);
        }
        return { result, touched };
      },
      gitHint: async () => backend.gitHintValue,
    };
    backends.push(backend);
    return backend;
  };
  return { factory, backends };
}
