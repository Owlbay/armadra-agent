/**
 * 每作用域一把锁（docs/history/wave6-plan.md §3.2）。[W6-M]
 *
 * 进程内按目录串行（`tools/file-mutex.ts`）；跨进程用作用域目录里的 `.lock`（`O_EXCL` 创建，写 pid）。
 * 等锁至多 `timeoutMs`（缺省 5 s）；锁文件超过 `staleMs`（缺省 30 s）视为陈旧，删掉重试。
 * 写操作（create / str_replace / delete 与索引重建）都在锁内；读不加锁（原子 rename 保证读到整文件）。
 */

import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { withFileMutex } from "../tools/file-mutex.js";

export const LOCK_FILE = ".lock";

export class MemoryLockError extends Error {
  readonly code = "locked";
}

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  now?(): number;
}

function stale(path: string, staleMs: number, now: number): boolean {
  try {
    return now - statSync(path).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function withScopeLock<T>(
  dir: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 30_000;
  const now = options.now ?? Date.now;
  const lock = join(dir, LOCK_FILE);
  return withFileMutex(lock, async () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const start = now();
    for (;;) {
      try {
        const fd = openSync(lock, "wx", 0o600);
        try {
          writeSync(fd, String(process.pid));
        } finally {
          closeSync(fd);
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (stale(lock, staleMs, now())) {
          rmSync(lock, { force: true });
          continue;
        }
        if (now() - start > timeoutMs)
          throw new MemoryLockError("memory is locked by another process; try again");
        await sleep(25);
      }
    }
    try {
      return await fn();
    } finally {
      rmSync(lock, { force: true });
    }
  });
}
