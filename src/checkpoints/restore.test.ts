import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFixture, type Fixture } from "../../test/helpers/checkpoint-fixture.js";
import { blobPath, hashBytes } from "./blobs.js";
import { loadCheckpoints } from "./replay.js";
import { countLineChanges, gitHintFor, restoreCheckpoint } from "./restore.js";
import type { CheckpointTracker } from "./tracker.js";

const POSIX = process.platform !== "win32";

let f: Fixture;
let t: CheckpointTracker;
beforeEach(async () => {
  f = makeFixture();
  t = f.tracker();
});
afterEach(() => f.cleanup());

/** 模拟 ama 写文件：写前 beforeWrite，写后 afterWrite。 */
async function amaWrite(path: string, content: string): Promise<void> {
  await t.beforeWrite(path);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  t.afterWrite(path, content);
}

function restore(
  target: string,
  extra: { dryRun?: boolean; onConflict?: "skip" | "overwrite" } = {},
) {
  const checkpoint = t.state.byUserEntry.get(target);
  if (checkpoint === undefined) throw new Error(`no checkpoint ${target}`);
  return restoreCheckpoint({
    cwd: f.cwd,
    dataDir: f.dataDir,
    state: t.state,
    target: checkpoint,
    lastWritten: t.lastWritten,
    ...extra,
  });
}

describe("restoreCheckpoint", () => {
  it("修改回滚、新建删除、未改跳过；touched 为绝对路径", async () => {
    const a = join(f.cwd, "a.txt");
    const b = join(f.cwd, "sub", "b.txt");
    const c = join(f.cwd, "c.txt");
    writeFileSync(a, "one\ntwo\n");
    writeFileSync(c, "same");
    await t.snapshot("u1");
    await amaWrite(a, "one\nTWO\nthree\n");
    await amaWrite(b, "new\n");
    await t.beforeWrite(c); // 跟踪但内容不变
    await t.snapshot("u2");

    const preview = await restore("u1", { dryRun: true });
    expect(preview.result).toMatchObject({
      restored: ["a.txt"],
      deleted: ["sub/b.txt"],
      conflicts: [],
      skipped: [],
      failed: [],
      insertions: 1,
      deletions: 3,
    });
    expect(preview.touched).toEqual([]);
    expect(readFileSync(a, "utf8")).toBe("one\nTWO\nthree\n");

    const done = await restore("u1");
    expect(done.result.restored).toEqual(["a.txt"]);
    expect(done.result.deleted).toEqual(["sub/b.txt"]);
    expect(done.touched.sort()).toEqual([a, b].sort());
    expect(readFileSync(a, "utf8")).toBe("one\ntwo\n");
    expect(existsSync(b)).toBe(false);
    expect(readFileSync(c, "utf8")).toBe("same");
  });

  it.skipIf(!POSIX)("恢复 mode（Windows 只有只读位，跳过）", async () => {
    const a = join(f.cwd, "run.sh");
    writeFileSync(a, "#!/bin/sh\n");
    chmodSync(a, 0o755);
    await t.snapshot("u1");
    await amaWrite(a, "changed\n");
    chmodSync(a, 0o644);
    await restore("u1", { onConflict: "overwrite" });
    expect(statSync(a).mode & 0o777).toBe(0o755);
  });

  it("目标检查点没有该文件 → 用最早记录（之后才跟踪的文件）", async () => {
    await t.snapshot("u1");
    await t.snapshot("u2");
    const a = join(f.cwd, "late.txt");
    writeFileSync(a, "orig");
    await amaWrite(a, "edited");
    const done = await restore("u1");
    expect(done.result.restored).toEqual(["late.txt"]);
    expect(readFileSync(a, "utf8")).toBe("orig");
  });

  it("冲突：skip 不动并列出，overwrite 覆盖", async () => {
    const a = join(f.cwd, "a.txt");
    writeFileSync(a, "v1");
    await t.snapshot("u1");
    await amaWrite(a, "v2");
    writeFileSync(a, "user edit"); // 回合外手动修改
    const skipped = await restore("u1");
    expect(skipped.result.conflicts).toEqual(["a.txt"]);
    expect(skipped.result.restored).toEqual([]);
    expect(readFileSync(a, "utf8")).toBe("user edit");

    const over = await restore("u1", { onConflict: "overwrite" });
    expect(over.result.conflicts).toEqual(["a.txt"]);
    expect(over.result.restored).toEqual(["a.txt"]);
    expect(readFileSync(a, "utf8")).toBe("v1");
  });

  it("恢复会话后没有 lastWritten：与最近检查点一致不算冲突", async () => {
    const a = join(f.cwd, "a.txt");
    writeFileSync(a, "v1");
    await t.snapshot("u1");
    await amaWrite(a, "v2");
    await t.snapshot("u2"); // 最近检查点记下 v2
    const state = loadCheckpoints(f.entries);
    const result = await restoreCheckpoint({
      cwd: f.cwd,
      dataDir: f.dataDir,
      state,
      target: state.byUserEntry.get("u1")!,
    });
    expect(result.result.conflicts).toEqual([]);
    expect(readFileSync(a, "utf8")).toBe("v1");
  });

  it.skipIf(!POSIX)(
    "目标被换成符号链接 → skipped symlink（Windows 建链接需权限，跳过）",
    async () => {
      const a = join(f.cwd, "a.txt");
      writeFileSync(a, "v1");
      await t.snapshot("u1");
      await amaWrite(a, "v2");
      const outside = join(f.root, "secret.txt");
      writeFileSync(outside, "secret");
      rmSync(a);
      symlinkSync(outside, a);
      const done = await restore("u1", { onConflict: "overwrite" });
      expect(done.result.skipped).toEqual([{ path: "a.txt", reason: "symlink" }]);
      expect(readFileSync(outside, "utf8")).toBe("secret");
    },
  );

  it("硬链接 → skipped hardlink", async () => {
    const a = join(f.cwd, "a.txt");
    writeFileSync(a, "v1");
    await t.snapshot("u1");
    await amaWrite(a, "v2");
    linkSync(a, join(f.root, "other-link.txt"));
    const done = await restore("u1");
    expect(done.result.skipped).toEqual([{ path: "a.txt", reason: "hardlink" }]);
    expect(readFileSync(a, "utf8")).toBe("v2");
  });

  it("变成目录 → skipped not_regular", async () => {
    const a = join(f.cwd, "a.txt");
    writeFileSync(a, "v1");
    await t.snapshot("u1");
    await amaWrite(a, "v2");
    rmSync(a);
    mkdirSync(a);
    const done = await restore("u1");
    expect(done.result.skipped).toEqual([{ path: "a.txt", reason: "not_regular" }]);
  });

  it.skipIf(!POSIX)("父目录被换成指向别处的链接 → skipped parent_moved", async () => {
    const dir = join(f.cwd, "pkg");
    mkdirSync(dir);
    const a = join(dir, "a.txt");
    writeFileSync(a, "v1");
    await t.snapshot("u1");
    await amaWrite(a, "v2");
    const elsewhere = join(f.root, "elsewhere");
    renameSync(dir, elsewhere);
    symlinkSync(elsewhere, dir);
    const done = await restore("u1");
    expect(done.result.skipped).toEqual([{ path: "pkg/a.txt", reason: "parent_moved" }]);
    expect(readFileSync(join(elsewhere, "a.txt"), "utf8")).toBe("v2");
  });

  it("too_large 与 backup_missing", async () => {
    const big = join(f.cwd, "big.txt");
    const a = join(f.cwd, "a.txt");
    writeFileSync(big, "x".repeat(64));
    writeFileSync(a, "v1");
    t = f.tracker({ maxFileBytes: 16 });
    await t.snapshot("u1");
    await amaWrite(big, "small");
    await amaWrite(a, "v2");
    rmSync(blobPath(f.dataDir, hashBytes("v1")));
    const done = await restore("u1");
    expect(done.result.skipped).toEqual([
      { path: "big.txt", reason: "too_large" },
      { path: "a.txt", reason: "backup_missing" },
    ]);
    expect(readFileSync(a, "utf8")).toBe("v2");
  });

  it("文件已被删：按记录重建（含父目录）", async () => {
    const a = join(f.cwd, "d", "a.txt");
    mkdirSync(join(f.cwd, "d"));
    writeFileSync(a, "v1");
    await t.snapshot("u1");
    await amaWrite(a, "v2");
    rmSync(join(f.cwd, "d"), { recursive: true });
    const done = await restore("u1", { onConflict: "overwrite" });
    expect(done.result.restored).toEqual(["d/a.txt"]);
    expect(readFileSync(a, "utf8")).toBe("v1");
  });
});

describe("countLineChanges / gitHintFor", () => {
  it("行级增删", () => {
    expect(countLineChanges("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({ insertions: 2, deletions: 1 });
    expect(countLineChanges("", "x\ny\n")).toEqual({ insertions: 2, deletions: 0 });
    // 只改换行也算改动（与 git diff 一致）
    expect(countLineChanges("a\r\nb\r\n", "a\nb\n")).toEqual({ insertions: 2, deletions: 2 });
  });

  it("HEAD 变了才提示", async () => {
    const git = join(f.cwd, ".git");
    mkdirSync(git);
    writeFileSync(join(git, "HEAD"), `${"b".repeat(40)}\n`);
    const target = { v: 1 as const, userEntryId: "u1", files: {}, git: { head: "a".repeat(40) } };
    expect(await gitHintFor(f.cwd, target)).toEqual({
      recordedHead: "a".repeat(40),
      currentHead: "b".repeat(40),
    });
    expect(await gitHintFor(f.cwd, { ...target, git: { head: "b".repeat(40) } })).toBeUndefined();
    expect(await gitHintFor(f.cwd, { v: 1, userEntryId: "u1", files: {} })).toBeUndefined();
  });
});
