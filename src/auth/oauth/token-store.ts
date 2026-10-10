/**
 * OAuth 条目的存取与跨进程刷新锁（docs/history/wave6-plan.md §4.3、D15）。[W6-O]
 *
 * - 读：每次都从磁盘读（绕过 `ApiKeyResolver.fileCache`，长会话才能看到别的进程刷新后的 token）；文件不存在 /
 *   坏掉 / 不是 oauth 条目 → undefined；
 * - 写：读-改-写 `auth.json` 整个文件，经 `writeAuthFile`（同目录临时文件 0600 → rename → chmod），其它条目原样保留；
 * - 锁：`<auth.json>.lock`，`open(O_CREAT|O_EXCL)`（flag `wx`）写 `{ pid, at }`；等待 ≤ 15 s；锁文件超过 60 s 且
 *   pid 已死视为陈旧，删除后重试。取锁后由调用方**重读文件**再决定要不要刷新。
 * - Windows：锁文件删除挂起时 `open(wx)` 报 EPERM / EACCES，按「被占用」继续等；读 / rename 的同类瞬时错误
 *   短暂重试（`config/fs-retry.ts`）。
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { writeAuthFile } from "../../config/auth-file.js";
import { isTransientFsError, retryTransientFs } from "../../config/fs-retry.js";
import { CONFIG_FILE_VERSION, type AuthFile } from "../../config/types.js";
import { isOAuthEntry, type AuthFileEntry, type OAuthAuthEntry } from "../../config/types-w6.js";
import { AmaError } from "../../errors.js";

export const LOCK_WAIT_MS = 15_000;
export const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 50;

function readRaw(path: string): AuthFile | undefined {
  try {
    const value = JSON.parse(retryTransientFs(() => readFileSync(path, "utf8"))) as AuthFile;
    return typeof value === "object" && value !== null && typeof value.providers === "object"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function readOAuthEntry(path: string, provider: string): OAuthAuthEntry | undefined {
  const entry = readRaw(path)?.providers?.[provider] as AuthFileEntry | undefined;
  return isOAuthEntry(entry) ? entry : undefined;
}

/** 写入（`undefined` 删除）该供应商的条目，其余条目不动。 */
export function writeOAuthEntry(
  path: string,
  provider: string,
  entry: OAuthAuthEntry | undefined,
): void {
  const file = readRaw(path) ?? { version: CONFIG_FILE_VERSION, providers: {} };
  const providers = { ...file.providers };
  if (entry === undefined) delete providers[provider];
  else providers[provider] = entry;
  writeAuthFile(path, { ...file, version: file.version ?? CONFIG_FILE_VERSION, providers });
}

export function lockPath(authFile: string): string {
  return `${authFile}.lock`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/** 锁文件陈旧：超过 60 s 且写锁的进程已不在。 */
export function isStaleLock(path: string, now = Date.now()): boolean {
  let age: number;
  let pid: number | undefined;
  try {
    age = now - statSync(path).mtimeMs;
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    pid = typeof value.pid === "number" ? value.pid : undefined;
  } catch {
    // 读不到内容（正在写或已删）：只按时间判断
    try {
      age = now - statSync(path).mtimeMs;
    } catch {
      return false;
    }
  }
  return age > LOCK_STALE_MS && (pid === undefined || !pidAlive(pid));
}

function tryAcquire(path: string): boolean {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // Windows：上一个持锁进程刚删掉锁文件（删除挂起）时 open(wx) 报 EPERM / EACCES——同样是「被占用」
    if (code === "EEXIST" || isTransientFsError(code)) return false;
    throw error;
  }
}

export interface LockOptions {
  waitMs?: number;
}

/** 在 `auth.json.lock` 下执行 `fn`；等不到锁抛 `auth_lock_timeout`。 */
export async function withRefreshLock<T>(
  authFile: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const path = lockPath(authFile);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    if (tryAcquire(path)) break;
    if (isStaleLock(path)) {
      try {
        unlinkSync(path);
      } catch {
        // 别人先删了
      }
      continue;
    }
    if (Date.now() >= deadline)
      throw new AmaError("auth_lock_timeout", `timed out waiting for ${path}`);
    await new Promise((r) =>
      setTimeout(r, LOCK_POLL_MS + Math.floor(Math.random() * LOCK_POLL_MS)),
    );
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // 已被当成陈旧锁删掉
    }
  }
}
