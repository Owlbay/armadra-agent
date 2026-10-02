import { existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFixture, type Fixture } from "../../test/helpers/checkpoint-fixture.js";
import { blobPath, hashBytes } from "./blobs.js";
import { loadCheckpoints } from "./replay.js";
import { CheckpointTracker, MTIME_GRANULARITY_MS } from "./tracker.js";
import {
  CHECKPOINT_CUSTOM_TYPE,
  CHECKPOINT_TRACK_CUSTOM_TYPE,
  type CheckpointData,
} from "./types.js";

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});
afterEach(() => f.cleanup());

const types = (): string[] => f.entries.map((e) => e.customType as string);

describe("CheckpointTracker.beforeWrite / afterWrite", () => {
  it("第一次碰文件：备份当前内容并追加 track；之后不再记", async () => {
    const file = join(f.cwd, "a.txt");
    writeFileSync(file, "v1");
    const t = f.tracker();
    await t.snapshot("u1");
    await t.beforeWrite(file);
    writeFileSync(file, "v2");
    t.afterWrite(file, "v2");
    await t.beforeWrite(file);
    expect(types()).toEqual([CHECKPOINT_CUSTOM_TYPE, CHECKPOINT_TRACK_CUSTOM_TYPE]);
    const track = f.entries[1]?.data as {
      userEntryId: string;
      path: string;
      record: { blob: string };
    };
    expect(track).toMatchObject({ v: 1, userEntryId: "u1", path: "a.txt" });
    expect(track.record.blob).toBe(hashBytes("v1"));
    expect(existsSync(blobPath(f.dataDir, track.record.blob))).toBe(true);
    expect(t.trackedFiles.has(file)).toBe(true);
    expect(t.lastWritten.get(file)).toBe(hashBytes("v2"));
    expect(t.state.byUserEntry.get("u1")?.files["a.txt"]?.blob).toBe(hashBytes("v1"));
  });

  it("新建文件记 null；并发两次只记一条", async () => {
    const t = f.tracker();
    await t.snapshot("u1");
    const file = join(f.cwd, "new.txt");
    await Promise.all([t.beforeWrite(file), t.beforeWrite(file)]);
    expect(types().filter((x) => x === CHECKPOINT_TRACK_CUSTOM_TYPE)).toHaveLength(1);
    expect(t.state.earliest.get("new.txt")?.blob).toBeNull();
  });

  it("备份失败只 warn 不抛", async () => {
    const t = f.tracker({ dataDir: join(f.cwd, "a.txt", "nested") });
    writeFileSync(join(f.cwd, "a.txt"), "x");
    await t.snapshot("u1");
    await expect(t.beforeWrite(join(f.cwd, "a.txt"))).resolves.toBeUndefined();
    expect(f.warnings.join("\n")).toContain("a.txt");
  });

  it("没有回合时只在内存跟踪，下一次 snapshot 收进检查点", async () => {
    const t = f.tracker();
    const file = join(f.cwd, "a.txt");
    writeFileSync(file, "v1");
    await t.beforeWrite(file);
    expect(f.entries).toHaveLength(0);
    await t.snapshot("u1");
    expect((f.entries[0]?.data as CheckpointData).files["a.txt"]?.blob).toBe(hashBytes("v1"));
  });

  it("cwd 外的文件用绝对路径作键", async () => {
    const t = f.tracker();
    await t.snapshot("u1");
    const outside = join(f.root, "outside.txt");
    await t.beforeWrite(outside);
    expect(t.state.earliest.has(outside)).toBe(true);
  });
});

describe("CheckpointTracker.snapshot", () => {
  it("没变沿用、改了出新版本、文件消失记 null", async () => {
    const file = join(f.cwd, "a.txt");
    writeFileSync(file, "v1");
    let now = Date.now();
    const t = f.tracker({ now: () => now });
    await t.snapshot("u1");
    await t.beforeWrite(file);
    // 文件 mtime 早于记录时间足够久 → 走快速沿用（不读内容）
    const past = (now - 10 * MTIME_GRANULARITY_MS) / 1000;
    utimesSync(file, past, past);
    now += 60_000;
    const c2 = await t.snapshot("u2");
    expect(c2.files["a.txt"]?.blob).toBe(hashBytes("v1"));

    writeFileSync(file, "v2-longer");
    now += 60_000;
    const c3 = await t.snapshot("u3");
    expect(c3.files["a.txt"]?.blob).toBe(hashBytes("v2-longer"));
    expect(existsSync(blobPath(f.dataDir, hashBytes("v2-longer")))).toBe(true);

    rmSync(file);
    const c4 = await t.snapshot("u4");
    expect(c4.files["a.txt"]?.blob).toBeNull();
  });

  it("size / mode 相同但 mtime 新：算哈希，内容相同仍沿用", async () => {
    const file = join(f.cwd, "a.txt");
    writeFileSync(file, "aa");
    const t = f.tracker();
    await t.snapshot("u1");
    await t.beforeWrite(file);
    writeFileSync(file, "bb");
    const c2 = await t.snapshot("u2");
    expect(c2.files["a.txt"]?.blob).toBe(hashBytes("bb"));
    writeFileSync(file, "bb");
    const c3 = await t.snapshot("u3");
    expect(c3.files["a.txt"]).toEqual(c2.files["a.txt"]);
  });

  it("超过上限记 too_large", async () => {
    const file = join(f.cwd, "big.txt");
    writeFileSync(file, "small");
    const t = f.tracker({ maxFileBytes: 8 });
    await t.snapshot("u1");
    await t.beforeWrite(file);
    writeFileSync(file, "this is too large");
    const c2 = await t.snapshot("u2");
    expect(c2.files["big.txt"]?.skipped).toBe("too_large");
  });

  it("记 git HEAD", async () => {
    const t = f.tracker({ readHead: async () => ({ head: "a".repeat(40), branch: "main" }) });
    const c = await t.snapshot("u1");
    expect(c.git).toEqual({ head: "a".repeat(40), branch: "main" });
  });

  it("从条目恢复后：已跟踪的文件不再追加 track", async () => {
    const file = join(f.cwd, "a.txt");
    writeFileSync(file, "v1");
    const t1 = f.tracker();
    await t1.snapshot("u1");
    await t1.beforeWrite(file);
    const before = f.entries.length;
    const t2 = new CheckpointTracker({
      cwd: f.cwd,
      dataDir: f.dataDir,
      append: () => {
        throw new Error("不应追加");
      },
      initial: loadCheckpoints(f.entries),
    });
    await t2.beforeWrite(file);
    expect(f.entries).toHaveLength(before);
    expect(t2.trackedFiles.has(file)).toBe(true);
  });
});
