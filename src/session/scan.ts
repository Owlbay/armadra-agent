/**
 * 会话目录的只读扫描（`ama stats`、`ama sessions search|export`、`--from`）。[W4-D]
 *
 * 与 store.ts / manager.ts 的区别：这里**从不加锁、不修复、不写文件**——正在运行的会话也能读。
 * - `sessionFilesInScope`：按 cwd（只看它的编码子目录）或全部子目录（跳过 `.trash`）列文件，最新在前；
 * - `forEachLine`：按行回调（不先 split 出整个数组）；
 * - `lineType`：ama 写入的行以 `{"type":"…"` 开头（manager 的 append 把 type 放在第一个键），
 *   据此不解析就能跳过不需要的行；其它程序写的行退回 JSON.parse；
 * - `readSessionReadOnly`：头 + 条目 + 叶子（同 migrate.ts 的规则），末尾半行忽略、中间坏行抛错。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { AmaError } from "../errors.js";
import { migrateSessionLines, type MigratedSession } from "./migrate.js";
import {
  SESSION_FILE_SUFFIX,
  TRASH_DIR_NAME,
  listSessionFiles,
  sessionDirForCwd,
  sessionIdFromFileName,
} from "./store.js";
import type { SessionLine } from "./types.js";

/** 根目录下全部 cwd 子目录（不含 trash）。 */
export function sessionSubdirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name !== TRASH_DIR_NAME)
    .map((name) => join(root, name))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}

/** 范围内的会话文件：给 cwd 只看该目录，否则全部；按文件名（创建时间）倒序。 */
export function sessionFilesInScope(root: string, cwd?: string): string[] {
  const dirs = cwd === undefined ? sessionSubdirs(root) : [sessionDirForCwd(root, cwd)];
  const files = dirs.flatMap((dir) => listSessionFiles(dir));
  return files.sort((a, b) => basename(b).localeCompare(basename(a)));
}

/** 按 id 或唯一前缀找会话文件；本 cwd 目录优先（同 compose-store 的规则，但只读、不 import 组装根）。 */
export function findSessionFileReadOnly(root: string, id: string, cwd?: string): string {
  const dirs =
    cwd === undefined
      ? sessionSubdirs(root)
      : [sessionDirForCwd(root, cwd), ...sessionSubdirs(root)];
  const seen = new Set<string>();
  const prefix: string[] = [];
  for (const dir of dirs) {
    for (const file of listSessionFiles(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);
      const fileId = sessionIdFromFileName(file);
      if (fileId === id) return file;
      if (fileId?.startsWith(id) === true) prefix.push(file);
    }
  }
  if (prefix.length > 1) {
    const ids = prefix.map((f) => sessionIdFromFileName(f) ?? f).slice(0, 10);
    throw new AmaError("invalid_arguments", `会话 id 前缀 ${id} 不唯一，候选：${ids.join(", ")}`, {
      exitCode: 5,
    });
  }
  const [file] = prefix;
  if (file === undefined)
    throw new AmaError("session_not_found", `会话不存在：${id}`, { exitCode: 5 });
  return file;
}

/**
 * 逐行回调（不含行尾 `\n` / `\r`，跳过空行）；`last` 表示文件最后一行且没有换行结尾
 * （可能是写入中途的半行）。回调返回 false 提前结束。
 */
export function forEachLine(
  file: string,
  visit: (line: string, index: number, last: boolean) => boolean | void,
): void {
  const text = readFileSync(file, "utf8");
  let start = 0;
  let index = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    const last = end === -1;
    if (last) end = text.length;
    let line = text.slice(start, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    start = end + 1;
    if (line.trim() === "") continue;
    if (visit(line, index++, last) === false) return;
  }
}

const TYPE_PREFIX = '{"type":"';

/** ama 写的行：不解析就取出 type（与消息的 role，若紧随其后）；不是这种形状时 undefined。 */
export function lineType(line: string): { type: string; role?: string } | undefined {
  if (!line.startsWith(TYPE_PREFIX)) return undefined;
  const end = line.indexOf('"', TYPE_PREFIX.length);
  if (end < 0) return undefined;
  const type = line.slice(TYPE_PREFIX.length, end);
  if (type !== "message") return { type };
  const rolePrefix = ',"message":{"role":"';
  if (!line.startsWith(rolePrefix, end + 1)) return { type };
  const roleStart = end + 1 + rolePrefix.length;
  const roleEnd = line.indexOf('"', roleStart);
  return roleEnd < 0 ? { type } : { type, role: line.slice(roleStart, roleEnd) };
}

/** 解析一行；失败时：末尾半行 → undefined，其它 → 抛 session_corrupt。 */
export function parseLine(
  file: string,
  line: string,
  index: number,
  last: boolean,
): SessionLine | undefined {
  try {
    return JSON.parse(line) as SessionLine;
  } catch (error) {
    if (last) return undefined;
    throw new AmaError("session_corrupt", `${file}:${index + 1}: invalid JSON line`, {
      cause: error,
    });
  }
}

/** 只读读取整个会话（不加锁、不修复）：头、全部条目、叶子 id。 */
export function readSessionReadOnly(file: string): MigratedSession & { leaf: string | null } {
  const lines: SessionLine[] = [];
  try {
    forEachLine(file, (line, index, last) => {
      const parsed = parseLine(file, line, index, last);
      if (parsed !== undefined) lines.push(parsed);
    });
  } catch (error) {
    if (error instanceof AmaError) throw error;
    throw new AmaError("session_not_found", `cannot read session file ${file}`, { cause: error });
  }
  const migrated = migrateSessionLines(lines, file);
  const leaf =
    migrated.leafId !== undefined ? migrated.leafId : (migrated.entries.at(-1)?.id ?? null);
  return { ...migrated, leaf };
}
