import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../session/types.js";
import { createCheckpointBackendFactory, type CheckpointBackendContext } from "./backend.js";
import { readSessionRoots } from "./gc.js";

let root: string;
let cwd: string;
let dataDir: string;
let entries: SessionEntry[];
let turn: string | undefined;
let logs: string[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ama-cp-backend-")));
  cwd = join(root, "proj");
  dataDir = join(root, "data");
  mkdirSync(cwd);
  entries = [];
  turn = undefined;
  logs = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function ctx(): CheckpointBackendContext {
  return {
    cwd,
    entries: () => entries,
    appendCustom: (customType, data) =>
      entries.push({
        type: "custom",
        customType,
        data: JSON.parse(JSON.stringify(data)),
        id: `e${entries.length}`,
        parentId: null,
        timestamp: new Date().toISOString(),
      }),
    currentTurn: () => turn,
    log: (level, message) => logs.push(`${level}: ${message}`),
  };
}

describe("createCheckpointBackendFactory", () => {
  it("off 时返回 undefined", () => {
    expect(createCheckpointBackendFactory({ mode: "off", dataDir })(ctx())).toBeUndefined();
  });

  it("snapshot → 写 → restore；重开会话从条目重放；keep 上限", async () => {
    const factory = createCheckpointBackendFactory({
      mode: "tools",
      dataDir,
      keep: 2,
      sessionsRoot: join(root, "sessions"),
    });
    const backend = factory(ctx())!;
    const file = join(cwd, "a.txt");
    writeFileSync(file, "v1");
    turn = "u1";
    await backend.snapshot("u1");
    await backend.hooks.beforeWrite(file);
    writeFileSync(file, "v2");
    backend.hooks.afterWrite(file, "v2");
    turn = "u2";
    await backend.snapshot("u2");
    turn = "u3";
    await backend.snapshot("u3");

    expect(backend.hasCheckpoint("u1")).toBe(false); // keep: 2
    expect(backend.hasCheckpoint("u2")).toBe(true);
    const none = await backend.restore("u1", { dryRun: false, onConflict: "skip" });
    expect(none).toEqual({
      result: {
        restored: [],
        deleted: [],
        conflicts: [],
        skipped: [],
        failed: [],
        insertions: 0,
        deletions: 0,
      },
      touched: [],
    });

    // 重开：新后端从条目重放（u2 记的是 v2，回到 u2 不需要改）
    const reopened = createCheckpointBackendFactory({ mode: "tools", dataDir, keep: 100 })(ctx())!;
    expect(reopened.hasCheckpoint("u1")).toBe(true);
    const preview = await reopened.restore("u1", { dryRun: true, onConflict: "skip" });
    expect(preview.result.restored).toEqual(["a.txt"]);
    const done = await reopened.restore("u1", { dryRun: false, onConflict: "skip" });
    expect(done.touched).toEqual([file]);
    expect(readFileSync(file, "utf8")).toBe("v1");
    expect(await reopened.gitHint("u1")).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(await readSessionRoots(dataDir)).toEqual([join(root, "sessions")]);
  });
});
