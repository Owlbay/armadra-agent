/**
 * 会话遥测：输出速率与首 token 延迟（docs/wave5-plan.md §1.3，D2）。[W5-A]
 *
 * 以 `SessionExtension.wrapStream` 包一层流，只观察不改事件：
 * - 只统计 `purpose: "turn"`（缺省即 turn）；summary / warm / probe / classify 原样透传、不计入；
 * - 首 token = 首个 `text_delta` / `thinking_delta` / `toolcall_start`（`ttftMs = firstTokenAt − requestAt`）；
 * - 流式中按增量字符估算输出 token（CJK / 假名 / 谚文每字 1，其余 / 4，与 `compaction/estimate.ts`
 *   同口径，不逐块取整），瞬时速率取最近 2 s 滑动窗口；请求结束改用 `usage.output`（含 reasoning）；
 * - `tps = outputTokens / (doneAt − firstTokenAt)`；会话均速 = Σoutput / Σ(done − firstToken)，只计有首
 *   token、非 error 且生成时长 ≥ 250 ms 的请求（更短的整块到达，速率无意义，`tps` 留空）；
 * - 流式中经 `emit` 发 `telemetry_tick`：首个在首 token 后 ≥ 500 ms，之后两次间隔 ≥ 500 ms（≤ 2 Hz，
 *   只由增量驱动、不起计时器）；
 *   `ticks: false`（`ui.animation: false`）时不发，界面在 message_end 时刷新。
 *
 * [W6-C0] 拆成「测量」与「发 tick」：子会话（depth > 0）也装、只测量不发 tick；每个请求结束时通知
 * `onRequestEnd` 的订阅者（`session-trace-writer.ts` 据此写 `ama.trace step`）；`telemetryOf(core)` 取本会话实例。
 *
 * 数据从 `getStats().telemetry` 取（`contributeStats`）：进行中的请求出了首 token 后 `last` 即指向它（只有
 * `requestAt / firstTokenAt / ttftMs`），结束后补齐 `doneAt / outputTokens / tps`；`sessionStartedAt` 是扩展创建（本进程打开会话）的时刻。
 */

import type { AssistantEvent, AssistantEventStream, AssistantMessage } from "../ai/types.js";
import type { StreamFn } from "./loop.js";
import type { SessionCore } from "./session-core.js";
import type { SessionExtension, SessionExtensionFactory } from "./session-extensions.js";
import type { SessionEvent } from "./types.js";
import type { RequestTelemetry, SessionTelemetry } from "./types-w5.js";

export const TELEMETRY_TICK_MS = 500;
export const TELEMETRY_WINDOW_MS = 2000;
/** 不足这么长（自首 token 起）不算速率：开头几块或整块到达的回复会把速率放大到无意义。 */
const MIN_SPAN_MS = 250;

export interface TelemetryDeps {
  now?(): number;
  /** 发 `telemetry_tick`（缺省不发）。 */
  emit?(event: SessionEvent): void;
  /** false：不发 tick（`ui.animation: false`）。缺省 true。 */
  ticks?: boolean;
}

/** 一个 turn 请求结束（成功、失败或被中断）时的记录。 */
export type RequestEndListener = (
  record: RequestTelemetry,
  message: AssistantMessage | undefined,
) => void;

export type TelemetryExtension = SessionExtension & {
  snapshot(): SessionTelemetry;
  /** [W6-C0] 订阅请求结束；返回取消函数。 */
  onRequestEnd(listener: RequestEndListener): () => void;
};

const byCore = new WeakMap<SessionCore, TelemetryExtension>();

/** [W6-C0] 本会话的遥测扩展（组装表装了才有）。 */
export function telemetryOf(core: SessionCore): TelemetryExtension | undefined {
  return byCore.get(core);
}

/** 一段增量文本的 token 估算（不取整，逐块累加不放大）。 */
export function deltaTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x1100) narrow++;
    else if (code >= 0xd840 && code <= 0xd87f) {
      wide++;
      i++;
    } else if (
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0x3130 && code <= 0x318f) ||
      (code >= 0x31f0 && code <= 0x31ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    )
      wide++;
    else narrow++;
  }
  return wide + narrow / 4;
}

function deltaText(event: AssistantEvent): string | undefined {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return event.delta;
    case "toolcall_start":
      return event.name;
    default:
      return undefined;
  }
}

/** 一次 turn 请求的进行中记录。 */
class RequestTracker {
  readonly record: RequestTelemetry;
  estimate = 0;
  private readonly samples: { at: number; tokens: number }[] = [];
  finished = false;

  constructor(requestAt: number) {
    this.record = { requestAt };
  }

  observe(event: AssistantEvent, at: number): boolean {
    if (this.finished) return false;
    const first =
      event.type === "text_delta" ||
      event.type === "thinking_delta" ||
      event.type === "toolcall_start";
    if (first && this.record.firstTokenAt === undefined) {
      this.record.firstTokenAt = at;
      this.record.ttftMs = at - this.record.requestAt;
    }
    const text = deltaText(event);
    if (text === undefined || text === "") return false;
    const tokens = deltaTokens(text);
    this.estimate += tokens;
    this.samples.push({ at, tokens });
    while (this.samples.length > 0 && at - this.samples[0]!.at > TELEMETRY_WINDOW_MS)
      this.samples.shift();
    return true;
  }

  live(now: number): { tps: number; outputTokens: number; elapsedMs: number } | undefined {
    const first = this.record.firstTokenAt;
    if (this.finished || first === undefined) return undefined;
    const elapsedMs = Math.max(0, now - first);
    const recent = this.samples.filter((s) => now - s.at <= TELEMETRY_WINDOW_MS);
    const windowTokens = recent.reduce((sum, s) => sum + s.tokens, 0);
    const span = Math.min(TELEMETRY_WINDOW_MS, elapsedMs);
    const tps = span < MIN_SPAN_MS ? 0 : windowTokens / (span / 1000);
    return { tps, outputTokens: Math.round(this.estimate), elapsedMs };
  }

  finish(message: AssistantMessage | undefined, at: number): void {
    if (this.finished) return;
    this.finished = true;
    const record = this.record;
    record.doneAt = at;
    const reported = message?.usage?.output;
    const output = reported !== undefined && reported > 0 ? reported : Math.round(this.estimate);
    record.outputTokens = output;
    // 太短（整块到达）的请求不算速率，免得显示成上万 tok/s
    if (record.firstTokenAt !== undefined && at - record.firstTokenAt >= MIN_SPAN_MS) {
      record.tps = output / ((at - record.firstTokenAt) / 1000);
    }
  }
}

export function createTelemetryExtension(deps: TelemetryDeps = {}): TelemetryExtension {
  const now = deps.now ?? Date.now;
  const ticks = deps.ticks !== false && deps.emit !== undefined;
  const sessionStartedAt = now();
  let last: RequestTelemetry | undefined;
  let current: RequestTracker | undefined;
  let sumOutput = 0;
  let sumMs = 0;
  let lastTickAt = Number.NEGATIVE_INFINITY;
  const listeners = new Set<RequestEndListener>();

  const finish = (tracker: RequestTracker, message: AssistantMessage | undefined): void => {
    if (tracker.finished) return;
    tracker.finish(message, now());
    if (current === tracker) current = undefined;
    const r = tracker.record;
    last = { ...r };
    for (const listener of listeners) listener({ ...r }, message);
    const failed = message === undefined || message.stopReason === "error";
    if (!failed && r.firstTokenAt !== undefined && r.doneAt !== undefined) {
      const ms = r.doneAt - r.firstTokenAt;
      if (ms >= MIN_SPAN_MS) {
        sumOutput += r.outputTokens ?? 0;
        sumMs += ms;
      }
    }
  };

  const wrap = (inner: AssistantEventStream, tracker: RequestTracker): AssistantEventStream => {
    let iterating = false;
    let final: AssistantMessage | undefined;
    // 只等 result() 的消费者：结果到了就结束记录；在迭代的消费者以读到终止事件为准（事件可能还在队列里）
    void inner.result().then(
      (message) => {
        final = message;
        if (!iterating) finish(tracker, message);
      },
      () => finish(tracker, undefined),
    );
    const observe = (event: AssistantEvent): void => {
      const at = now();
      if (event.type === "done" || event.type === "error") {
        finish(tracker, event.message);
        return;
      }
      if (!tracker.observe(event, at) || !ticks) return;
      // 首个 tick 在首 token 之后 500 ms：瞬时完成的短回复不发（RPC 事件序列不变）
      const since = Math.max(lastTickAt, tracker.record.firstTokenAt ?? at);
      if (at - since >= TELEMETRY_TICK_MS) {
        lastTickAt = at;
        deps.emit?.({ type: "telemetry_tick" });
      }
    };
    return {
      result: () => inner.result(),
      [Symbol.asyncIterator]() {
        iterating = true;
        const it = inner[Symbol.asyncIterator]();
        const iterator: AsyncIterator<AssistantEvent> = {
          async next() {
            const step = await it.next();
            if (step.done === true) finish(tracker, final);
            else observe(step.value);
            return step;
          },
          // 提前退出（break / return）：按已有结果结束记录
          async return(value?: unknown) {
            finish(tracker, final);
            return it.return !== undefined
              ? it.return(value)
              : { done: true as const, value: undefined };
          },
        };
        return iterator;
      },
    };
  };

  const snapshot = (): SessionTelemetry => {
    const out: SessionTelemetry = { sessionStartedAt };
    // 进行中的请求有了首 token 就算「最近一次」（没有 doneAt / tps），之前仍显示上一次
    const recent = current?.record.firstTokenAt !== undefined ? current.record : last;
    if (recent !== undefined) out.last = { ...recent };
    const live = current?.live(now());
    if (live !== undefined) out.live = live;
    if (sumMs > 0) out.avgTps = sumOutput / (sumMs / 1000);
    return out;
  };

  return {
    id: "telemetry",
    wrapStream(stream: StreamFn): StreamFn {
      return (model, context, options) => {
        const inner = stream(model, context, options);
        if ((options.purpose ?? "turn") !== "turn") return inner;
        const tracker = new RequestTracker(now());
        current = tracker;
        return wrap(inner, tracker);
      };
    },
    contributeStats(stats) {
      stats.telemetry = snapshot();
    },
    snapshot,
    onRequestEnd(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * 组装表用的工厂：主会话测量并发 tick（`ui.animation: false` 不发）；[W6-C0] 子会话（depth > 0）也装，
 * 只测量（供 `ama.trace` 与子 Agent 视图），不发 tick。
 */
export function telemetryFactory(ui?: { animation?: boolean }): SessionExtensionFactory {
  return ({ core }) => {
    const extension =
      core.depth > 0
        ? createTelemetryExtension({ ticks: false })
        : createTelemetryExtension({
            emit: (event) => core.emit(event),
            ticks: ui?.animation !== false,
          });
    byCore.set(core, extension);
    return extension;
  };
}
