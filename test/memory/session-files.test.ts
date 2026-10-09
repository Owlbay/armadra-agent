/**
 * 会话文件流式读取的内存回归（docs/memory-plan.md D6、D13、[M-C] 测试 2）：24 MB 会话（中文文本 + 2 张
 * 1 MB 图）上，`listSessionItems` 不留增长、读的过程中不出现整文件大小的字符串 / Buffer；
 * `readSessionLines` 只留解析出的条目（与旧实现相同），过程中不再有整文件 Buffer。
 *
 * `beforeGc` 是 fn 刚结束、尚未 GC 时的增长：fn 期间若发生 GC 只会让它更小，所以拿它做上界不会误报；
 * 旧实现在这里整读文件（heap 上一份全文字符串、external 上一份整文件 Buffer），同一断言必然失败。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listSessionItems } from "../../src/session/list.js";
import { readSessionLines } from "../../src/session/store.js";
import { makeSessionFile, measureGrowth, type GeneratedFile } from "../helpers/memory.js";
import { legacyReadSessionLines } from "../helpers/session-legacy.js";

const MB = 1024 * 1024;
const dir = mkdtempSync(join(tmpdir(), "ama-mem-session-"));
let made: GeneratedFile;

beforeAll(() => {
  made = makeSessionFile(join(dir, "sessions"), {
    messages: 240,
    textBytes: 96 * 1024,
    images: 2,
    imageBytes: MB,
  });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("会话文件：内存增长上限", () => {
  it("生成的会话约 24 MB", () => {
    expect(made.bytes).toBeGreaterThan(22 * MB);
    expect(made.bytes).toBeLessThan(32 * MB);
  });

  it("listSessionItems：GC 后增长 < 2 MB；过程中 heap < 0.2 × 文件、external < 0.5 × 文件", async () => {
    const growth = await measureGrowth(() => listSessionItems(dirname(made.path)));
    expect(growth.result).toHaveLength(1);
    expect(growth.result[0]?.messageCount).toBe(240);
    expect(growth.total).toBeLessThan(2 * MB);
    expect(growth.beforeGc.heapUsed).toBeLessThan(0.2 * made.bytes);
    expect(growth.beforeGc.external).toBeLessThan(0.5 * made.bytes);
  });

  it("readSessionLines：只留解析结果（≤ 旧实现 + 2 MB）；过程中 external < 0.5 × 文件", async () => {
    const legacy = await measureGrowth(() => legacyReadSessionLines(made.path));
    const growth = await measureGrowth(() => readSessionLines(made.path));
    expect(growth.result.lines).toHaveLength(made.lines);
    expect(growth.total).toBeLessThan(legacy.total + 2 * MB);
    expect(growth.beforeGc.external).toBeLessThan(0.5 * made.bytes);
  });
});
