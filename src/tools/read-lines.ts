/**
 * `read` 大文件的字节窗口读取（docs/memory-plan.md D1、§2.1）。[M-C0] 签名就位；[M-E] 实现：
 * fd + 64 KiB 块顺序扫描，只解码 `[offset, offset + limit)` 内且累计不超过 `maxBytes`（多收一行）
 * 的行，`totalLines` 只计换行；口径与小文件路径（`normalizeToLF` + `split`）逐字节相同。
 */

/** 超过这个大小的文本文件走字节窗口；不超过的保留整读路径。 */
export const STREAM_READ_THRESHOLD = 1024 * 1024;

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

/** 读取 `abs` 第 `offset` 行（1 起）开始的至多 `limit` 行。[M-C0] 尚未实现，无调用方。 */
export function readLineWindow(
  abs: string,
  offset: number,
  limit: number | undefined,
  maxBytes: number,
): LineWindow {
  void [abs, offset, limit, maxBytes];
  throw new Error("readLineWindow: not implemented");
}
