import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../../agent/types.js";
import { EventPrinter, logsInfo, type EventPrinterOptions } from "./line-render.js";

function printer(options?: EventPrinterOptions): {
  p: EventPrinter;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    p: new EventPrinter(
      (t) => out.push(t),
      (t) => err.push(t),
      options,
    ),
    out,
    err,
  };
}

const MISS: SessionEvent = {
  type: "cache_miss",
  missedTokens: 38_200,
  missedCost: 0.11,
  reason: "idle",
  idleMs: 420_000,
};
const SMALL_MISS: SessionEvent = {
  type: "cache_miss",
  missedTokens: 3_000,
  reason: "evicted",
  idleMs: 0,
};
const PRESSURE: SessionEvent = {
  type: "context_pressure",
  percent: 72,
  threshold: 70,
  remainingTokens: 56_000,
  estimatedTurnsLeft: 9,
};
const WARM: SessionEvent = {
  type: "cache_warm",
  phase: "sent",
  usage: { input: 1, output: 1, cacheRead: 12_000, cacheWrite: 0, totalTokens: 0 },
  cost: 0.0012,
};

describe("行式界面：缓存提示写 stderr [W3-C2]", () => {
  it("未命中（超过门槛）与 70% / 90% 各一行；小未命中与保温不写；stdout 不受影响", () => {
    const { p, out, err } = printer();
    for (const event of [MISS, SMALL_MISS, PRESSURE, WARM]) p.handle(event);
    expect(out).toEqual([]);
    expect(err).toEqual([
      "ama: 缓存未命中（空闲 7 分钟后）：重计费 38.2k token（约 $0.11）\n",
      "ama: 上下文已用 72%，约剩 9 回合（按最近 5 回合均值）\n",
    ]);
  });

  it("missNotices 为 false 不写；AMA_LOG=info 时保温成功写一行", () => {
    let enabled = false;
    const { p, err } = printer({ missNotices: () => enabled, info: true });
    p.handle(MISS);
    p.handle(PRESSURE);
    p.handle(WARM);
    p.handle({ type: "cache_warm", phase: "scheduled", nextWarmAt: 1 });
    expect(err).toEqual(["ama: 缓存保温已刷新（读 12k token，$0.001）\n"]);
    enabled = true;
    p.handle(PRESSURE);
    expect(err).toHaveLength(2);
  });

  it("流式文本中间来提示：先换行再写 stderr", () => {
    const { p, out, err } = printer();
    p.handle({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "半行",
        partial: {} as never,
      },
    });
    p.handle(PRESSURE);
    expect(out).toEqual(["半行", "\n"]);
    expect(err).toHaveLength(1);
  });

  it("logsInfo：info / debug 为真", () => {
    expect(logsInfo({ AMA_LOG: "info" })).toBe(true);
    expect(logsInfo({ AMA_LOG: "debug" })).toBe(true);
    expect(logsInfo({ AMA_LOG: "warn" })).toBe(false);
    expect(logsInfo({})).toBe(false);
  });
});
