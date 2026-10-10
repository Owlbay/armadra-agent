/**
 * [M-E] `read` 大文件按字节窗口读取（docs/history/memory-plan.md D1、§2.1）：32 MB 文本读 100 行，
 * 不再整文件进内存（旧实现 Buffer + 字符串 + 行数组 ≥ 3 × 文件大小）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { executeRead, type ReadInput } from "../../src/tools/read.js";
import { makeTextFile, measureGrowth } from "../helpers/memory.js";
import { makeToolContext } from "../helpers/tool-context.js";

const MB = 1024 * 1024;
const dir = mkdtempSync(join(tmpdir(), "ama-mem-read-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const file = makeTextFile(join(dir, "huge.txt"), 32 * MB, { cjk: true, lineBytes: 80 });

async function readHuge(input: Omit<ReadInput, "path">) {
  return executeRead({ path: "huge.txt", ...input }, makeToolContext(dir));
}

describe("[M-E] read 32 MB 文件", () => {
  it.each([
    ["开头", 1],
    ["接近尾部", 400_000],
  ])("%s读 100 行：结果正确，GC 前后增长都 < 2 MB", async (_name, offset) => {
    expect(file.lines).toBeGreaterThan(offset + 100);
    const growth = await measureGrowth(() => readHuge({ offset, limit: 100 }));
    const result = growth.result;
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      totalLines: file.lines,
      firstLine: offset,
      lastLine: offset + 99,
      truncated: false,
    });
    const content = result.content as string;
    expect(content.startsWith(`${String(offset).padStart(6)}\t${offset}: 中文🙂 x`)).toBe(true);
    expect(content).toContain(`Use offset=${offset + 100} to continue.`);
    expect(growth.total).toBeLessThan(2 * MB);
    expect(growth.beforeGc.total).toBeLessThan(2 * MB);
  });

  it("扫描整个文件期间让出事件循环：读的同时其它回调持续得到执行（#171）", async () => {
    // 计 setImmediate 轮数而不是 1 ms 计时器：stat 等前置 await 也会让出一两轮，计时器在同步扫描下
    // 也可能碰巧触发；按块 await 时 32 MB（512 块）期间至少跑几十轮，同步扫描至多两三轮。
    let turns = 0;
    let running = true;
    const spin = (): void => {
      turns++;
      if (running) setImmediate(spin);
    };
    setImmediate(spin);
    const result = await readHuge({ offset: 400_000, limit: 100 }).finally(() => {
      running = false;
    });
    expect(result.details).toMatchObject({ totalLines: file.lines, firstLine: 400_000 });
    expect(turns).toBeGreaterThanOrEqual(32);
  });

  it("offset 超界：错误文案给出正确的总行数", async () => {
    const result = await readHuge({ offset: file.lines + 1 });
    expect(result).toEqual({
      content: `offset ${file.lines + 1} is beyond the end of huge.txt (${file.lines} lines)`,
      isError: true,
    });
  });
});
