/**
 * 会话遥测（wave5-plan §1.3、§1.4）：ttft、流式瞬时速率、请求速率、会话均速、tick 频率、非 turn 不计入。[W5-A]
 */

import { describe, expect, it } from "vitest";
import { AssistantEventStreamImpl } from "../ai/event-stream.js";
import type {
  AssistantEvent,
  AssistantMessage,
  Model,
  StreamOptions,
  TranscriptContext,
} from "../ai/types.js";
import type { StreamFn } from "./loop.js";
import { createTelemetryExtension, deltaTokens } from "./session-telemetry.js";
import type { SessionEvent } from "./types.js";
import { createHarness } from "./testing/harness.js";

function message(output: number, stopReason: AssistantMessage["stopReason"] = "stop") {
  return {
    role: "assistant",
    content: [],
    usage: {
      input: 0,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  } as unknown as AssistantMessage;
}

/** 手动推进的假时钟 + 手动推事件的流。 */
function rig(ticks = true) {
  let t = 1_000;
  const emitted: SessionEvent[] = [];
  const ext = createTelemetryExtension({
    now: () => t,
    emit: (e) => emitted.push(e),
    ticks,
  });
  const streams: AssistantEventStreamImpl[] = [];
  const inner: StreamFn = () => {
    const s = new AssistantEventStreamImpl();
    streams.push(s);
    return s;
  };
  const stream = ext.wrapStream!(inner);
  const open = (purpose?: StreamOptions["purpose"]) => {
    const options = { signal: new AbortController().signal, ...(purpose ? { purpose } : {}) };
    const wrapped = stream({} as Model, {} as TranscriptContext, options as StreamOptions);
    let it: AsyncIterator<AssistantEvent> | undefined;
    const source = streams[streams.length - 1]!;
    /** 推一个事件并让消费者读走（观测发生在读取时）。 */
    const push = async (event: AssistantEvent): Promise<void> => {
      it ??= wrapped[Symbol.asyncIterator]();
      source.push(event);
      await it.next();
    };
    return { wrapped, push, source };
  };
  const text = (delta: string): AssistantEvent =>
    ({ type: "text_delta", contentIndex: 0, delta, partial: message(0) }) as AssistantEvent;
  const done = (output: number): AssistantEvent => ({
    type: "done",
    reason: "stop",
    message: message(output),
  });
  return {
    ext,
    emitted,
    open,
    text,
    done,
    advance: (ms: number) => void (t += ms),
    now: () => t,
  };
}

describe("会话遥测", () => {
  it("增量估算：ASCII 每 4 字符 1、CJK 每字 1，不逐块取整", () => {
    expect(deltaTokens("abcd")).toBe(1);
    expect(deltaTokens("ab")).toBe(0.5);
    expect(deltaTokens("你好")).toBe(2);
    expect(deltaTokens("")).toBe(0);
  });

  it("ttft、流式瞬时速率（2 s 窗口）、结束后按 usage.output 算 tps，均速累计", async () => {
    const r = rig();
    const { push } = r.open();
    r.advance(1_400);
    await push(r.text("x".repeat(40))); // 首 token：10 token
    expect(r.ext.snapshot().live).toEqual({ tps: 0, outputTokens: 10, elapsedMs: 0 });
    for (let i = 0; i < 10; i++) {
      r.advance(500);
      await push(r.text("x".repeat(200))); // 每 0.5 s 50 token = 100 tok/s
    }
    const live = r.ext.snapshot().live!;
    expect(live.elapsedMs).toBe(5_000);
    expect(live.outputTokens).toBe(510);
    // 窗口 2 s 内 5 个样本（含边界）= 250 token / 2 s
    expect(live.tps).toBeCloseTo(125, 5);
    r.advance(500);
    await push(r.done(546));
    const snap = r.ext.snapshot();
    expect(snap.live).toBeUndefined();
    expect(snap.last).toMatchObject({ ttftMs: 1_400, outputTokens: 546 });
    expect(snap.last!.tps).toBeCloseTo(546 / 5.5, 5);
    expect(snap.avgTps).toBeCloseTo(546 / 5.5, 5);
    // 第二个请求：200 token / 1 s
    const second = r.open();
    r.advance(300);
    await second.push(r.text("abcd"));
    r.advance(1_000);
    await second.push(r.done(200));
    expect(r.ext.snapshot().last!.tps).toBeCloseTo(200, 5);
    expect(r.ext.snapshot().avgTps).toBeCloseTo(746 / 6.5, 5);
    expect(r.ext.snapshot().sessionStartedAt).toBe(1_000);
  });

  it("没报 usage.output 时用估算；error 请求记 last 但不进均速", async () => {
    const r = rig();
    const a = r.open();
    r.advance(100);
    await a.push(r.text("x".repeat(400)));
    r.advance(1_000);
    await a.push(r.done(0));
    expect(r.ext.snapshot().last!.outputTokens).toBe(100);
    const b = r.open();
    r.advance(100);
    await b.push(r.text("x".repeat(400)));
    r.advance(1_000);
    await b.push({ type: "error", reason: "error", message: message(0, "error") });
    const snap = r.ext.snapshot();
    expect(snap.last!.tps).toBeCloseTo(100, 5);
    expect(snap.avgTps).toBeCloseTo(100, 5);
  });

  it("telemetry_tick ≤ 2 Hz；ticks:false 不发；非 turn 请求不计入", async () => {
    const r = rig();
    const { push } = r.open();
    for (let i = 0; i < 40; i++) {
      r.advance(100);
      await push(r.text("abcd"));
    }
    await push(r.done(40));
    // 4 s、每 100 ms 一块 → 最多 8 次（间隔 ≥ 500 ms）
    expect(r.emitted.length).toBe(8);
    const quiet = rig(false);
    const q = quiet.open();
    quiet.advance(600);
    await q.push(quiet.text("abcd"));
    await q.push(quiet.done(1));
    expect(quiet.emitted).toEqual([]);
    for (const purpose of ["summary", "warm", "probe", "classify"] as const) {
      const s = rig();
      const x = s.open(purpose);
      s.advance(100);
      await x.push(s.text("abcd"));
      await x.push(s.done(1));
      expect(s.ext.snapshot()).toEqual({ sessionStartedAt: 1_000 });
      expect(s.emitted).toEqual([]);
    }
  });

  it("消费者不迭代、只等 result() 时同样结束记录", async () => {
    const r = rig();
    const { wrapped, source } = r.open();
    r.advance(10);
    source.push(r.done(5));
    await wrapped.result();
    await Promise.resolve();
    expect(r.ext.snapshot().last).toMatchObject({ outputTokens: 5, doneAt: 1_010 });
  });

  it("装进会话：getStats().telemetry 有最近一次请求与均速", async () => {
    const h = createHarness({
      script: [{ text: "hello world, this is a reply", usage: { output: 7 } }],
      extensions: [() => createTelemetryExtension({})],
    });
    await h.session.prompt("hi");
    await h.session.waitForIdle();
    const telemetry = h.session.getStats().telemetry;
    expect(telemetry?.last?.outputTokens).toBe(7);
    expect(telemetry?.last?.ttftMs).toBeGreaterThanOrEqual(0);
    expect(telemetry?.sessionStartedAt).toBeGreaterThan(0);
  });
});
