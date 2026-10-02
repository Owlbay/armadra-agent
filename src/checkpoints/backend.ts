/**
 * 会话侧的检查点后端（与 RW-B 约定的接口）。[RW-A]
 *
 * 会话（`src/agent/session-rewind.ts`）只经这里的接口使用检查点：工厂拿到会话上下文后返回后端；
 * 内存会话不调工厂，`mode: "off"` 时工厂返回 undefined。条目重放在第一次使用时惰性执行。
 *
 * `shadow-git`（§6，RW-D）：在 tools 的基础上，每个新回合先做影子快照，提交 id 记进
 * `CheckpointData.shadowCommit`；恢复时目标有影子提交就以影子差异为准（同时覆盖 edit / write 跟踪的文件），
 * 否则回退 tools。git 不可用、cwd 是家目录或根目录、文件数或快照耗时超限 → 本会话降级为 tools 并 warn 一次。
 */

import type { SessionEntry } from "../session/types.js";
import { registerSessionRoot } from "./gc.js";
import { loadCheckpoints, isRewindable } from "./replay.js";
import { emptyCodeResult, gitHintFor, restoreCheckpoint } from "./restore.js";
import {
  GitMissingError,
  ShadowRepo,
  unsafeShadowCwd,
  type ShadowGitOptions,
} from "./shadow-git.js";
import { latestShadowCommit, restoreFromShadow } from "./shadow-restore.js";
import { CheckpointTracker } from "./tracker.js";
import type { CheckpointHooks, CheckpointMode, CodeRestoreResult } from "./types.js";
import { msg } from "../i18n/index.js";

export interface CheckpointBackendContext {
  cwd: string;
  /** 全部会话条目（重放 ama.checkpoint* 用；不限活动分支）。 */
  entries(): readonly SessionEntry[];
  /** 追加 custom 条目（ama.checkpoint / ama.checkpoint-track）。 */
  appendCustom(customType: string, data: unknown): void;
  /** 当前回合的用户消息 id（beforeWrite 追加 checkpoint-track 时用；无回合时 undefined）。 */
  currentTurn(): string | undefined;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface CheckpointBackend {
  /** 交给 ToolContext.checkpoint（子会话共用父会话的这一份）。 */
  readonly hooks: CheckpointHooks;
  /** 新回合用户消息落盘后调用。 */
  snapshot(userEntryId: string): Promise<void>;
  /** 该用户消息有可用检查点（含 keep 上限）。 */
  hasCheckpoint(userEntryId: string): boolean;
  /**
   * 恢复到 userEntryId 之前；dryRun 只做 §3.2 1–4 + diff。
   * touched = 被恢复 / 删除文件的绝对路径（从 readFiles 移除；dryRun 时为空）。
   */
  restore(
    userEntryId: string,
    options: { dryRun: boolean; onConflict: "skip" | "overwrite" },
  ): Promise<{ result: CodeRestoreResult; touched: string[] }>;
  /** 记录的 HEAD 与当前不同时返回。 */
  gitHint(userEntryId: string): Promise<{ recordedHead: string; currentHead: string } | undefined>;
}

export type CheckpointBackendFactory = (
  ctx: CheckpointBackendContext,
) => CheckpointBackend | undefined;

export interface CheckpointBackendSettings {
  mode: CheckpointMode;
  dataDir: string;
  maxFileBytes?: number;
  keep?: number;
  /** 会话根目录：登记进 file-history/roots.json，GC 标记时会扫描它。 */
  sessionsRoot?: string;
  /** 影子 git 的参数（测试注入阈值、git 路径、环境）。 */
  shadow?: ShadowGitOptions & { homeDir?: string };
}

export function createCheckpointBackendFactory(
  settings: CheckpointBackendSettings,
): CheckpointBackendFactory {
  return (ctx) => {
    if (settings.mode === "off") return undefined;
    let tracker: CheckpointTracker | undefined;
    let registered = false;
    const warn = (message: string): void => ctx.log("warn", message);
    const get = (): CheckpointTracker => {
      tracker ??= new CheckpointTracker({
        cwd: ctx.cwd,
        dataDir: settings.dataDir,
        ...(settings.maxFileBytes !== undefined ? { maxFileBytes: settings.maxFileBytes } : {}),
        append: (customType, data) => ctx.appendCustom(customType, data),
        currentTurn: () => ctx.currentTurn(),
        warn,
        initial: loadCheckpoints(ctx.entries()),
      });
      if (!registered && settings.sessionsRoot !== undefined) {
        registered = true;
        registerSessionRoot(settings.dataDir, settings.sessionsRoot).catch((error: unknown) =>
          ctx.log("debug", msg().session.checkpoints.registerFailed(String(error))),
        );
      }
      return tracker;
    };
    // 影子 git：undefined = 未建；null = 本会话不用（模式不是 shadow-git 或已降级）
    let shadow: ShadowRepo | null | undefined = settings.mode === "shadow-git" ? undefined : null;
    const degrade = (message: string): void => {
      shadow = null;
      warn(msg().session.checkpoints.shadowUnavailable(message));
    };
    const getShadow = (): ShadowRepo | null => {
      if (shadow !== undefined) return shadow;
      const unsafe = unsafeShadowCwd(ctx.cwd, settings.shadow?.homeDir);
      if (unsafe !== undefined) {
        degrade(unsafe);
        return null;
      }
      shadow = new ShadowRepo(settings.dataDir, ctx.cwd, settings.shadow ?? {});
      return shadow;
    };
    const shadowSnapshot = async (userEntryId: string): Promise<string | undefined> => {
      const repo = getShadow();
      if (repo === null) return undefined;
      try {
        const parent = latestShadowCommit(get().state);
        const snap = await repo.snapshot(parent, `ama checkpoint ${userEntryId}`);
        if (snap.degrade !== undefined) degrade(snap.degrade.message);
        return snap.commit;
      } catch (error) {
        degrade(
          error instanceof GitMissingError ? msg().session.checkpoints.gitMissing : describe(error),
        );
        return undefined;
      }
    };
    const hooks: CheckpointHooks = {
      beforeWrite: (absolutePath) => get().beforeWrite(absolutePath),
      afterWrite: (absolutePath, content) => get().afterWrite(absolutePath, content),
    };
    return {
      hooks,
      snapshot: async (userEntryId) => {
        try {
          const shadowCommit = await shadowSnapshot(userEntryId);
          await get().snapshot(userEntryId, shadowCommit !== undefined ? { shadowCommit } : {});
        } catch (error) {
          warn(msg().session.checkpoints.createFailed(describe(error)));
        }
      },
      hasCheckpoint: (userEntryId) => isRewindable(get().state, userEntryId, settings.keep),
      restore: async (userEntryId, options) => {
        const t = get();
        const target = t.state.byUserEntry.get(userEntryId);
        if (target === undefined || !isRewindable(t.state, userEntryId, settings.keep)) {
          return { result: emptyCodeResult(), touched: [] };
        }
        const base = {
          cwd: ctx.cwd,
          dataDir: settings.dataDir,
          state: t.state,
          target,
          lastWritten: t.lastWritten,
          dryRun: options.dryRun,
          onConflict: options.onConflict,
          ...(settings.maxFileBytes !== undefined ? { maxDiffBytes: settings.maxFileBytes } : {}),
        };
        // 有影子提交就以影子差异为准（降级前留下的提交照样可用）；影子不可用时回退 tools
        if (target.shadowCommit !== undefined && settings.mode === "shadow-git") {
          const unsafe = unsafeShadowCwd(ctx.cwd, settings.shadow?.homeDir);
          if (unsafe === undefined) {
            const repo = shadow ?? new ShadowRepo(settings.dataDir, ctx.cwd, settings.shadow ?? {});
            try {
              return await restoreFromShadow({
                ...base,
                repo,
                ...(settings.maxFileBytes !== undefined
                  ? { maxFileBytes: settings.maxFileBytes }
                  : {}),
              });
            } catch (error) {
              warn(msg().session.checkpoints.shadowRestoreFailed(describe(error)));
            }
          }
        }
        return restoreCheckpoint(base);
      },
      gitHint: async (userEntryId) => {
        const target = get().state.byUserEntry.get(userEntryId);
        return target === undefined ? undefined : gitHintFor(ctx.cwd, target);
      },
    };
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
