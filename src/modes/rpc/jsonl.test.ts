import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLineReader, writeChunked } from "./jsonl.js";

describe("JSONL 读", () => {
  it("只按 \\n 切行：U+2028 / U+2029 不切，容忍 \\r\\n，空行跳过，末行无换行也交出", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const ended = new Promise<void>((resolve) =>
      createLineReader(stream, (l) => lines.push(l), resolve),
    );
    stream.write('{"a":"x y z"}\r\n\n{"b":');
    stream.write("1}\n");
    stream.end('{"c":2}');
    await ended;
    expect(lines).toEqual(['{"a":"x y z"}', '{"b":1}', '{"c":2}']);
  });

  it("多字节 UTF-8 跨 chunk", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const ended = new Promise<void>((resolve) =>
      createLineReader(stream, (l) => lines.push(l), resolve),
    );
    const bytes = Buffer.from("中文\n", "utf8");
    stream.write(bytes.subarray(0, 2));
    stream.write(bytes.subarray(2));
    stream.end();
    await ended;
    expect(lines).toEqual(["中文"]);
  });
});

describe("JSONL 写", () => {
  it("按 64 KiB 分片、等 drain，内容完整", async () => {
    const pieces: number[] = [];
    const chunks: Buffer[] = [];
    const sink = new Writable({
      highWaterMark: 1024,
      write(chunk: Buffer, _enc, done) {
        pieces.push(chunk.length);
        chunks.push(chunk);
        setImmediate(done);
      },
    });
    const text = `${"x".repeat(200 * 1024)}\n`;
    await writeChunked(sink, text);
    expect(Math.max(...pieces)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(text);
  });
});
