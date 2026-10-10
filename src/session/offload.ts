/**
 * 会话图片卸载（#170）：被 `context_edit` 改写的旧消息不再进上下文，内存里只留它在会话文件中的行位置，
 * 图片 base64 需要时再从文件回读。JSONL 格式不变。
 *
 * - 对象：活动分支上、被活动分支上的 `context_edit`（任何 reason）改写的 `message` 条目里的 `image` 块；
 *   不在活动分支上的条目一律保持原文（rewind 回到编辑点之前、`/tree` 换分支时回读）；
 * - 打开文件时先扫一遍 `context_edit` 行（只解码行首判断类型）收集目标，读条目时目标里的图片解析完
 *   随即剥掉，峰值不再含全部旧图；随后按活动分支对齐（不在分支上的编辑目标回读）；
 * - 卸载**不改共享的 ImageBlock**（驻留 block 被其它条目 / 会话共享）：`entry.message` 换成浅拷贝，
 *   `content` 换新数组，image 块换成 `data: ""` 的占位；
 * - 回读：按行位置 `readSync` 一行、`JSON.parse`，校验 id 与内容块数，图片经 `internImage` 驻留后
 *   **就地**放回占位所在的数组（之前拿到同一消息对象的调用方随之看到原图）；读不回（文件被外部改写）时
 *   保留 `""` 并告警，不再重试；告警通道可后接（`setWarn`）：接上之前的告警先缓冲（最多
 *   `PENDING_WARNINGS` 条，其余折叠成一条计数），接上时按序冲出（#183）；
 * - `original(entry)`：给 `getEntries` / `fork` 的原文副本，不改内存状态。
 */

import { closeSync, openSync, readSync } from "node:fs";
import { internImage } from "../ai/image-intern.js";
import type { ImageBlock, Message } from "../ai/types.js";
import { forEachLineSync, lineTypeOf } from "./line-reader.js";
import { collectContextEdits } from "./projection.js";
import type { SessionEntry } from "./types.js";

/** 一行在会话文件里的位置：行首偏移与字节数（不含行尾）。 */
export interface LineLocator {
  offset: number;
  length: number;
}

function isImage(block: unknown): block is ImageBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "image" &&
    typeof (block as { data?: unknown }).data === "string"
  );
}

function contentOf(entry: SessionEntry): unknown[] | undefined {
  if (entry.type !== "message") return undefined;
  const content = (entry.message as { content?: unknown }).content;
  return Array.isArray(content) ? content : undefined;
}

/** `message` 条目的内容里有图片块。 */
export function hasImages(entry: SessionEntry): boolean {
  return contentOf(entry)?.some(isImage) === true;
}

/** 读文件里 `locator` 处的一行并解析。 */
export function readLineAt(file: string, locator: LineLocator): unknown {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(locator.length);
    let read = 0;
    while (read < locator.length) {
      const n = readSync(fd, buf, read, locator.length - read, locator.offset + read);
      if (n === 0) throw new Error("unexpected end of file");
      read += n;
    }
    return JSON.parse(buf.toString("utf8")) as unknown;
  } finally {
    closeSync(fd);
  }
}

/** 文件里全部 `context_edit` 的目标 id（只解析 context_edit 行；读不了时为空集）。 */
export function editTargets(file: string): Set<string> {
  const targets = new Set<string>();
  try {
    forEachLineSync(file, (line) => {
      if (lineTypeOf(line)?.type !== "context_edit") return;
      try {
        const id = (JSON.parse(line.toString("utf8")) as { targetId?: unknown }).targetId;
        if (typeof id === "string") targets.add(id);
      } catch {
        // 末尾半行：随后的 readSessionLines 修复
      }
    });
  } catch {
    // 读不了：由随后的 readSessionLines 报错
  }
  return targets;
}

const placeholder = (block: ImageBlock): ImageBlock => ({ ...block, data: "" });

/** 告警通道接上之前最多缓冲的条数；超出的只计数，冲出时折叠成一条。 */
export const PENDING_WARNINGS = 16;

export class ImageOffload {
  /** 含图 message 条目的行位置（只有已落盘的条目才有）。 */
  private readonly locators = new Map<string, LineLocator>();
  private readonly offloaded = new Set<string>();

  private warn: ((message: string) => void) | undefined;
  private readonly pending: string[] = [];
  private dropped = 0;

  constructor(warn?: (message: string) => void) {
    this.warn = warn;
  }

  /** 接上（或换掉）告警通道；之前缓冲的告警按序冲出。 */
  setWarn(warn: (message: string) => void): void {
    this.warn = warn;
    const pending = this.pending.splice(0);
    if (this.dropped > 0)
      pending.push(`and ${this.dropped} more session entries could not be read back`);
    this.dropped = 0;
    for (const message of pending) warn(message);
  }

  /** 记下条目的行位置；不含图片的条目忽略。 */
  track(entry: SessionEntry, locator: LineLocator): void {
    if (hasImages(entry)) this.locators.set(entry.id, locator);
  }

  /** 读文件时逐行调用：记下行位置；`strip` 时就地换成占位（刚解析的对象，别处没有引用）。 */
  load(line: SessionEntry, locator: LineLocator, strip: boolean): void {
    if (typeof line.id !== "string" || !hasImages(line)) return;
    this.locators.set(line.id, locator);
    if (!strip) return;
    const content = contentOf(line) as unknown[];
    content.forEach((block, i) => {
      if (isImage(block)) content[i] = placeholder(block);
    });
    this.offloaded.add(line.id);
  }

  isOffloaded(id: string): boolean {
    return this.offloaded.has(id);
  }

  /** 已卸载的条目数（测试与诊断用）。 */
  get size(): number {
    return this.offloaded.size;
  }

  /** 把条目里的图片换成占位；没有行位置（未落盘、不含图）或已卸载时返回 false。 */
  offload(entry: SessionEntry): boolean {
    if (entry.type !== "message" || this.offloaded.has(entry.id)) return false;
    const content = contentOf(entry);
    if (content === undefined || !this.locators.has(entry.id)) return false;
    entry.message = {
      ...entry.message,
      content: content.map((block) => (isImage(block) ? placeholder(block) : block)),
    } as Message;
    this.offloaded.add(entry.id);
    return true;
  }

  /** 就地放回图片；读不回时返回 false（占位保留，之后不再卸载 / 回读这一条）。 */
  hydrate(file: string, entry: SessionEntry): boolean {
    if (!this.offloaded.has(entry.id)) return true;
    this.offloaded.delete(entry.id);
    const source = this.read(file, entry);
    const content = contentOf(entry);
    if (source === undefined || content === undefined) return false;
    const originals = contentOf(source) ?? [];
    content.forEach((block, i) => {
      const original = originals[i];
      if (isImage(block) && block.data === "" && isImage(original)) {
        content[i] = internImage(original);
      }
    });
    return true;
  }

  /** 原文：已卸载的条目从文件读一份新副本（图片驻留），否则原样返回。读不回时返回占位版本。 */
  original(file: string, entry: SessionEntry): SessionEntry {
    if (!this.offloaded.has(entry.id)) return entry;
    const copy = this.read(file, entry);
    if (copy === undefined) return entry;
    const content = contentOf(copy) ?? [];
    content.forEach((block, i) => {
      if (isImage(block)) content[i] = internImage(block);
    });
    return copy;
  }

  /** 按活动分支对齐：分支上被生效编辑改写的含图条目卸载，其余已卸载的回读。 */
  sync(
    file: string,
    branch: readonly SessionEntry[],
    index: ReadonlyMap<string, SessionEntry>,
  ): void {
    const edits = collectContextEdits(branch);
    const onBranch = new Set<string>();
    for (const entry of branch) if (edits.has(entry.id)) onBranch.add(entry.id);
    for (const id of [...this.offloaded]) {
      const entry = index.get(id);
      if (entry !== undefined && !onBranch.has(id)) this.hydrate(file, entry);
    }
    for (const id of onBranch) {
      const entry = index.get(id);
      if (entry !== undefined) this.offload(entry);
    }
  }

  /** 从文件读回条目（新对象）；不成功时告警、忘掉行位置并返回 undefined。 */
  private read(file: string, entry: SessionEntry): SessionEntry | undefined {
    const locator = this.locators.get(entry.id);
    try {
      if (locator === undefined) throw new Error("no line locator");
      const line = readLineAt(file, locator) as SessionEntry;
      const content = line.id === entry.id ? contentOf(line) : undefined;
      if (content === undefined || content.length !== contentOf(entry)?.length) {
        throw new Error("line does not match the entry");
      }
      return line;
    } catch (error) {
      this.locators.delete(entry.id);
      this.offloaded.delete(entry.id);
      this.report(`cannot read session entry ${entry.id} back from ${file}: ${String(error)}`);
      return undefined;
    }
  }

  private report(message: string): void {
    if (this.warn !== undefined) this.warn(message);
    else if (this.pending.length < PENDING_WARNINGS) this.pending.push(message);
    else this.dropped++;
  }
}
