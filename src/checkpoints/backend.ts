/**
 * 会话侧的检查点后端（与 RW-B 约定的接口）。[RW-A]
 *
 * 会话（`src/agent/session-rewind.ts`）只经这里的接口使用检查点：工厂拿到会话上下文后返回后端；
 * 内存会话不调工厂，`mode: "off"` 时工厂返回 undefined。条目重放在第一次使用时惰性执行。
 * `shadow-git` 在 RW-D 落地前按 `tools` 处理。
 */

import type { SessionEntry } from "../session/types.js";
import { registerSessionRoot } from "./gc.js";
import { loadCheckpoints, isRewindable } from "./replay.js";
import { emptyCodeResult, gitHintFor, restoreCheckpoint } from "./restore.js";
import { CheckpointTracker } from "./tracker.js";
import type { CheckpointHooks, CheckpointMode, CodeRestoreResult } from "./types.js";

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
          ctx.log("debug", `检查点：登记会话目录失败（${String(error)}）`),
        );
      }
      return tracker;
    };
    const hooks: CheckpointHooks = {
      beforeWrite: (absolutePath) => get().beforeWrite(absolutePath),
      afterWrite: (absolutePath, content) => get().afterWrite(absolutePath, content),
    };
    return {
      hooks,
      snapshot: async (userEntryId) => {
        try {
          await get().snapshot(userEntryId);
        } catch (error) {
          warn(`检查点：建立失败（${error instanceof Error ? error.message : String(error)}）`);
        }
      },
      hasCheckpoint: (userEntryId) => isRewindable(get().state, userEntryId, settings.keep),
      restore: async (userEntryId, options) => {
        const t = get();
        const target = t.state.byUserEntry.get(userEntryId);
        if (target === undefined || !isRewindable(t.state, userEntryId, settings.keep)) {
          return { result: emptyCodeResult(), touched: [] };
        }
        return restoreCheckpoint({
          cwd: ctx.cwd,
          dataDir: settings.dataDir,
          state: t.state,
          target,
          lastWritten: t.lastWritten,
          dryRun: options.dryRun,
          onConflict: options.onConflict,
          ...(settings.maxFileBytes !== undefined ? { maxDiffBytes: settings.maxFileBytes } : {}),
        });
      },
      gitHint: async (userEntryId) => {
        const target = get().state.byUserEntry.get(userEntryId);
        return target === undefined ? undefined : gitHintFor(ctx.cwd, target);
      },
    };
  };
}
