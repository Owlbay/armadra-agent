/**
 * 检查点备份存储（docs/history/rewind-plan.md §1.1）。[RW-A]
 *
 * - 位置 `<dataDir>/file-history/blobs/<sha256 前 2 位>/<sha256>`，内容为文件原字节；
 *   先写 `<name>.tmp-<pid>-<序号>` 再 rename，已存在即跳过（内容寻址，同内容只存一份）。
 * - `recordFile` 把磁盘上一个路径变成 `FileRecord`：不存在记 `blob: null`；符号链接与非普通文件记
 *   `skipped: "not_regular"`；超过上限记 `skipped: "too_large"`（都不写 blob）。
 * - 路径键（§1.2）：cwd 内为相对路径（`/` 分隔），cwd 外为绝对路径。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileRecord } from "./types.js";

export const FILE_HISTORY_DIR = "file-history";
export const BLOBS_DIR = "blobs";
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function fileHistoryDir(dataDir: string): string {
  return join(dataDir, FILE_HISTORY_DIR);
}

export function blobsDir(dataDir: string): string {
  return join(fileHistoryDir(dataDir), BLOBS_DIR);
}

export function isBlobHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/** blob 的路径；哈希格式不对时抛（防止拼出目录穿越）。 */
export function blobPath(dataDir: string, hash: string): string {
  if (!isBlobHash(hash)) throw new Error(`invalid blob hash: ${hash}`);
  return join(blobsDir(dataDir), hash.slice(0, 2), hash);
}

export function hashBytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 流式算文件 sha256（不受 maxFileBytes 限制，冲突检测用）。 */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

let tmpCounter = 0;

/** 写入 blob（已存在跳过），返回哈希。 */
export async function putBlob(
  dataDir: string,
  bytes: Uint8Array,
  hash = hashBytes(bytes),
): Promise<string> {
  const target = blobPath(dataDir, hash);
  if (await exists(target)) {
    // 复用旧 blob：刷新 mtime，避免并发的 GC 在新条目落盘前把它当作「未引用且超过 1 天」删掉。
    const now = new Date();
    await utimes(target, now, now).catch(() => undefined);
    return hash;
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}-${tmpCounter++}`;
  try {
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    if (await exists(target)) return hash;
    throw error;
  }
  return hash;
}

/** 读 blob；不存在返回 undefined。 */
export async function readBlob(dataDir: string, hash: string): Promise<Buffer | undefined> {
  try {
    return await readFile(blobPath(dataDir, hash));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function hasBlob(dataDir: string, hash: string): Promise<boolean> {
  return exists(blobPath(dataDir, hash));
}

export interface RecordFileOptions {
  dataDir: string;
  maxFileBytes?: number;
}

/** 记录时一并给出的 lstat 信息（快照沿用判断用）。 */
export interface RecordedFile {
  record: FileRecord;
  /** 记录开始的时间（毫秒）；mtime 不晚于它（减去粒度余量）才可沿用。 */
  at: number;
}

/** 父目录 realpath；父目录不存在时 undefined。 */
export async function realParentOf(absolutePath: string): Promise<string | undefined> {
  try {
    return await realpath(dirname(absolutePath));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** 把磁盘上的一个路径记成 FileRecord（需要时写 blob）。 */
export async function recordFile(
  absolutePath: string,
  options: RecordFileOptions,
): Promise<RecordedFile> {
  const at = Date.now();
  const max = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const realParentDir = await realParentOf(absolutePath);
    return {
      record: { blob: null, ...(realParentDir !== undefined ? { realParentDir } : {}) },
      at,
    };
  }
  if (!info.isFile()) return { record: { blob: null, skipped: "not_regular" }, at };
  const mode = info.mode & 0o7777;
  const realParentDir = await realParentOf(absolutePath);
  const base = { mode, size: info.size, ...(realParentDir !== undefined ? { realParentDir } : {}) };
  if (info.size > max) return { record: { blob: null, ...base, skipped: "too_large" }, at };
  const bytes = await readFile(absolutePath);
  if (bytes.length > max)
    return { record: { blob: null, ...base, size: bytes.length, skipped: "too_large" }, at };
  const blob = await putBlob(options.dataDir, bytes);
  return { record: { blob, ...base, size: bytes.length }, at };
}

/** 绝对路径 → 记录键（cwd 内相对、`/` 分隔；cwd 外绝对）。 */
export function pathKey(cwd: string, absolutePath: string): string {
  const abs = resolve(absolutePath);
  const rel = relative(resolve(cwd), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return abs;
  return rel.split(sep).join("/");
}

/** 记录键 → 绝对路径。 */
export function keyToPath(cwd: string, key: string): string {
  return isAbsolute(key) ? resolve(key) : resolve(cwd, ...key.split("/"));
}

export interface BlobUsage {
  blobs: number;
  bytes: number;
}

/** file-history 的 blob 数与字节数（不含临时文件）。 */
export async function blobUsage(dataDir: string): Promise<BlobUsage> {
  const usage: BlobUsage = { blobs: 0, bytes: 0 };
  for (const blob of await listBlobs(dataDir)) {
    usage.blobs++;
    usage.bytes += blob.size;
  }
  return usage;
}

export interface BlobFile {
  path: string;
  /** 哈希；临时文件为 undefined。 */
  hash?: string;
  size: number;
  mtimeMs: number;
}

/** 列出 blob 目录下的文件（含残留的临时文件）。 */
export async function listBlobs(dataDir: string, includeTemp = false): Promise<BlobFile[]> {
  const root = blobsDir(dataDir);
  let shards: string[];
  try {
    shards = await readdir(root);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const out: BlobFile[] = [];
  for (const shard of shards) {
    if (!/^[0-9a-f]{2}$/.test(shard)) continue;
    let names: string[];
    try {
      names = await readdir(join(root, shard));
    } catch {
      continue;
    }
    for (const name of names) {
      const isBlob = isBlobHash(name) && name.startsWith(shard);
      if (!isBlob && !(includeTemp && name.includes(".tmp-"))) continue;
      const path = join(root, shard, name);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        out.push({
          path,
          ...(isBlob ? { hash: name } : {}),
          size: info.size,
          mtimeMs: info.mtimeMs,
        });
      } catch {
        // 并发删除：忽略
      }
    }
  }
  return out;
}

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
