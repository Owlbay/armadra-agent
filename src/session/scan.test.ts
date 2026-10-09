/**
 * `forEachLine` 包装 `forEachLineSync`（docs/memory-plan.md D6、[M-C] 测试 1、3）：回调序列与旧实现
 * （整读 + 按 `\n` 切）相同；回调返回 false 时真的停止读盘。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURES, fixtureFiles, legacyForEachLine } from "../../test/helpers/session-legacy.js";

/** 每次 readSync 读到的字节数。 */
const reads = vi.hoisted((): number[] => []);

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readSync: (...args: Parameters<typeof real.readSync>) => {
      const n = real.readSync(...args);
      reads.push(n);
      return n;
    },
  };
});

// setup 文件可能已加载过 line-reader（真 fs）；重置模块图后再取，读盘计数才生效
vi.resetModules();
const { forEachLine } = await import("./scan.js");

const dir = mkdtempSync(join(tmpdir(), "ama-scan-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => void reads.splice(0));

type Seen = [string, number, boolean];

function collect(walk: (visit: (line: string, index: number, last: boolean) => void) => void) {
  const seen: Seen[] = [];
  walk((line, index, last) => {
    seen.push([line, index, last]);
  });
  return seen;
}

let seq = 0;
function file(content: string): string {
  const path = join(dir, `f${seq++}.jsonl`);
  writeFileSync(path, content);
  return path;
}

describe("forEachLine：与旧实现同序列", () => {
  for (const path of fixtureFiles()) {
    it(relative(FIXTURES, path), () => {
      const expected = collect((visit) => legacyForEachLine(path, visit));
      expect(collect((visit) => forEachLine(path, visit))).toEqual(expected);
      // 小块：行跨多块
      expect(collect((visit) => forEachLine(path, visit, 7))).toEqual(expected);
    });
  }

  it("边角：空行不计 index、CRLF、全角空白、末行无换行、中文跨块", () => {
    const cases = [
      "",
      "\n\n",
      "a\r\n\r\n  \nb",
      "　\nx\n",
      `${"中文🙂".repeat(50)}\n${"尾".repeat(30)}`,
      "only",
      "x\r",
    ];
    for (const content of cases) {
      const path = file(content);
      const expected = collect((visit) => legacyForEachLine(path, visit));
      for (const chunk of [1, 3, 64, undefined]) {
        expect(collect((visit) => forEachLine(path, visit, chunk))).toEqual(expected);
      }
    }
  });
});

describe("forEachLine：提前返回停止读盘", () => {
  it("第 3 行返回 false：读盘 ≤ 2 块", () => {
    const line = `{"type":"message","pad":"${"x".repeat(70)}"}`; // 约 100 字节
    const path = file(`${Array.from({ length: 2000 }, () => line).join("\n")}\n`);
    const chunk = 256;
    const indexes: number[] = [];
    reads.splice(0);
    forEachLine(
      path,
      (_line, index) => {
        indexes.push(index);
        return index < 2;
      },
      chunk,
    );
    expect(indexes).toEqual([0, 1, 2]);
    expect(reads.length).toBeLessThanOrEqual(2);
    expect(reads.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(2 * chunk);
  });

  it("不提前返回时读完全文", () => {
    const path = file("a\nb\nc\n");
    let count = 0;
    forEachLine(path, () => void count++, 2);
    expect(count).toBe(3);
    expect(reads.length).toBeGreaterThan(2);
  });
});
