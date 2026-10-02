import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "../../test/helpers/tool-context.js";
import {
  byteLength,
  formatSize,
  safeFileName,
  sliceHeadBytes,
  sliceTailBytes,
  splitLines,
  truncateHead,
  truncateLine,
  truncateMiddle,
  truncateTail,
  writeFullOutput,
} from "./truncate.js";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("truncate", () => {
  it("splitLines 不把末尾换行算作一行", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
  });

  it("未超限时原样返回", () => {
    const r = truncateHead("a\nb", { maxLines: 5 });
    expect(r).toMatchObject({
      content: "a\nb",
      truncated: false,
      truncatedBy: null,
      totalLines: 2,
    });
  });

  it("头截断按行数", () => {
    const r = truncateHead(lines(10), { maxLines: 3 });
    expect(r.content).toBe("line 1\nline 2\nline 3");
    expect(r).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      totalLines: 10,
      outputLines: 3,
    });
  });

  it("头截断按字节先到", () => {
    const r = truncateHead(lines(100), { maxLines: 1000, maxBytes: 20 });
    expect(r.truncatedBy).toBe("bytes");
    expect(r.content).toBe("line 1\nline 2\nline 3");
    expect(r.outputBytes).toBeLessThanOrEqual(20);
  });

  it("尾截断保留结尾", () => {
    const r = truncateTail(lines(10), { maxLines: 2 });
    expect(r.content).toBe("line 9\nline 10");
    expect(r.truncatedBy).toBe("lines");
    const b = truncateTail(lines(100), { maxLines: 1000, maxBytes: 16 });
    expect(b.truncatedBy).toBe("bytes");
    expect(b.content).toBe("line 99\nline 100");
  });

  it("单行超出字节上限时按字符边界切该行", () => {
    const wide = "汉".repeat(100); // 每字 3 字节
    const head = truncateHead(wide, { maxBytes: 10 });
    expect(head.content).toBe("汉汉汉");
    const tail = truncateTail(wide, { maxBytes: 10 });
    expect(tail.content).toBe("汉汉汉");
    expect(sliceHeadBytes("a汉", 2)).toBe("a");
    expect(sliceTailBytes("汉a", 2)).toBe("a");
    expect(byteLength("汉")).toBe(3);
  });

  it("truncateLine 与 formatSize", () => {
    expect(truncateLine("abc", 5)).toBe("abc");
    expect(truncateLine("abcdefgh", 3)).toBe("abc… [5 more chars]");
    expect(formatSize(10)).toBe("10 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("全文落盘", () => {
    const tmp = makeTmpDir();
    try {
      const path = writeFullOutput(tmp.dir, "a/b:c.txt", "full");
      expect(path.startsWith(tmp.dir)).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("full");
      expect(safeFileName("../x y")).toBe(".._x_y");
    } finally {
      tmp.cleanup();
    }
  });
});

describe("truncateMiddle（W5-H2 头 + 尾）", () => {
  it("未超限原样返回", () => {
    expect(truncateMiddle("abc", 3)).toEqual({ content: "abc", omitted: 0 });
  });

  it("保留前 70% 与后 30%，中间给省略数", () => {
    const text = `${"h".repeat(100)}${"m".repeat(800)}${"t".repeat(100)}`;
    const out = truncateMiddle(text, 100, (n) => `[skip ${n}]`);
    expect(out.omitted).toBe(900);
    expect(out.content).toBe(`${"h".repeat(70)}\n\n[skip 900]\n\n${"t".repeat(30)}`);
  });

  it("尾部的错误信息保住；缺省标记为英文省略说明（进模型，固定英文）", () => {
    const text = `${"x".repeat(5000)}\nError: boom at line 3`;
    const out = truncateMiddle(text, 200);
    expect(out.content.endsWith("Error: boom at line 3")).toBe(true);
    expect(out.content).toMatch(/\[… \d+ chars omitted\]/);
  });

  it("不切断代理对", () => {
    const text = "😀".repeat(100);
    const out = truncateMiddle(text, 15);
    expect(out.content).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(out.content).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});
