/**
 * 检查点单测共用的临时目录与内存条目（RW-A）。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckpointEntryLike } from "../../src/checkpoints/replay.js";
import { CheckpointTracker, type CheckpointTrackerOptions } from "../../src/checkpoints/tracker.js";

export interface Fixture {
  root: string;
  cwd: string;
  dataDir: string;
  entries: CheckpointEntryLike[];
  warnings: string[];
  tracker(extra?: Partial<CheckpointTrackerOptions>): CheckpointTracker;
  cleanup(): void;
}

export function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ama-cp-")));
  const cwd = join(root, "proj");
  const dataDir = join(root, "data");
  mkdirSync(cwd, { recursive: true });
  const entries: CheckpointEntryLike[] = [];
  const warnings: string[] = [];
  return {
    root,
    cwd,
    dataDir,
    entries,
    warnings,
    tracker: (extra = {}) =>
      new CheckpointTracker({
        cwd,
        dataDir,
        append: (customType, data) =>
          entries.push({
            type: "custom",
            customType,
            data: JSON.parse(JSON.stringify(data)),
            timestamp: new Date().toISOString(),
          }),
        warn: (message) => warnings.push(message),
        readHead: async () => undefined,
        ...extra,
      }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
