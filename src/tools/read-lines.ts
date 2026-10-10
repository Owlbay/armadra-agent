/**
 * `read` 大文件的字节窗口读取（docs/history/memory-plan.md D1、§2.1）。[M-E]
 *
 * fd + 64 KiB 块顺序扫描，只解码 `[offset, offset + limit)` 内且累计不超过 `maxBytes`（多收一行）
 * 的行，其余行只计数；口径与小文件路径（`splitBom` + `normalizeToLF` + 去末尾一个换行再 `split`）
 * 逐字节相同：
 * - 行终止符是 `\r\n`、`\n` 或孤立 `\r`（`normalizeToLF` 把孤立 `\r` 也当换行，R1）；块边界上的
 *   `\r` | `\n` 记作一个终止符；最后一个终止符之后还有字节则多一行；
 * - UTF-8 BOM 只看文件前 3 字节；
 * - 按行解码：终止符都是 ASCII，不会落在多字节序列中间，无效字节的替换结果与整段解码相同；
 * - 窗口内单行超过 `maxBytes + LINE_SLACK` 字节时只留开头（这一行必然触发字节截断，
 *   `truncateHead` 至多取它开头 `maxBytes` 字节），超长行不会整行进内存。
 *
 * 解析状态机是 `LineScanner`，同步版 `readLineWindow` 与异步版 `readLineWindowAsync` 共用（#171）：
 * 异步版每块一次 `await`，大文件扫描期间不独占事件循环；峰值内存相同（仍一块缓冲）。
 */

import { closeSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";

/** 超过这个大小的文本文件走字节窗口；不超过的保留整读路径。 */
export const STREAM_READ_THRESHOLD = 1024 * 1024;

const CHUNK_BYTES = 64 * 1024;
/** 截短超长行时多留的字节：盖住行号前缀与 `sliceHeadBytes` 回退到字符起点的余量。 */
const LINE_SLACK = 64;
const LF = 0x0a;
const CR = 0x0d;

export interface LineWindow {
  /** 窗口内的行：首行已去 BOM、已按 LF 切分、已去行尾 `\r`。 */
  lines: string[];
  /** 全文行数（口径同 `normalized.replace(/\n$/, "").split("\n")`）。 */
  totalLines: number;
  /** 因 `maxBytes` 提前停止收集。 */
  truncatedBy?: "bytes";
  /** 文件以 UTF-8 BOM 开头。 */
  bom: boolean;
}

/** 文件开头至多 `bytes` 字节（一次 `readSync`，用于二进制嗅探）。 */
export function readHead(abs: string, bytes: number): Buffer {
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(bytes);
    let got = 0;
    while (got < bytes) {
      const n = readSync(fd, buf, got, bytes - got, null);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** `readHead` 的异步版（#171）。 */
export async function readHeadAsync(abs: string, bytes: number): Promise<Buffer> {
  const handle = await open(abs, "r");
  try {
    const buf = Buffer.alloc(bytes);
    let got = 0;
    while (got < bytes) {
      const { bytesRead } = await handle.read(buf, got, bytes - got, null);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return buf.subarray(0, got);
  } finally {
    await handle.close();
  }
}

/**
 * 按块喂入文件字节的行扫描状态机：第 `first` 行（0 起）到第 `stop` 行（不含）之间的行被收集，
 * 收集的行累计 `字节 + 1` 超过 `maxBytes` 后停止收集（含越界的那一行），其余行只计数。
 */
export class LineScanner {
  private readonly lineCap: number;
  private readonly lines: string[] = [];
  private truncatedBy: "bytes" | undefined;
  private collected = 0;
  private index = 0; // 已完成的行数
  private parts: Buffer[] = [];
  private partBytes = 0;
  private pending = false; // 最后一个终止符之后已有字节
  private skipLF = false; // 上一块以 `\r` 结尾：下一块开头的 `\n` 属于同一终止符
  private bom = false;
  private firstChunk = true;

  constructor(
    private readonly first: number,
    private readonly stop: number,
    private readonly maxBytes: number,
  ) {
    this.lineCap = maxBytes + LINE_SLACK;
  }

  /**
   * 处理 `buf[0, end)`；`eof` 表示这是最后一块。返回调用方下次读取前应保留在 `buf` 开头的字节数
   * （只在首块不足 3 字节、还判断不了 BOM 时非零）。
   */
  feed(buf: Buffer, end: number, eof: boolean): number {
    let pos = 0;
    if (this.firstChunk) {
      if (end < 3 && !eof) return end;
      this.firstChunk = false;
      if (end >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        this.bom = true;
        pos = 3;
      }
    }
    if (this.skipLF && pos < end) {
      if (buf[pos] === LF) pos++;
      this.skipLF = false;
    }
    let nextLF = buf.indexOf(LF, pos);
    let nextCR = buf.indexOf(CR, pos);
    while (pos < end) {
      if (nextLF !== -1 && nextLF < pos) nextLF = buf.indexOf(LF, pos);
      if (nextCR !== -1 && nextCR < pos) nextCR = buf.indexOf(CR, pos);
      const lf = nextLF === -1 || nextLF >= end ? end : nextLF;
      const cr = nextCR === -1 || nextCR >= end ? end : nextCR;
      const at = Math.min(lf, cr);
      if (at > pos) {
        this.pending = true;
        if (this.collecting()) this.take(buf, pos, at);
      }
      if (at === end) break;
      this.endLine();
      pos = at + 1;
      if (at === cr) {
        if (pos < end) {
          if (buf[pos] === LF) pos++;
        } else {
          this.skipLF = true;
        }
      }
    }
    return 0;
  }

  /** 文件读完：收尾最后一行并给出结果。 */
  finish(): LineWindow {
    if (this.pending) this.endLine();
    const { lines, truncatedBy, bom } = this;
    return { lines, totalLines: this.index, ...(truncatedBy ? { truncatedBy } : {}), bom };
  }

  private collecting(): boolean {
    return this.truncatedBy === undefined && this.index >= this.first && this.index < this.stop;
  }

  private take(buf: Buffer, from: number, to: number): void {
    if (to <= from || this.partBytes >= this.lineCap) return;
    const end = Math.min(to, from + this.lineCap - this.partBytes);
    this.parts.push(Buffer.from(buf.subarray(from, end)));
    this.partBytes += end - from;
  }

  private endLine(): void {
    if (this.collecting()) {
      const { parts } = this;
      const line = (parts.length === 1 ? parts[0]! : Buffer.concat(parts)).toString("utf8");
      this.lines.push(line);
      this.collected += Buffer.byteLength(line) + 1;
      if (this.collected > this.maxBytes) this.truncatedBy = "bytes";
    }
    if (this.partBytes > 0) this.parts = []; // 窗口外的行不分配：40 万行时每行一个空数组就是十几 MB 临时垃圾
    this.partBytes = 0;
    this.pending = false;
    this.index++;
  }
}

function scanner(offset: number, limit: number | undefined, maxBytes: number): LineScanner {
  const first = offset - 1;
  return new LineScanner(first, limit === undefined ? Infinity : first + limit, maxBytes);
}

/**
 * 读取 `abs` 第 `offset` 行（1 起）开始的至多 `limit` 行（`undefined` 不限，`0` 只计数）；
 * 收集的行累计 `字节 + 1` 超过 `maxBytes` 后停止收集（含越界的那一行）。`chunkBytes` 只供测试。
 * 同步版，保留给单测与口径比对；`read` 工具用 `readLineWindowAsync`。
 */
export function readLineWindow(
  abs: string,
  offset: number,
  limit: number | undefined,
  maxBytes: number,
  chunkBytes = CHUNK_BYTES,
): LineWindow {
  const scan = scanner(offset, limit, maxBytes);
  const size = Math.max(3, chunkBytes);
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(size);
    let carry = 0; // 首块凑满 3 字节判断 BOM
    for (;;) {
      const n = readSync(fd, buf, carry, size - carry, null);
      const end = carry + n;
      if (end === 0) break;
      carry = scan.feed(buf, end, n === 0);
      if (n === 0) break;
    }
  } finally {
    closeSync(fd);
  }
  return scan.finish();
}

/** `readLineWindow` 的异步版（#171）：每块一次 `await`，结果与同步版相同。 */
export async function readLineWindowAsync(
  abs: string,
  offset: number,
  limit: number | undefined,
  maxBytes: number,
  chunkBytes = CHUNK_BYTES,
): Promise<LineWindow> {
  const scan = scanner(offset, limit, maxBytes);
  const size = Math.max(3, chunkBytes);
  const handle = await open(abs, "r");
  try {
    const buf = Buffer.alloc(size);
    let carry = 0;
    for (;;) {
      const { bytesRead: n } = await handle.read(buf, carry, size - carry, null);
      const end = carry + n;
      if (end === 0) break;
      carry = scan.feed(buf, end, n === 0);
      if (n === 0) break;
    }
  } finally {
    await handle.close();
  }
  return scan.finish();
}
