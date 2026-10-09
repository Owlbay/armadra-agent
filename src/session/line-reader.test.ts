import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { forEachLineSync, lineTypeOf } from "./line-reader.js";
import { lineType } from "./scan.js";

const dir = mkdtempSync(join(tmpdir(), "ama-line-reader-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function file(content: string | Buffer): string {
  const path = join(dir, `f${seq++}.jsonl`);
  writeFileSync(path, content);
  return path;
}

interface Seen {
  text: string;
  index: number;
  last: boolean;
  offset: number;
}

function collect(path: string, chunkBytes?: number): Seen[] {
  const seen: Seen[] = [];
  forEachLineSync(
    path,
    (line, index, last, offset) => {
      seen.push({ text: line.toString("utf8"), index, last, offset });
    },
    chunkBytes,
  );
  return seen;
}

/** 参考口径：按 `\n` 切、去行尾一个 `\r`；以 `\n` 结尾时不出空末行。 */
function reference(content: string): Seen[] {
  const buf = Buffer.from(content, "utf8");
  const out: Seen[] = [];
  let start = 0;
  let index = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl < 0 ? buf.length : nl;
    out.push({
      text: buf.subarray(start, end).toString("utf8").replace(/\r$/, ""),
      index: index++,
      last: nl < 0,
      offset: start,
    });
    start = end + 1;
  }
  return out;
}

describe("forEachLineSync", () => {
  const samples: Record<string, string> = {
    empty: "",
    oneTerminated: "a\n",
    oneUnterminated: "a",
    onlyNewline: "\n",
    blankLines: "a\n\n  \nb\n",
    crlf: '{"type":"x"}\r\n{"type":"y"}\r\nz',
    loneCr: "a\rb\nc\r",
    cjkEmoji: "中文行🙂\n第二行🎉末尾\n" + "汉".repeat(50) + "\n",
  };

  for (const [name, content] of Object.entries(samples)) {
    it(`口径与参考实现一致：${name}`, () => {
      const path = file(content);
      for (const chunk of [1, 2, 3, 5, 7, 64, 65536]) {
        expect(collect(path, chunk), `chunk ${chunk}`).toEqual(reference(content));
      }
    });
  }

  it("多字节字符跨块边界：按行解码不切坏字符", () => {
    const content = Array.from({ length: 200 }, (_, i) => `${i}:${"汉🙂".repeat(i % 13)}`).join(
      "\n",
    );
    const path = file(content);
    expect(collect(path, 17)).toEqual(reference(content));
    expect(collect(path, 4096)).toEqual(reference(content));
  });

  it("byteOffset 指向行首：从该偏移截断文件即去掉这一行及之后", () => {
    const content = "第一\n第二\n半行";
    const seen = collect(file(content), 4);
    const buf = Buffer.from(content, "utf8");
    for (const s of seen) {
      expect(buf.subarray(s.offset).toString("utf8").startsWith(s.text)).toBe(true);
    }
    expect(seen.at(-1)).toMatchObject({ text: "半行", last: true });
  });

  it("回调返回 false 立即停止", () => {
    const path = file("a\nb\nc\nd\n");
    const seen: string[] = [];
    forEachLineSync(
      path,
      (line) => {
        seen.push(line.toString());
        return seen.length < 2 ? undefined : false;
      },
      1,
    );
    expect(seen).toEqual(["a", "b"]);
  });

  it("超长单行（远大于块）完整拼回", () => {
    const long = "x".repeat(300_000);
    const seen = collect(file(`${long}\nshort`), 65536);
    expect(seen.map((s) => s.text.length)).toEqual([300_000, 5]);
  });

  it("文件不存在抛 ENOENT", () => {
    expect(() => forEachLineSync(join(dir, "missing.jsonl"), () => {})).toThrow(/ENOENT/);
  });
});

describe("lineTypeOf", () => {
  const lines = [
    '{"type":"session","version":1}',
    '{"type":"message","message":{"role":"user","content":"hi"}}',
    `{"type":"message","message":{"role":"toolResult","content":"${"x".repeat(500)}"}}`,
    `{"type":"session_info","name":"${"名".repeat(100)}"}`,
    '{"id":"a","type":"message"}',
    "not json",
  ];
  for (const line of lines) {
    it(`与 lineType 同口径：${line.slice(0, 40)}`, () => {
      expect(lineTypeOf(Buffer.from(line, "utf8"))).toEqual(lineType(line));
    });
  }

  it("行首放不下 role 时返回 undefined（调用方退回 JSON.parse）", () => {
    const line = `{"type":"message","message":{"role":"${"r".repeat(200)}"}}`;
    expect(lineTypeOf(Buffer.from(line))).toBeUndefined();
  });
});
