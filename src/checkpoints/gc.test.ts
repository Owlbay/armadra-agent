import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blobPath, blobUsage, putBlob } from "./blobs.js";
import { formatBytes, gcBlobs, readSessionRoots, registerSessionRoot } from "./gc.js";
import { CHECKPOINT_CUSTOM_TYPE, CHECKPOINT_TRACK_CUSTOM_TYPE } from "./types.js";

let root: string;
let dataDir: string;
let sessions: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ama-cp-gc-"));
  dataDir = join(root, "data");
  sessions = join(dataDir, "sessions");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function age(path: string, days: number): void {
  const t = (Date.now() - days * 86_400_000) / 1000;
  utimesSync(path, t, t);
}

function session(dir: string, name: string, lines: unknown[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("gcBlobs", () => {
  it("标记全部会话（含 trash 与登记的根目录）的引用，清除未引用且超过 1 天的 blob", async () => {
    const keep1 = await putBlob(dataDir, Buffer.from("in checkpoint"));
    const keep2 = await putBlob(dataDir, Buffer.from("in track, trashed session"));
    const keep3 = await putBlob(dataDir, Buffer.from("profile session dir"));
    const young = await putBlob(dataDir, Buffer.from("unreferenced but new"));
    const old = await putBlob(dataDir, Buffer.from("unreferenced and old"));
    const mention = await putBlob(dataDir, Buffer.from("hash only in a message"));
    for (const h of [keep1, keep2, keep3, old, mention]) age(blobPath(dataDir, h), 3);
    const tmp = `${blobPath(dataDir, old)}.tmp-1-0`;
    writeFileSync(tmp, "partial");
    age(tmp, 3);

    session(join(sessions, "proj"), "s1.jsonl", [
      { type: "session" },
      { type: "message", message: { role: "user", content: mention } },
      {
        type: "custom",
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: { files: { a: { blob: keep1 } } },
      },
    ]);
    session(join(sessions, ".trash"), "1__proj__s2.jsonl", [
      {
        type: "custom",
        customType: CHECKPOINT_TRACK_CUSTOM_TYPE,
        data: { record: { blob: keep2 } },
      },
    ]);
    const profileDir = join(root, "host-sessions");
    session(join(profileDir, "x"), "s3.jsonl", [
      {
        type: "custom",
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: { files: { b: { blob: keep3 } } },
      },
    ]);
    await registerSessionRoot(dataDir, profileDir);
    await registerSessionRoot(dataDir, profileDir);
    expect(await readSessionRoots(dataDir)).toEqual([profileDir]);

    const dry = await gcBlobs({ dataDir, sessionRoots: [sessions], dryRun: true });
    expect(dry.removed.sort()).toEqual(
      [blobPath(dataDir, old), blobPath(dataDir, mention), tmp].sort(),
    );
    expect(existsSync(blobPath(dataDir, old))).toBe(true);

    const done = await gcBlobs({ dataDir, sessionRoots: [sessions] });
    expect(done.sessionFiles).toBe(3);
    expect(done.removed).toHaveLength(3);
    for (const h of [keep1, keep2, keep3, young])
      expect(existsSync(blobPath(dataDir, h))).toBe(true);
    expect(existsSync(blobPath(dataDir, old))).toBe(false);
    expect(existsSync(tmp)).toBe(false);
    expect(done.kept.blobs).toBe(4);
    expect((await blobUsage(dataDir)).blobs).toBe(4);
  });

  it("没有 file-history 目录时什么都不做", async () => {
    const result = await gcBlobs({ dataDir, sessionRoots: [sessions] });
    expect(result).toMatchObject({ removed: [], removedBytes: 0, kept: { blobs: 0, bytes: 0 } });
  });

  it("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  });
});
