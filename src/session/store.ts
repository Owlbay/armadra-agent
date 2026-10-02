/**
 * 会话文件的磁盘层（设计 §8）：目录编码、文件名、JSONL 读写、原子追加、单写者锁、trash。[B2]
 *
 * - 位置 `<sessionsRoot>/<编码 cwd>/<ISO>_<uuid>.jsonl`；编码 cwd = 去首分隔符、`/ \ :` 换 `-`。
 * - 只追加：每条记录一行 JSON + LF，用 O_APPEND 写（单写者由锁保证）。
 * - 打开时若末行是半行（进程在写入中途崩溃），截掉半行再继续追加；中间行损坏 → session_corrupt。
 * - 锁：`<file>.lock`（O_EXCL 创建，内容为 pid）；持锁进程已不在 → 视为陈旧锁并接管。
 * - prune：移到 `<sessionsRoot>/.trash/`，文件名前缀删除时间；`purgeTrash` 清理超过 7 天的。
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { AmaError } from "../errors.js";
import type { SessionLine } from "./types.js";

export const SESSION_FILE_SUFFIX = ".jsonl";
export const TRASH_DIR_NAME = ".trash";
export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 去首分隔符，`/ \ :` 换 `-`。 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-");
}

export function sessionDirForCwd(sessionsRoot: string, cwd: string): string {
  return join(sessionsRoot, encodeCwd(cwd));
}

/** `2026-10-02T05-23-11-123Z_<id>.jsonl`（ISO 里的 `:` 与 `.` 换 `-`，Windows 可用）。 */
export function sessionFileName(date: Date, id: string): string {
  return `${date.toISOString().replace(/[:.]/g, "-")}_${id}${SESSION_FILE_SUFFIX}`;
}

/** 从文件名取会话 id（不符合命名时 undefined）。 */
export function sessionIdFromFileName(file: string): string | undefined {
  const name = basename(file);
  if (!name.endsWith(SESSION_FILE_SUFFIX)) return undefined;
  const stem = name.slice(0, -SESSION_FILE_SUFFIX.length);
  const at = stem.indexOf("_");
  return at < 0 ? undefined : stem.slice(at + 1);
}

export interface ReadResult {
  lines: SessionLine[];
  /** 末尾半行被截掉时为 true。 */
  repairedTail: boolean;
}

/**
 * 读并解析 JSONL。`repair: true` 时把末尾半行从文件里截掉（只截最后一行，且只在它无法解析时）。
 */
export function readSessionLines(file: string, options: { repair?: boolean } = {}): ReadResult {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new AmaError("session_not_found", `cannot read session file ${file}`, { cause: error });
  }
  const rawLines = text.split("\n");
  const endsWithNewline = text.endsWith("\n");
  if (endsWithNewline) rawLines.pop();
  const lines: SessionLine[] = [];
  let repairedTail = false;
  for (let i = 0; i < rawLines.length; i++) {
    const raw = (rawLines[i] ?? "").replace(/\r$/, "");
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw) as SessionLine);
    } catch (error) {
      const isLast = i === rawLines.length - 1;
      if (isLast && !endsWithNewline) {
        repairedTail = true;
        if (options.repair === true) {
          const keep = Buffer.byteLength(rawLines.slice(0, i).join("\n"), "utf8") + (i > 0 ? 1 : 0);
          truncateSync(file, keep);
        }
        break;
      }
      throw new AmaError("session_corrupt", `${file}:${i + 1}: invalid JSON line`, {
        cause: error,
      });
    }
  }
  if (!repairedTail && !endsWithNewline && text.length > 0 && options.repair === true) {
    // 最后一行完整但缺 LF：补上，保证后续追加另起一行。
    appendRaw(file, "\n");
  }
  return { lines, repairedTail };
}

function appendRaw(file: string, text: string): void {
  const fd = openSync(file, "a");
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** 追加若干行（一次 write，O_APPEND）。 */
export function appendLines(file: string, lines: readonly SessionLine[]): void {
  if (lines.length === 0) return;
  appendRaw(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

/** 新建文件：先写临时文件再 rename，避免出现只有半个头的文件。 */
export function writeNewSessionFile(file: string, lines: readonly SessionLine[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) {
    throw new AmaError("session_exists", `session file already exists: ${file}`);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// 锁
// ---------------------------------------------------------------------------

const heldLocks = new Set<string>();
let exitHandlerInstalled = false;

function installExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.once("exit", () => {
    for (const lock of heldLocks) rmSync(lock, { force: true });
  });
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface SessionLock {
  readonly path: string;
  release(): void;
}

/** 单写者锁。同一进程内对同一文件重复加锁也视为冲突。 */
export function acquireLock(file: string): SessionLock {
  const path = `${file}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      heldLocks.add(path);
      installExitHandler();
      let released = false;
      return {
        path,
        release() {
          if (released) return;
          released = true;
          heldLocks.delete(path);
          rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = Number.NaN;
      try {
        owner = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
      } catch {
        // 读不到当作陈旧
      }
      const stale = heldLocks.has(path) ? false : !pidAlive(owner) || owner === process.pid;
      if (!stale || attempt > 0) {
        throw new AmaError("session_locked", `session file is in use by pid ${owner}: ${file}`);
      }
      rmSync(path, { force: true });
    }
  }
  throw new AmaError("session_locked", `cannot lock session file ${file}`);
}

// ---------------------------------------------------------------------------
// 列表与 trash
// ---------------------------------------------------------------------------

/** 目录下的会话文件（按文件名倒序 = 最新在前）。 */
export function listSessionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(SESSION_FILE_SUFFIX))
    .sort()
    .reverse()
    .map((name) => join(dir, name));
}

/** 子 Agent（task）会话第一条条目的 customType（与 agents/task-record.ts 同值）。 */
export const TASK_SESSION_CUSTOM_TYPE = "ama.task";

/**
 * 子 Agent 会话：头有 `parentSession`，且第一条条目是 `custom{ama.task}`（fork / clone 也带
 * `parentSession`，但第一条不是任务记录，不算）。
 */
export function isSubagentSession(
  header: { parentSession?: string } | undefined,
  first: unknown,
): boolean {
  if (header?.parentSession === undefined) return false;
  const entry = first as { type?: unknown; customType?: unknown } | undefined;
  return entry?.type === "custom" && entry.customType === TASK_SESSION_CUSTOM_TYPE;
}

const HEAD_CHUNK = 16 * 1024;
const HEAD_LIMIT = 1024 * 1024;

/** 只读文件开头的前两行（头 + 第一条条目）判断是否子 Agent 会话；读不了 / 解析不了 → false。 */
export function isSubagentSessionFile(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const chunks: Buffer[] = [];
    let size = 0;
    let newlines = 0;
    while (newlines < 2 && size < HEAD_LIMIT) {
      const buffer = Buffer.alloc(HEAD_CHUNK);
      const read = readSync(fd, buffer, 0, HEAD_CHUNK, size);
      if (read === 0) break;
      const chunk = buffer.subarray(0, read);
      for (const byte of chunk) if (byte === 0x0a) newlines++;
      chunks.push(chunk);
      size += read;
    }
    const [header, first] = Buffer.concat(chunks).toString("utf8").split("\n", 2);
    if (header === undefined || first === undefined || first.trim() === "") return false;
    return isSubagentSession(
      JSON.parse(header) as { parentSession?: string },
      JSON.parse(first) as unknown,
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 移到 `<sessionsRoot>/.trash/<删除时间毫秒>__<编码目录>__<文件名>`，返回新路径。 */
export function trashSession(file: string, sessionsRoot: string, now = Date.now()): string {
  const trash = join(sessionsRoot, TRASH_DIR_NAME);
  mkdirSync(trash, { recursive: true, mode: 0o700 });
  const target = join(trash, `${now}__${basename(dirname(file))}__${basename(file)}`);
  renameSync(file, target);
  rmSync(`${file}.lock`, { force: true });
  return target;
}

/** 删除 trash 中超过保留期的文件，返回删除的路径。 */
export function purgeTrash(
  sessionsRoot: string,
  now = Date.now(),
  retentionMs = TRASH_RETENTION_MS,
): string[] {
  const trash = join(sessionsRoot, TRASH_DIR_NAME);
  if (!existsSync(trash)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(trash)) {
    const full = join(trash, name);
    const stamp = Number.parseInt(name.split("__")[0] ?? "", 10);
    const deletedAt = Number.isFinite(stamp) ? stamp : statSync(full).mtimeMs;
    if (now - deletedAt > retentionMs) {
      rmSync(full, { force: true });
      removed.push(full);
    }
  }
  return removed;
}
