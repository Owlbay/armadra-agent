/**
 * JSONL 读写（设计 §13.2）。[B6]
 *
 * - 读：只按 `\n` 切行（不用 readline——它会在 U+2028 / U+2029 等处切），去掉行尾 `\r`，空行跳过；
 *   多字节 UTF-8 跨 chunk 用 StringDecoder 拼接；流结束时把最后一段不带换行的行也交出去。
 * - 写：一行拆成 ≤ 64 KiB 的片依次写入，遇到背压等 `drain`，保证大行（图片、长输出）不被截断、
 *   行与行之间不交错（调用方串行 await）。
 */

import { StringDecoder } from "node:string_decoder";

export const WRITE_CHUNK_BYTES = 64 * 1024;

export interface LineReader {
  /** 停止监听（不关闭流）。 */
  close(): void;
}

export function createLineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onEnd?: () => void,
): LineReader {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const emit = (raw: string): void => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() !== "") onLine(line);
  };
  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      emit(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
  };
  const finish = (): void => {
    buffer += decoder.end();
    if (buffer !== "") emit(buffer);
    buffer = "";
    detach();
    onEnd?.();
  };
  const detach = (): void => {
    stream.off("data", onData);
    stream.off("end", finish);
    stream.off("close", finish);
  };
  stream.on("data", onData);
  stream.once("end", finish);
  stream.once("close", finish);
  return { close: detach };
}

/** 按 64 KiB 分片写入（背压时等 drain）。 */
export async function writeChunked(
  stream: NodeJS.WritableStream,
  text: string,
  chunkBytes = WRITE_CHUNK_BYTES,
): Promise<void> {
  const bytes = Buffer.from(text, "utf8");
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const piece = bytes.subarray(offset, Math.min(bytes.length, offset + chunkBytes));
    if (!stream.write(piece)) {
      await new Promise<void>((resolve) => stream.once("drain", resolve));
    }
  }
}
