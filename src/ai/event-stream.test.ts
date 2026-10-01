import { describe, expect, it } from "vitest";
import { AssistantEventStreamImpl, collectEvents, runEventStream } from "./event-stream.js";
import type { AssistantMessage } from "./types.js";

function message(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "x",
    provider: "p",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop",
    timestamp: 0,
  };
}

describe("AssistantEventStreamImpl", () => {
  it("终止事件后的 push 被丢弃；result() 拿到终止消息", async () => {
    const stream = new AssistantEventStreamImpl();
    const msg = message();
    stream.push({ type: "start", partial: msg });
    stream.push({ type: "done", reason: "stop", message: msg });
    stream.push({ type: "error", reason: "error", message: msg });
    stream.push({ type: "start", partial: msg });
    expect((await collectEvents(stream)).map((e) => e.type)).toEqual(["start", "done"]);
    expect(await stream.result()).toBe(msg);
  });

  it("消费者先等待、生产者后推送", async () => {
    const stream = new AssistantEventStreamImpl();
    const msg = message();
    const pending = collectEvents(stream);
    setTimeout(() => {
      stream.push({ type: "start", partial: msg });
      stream.push({ type: "done", reason: "stop", message: msg });
    }, 1);
    expect((await pending).length).toBe(2);
  });

  it("end() 前没有终止事件 → 补一个 error", async () => {
    const stream = new AssistantEventStreamImpl();
    const msg = message();
    stream.push({ type: "start", partial: msg });
    stream.end();
    const events = await collectEvents(stream);
    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    expect((await stream.result()).errorMessage).toMatch(/without a terminal event/);
  });

  it("runEventStream：生产函数抛错编码为 error 事件", async () => {
    const stream = runEventStream(message, async (s) => {
      s.push({ type: "start", partial: message() });
      throw new Error("boom");
    });
    const events = await collectEvents(stream);
    expect(events.map((e) => e.type)).toEqual(["start", "error"]);
    expect((await stream.result()).errorMessage).toBe("boom");
  });
});
