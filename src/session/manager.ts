/**
 * SessionManager（设计 §8、§11.1 第 7 / 16 步）：JSONL 条目树的读写与叶子管理。[B2]
 *
 * - `inMemory(cwd)`：从不落盘。
 * - `create(dir, cwd)`：**延迟落盘**——`append()` 先记在内存，直到 `flush()`（AgentSession 在
 *   首次模型请求前调用）才建文件、写头与已缓存条目、加锁；之后每次 `append()` 立即追加一行。
 * - `open(file)`：读文件（修复末尾半行）、校验版本、加锁；叶子 = 文件中最后一条条目，
 *   若其后还有 `leaf` 行（`/tree` 换叶子落盘，第三波 A7）则取最后一条 leaf 行。
 * - `setLeaf(id)`：已落盘时追加一行 `leaf{id, timestamp}`；延迟会话在 `flush()` 时补写。
 * - `fork(entryId, { head })`：复制 root → entryId 的分支到新文件（头的 parentSession 指回本文件），
 *   不复制 leaf 行；给了 `head` 时它成为新根条目，复制的首条重挂到它下面（fork 子会话的 ama.task）。
 * - `close()`：释放锁；之后的 append 抛错。
 */

import { randomBytes, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { AmaError } from "../errors.js";
import { AMA_VERSION } from "../version.js";
import { migrateSessionLines } from "./migrate.js";
import {
  acquireLock,
  appendLines,
  isSubagentSession,
  isSubagentSessionFile,
  listSessionFiles,
  readSessionLines,
  sessionDirForCwd,
  sessionFileName,
  writeNewSessionFile,
  type SessionLock,
} from "./store.js";
import { buildTree, indexEntries, pathToRoot } from "./tree.js";
import { SESSION_FORMAT_VERSION } from "./types.js";
import type {
  LeafLine,
  SessionEntry,
  SessionEntryInput,
  SessionHeader,
  SessionListItem,
  SessionManagerApi,
  SessionTreeNode,
} from "./types.js";

export interface SessionManagerOptions {
  /** 测试注入时钟。 */
  now?: () => Date;
  /** 头里的 parentSession。 */
  parentSession?: string;
  /** 指定会话 id（`--session-id`）。 */
  id?: string;
}

type Storage =
  | { kind: "memory" }
  | { kind: "lazy"; dir: string }
  | { kind: "file"; file: string; lock: SessionLock | undefined };

function newEntryId(taken: ReadonlyMap<string, unknown>): string {
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!taken.has(id)) return id;
  }
}

export class SessionManager implements SessionManagerApi {
  readonly id: string;
  readonly cwd: string;
  private readonly _header: SessionHeader;
  private readonly _entries: SessionEntry[];
  private readonly index: Map<string, SessionEntry>;
  private leaf: string | null;
  private storage: Storage;
  private closed = false;
  private readonly now: () => Date;

  private constructor(
    header: SessionHeader,
    entries: SessionEntry[],
    storage: Storage,
    now: () => Date,
    leafId?: string | null,
  ) {
    this._header = header;
    this.id = header.id;
    this.cwd = header.cwd;
    this._entries = entries;
    this.index = indexEntries(entries);
    const last = entries.at(-1)?.id ?? null;
    this.leaf =
      leafId === undefined || (leafId !== null && !this.index.has(leafId)) ? last : leafId;
    this.storage = storage;
    this.now = now;
  }

  private static newHeader(cwd: string, options: SessionManagerOptions, now: Date): SessionHeader {
    const header: SessionHeader = {
      type: "session",
      version: SESSION_FORMAT_VERSION,
      id: options.id ?? randomUUID(),
      timestamp: now.toISOString(),
      cwd,
      agent: { name: "ama", version: AMA_VERSION },
    };
    if (options.parentSession !== undefined) header.parentSession = options.parentSession;
    return header;
  }

  static inMemory(cwd: string, options: SessionManagerOptions = {}): SessionManager {
    const now = options.now ?? (() => new Date());
    return new SessionManager(this.newHeader(cwd, options, now()), [], { kind: "memory" }, now);
  }

  /** `dir` 是会话文件所在目录（通常是 `sessionDirForCwd(sessionsRoot, cwd)`）。 */
  static create(dir: string, cwd: string, options: SessionManagerOptions = {}): SessionManager {
    const now = options.now ?? (() => new Date());
    return new SessionManager(this.newHeader(cwd, options, now()), [], { kind: "lazy", dir }, now);
  }

  static createForCwd(
    sessionsRoot: string,
    cwd: string,
    options: SessionManagerOptions = {},
  ): SessionManager {
    return this.create(sessionDirForCwd(sessionsRoot, cwd), cwd, options);
  }

  static open(file: string, options: { now?: () => Date } = {}): SessionManager {
    const lock = acquireLock(file);
    try {
      const { lines } = readSessionLines(file, { repair: true });
      const { header, entries, leafId } = migrateSessionLines(lines, file);
      return new SessionManager(
        header,
        entries,
        { kind: "file", file, lock },
        options.now ?? (() => new Date()),
        leafId,
      );
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  /** `--continue`：本目录最近一条（跳过子 Agent 会话，只读文件头两行）；没有则新建（延迟落盘）。 */
  static continueRecent(dir: string, cwd: string): SessionManager {
    const latest = listSessionFiles(dir).find((file) => !isSubagentSessionFile(file));
    return latest === undefined ? this.create(dir, cwd) : this.open(latest);
  }

  /** 只读列出目录下的会话（最新在前）；损坏的文件跳过。 */
  static list(dir: string): SessionListItem[] {
    const items: SessionListItem[] = [];
    for (const file of listSessionFiles(dir)) {
      try {
        const { header, entries } = migrateSessionLines(readSessionLines(file).lines, file);
        let name: string | undefined;
        let firstPrompt: string | undefined;
        let messageCount = 0;
        for (const entry of entries) {
          if (entry.type === "session_info" && entry.name !== undefined) name = entry.name;
          if (entry.type !== "message" || entry.message.role === "system") continue;
          messageCount++;
          if (firstPrompt === undefined && entry.message.role === "user") {
            const { content } = entry.message;
            firstPrompt =
              typeof content === "string"
                ? content
                : content.map((block) => (block.type === "text" ? block.text : "")).join("");
          }
        }
        const item: SessionListItem = {
          id: header.id,
          file,
          cwd: header.cwd,
          createdAt: header.timestamp,
          modifiedAt: statSync(file).mtime.toISOString(),
          messageCount,
        };
        if (name !== undefined) item.name = name;
        if (isSubagentSession(header, entries[0])) item.subagent = true;
        if (firstPrompt !== undefined) item.firstPrompt = firstPrompt.slice(0, 200);
        items.push(item);
      } catch {
        // 损坏 / 不可读：列表里跳过（sessions show 会给出具体错误）
      }
    }
    return items;
  }

  // -------------------------------------------------------------------------
  // SessionManagerApi
  // -------------------------------------------------------------------------

  file(): string | undefined {
    return this.storage.kind === "file" ? this.storage.file : undefined;
  }

  header(): SessionHeader {
    return this._header;
  }

  entries(): readonly SessionEntry[] {
    return this._entries;
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.index.get(id);
  }

  leafId(): string | null {
    return this.leaf;
  }

  append(input: SessionEntryInput): SessionEntry {
    if (this.closed) throw new AmaError("session_closed", "session manager is closed");
    const entry = {
      ...input,
      id: newEntryId(this.index),
      parentId: this.leaf,
      timestamp: this.now().toISOString(),
    } as SessionEntry;
    if (this.storage.kind === "file") appendLines(this.storage.file, [entry]);
    this._entries.push(entry);
    this.index.set(entry.id, entry);
    this.leaf = entry.id;
    return entry;
  }

  setLeaf(id: string | null): void {
    if (id !== null && !this.index.has(id)) {
      throw new AmaError("invalid_arguments", `no such session entry: ${id}`);
    }
    this.leaf = id;
    if (this.storage.kind === "file") appendLines(this.storage.file, [this.leafLine()]);
  }

  private leafLine(): LeafLine {
    return { type: "leaf", id: this.leaf, timestamp: this.now().toISOString() };
  }

  branch(leafId?: string | null): SessionEntry[] {
    return pathToRoot(this.index, leafId === undefined ? this.leaf : leafId);
  }

  getEntries(since?: string): { entries: SessionEntry[]; leafId: string | null } {
    if (since === undefined) return { entries: [...this._entries], leafId: this.leaf };
    const at = this._entries.findIndex((entry) => entry.id === since);
    return {
      entries: at < 0 ? [...this._entries] : this._entries.slice(at + 1),
      leafId: this.leaf,
    };
  }

  getTree(): SessionTreeNode[] {
    return buildTree(this._entries);
  }

  name(): string | undefined {
    let name: string | undefined;
    for (const entry of this._entries) if (entry.type === "session_info") name = entry.name;
    return name;
  }

  setName(name: string): void {
    this.append({ type: "session_info", name });
  }

  fork(entryId: string, forkOptions: { head?: SessionEntryInput } = {}): SessionManager {
    if (!this.index.has(entryId)) {
      throw new AmaError("invalid_arguments", `no such session entry: ${entryId}`);
    }
    const copied = this.branch(entryId).map((entry) => structuredClone(entry));
    if (forkOptions.head !== undefined) {
      const head = {
        ...forkOptions.head,
        id: newEntryId(indexEntries(copied)),
        parentId: null,
        timestamp: this.now().toISOString(),
      } as SessionEntry;
      if (copied[0] !== undefined) copied[0].parentId = head.id;
      copied.unshift(head);
    }
    const options: SessionManagerOptions = { now: this.now };
    const parentFile = this.file();
    if (parentFile !== undefined) options.parentSession = parentFile;
    const header = SessionManager.newHeader(this.cwd, options, this.now());
    let storage: Storage;
    if (this.storage.kind === "memory") storage = { kind: "memory" };
    else if (this.storage.kind === "lazy") storage = { kind: "lazy", dir: this.storage.dir };
    else storage = { kind: "lazy", dir: dirname(this.storage.file) };
    const forked = new SessionManager(header, copied, storage, this.now);
    if (parentFile !== undefined) forked.flush();
    return forked;
  }

  // -------------------------------------------------------------------------
  // 落盘控制
  // -------------------------------------------------------------------------

  /** 延迟会话：建文件、写头与缓存条目、加锁。返回文件路径（内存会话为 undefined）。幂等。 */
  flush(): string | undefined {
    if (this.closed) throw new AmaError("session_closed", "session manager is closed");
    if (this.storage.kind === "memory") return undefined;
    if (this.storage.kind === "file") return this.storage.file;
    const file = join(this.storage.dir, sessionFileName(new Date(this._header.timestamp), this.id));
    const moved = this.leaf !== (this._entries.at(-1)?.id ?? null);
    writeNewSessionFile(file, [
      this._header,
      ...this._entries,
      ...(moved ? [this.leafLine()] : []),
    ]);
    let lock: SessionLock | undefined;
    try {
      lock = acquireLock(file);
    } catch {
      lock = undefined;
    }
    this.storage = { kind: "file", file, lock };
    return file;
  }

  isPersisted(): boolean {
    return this.storage.kind === "file";
  }

  isInMemory(): boolean {
    return this.storage.kind === "memory";
  }

  /** 会话文件所在目录（内存会话 undefined）。 */
  directory(): string | undefined {
    if (this.storage.kind === "lazy") return this.storage.dir;
    if (this.storage.kind === "file") return dirname(this.storage.file);
    return undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.storage.kind === "file") this.storage.lock?.release();
  }
}
