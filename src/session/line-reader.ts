/**
 * 会话文件的字节级按行读取（docs/memory-plan.md D6、§2.4）。[M-C0] 实现与单测；调用方由 [M-C] 接入
 * （`store.ts readSessionLines`、`scan.ts forEachLine`、`list.ts`）。
 *
 * - fd + 定长块（缺省 64 KiB）顺序 `readSync`，以 `indexOf(0x0a)` 切行；跨块的残片拷贝后在行尾
 *   `Buffer.concat`，不生成全文字符串，也不 split 出整个数组；
 * - 回调拿到的 `line` 不含 `\n` 与行尾的一个 `\r`，**只在回调期间有效**（可能是复用块的视图），
 *   需要保留时自行拷贝或解码；空行照样回调（是否跳过由调用方决定）；
 * - `index` 是物理行号（0 起，含空行）；`byteOffset` 是该行首字节在文件中的偏移（修复半行时
 *   直接 `truncateSync(file, byteOffset)`）；`last` 为 true 表示这是**没有以 `\n` 结尾**的末行；
 *   文件以 `\n` 结尾时不会多回调一个空的末行；
 * - 回调返回 `false` 立即停止读盘并关闭 fd。
 */

import { closeSync, openSync, readSync } from "node:fs";
import { lineType } from "./scan.js";

/** 缺省块大小。 */
export const LINE_CHUNK_BYTES = 64 * 1024;

export interface LineVisit {
  (line: Buffer, index: number, last: boolean, byteOffset: number): boolean | void;
}

const LF = 0x0a;
const CR = 0x0d;

function stripCr(line: Buffer): Buffer {
  return line.length > 0 && line[line.length - 1] === CR ? line.subarray(0, -1) : line;
}

/** 逐行访问 `file`（同步）；打不开时抛 `fs` 的原始错误。 */
export function forEachLineSync(
  file: string,
  visit: LineVisit,
  chunkBytes: number = LINE_CHUNK_BYTES,
): void {
  const size = Math.max(1, Math.floor(chunkBytes));
  const fd = openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(size);
    let pending: Buffer[] = [];
    let index = 0;
    let lineStart = 0;
    let position = 0;
    for (;;) {
      const read = readSync(fd, chunk, 0, size, position);
      if (read === 0) break;
      position += read;
      const view = chunk.subarray(0, read);
      let from = 0;
      for (let nl = view.indexOf(LF, from); nl >= 0; nl = view.indexOf(LF, from)) {
        let line = view.subarray(from, nl);
        if (pending.length > 0) {
          pending.push(line);
          line = Buffer.concat(pending);
          pending = [];
        }
        const offset = lineStart;
        lineStart += line.length + 1;
        from = nl + 1;
        if (visit(stripCr(line), index++, false, offset) === false) return;
      }
      // 块尾残片：块会被下一次 readSync 覆盖，必须拷贝
      if (from < read) pending.push(Buffer.from(view.subarray(from)));
    }
    if (pending.length > 0) {
      const line = pending.length === 1 ? (pending[0] as Buffer) : Buffer.concat(pending);
      visit(stripCr(line), index, true, lineStart);
    }
  } finally {
    closeSync(fd);
  }
}

/** 只解码这么多字节来判断行类型（`{"type":"message","message":{"role":"toolResult"` 约 48 字节）。 */
const TYPE_HEAD_BYTES = 96;

/**
 * ama 写的行：不解析、只解码行首就取出 type（与消息的 role），口径同 `scan.ts lineType`；
 * 不是这种形状（或行首不足以判断 role）时 undefined，调用方退回 `JSON.parse`。
 */
export function lineTypeOf(line: Buffer): { type: string; role?: string } | undefined {
  if (line.length <= TYPE_HEAD_BYTES) return lineType(line.toString("utf8"));
  const found = lineType(line.subarray(0, TYPE_HEAD_BYTES).toString("utf8"));
  // role 可能被截断：宁可让调用方完整解析，也不给出与 `lineType` 不同的答案
  if (found?.type === "message" && found.role === undefined) return undefined;
  return found;
}
