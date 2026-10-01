/**
 * 按路径串行化读 - 改 - 写（设计 §1.2）。[B3]
 *
 * 同一绝对路径上的 write / edit 排队执行；不同路径互不阻塞。前一个失败不影响后一个。
 */

import { resolve } from "node:path";

const tails = new Map<string, Promise<unknown>>();

function keyOf(path: string): string {
  const abs = resolve(path);
  return process.platform === "win32" || process.platform === "darwin" ? abs.toLowerCase() : abs;
}

export async function withFileMutex<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = keyOf(path);
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/** 当前持有队列的路径数（测试用）。 */
export function pendingMutexCount(): number {
  return tails.size;
}
