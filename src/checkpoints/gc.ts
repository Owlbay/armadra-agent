/**
 * 备份清理（docs/rewind-plan.md §1.4）。[RW-A]
 *
 * - 标记：递归扫描会话根目录下全部 `*.jsonl`（含 `.trash/`，trash 里的会话还能找回），凡含
 *   `ama.checkpoint` 的行，取其中所有 64 位十六进制串作为引用。不解析 JSON：损坏或未来格式的行也只会
 *   多保留，不会误删。任何会话文件读不了 → 整次 GC 放弃（抛错），不删除任何东西。
 * - 清除：未被引用且 mtime 早于 `minAgeMs`（缺省 1 天）的 blob；同样年龄的残留临时文件一并删除。
 * - 会话根目录除调用方给出的以外，还包括 `<dataDir>/file-history/roots.json` 里登记过的（宿主 profile
 *   的 `sessionDir` 不在缺省位置时，备份仍被看到）。
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileHistoryDir, isNotFound, listBlobs } from "./blobs.js";
import { CHECKPOINT_CUSTOM_TYPE } from "./types.js";

export const GC_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const ROOTS_FILE = "roots.json";

const HASH_IN_LINE = /\b[0-9a-f]{64}\b/g;

function rootsFile(dataDir: string): string {
  return join(fileHistoryDir(dataDir), ROOTS_FILE);
}

/** 已登记的会话根目录。 */
export async function readSessionRoots(dataDir: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(rootsFile(dataDir), "utf8"));
    const roots = (value as { roots?: unknown } | null)?.roots;
    return Array.isArray(roots) ? roots.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/** 登记会话根目录（已登记则不写）。 */
export async function registerSessionRoot(dataDir: string, sessionsRoot: string): Promise<void> {
  const root = resolve(sessionsRoot);
  const roots = await readSessionRoots(dataDir);
  if (roots.includes(root)) return;
  const dir = fileHistoryDir(dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${rootsFile(dataDir)}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify({ roots: [...roots, root] }, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(tmp, rootsFile(dataDir));
}

async function* sessionFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(full);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield full;
  }
}

export interface BlobRefs {
  refs: Set<string>;
  sessionFiles: number;
}

/** 标记：会话根目录下全部会话文件引用的 blob。 */
export async function collectBlobRefs(sessionRoots: readonly string[]): Promise<BlobRefs> {
  const refs = new Set<string>();
  let count = 0;
  const seen = new Set<string>();
  for (const root of sessionRoots) {
    const abs = resolve(root);
    if (seen.has(abs)) continue;
    seen.add(abs);
    for await (const file of sessionFiles(abs)) {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if (isNotFound(error)) continue; // 扫描期间被移走：移到的位置（trash）也在扫描范围内或已删
        throw error;
      }
      count++;
      if (!text.includes(CHECKPOINT_CUSTOM_TYPE)) continue;
      for (const line of text.split("\n")) {
        if (!line.includes(CHECKPOINT_CUSTOM_TYPE)) continue;
        for (const match of line.matchAll(HASH_IN_LINE)) refs.add(match[0]);
      }
    }
  }
  return { refs, sessionFiles: count };
}

export interface GcOptions {
  dataDir: string;
  /** 要扫描的会话根目录；登记过的根目录自动并入。 */
  sessionRoots: readonly string[];
  dryRun?: boolean;
  /** 缺省 1 天。 */
  minAgeMs?: number;
  now?: number;
}

export interface GcResult {
  sessionFiles: number;
  referenced: number;
  /** 删除（dryRun 时为将删除）的 blob 与临时文件路径。 */
  removed: string[];
  removedBytes: number;
  /** 保留的 blob 数与字节数。 */
  kept: { blobs: number; bytes: number };
}

/** 标记 + 清除。 */
export async function gcBlobs(options: GcOptions): Promise<GcResult> {
  const minAge = options.minAgeMs ?? GC_MIN_AGE_MS;
  const now = options.now ?? Date.now();
  const roots = [...options.sessionRoots, ...(await readSessionRoots(options.dataDir))];
  const { refs, sessionFiles: count } = await collectBlobRefs(roots);
  const result: GcResult = {
    sessionFiles: count,
    referenced: refs.size,
    removed: [],
    removedBytes: 0,
    kept: { blobs: 0, bytes: 0 },
  };
  for (const blob of await listBlobs(options.dataDir, true)) {
    const old = now - blob.mtimeMs > minAge;
    const unreferenced = blob.hash === undefined || !refs.has(blob.hash);
    if (old && unreferenced) {
      if (options.dryRun !== true) {
        try {
          await rm(blob.path, { force: true });
        } catch {
          continue;
        }
      }
      result.removed.push(blob.path);
      result.removedBytes += blob.size;
    } else if (blob.hash !== undefined) {
      result.kept.blobs++;
      result.kept.bytes += blob.size;
    }
  }
  return result;
}

/** 人读的字节数（doctor / prune 输出）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
