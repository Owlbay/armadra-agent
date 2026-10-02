import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  blobPath,
  blobUsage,
  hashBytes,
  hashFile,
  keyToPath,
  listBlobs,
  pathKey,
  putBlob,
  readBlob,
  recordFile,
} from "./blobs.js";

let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ama-cp-blobs-"));
  dataDir = join(root, "data");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("blob 存储", () => {
  it("按 sha256 前 2 位分目录，原字节写入，已存在跳过", async () => {
    const bytes = Buffer.from("hello\r\n﻿world");
    const hash = await putBlob(dataDir, bytes);
    expect(hash).toBe(hashBytes(bytes));
    const path = blobPath(dataDir, hash);
    expect(path).toBe(join(dataDir, "file-history", "blobs", hash.slice(0, 2), hash));
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(await putBlob(dataDir, bytes)).toBe(hash);
    expect((await readBlob(dataDir, hash))?.equals(bytes)).toBe(true);
    expect(await readBlob(dataDir, "0".repeat(64))).toBeUndefined();
    expect(await blobUsage(dataDir)).toEqual({ blobs: 1, bytes: bytes.length });
    expect((await listBlobs(dataDir, true)).some((b) => b.path.includes(".tmp-"))).toBe(false);
  });

  it("哈希格式不对时拒绝拼路径", () => {
    expect(() => blobPath(dataDir, "../../etc/passwd")).toThrow();
  });

  it("hashFile 与 hashBytes 一致", async () => {
    const file = join(root, "a.txt");
    writeFileSync(file, "abc");
    expect(await hashFile(file)).toBe(hashBytes("abc"));
  });
});

describe("recordFile", () => {
  it("不存在记 null（带父目录 realpath）", async () => {
    const { record } = await recordFile(join(root, "missing.txt"), { dataDir });
    expect(record.blob).toBeNull();
    expect(record.skipped).toBeUndefined();
    expect(typeof record.realParentDir).toBe("string");
  });

  it("普通文件写 blob，记 mode / size / realParentDir", async () => {
    const file = join(root, "a.txt");
    writeFileSync(file, "abc", { mode: 0o640 });
    const { record } = await recordFile(file, { dataDir });
    expect(record.blob).toBe(hashBytes("abc"));
    expect(record.size).toBe(3);
    if (process.platform !== "win32") expect(record.mode).toBe(0o640);
    expect(existsSync(blobPath(dataDir, record.blob as string))).toBe(true);
  });

  it("超过上限记 too_large，不写 blob", async () => {
    const file = join(root, "big.bin");
    writeFileSync(file, Buffer.alloc(32));
    const { record } = await recordFile(file, { dataDir, maxFileBytes: 16 });
    expect(record).toMatchObject({ blob: null, skipped: "too_large", size: 32 });
    expect(await blobUsage(dataDir)).toEqual({ blobs: 0, bytes: 0 });
  });

  it("目录记 not_regular", async () => {
    mkdirSync(join(root, "dir"));
    const { record } = await recordFile(join(root, "dir"), { dataDir });
    expect(record).toEqual({ blob: null, skipped: "not_regular" });
  });

  it.skipIf(process.platform === "win32")(
    "符号链接记 not_regular（Windows 建链接需要权限，跳过）",
    async () => {
      writeFileSync(join(root, "real.txt"), "x");
      symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
      const { record } = await recordFile(join(root, "link.txt"), { dataDir });
      expect(record.skipped).toBe("not_regular");
    },
  );
});

describe("路径键", () => {
  it("cwd 内为 / 分隔的相对路径，cwd 外为绝对路径，可还原", () => {
    const cwd = join(root, "proj");
    const inside = join(cwd, "src", "a.ts");
    const outside = join(root, "other", "b.ts");
    expect(pathKey(cwd, inside)).toBe("src/a.ts");
    expect(pathKey(cwd, outside)).toBe(resolve(outside));
    expect(keyToPath(cwd, "src/a.ts")).toBe(resolve(inside));
    expect(keyToPath(cwd, resolve(outside))).toBe(resolve(outside));
  });
});

describe("复用旧 blob", () => {
  it("刷新 mtime（GC 不会在新条目落盘前删掉它）", async () => {
    const { utimesSync, statSync } = await import("node:fs");
    const hash = await putBlob(dataDir, Buffer.from("x"));
    const old = (Date.now() - 3 * 86_400_000) / 1000;
    utimesSync(blobPath(dataDir, hash), old, old);
    await putBlob(dataDir, Buffer.from("x"));
    expect(Date.now() - statSync(blobPath(dataDir, hash)).mtimeMs).toBeLessThan(60_000);
  });
});
