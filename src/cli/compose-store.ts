/**
 * 组装根：会话存储（实施计划 §1.1 `sessions.*`）。[B6]
 *
 * 会话根目录 `sessionDir` 下按 cwd 分子目录（`sessionDirForCwd`）。
 * - `new` → 延迟落盘新建；`memory`（`--no-session`）→ 内存会话，从不落盘；`continue` → 本目录最近一条（没有则新建）；
 * - `resume{id}` / `fork{id}`：先在本目录、再在全部子目录里按 id 或唯一前缀找文件；找不到 →
 *   `session_not_found`，前缀不唯一 → `invalid_arguments` 并列出候选；
 * - `session-id{id}`：找到则打开，否则以该 id 新建；
 * - `fork{id}`：打开后从叶子复制出新文件，原会话立即关闭（释放锁）。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AmaError } from "../errors.js";
import { SessionManager } from "../session/manager.js";
import { migrateSessionLines } from "../session/migrate.js";
import {
  TRASH_DIR_NAME,
  listSessionFiles,
  purgeTrash,
  readSessionLines,
  sessionDirForCwd,
  sessionIdFromFileName,
  trashSession,
} from "../session/store.js";
import type { SessionListItem } from "../session/types.js";
import type { RuntimeDeps, SessionRequest } from "./deps.js";
import { msg } from "../i18n/index.js";

/** 根目录下全部 cwd 子目录（不含 trash）。 */
function cwdDirs(root: string): string[] {
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

/** 按 id / 唯一前缀找会话文件；本 cwd 目录优先。 */
export function findSessionFile(root: string, id: string, cwd?: string): string | undefined {
  const dirs = cwd === undefined ? cwdDirs(root) : [sessionDirForCwd(root, cwd), ...cwdDirs(root)];
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
    throw new AmaError("invalid_arguments", msg().cli.composeStore.ambiguousId(id, ids), {
      exitCode: 5,
    });
  }
  return prefix[0];
}

function requireFile(root: string, id: string, cwd?: string): string {
  const file = findSessionFile(root, id, cwd);
  if (file === undefined)
    throw new AmaError("session_not_found", msg().cli.composeStore.sessionNotFound(id));
  return file;
}

export function openSession(
  request: SessionRequest,
  context: { sessionDir: string; cwd: string },
): SessionManager {
  const { sessionDir: root, cwd } = context;
  const dir = sessionDirForCwd(root, cwd);
  switch (request.kind) {
    case "new":
      return SessionManager.create(dir, cwd);
    case "memory":
      return SessionManager.inMemory(cwd);
    case "continue":
      return SessionManager.continueRecent(dir, cwd);
    case "resume":
      return SessionManager.open(requireFile(root, request.id, cwd));
    case "session-id": {
      const file = findSessionFile(root, request.id, cwd);
      return file === undefined
        ? SessionManager.create(dir, cwd, { id: request.id })
        : SessionManager.open(file);
    }
    case "fork": {
      const source = SessionManager.open(requireFile(root, request.id, cwd));
      try {
        const leaf = source.leafId();
        if (leaf === null)
          throw new AmaError("session_corrupt", msg().cli.composeStore.noEntries(request.id));
        return source.fork(leaf);
      } finally {
        source.close();
      }
    }
  }
}

/** 列会话（最新在前）；子 Agent 会话缺省跳过，`includeSubagents` 时保留（带 `subagent` 标记）。 */
export function listSessions(context: {
  sessionDir: string;
  cwd?: string;
  includeSubagents?: boolean;
}): SessionListItem[] {
  const dirs =
    context.cwd === undefined
      ? cwdDirs(context.sessionDir)
      : [sessionDirForCwd(context.sessionDir, context.cwd)];
  return dirs
    .flatMap((dir) => SessionManager.list(dir))
    .filter((item) => context.includeSubagents === true || item.subagent !== true)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export function createSessionStore(): RuntimeDeps["sessions"] {
  return {
    open: (request, context) => openSession(request, context),
    list: async (context) => listSessions(context),
    show: async (id, context) => {
      const file = requireFile(context.sessionDir, id);
      const item = SessionManager.list(join(file, "..")).find((i) => i.file === file);
      if (item === undefined)
        throw new AmaError("session_corrupt", msg().cli.composeStore.unreadable(file));
      const { entries } = migrateSessionLines(readSessionLines(file).lines, file);
      return { item, entries };
    },
    prune: async (context) => {
      const cutoff = Date.now() - context.olderThanDays * 24 * 60 * 60 * 1000;
      // 子 Agent 会话一样按时间清理
      const old = listSessions({ ...context, includeSubagents: true }).filter(
        (i) => Date.parse(i.modifiedAt) < cutoff,
      );
      if (context.dryRun) return { moved: old.map((i) => i.file) };
      for (const item of old) trashSession(item.file, context.sessionDir);
      purgeTrash(context.sessionDir);
      return { moved: old.map((i) => i.file) };
    },
  };
}
