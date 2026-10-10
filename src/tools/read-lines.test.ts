import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, makeToolContext } from "../../test/helpers/tool-context.js";
import { normalizeToLF, splitBom } from "./edit-fuzzy.js";
import {
  STREAM_READ_THRESHOLD,
  readHead,
  readHeadAsync,
  readLineWindow,
  readLineWindowAsync,
} from "./read-lines.js";
import { executeRead, type ReadInput } from "./read.js";

let tmp: { dir: string; cleanup(): void };
beforeEach(() => {
  tmp = makeTmpDir();
});
afterEach(() => tmp.cleanup());

/** 小文件路径的口径（read.ts 整读分支）。 */
function wholeLines(buf: Buffer): string[] {
  const normalized = normalizeToLF(splitBom(buf.toString("utf8")).text);
  return normalized === "" ? [] : normalized.replace(/\n$/, "").split("\n");
}

function write(name: string, data: string | Buffer): string {
  const path = join(tmp.dir, name);
  writeFileSync(path, data);
  return path;
}

const KB = 1024;
const BLOCK = 64 * KB;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** 跨 64 KiB 块边界的多字节字符、`\r\n` 与孤立 `\r`。 */
function straddling(): Buffer {
  const pad = (n: number): string => "p".repeat(n);
  return Buffer.concat([
    Buffer.from(`${pad(BLOCK - 2)}中x\n`), // 「中」3 字节跨第一个块边界；到 BLOCK + 3
    Buffer.from(`${pad(BLOCK - 4)}\r\ny\n`), // `\r` | `\n` 落在第二个块边界两侧；到 2 * BLOCK + 3
    Buffer.from(`${pad(BLOCK - 5)}🙂\rz\r`), // emoji 4 字节跨第三个块边界；孤立 `\r` 结尾
  ]);
}

const FIXTURES: [string, string | Buffer][] = [
  ["空", ""],
  ["只有 BOM", BOM],
  ["无尾换行", "a\nb"],
  ["只有换行", "\n"],
  ["两个换行", "\n\n"],
  ["CRLF", "one\r\ntwo\r\n"],
  ["孤立 \\r", "a\rb\r\rc\r"],
  ["BOM + CRLF", Buffer.concat([BOM, Buffer.from("x\r\ny\r\n\r\n")])],
  ["CJK 与 emoji", "中文一行\n🙂 emoji 行\n混合 mixed 🙂\n"],
  ["无效 UTF-8", Buffer.from([0x61, 0xe4, 0xb8, 0x0a, 0xf0, 0x9f, 0x0d, 0x62, 0xff])],
  ["单行 100 KB", "w".repeat(100 * KB)],
  ["2500 行", Array.from({ length: 2500 }, (_, i) => `x${i}`).join("\n")],
  ["跨块边界", straddling()],
];

const INPUTS: Omit<ReadInput, "path">[] = [
  {},
  { offset: 2 },
  { offset: 1, limit: 1 },
  { offset: 2, limit: 1000 },
  { offset: 3, limit: 2 },
  { offset: 2400, limit: 50 },
  { offset: 2500 },
  { offset: 2501 },
  { offset: 0 },
  { offset: 1, limit: 0 },
  { offset: 1.5 },
];

describe("[M-E] read 字节窗口", () => {
  it("fixture × 输入：整读与字节窗口的 content / details 逐字节相同", async () => {
    for (const [name, data] of FIXTURES) {
      const path = write(`f-${FIXTURES.findIndex((f) => f[0] === name)}.txt`, data);
      for (const input of INPUTS) {
        for (const maxResultChars of [undefined, 4000]) {
          const run = (streamThreshold: number) =>
            executeRead(
              { path, ...input },
              makeToolContext(tmp.dir, maxResultChars === undefined ? {} : { maxResultChars }),
              {
                streamThreshold,
              },
            );
          const whole = await run(Infinity);
          const stream = await run(0);
          expect(stream, `${name} ${JSON.stringify(input)} ${maxResultChars}`).toEqual(whole);
        }
      }
    }
  });

  it("同步版与异步版结果深度相等：fixture × 块大小 × 窗口（#171）", async () => {
    const windows: [number, number | undefined, number][] = [
      [1, undefined, 1_000_000],
      [2, 1, 1_000_000],
      [3, 2, 1_000_000],
      [2400, 50, 1_000_000],
      [1, 0, 1_000_000],
      [1, undefined, 4000],
      [1, undefined, 15],
    ];
    for (const [i, [name, data]] of FIXTURES.entries()) {
      const path = write(`sa-${i}.txt`, data);
      const chunks = data.length > 4 * KB ? [1000, BLOCK] : [3, 4, 7, 64, BLOCK]; // 小块只用于小文件，免得几万次 await
      for (const chunk of chunks) {
        for (const [offset, limit, maxBytes] of windows) {
          const label = `${name} chunk=${chunk} ${offset}/${limit}/${maxBytes}`;
          expect(await readLineWindowAsync(path, offset, limit, maxBytes, chunk), label).toEqual(
            readLineWindow(path, offset, limit, maxBytes, chunk),
          );
        }
      }
      for (const bytes of [0, 2, 3, 8000]) {
        expect(await readHeadAsync(path, bytes), `${name} head ${bytes}`).toEqual(
          readHead(path, bytes),
        );
      }
    }
  });

  it("readLineWindow 与整读口径一致：随机内容 × 块大小 × 窗口", async () => {
    const pieces = ["a", "bc", "\n", "\r", "\r\n", "中", "🙂", "\uFEFF", "\u00e9"];
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const parts: Buffer[] = round % 5 === 0 ? [BOM] : [];
      const count = rand(40);
      for (let i = 0; i < count; i++) {
        parts.push(rand(12) === 0 ? Buffer.from([0xe4, 0xb8]) : Buffer.from(pieces[rand(9)]!));
      }
      const buf = Buffer.concat(parts);
      const path = write("rand.txt", buf);
      const expected = wholeLines(buf);
      for (const chunk of [3, 4, 5, 7, 64]) {
        const offset = 1 + rand(Math.max(1, expected.length + 1));
        const limit = rand(4) === 0 ? undefined : rand(6);
        const win = readLineWindow(path, offset, limit, 1_000_000, chunk);
        expect(await readLineWindowAsync(path, offset, limit, 1_000_000, chunk)).toEqual(win);
        const label = `${JSON.stringify(buf.toString("latin1"))} chunk=${chunk}`;
        expect(win.totalLines, label).toBe(expected.length);
        const end = limit === undefined ? undefined : offset - 1 + limit;
        expect(win.lines, label).toEqual(expected.slice(offset - 1, end));
        expect(win.bom).toBe(buf.subarray(0, 3).equals(BOM));
      }
    }
  });

  it("按字节停止收集时多收一行；超长行只留开头", () => {
    const path = write("wide.txt", `${"a".repeat(10)}\n${"b".repeat(10)}\n${"c".repeat(10)}\n`);
    const win = readLineWindow(path, 1, undefined, 15);
    expect(win).toEqual({
      lines: ["a".repeat(10), "b".repeat(10)],
      totalLines: 3,
      truncatedBy: "bytes",
      bom: false,
    });
    const huge = write("huge-line.txt", `${"h".repeat(300 * KB)}\nend\n`);
    const one = readLineWindow(huge, 1, undefined, 50 * KB);
    expect(one.totalLines).toBe(2);
    expect(one.lines).toHaveLength(1);
    expect(one.lines[0]!.length).toBeLessThan(51 * KB);
    expect(readLineWindow(huge, 2, 1, 50 * KB).lines).toEqual(["end"]);
  });

  it("大于阈值：NUL 在前 8000 字节内拒绝；NUL 在其后仍当文本", async () => {
    expect(STREAM_READ_THRESHOLD).toBe(1024 * 1024);
    const body = `${"t".repeat(99)}\n`.repeat(11 * 1024);
    const early = Buffer.from(body);
    early[7999] = 0;
    const late = Buffer.from(body);
    late[8000] = 0;
    write("early.txt", early);
    write("late.txt", late);
    const ctx = makeToolContext(tmp.dir);
    const rejected = await executeRead({ path: "early.txt" }, ctx);
    expect(rejected).toEqual({
      content: "early.txt appears to be a binary file; refusing to read it",
      isError: true,
    });
    const text = await executeRead({ path: "late.txt", offset: 80, limit: 2 }, ctx);
    expect(text.isError).toBeUndefined();
    expect(text.details).toMatchObject({ totalLines: 11 * 1024, firstLine: 80, lastLine: 81 });
    expect(
      await executeRead({ path: "late.txt", offset: 80, limit: 2 }, ctx, {
        streamThreshold: Infinity,
      }),
    ).toEqual(text);
    expect(readHead(join(tmp.dir, "late.txt"), 8000)).toHaveLength(8000);
  });
});
