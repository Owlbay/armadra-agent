import { describe, expect, it } from "vitest";
import { record } from "../../agent/testing/cache-records.js";
import type { AssistantMessage, Usage } from "../types.js";
import type { RequestRecord, WarmDecision, WarmingMode } from "./types.js";
import {
  CacheWarmer,
  REAL_TIMERS,
  WARM_IDLE_CAP_MS,
  WARM_STREAMING_CAP_MS,
  replayBlocker,
  warmDelay,
  type WarmerDeps,
  type WarmerTimers,
} from "./warmer.js";

const TTL = 300_000;
const DELAY = 270_000;

/** fake 时钟：`advance` 推进并按到期顺序执行计时器；`jump` 只推进（模拟睡眠 / 阻塞）。 */
class FakeClock implements WarmerTimers {
  now = 0;
  private seq = 0;
  readonly pending = new Map<number, { due: number; fn: () => void }>();

  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { due: this.now + ms, fn });
    return id;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.pending.entries()]
        .filter(([, t]) => t.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (next === undefined) break;
      this.pending.delete(next[0]);
      this.now = Math.max(this.now, next[1].due);
      next[1].fn();
      await flush();
    }
    this.now = end;
    await flush();
  }

  jump(ms: number): void {
    this.now += ms;
  }

  async fireAll(): Promise<void> {
    for (const [id, t] of [...this.pending.entries()]) {
      this.pending.delete(id);
      t.fn();
    }
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

function reply(usage: Partial<Usage>, stopReason: AssistantMessage["stopReason"] = "length") {
  const full: Usage = {
    input: 0,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    ...usage,
  };
  full.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 };
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    usage: full,
    stopReason,
    timestamp: 0,
  } satisfies AssistantMessage;
}

const WARM: WarmDecision = {
  action: "warm",
  phase: "streaming",
  promptTokens: 100_000,
  warmCost: 0.02,
  missCost: 0.23,
  probability: 1,
};

interface Rig {
  clock: FakeClock;
  warmer: CacheWarmer;
  sent: { record: RequestRecord; at: number; signal: AbortSignal }[];
  stopped: string[];
  scheduled: number[];
  warmed: number[];
  set(patch: Partial<RigState>): void;
}

interface RigState {
  mode: WarmingMode;
  current: boolean;
  replies: AssistantMessage[];
  decision: WarmDecision;
  decide: WarmerDeps["decide"];
  hang: boolean;
}

function rig(initial: Partial<RigState> = {}): Rig {
  const clock = new FakeClock();
  const state: RigState = {
    mode: "streaming",
    current: true,
    replies: [],
    decision: WARM,
    decide: undefined,
    hang: false,
    ...initial,
  };
  const out: Rig = {
    clock,
    sent: [],
    stopped: [],
    scheduled: [],
    warmed: [],
    set: (patch) => Object.assign(state, patch),
    warmer: undefined as unknown as CacheWarmer,
  };
  out.warmer = new CacheWarmer({
    mode: () => state.mode,
    now: () => clock.now,
    timers: clock,
    send: (r, signal) => {
      out.sent.push({ record: r, at: clock.now, signal });
      if (state.hang)
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      return Promise.resolve(state.replies.shift() ?? reply({ cacheRead: 100_000 }));
    },
    isCurrent: () => state.current,
    evaluate: (_r, phase) => ({ ...state.decision, phase }),
    decide: (d) => (state.decide === undefined ? d.action : state.decide(d)),
    onWarmed: (_r, _m, at) => out.warmed.push(at),
    onScheduled: (at) => out.scheduled.push(at),
    onStopped: (reason) => out.stopped.push(reason),
  });
  return out;
}

describe("保温延迟与截止（§1.7）", () => {
  it("delay = max(1s, floor(min(0.9·TTL, TTL − 10s)))；TTL ≤ 10 s 不保温（无事件）", () => {
    expect(warmDelay(300_000)).toBe(DELAY);
    expect(warmDelay(3_600_000)).toBe(3_240_000);
    expect(warmDelay(20_000)).toBe(10_000);
    expect(warmDelay(11_000)).toBe(1000);
    const r = rig();
    r.warmer.start(record({ cacheRead: 100_000 }), 10_000);
    expect(r.warmer.status).toMatchObject({ state: "stopped", reason: "ttl_too_short" });
    expect(r.stopped).toEqual([]);
  });

  it("计时从请求发出算：响应用了 100 s，保温在发出后 270 s；之后从保温发出时刻再排", async () => {
    const r = rig();
    r.clock.now = 100_000;
    r.warmer.start(record({ at: 0, cacheRead: 100_000 }), TTL);
    expect(r.warmer.status).toMatchObject({
      state: "scheduled",
      phase: "streaming",
      nextWarmAt: DELAY,
    });
    await r.clock.advance(DELAY - 100_000 - 1);
    expect(r.sent).toHaveLength(0);
    await r.clock.advance(1);
    expect(r.sent.map((s) => s.at)).toEqual([DELAY]);
    expect(r.warmed).toEqual([DELAY]);
    expect(r.scheduled).toEqual([DELAY, 2 * DELAY]);
    expect(r.warmer.status).toMatchObject({ sent: 1, costUsd: 0.01 });
    expect(r.warmer.status.expectedSavingsUsd).toBeCloseTo(0.21, 10);
  });

  it("计时器迟到超过截止（nextWarmAt + (TTL − delay)/2）→ 停止，不发", async () => {
    const r = rig();
    r.warmer.start(record({ cacheRead: 100_000 }), TTL);
    r.clock.jump(DELAY + (TTL - DELAY) / 2 + 1);
    await r.clock.fireAll();
    expect(r.sent).toHaveLength(0);
    expect(r.stopped).toEqual(["late"]);
    expect(r.warmer.status).toMatchObject({ state: "stopped", reason: "late" });
  });
});

describe("上限与零命中", () => {
  it("streaming 相 60 min（从起始真实请求算）", async () => {
    const r = rig();
    r.warmer.start(record({ cacheRead: 100_000 }), TTL);
    await r.clock.advance(2 * WARM_STREAMING_CAP_MS);
    expect(r.sent).toHaveLength(Math.floor(WARM_STREAMING_CAP_MS / DELAY));
    expect(r.stopped).toEqual(["max_duration"]);
  });

  it("idle 模式 settle 后转空闲相，30 min 上限；streaming 模式 settle 静默结束", async () => {
    const idle = rig({ mode: "idle" });
    idle.warmer.start(record({ cacheRead: 100_000 }), TTL);
    idle.warmer.onAgentSettled();
    expect(idle.warmer.status).toMatchObject({ state: "scheduled", phase: "idle" });
    await idle.clock.advance(2 * WARM_IDLE_CAP_MS);
    expect(idle.sent).toHaveLength(Math.floor(WARM_IDLE_CAP_MS / DELAY));
    expect(idle.stopped).toEqual(["max_duration"]);

    const streaming = rig();
    streaming.warmer.start(record({ cacheRead: 100_000 }), TTL);
    streaming.warmer.onAgentSettled();
    expect(streaming.warmer.status.state).toBe("inactive");
    await streaming.clock.advance(TTL);
    expect(streaming.sent).toHaveLength(0);
    expect(streaming.stopped).toEqual([]);
  });

  it("连续 2 次保温响应读写都为 0 即停；中间有命中则重新计数", async () => {
    const r = rig({
      replies: [reply({ input: 9 }), reply({ cacheRead: 5 }), reply({ input: 9 }), reply({})],
    });
    r.warmer.start(record({ cacheRead: 100_000 }), TTL);
    await r.clock.advance(10 * DELAY);
    expect(r.sent).toHaveLength(4);
    expect(r.warmed).toHaveLength(4);
    expect(r.stopped).toEqual(["no_cache_hits"]);
  });

  it("发送失败或返回 error → 停止（静默失败，不重试）", async () => {
    const r = rig({ replies: [reply({}, "error")] });
    r.warmer.start(record({ cacheRead: 100_000 }), TTL);
    await r.clock.advance(DELAY);
    expect(r.stopped).toEqual(["error"]);
    expect(r.warmed).toEqual([]);
  });
});

describe("可重放性、isCurrent 与否决钩子", () => {
  it("不可重放：retention none、onPayload 替换、anthropic 预算型思考、端点未报告", () => {
    const anthropic = { api: "anthropic-messages", reasoning: true } as const;
    const base = { model: anthropic, options: {}, payloadReplaced: false, reporting: "reported" };
    expect(replayBlocker(base as never)).toBeUndefined();
    expect(replayBlocker({ ...base, options: { cacheRetention: "none" } } as never)).toBe(
      "retention_none",
    );
    expect(replayBlocker({ ...base, payloadReplaced: true } as never)).toBe("payload_replaced");
    expect(replayBlocker({ ...base, options: { thinkingLevel: "high" } } as never)).toBe(
      "thinking_budget",
    );
    expect(
      replayBlocker({
        ...base,
        model: { ...anthropic, compat: { adaptiveThinking: true } },
        options: { thinkingLevel: "high" },
      } as never),
    ).toBeUndefined();
    expect(replayBlocker({ ...base, reporting: "silent" } as never)).toBe("reporting_silent");
    const r = rig();
    r.warmer.block("thinking_budget");
    expect(r.warmer.status).toMatchObject({ state: "stopped", reason: "thinking_budget" });
    expect(r.stopped).toEqual([]);
  });

  it("isCurrent 不成立 → stale 停止", async () => {
    const r = rig();
    r.warmer.start(record({ cacheRead: 100_000 }), TTL);
    r.set({ current: false });
    await r.clock.advance(DELAY);
    expect(r.sent).toHaveLength(0);
    expect(r.stopped).toEqual(["stale"]);
  });

  it("否决钩子：stop 否决；warm 覆盖内置 stop；抛错回落内置决策", async () => {
    const vetoed = rig({ decide: () => "stop" });
    vetoed.warmer.start(record({ cacheRead: 100_000 }), TTL);
    await vetoed.clock.advance(DELAY);
    expect(vetoed.sent).toHaveLength(0);
    expect(vetoed.stopped).toEqual(["declined"]);

    const cheap = { ...WARM, action: "stop" as const, reason: "below_min_savings" };
    const forced = rig({ decision: cheap, decide: async () => "warm" as const });
    forced.warmer.start(record({ cacheRead: 100_000 }), TTL);
    await forced.clock.advance(DELAY);
    expect(forced.sent).toHaveLength(1);

    const broken = rig({
      decision: cheap,
      decide: () => {
        throw new Error("boom");
      },
    });
    broken.warmer.start(record({ cacheRead: 100_000 }), TTL);
    await broken.clock.advance(DELAY);
    expect(broken.sent).toHaveLength(0);
    expect(broken.stopped).toEqual(["below_min_savings"]);
  });

  it("pause / cancel 静默；cancel 中断进行中的保温请求；off 模式不排期", async () => {
    const r = rig({ hang: true });
    r.warmer.start(record({ cacheRead: 100_000 }), TTL);
    await r.clock.advance(DELAY);
    expect(r.sent).toHaveLength(1);
    r.warmer.cancel();
    await flush();
    expect(r.sent[0]?.signal.aborted).toBe(true);
    expect(r.stopped).toEqual([]);
    expect(r.warmer.status.state).toBe("inactive");

    const p = rig();
    p.warmer.start(record({ cacheRead: 100_000 }), TTL);
    p.warmer.pause();
    await p.clock.advance(TTL);
    expect(p.sent).toHaveLength(0);

    const off = rig({ mode: "off" });
    off.warmer.start(record({ cacheRead: 100_000 }), TTL);
    expect(off.warmer.status).toEqual({ mode: "off", state: "inactive" });
    expect(off.clock.pending.size).toBe(0);
  });

  it("真实计时器 unref（不拖住进程退出）", () => {
    const handle = REAL_TIMERS.set(() => undefined, 60_000) as ReturnType<typeof setTimeout>;
    expect(handle.hasRef()).toBe(false);
    REAL_TIMERS.clear(handle);
  });
});
