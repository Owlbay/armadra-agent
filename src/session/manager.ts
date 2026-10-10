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
 *   不复制 leaf 行；给了 `head` 时它成为新根条目，复制的首条重挂到它下面（fork 子会话的 ama.task）；
 *   `cwd` 缺省同本会话（[ME-A] 隔离的 fork 子会话传 worktree）。
 * - `close()`：释放锁；之后的 append 抛错。
 * - 图片卸载（#170，offload.ts）：已落盘会话里，活动分支上被 `context_edit` 改写的含图消息只留占位
 *   （`data: ""`），`entries()` / `branch()` / `getEntry()` 返回卸载后的对象；`getEntries()` 与
 *   `fork()` 从文件回读原文；`setLeaf()` 换分支后回读不再被改写的条目。内存会话不卸载。
 */

import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { internSessionImages } from "../ai/image-intern.js";
import { AmaError } from "../errors.js";
import { AMA_VERSION } from "../version.js";
import { listSessionItems } from "./list.js";
import { migrateSessionLines } from "./migrate.js";
import { ImageOffload, editTargets } from "./offload.js";
import {
  acquireLock,
  appendLines,
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
  /** 图片回读失败等告警（缺省丢弃）。 */
  warn?: (message: string) => void;
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
  private readonly images: ImageOffload;
  private warn: ((message: string) => void) | undefined;
  /** 已知的会话文件字节数（新行的行首偏移）。 */
  private fileBytes = 0;

  private constructor(
    header: SessionHeader,
    entries: SessionEntry[],
    storage: Storage,
    now: () => Date,
    leafId?: string | null,
    warn?: (message: string) => void,
    images?: ImageOffload,
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
    this.warn = warn;
    this.images = images ?? new ImageOffload(warn);
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
    return new SessionManager(
      this.newHeader(cwd, options, now()),
      [],
      { kind: "lazy", dir },
      now,
      undefined,
      options.warn,
    );
  }

  static createForCwd(
    sessionsRoot: string,
    cwd: string,
    options: SessionManagerOptions = {},
  ): SessionManager {
    return this.create(sessionDirForCwd(sessionsRoot, cwd), cwd, options);
  }

  static open(
    file: string,
    options: { now?: () => Date; warn?: (message: string) => void } = {},
  ): SessionManager {
    const lock = acquireLock(file);
    try {
      const images = new ImageOffload(options.warn);
      const targets = editTargets(file);
      const { lines, bytes } = readSessionLines(file, {
        repair: true,
        onLine: (line, locator) => {
          const entry = line as SessionEntry;
          images.load(entry, locator, targets.has(entry.id));
        },
      });
      const { header, entries, leafId } = migrateSessionLines(lines, file);
      internSessionImages(entries); // D5：同一图片的 base64 只留一份；JSONL 不变
      const manager = new SessionManager(
        header,
        entries,
        { kind: "file", file, lock },
        options.now ?? (() => new Date()),
        leafId,
        options.warn,
        images,
      );
      manager.fileBytes = bytes ?? 0;
      manager.syncImages();
      return manager;
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
    return listSessionItems(dir);
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
    if (this.storage.kind === "file") {
      const written = appendLines(this.storage.file, [entry]);
      this.images.track(entry, { offset: this.fileBytes, length: written - 1 });
      this.fileBytes += written;
    }
    this._entries.push(entry);
    this.index.set(entry.id, entry);
    this.leaf = entry.id;
    if (entry.type === "context_edit" && this.storage.kind === "file") {
      const target = this.index.get(entry.targetId);
      if (target !== undefined && this.branch().includes(target)) this.images.offload(target);
    }
    return entry;
  }

  setLeaf(id: string | null): void {
    if (id !== null && !this.index.has(id)) {
      throw new AmaError("invalid_arguments", `no such session entry: ${id}`);
    }
    this.leaf = id;
    if (this.storage.kind === "file") {
      this.fileBytes += appendLines(this.storage.file, [this.leafLine()]);
    }
    this.syncImages();
  }

  /** 按当前活动分支卸载 / 回读图片（只对已落盘的会话）。 */
  private syncImages(): void {
    if (this.storage.kind === "file")
      this.images.sync(this.storage.file, this.branch(), this.index);
  }

  /** 原文条目（已卸载的从文件回读一份副本）。 */
  private original(entry: SessionEntry): SessionEntry {
    if (this.storage.kind !== "file" || !this.images.isOffloaded(entry.id)) return entry;
    return this.images.original(this.storage.file, entry);
  }

  /** 接上（或换掉）告警出口（图片读不回等）；`open()` 期间缓冲的告警随即按序冲出（#183）。 */
  setWarn(warn: (message: string) => void): void {
    this.warn = warn;
    this.images.setWarn(warn);
  }

  /** 已卸载图片的条目数（测试与诊断用）。 */
  offloadedCount(): number {
    return this.images.size;
  }

  private leafLine(): LeafLine {
    return { type: "leaf", id: this.leaf, timestamp: this.now().toISOString() };
  }

  branch(leafId?: string | null): SessionEntry[] {
    return pathToRoot(this.index, leafId === undefined ? this.leaf : leafId);
  }

  getEntries(since?: string): { entries: SessionEntry[]; leafId: string | null } {
    const at = since === undefined ? -1 : this._entries.findIndex((entry) => entry.id === since);
    return {
      entries: this._entries.slice(at + 1).map((entry) => this.original(entry)),
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

  fork(
    entryId: string,
    forkOptions: { head?: SessionEntryInput; cwd?: string } = {},
  ): SessionManager {
    if (!this.index.has(entryId)) {
      throw new AmaError("invalid_arguments", `no such session entry: ${entryId}`);
    }
    const copied = this.branch(entryId).map((entry) => {
      const original = this.original(entry);
      return original === entry ? structuredClone(entry) : original;
    });
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
    const header = SessionManager.newHeader(forkOptions.cwd ?? this.cwd, options, this.now());
    let storage: Storage;
    if (this.storage.kind === "memory") storage = { kind: "memory" };
    else if (this.storage.kind === "lazy") storage = { kind: "lazy", dir: this.storage.dir };
    else storage = { kind: "lazy", dir: dirname(this.storage.file) };
    const forked = new SessionManager(header, copied, storage, this.now, undefined, this.warn);
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
    const lengths = writeNewSessionFile(file, [
      this._header,
      ...this._entries,
      ...(moved ? [this.leafLine()] : []),
    ]);
    let offset = 0;
    lengths.forEach((length, i) => {
      const entry = i === 0 ? undefined : this._entries[i - 1];
      if (entry !== undefined) this.images.track(entry, { offset, length });
      offset += length + 1;
    });
    this.fileBytes = offset;
    let lock: SessionLock | undefined;
    try {
      lock = acquireLock(file);
    } catch {
      lock = undefined;
    }
    this.storage = { kind: "file", file, lock };
    this.syncImages();
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
