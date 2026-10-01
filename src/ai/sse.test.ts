import { describe, expect, it } from "vitest";
import { SseParser, readSseEvents } from "./sse.js";

function parseAll(chunks: string[]): ReturnType<SseParser["feed"]> {
  const parser = new SseParser();
  return [...chunks.flatMap((c) => parser.feed(c)), ...parser.flush()];
}

describe("SseParser", () => {
  it("event / data / id；空行分派", () => {
    expect(parseAll(["event: a\ndata: 1\nid: 7\n\ndata: 2\n\n"])).toEqual([
      { event: "a", data: "1", id: "7" },
      { event: undefined, data: "2", id: "7" },
    ]);
  });

  it("多行 data 以 LF 连接；字段名后只去掉一个空格；无冒号的行是空值字段", () => {
    expect(parseAll(["data:  two spaces\ndata\ndata:x\n\n"])).toEqual([
      { event: undefined, data: " two spaces\n\nx", id: undefined },
    ]);
  });

  it("注释行与未知字段忽略；只有注释不产生事件", () => {
    expect(parseAll([": keep-alive\n\nretry: 100\nfoo: bar\ndata: ok\n\n"])).toEqual([
      { event: undefined, data: "ok", id: undefined },
    ]);
  });

  it("CRLF、CR、LF 混用；CR 落在块尾时与下一块的 LF 合并", () => {
    expect(parseAll(["data: a\r", "\n\r", "\ndata: b\rdata: c\r\r"])).toEqual([
      { event: undefined, data: "a", id: undefined },
      { event: undefined, data: "b\nc", id: undefined },
    ]);
  });

  it("BOM 去掉；逐字符喂入结果相同；流结束时分派未收尾的事件", () => {
    const text = '﻿event: x\ndata: {"a":1}\n\nevent: y\ndata: tail';
    const whole = parseAll([text]);
    const bytes = parseAll([...text]);
    expect(bytes).toEqual(whole);
    expect(whole).toEqual([
      { event: "x", data: '{"a":1}', id: undefined },
      { event: "y", data: "tail", id: undefined },
    ]);
  });

  it("只有 event 没有 data 也分派（Anthropic ping 之类的容错）", () => {
    expect(parseAll(["event: ping\n\n"])).toEqual([{ event: "ping", data: "", id: undefined }]);
  });
});

describe("readSseEvents", () => {
  it("跨块的多字节 UTF-8 正确解码", async () => {
    const bytes = new TextEncoder().encode("data: 世界👋\n\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const events = [];
    for await (const event of readSseEvents(body)) events.push(event);
    expect(events).toEqual([{ event: undefined, data: "世界👋", id: undefined }]);
  });

  it("消费者提前退出时取消底层流", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: x\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const event of readSseEvents(body)) {
      expect(event.data).toBe("x");
      break;
    }
    expect(cancelled).toBe(true);
  });
});
