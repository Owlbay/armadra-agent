/**
 * `readSessionLines` 流式实现与旧实现（整读 + split）的口径比对（docs/history/memory-plan.md §2.4、[M-C] 测试 1、4）。
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AmaError } from "../errors.js";
import { makeSessionFile } from "../../test/helpers/memory.js";
import {
  FIXTURES,
  fixtureFiles,
  legacyReadSessionLines,
} from "../../test/helpers/session-legacy.js";
import { isBlankLine, readSessionLines, type ReadResult } from "./store.js";

const dir = mkdtempSync(join(tmpdir(), "ama-store-read-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Outcome = { ok: ReadResult } | { code: string; message: string };

function outcome(read: () => ReadResult): Outcome {
  try {
    return { ok: read() };
  } catch (error) {
    if (!(error instanceof AmaError)) throw error;
    return { code: error.code, message: error.message };
  }
}

let seq = 0;
/** 同一份内容放两份（文件名相同、目录不同，错误信息里的路径换目录即可比）。 */
function twin(source: { copy: string } | string | Buffer): [string, string] {
  const name = "s.jsonl";
  const files = [`a${seq}`, `b${seq}`].map((d) => {
    mkdirSync(join(dir, d), { recursive: true });
    const file = join(dir, d, name);
    if (typeof source === "string" || Buffer.isBuffer(source)) writeFileSync(file, source);
    else copyFileSync(source.copy, file);
    return file;
  });
  seq++;
  return files as [string, string];
}

function compare(content: { copy: string } | string | Buffer, repair: boolean): void {
  const [legacyFile, file] = twin(content);
  const before = outcome(() => legacyReadSessionLines(legacyFile, { repair }));
  const after = outcome(() => readSessionLines(file, { repair }));
  const normalize = (o: Outcome): Outcome =>
    "message" in o ? { code: o.code, message: o.message.replace(legacyFile, file) } : o;
  expect(normalize(after)).toEqual(normalize(before));
  expect(readFileSync(file).equals(readFileSync(legacyFile))).toBe(true);
}

describe("readSessionLines：新旧口径一致", () => {
  const files = fixtureFiles();

  it("fixture 语料覆盖会话与非会话文件", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.includes(join("fixtures", "sessions")))).toBe(true);
    expect(files.some((f) => f.includes(join("fixtures", "trace")))).toBe(true);
  });

  for (const file of files) {
    const name = relative(FIXTURES, file);
    it(`${name}：lines / repairedTail / 错误与修复后字节相同`, () => {
      compare({ copy: file }, false);
      compare({ copy: file }, true);
    });
  }

  it("真实写出的大会话（多块、长行、中文与图片）", () => {
    const made = makeSessionFile(join(dir, "made"), {
      messages: 12,
      textBytes: 40_000,
      images: 2,
      imageBytes: 200_000,
    });
    compare({ copy: made.path }, false);
    const raw = readFileSync(made.path);
    // 截在最后一行中间：末尾半行
    compare(raw.subarray(0, raw.length - 1000), true);
  });

  it("边角：空文件、只有空白、全角空白行、BOM、CRLF 半行、缺 LF 的完整末行", () => {
    const header = `{"type":"session","version":1,"id":"x","cwd":"/","timestamp":"t"}`;
    const cases = [
      "",
      "\n\n",
      "   ",
      `${header}\n　\n{"id":"a","type":"label"}\n`,
      `﻿${header}\n`,
      `${header}\r\n{"id":"a","type":"label"`,
      `${header}\r\n{"id":"a","type":"label"}`,
      `${header}\n  \t`,
      `${header}\nnot json\n`,
      `${header}\n\n\nnot json`,
    ];
    for (const content of cases) {
      compare(content, false);
      compare(content, true);
    }
  });
});

describe("readSessionLines：错误", () => {
  it("中间坏行 → session_corrupt 带物理行号（含空行）", () => {
    const [, file] = twin(`{"type":"session"}\n\n  \nnot json\n{}\n`);
    expect(() => readSessionLines(file)).toThrow(
      expect.objectContaining({ code: "session_corrupt", message: `${file}:4: invalid JSON line` }),
    );
  });

  it("读不到 → session_not_found", () => {
    const missing = join(dir, "missing.jsonl");
    expect(() => readSessionLines(missing)).toThrow(
      expect.objectContaining({ code: "session_not_found" }),
    );
    expect(() => readSessionLines(dir)).toThrow(
      expect.objectContaining({ code: "session_not_found" }),
    );
  });
});

describe("isBlankLine", () => {
  it("与 trim() === '' 同口径", () => {
    for (const text of ["", " ", "\t\r", "　", "  ", "﻿", " x", "{}", "　a"]) {
      expect(isBlankLine(Buffer.from(text))).toBe(text.trim() === "");
    }
  });
});
