/**
 * `ama.trace` 写入扩展（docs/wave6-plan.md §2.2、§2.7 C0 测试）。[W6-C0]
 */

import { describe, expect, it } from "vitest";
import { buildProjection } from "../session/projection.js";
import { SessionManager } from "../session/manager.js";
import type { SessionEntry } from "../session/types.js";
import { TRACE_CUSTOM_TYPE, type TraceEntryData, type TraceStepData } from "../trace/types.js";
import { AgentSessionImpl } from "./session.js";
import type { SessionCore } from "./session-core.js";
import { telemetryFactory } from "./session-telemetry.js";
import { createTraceWriter, traceWriterFactory } from "./session-trace-writer.js";
import { createScriptedApi, type ScriptCall, type ScriptStep } from "./testing/scripted-api.js";
import { fakeModel, stubRegistry, stubTool, waitOrAbort } from "./testing/stubs.js";
import type { SessionEvent } from "./types.js";

function clock(): () => number {
  let t = 1_000;
  return () => (t += 7);
}

function traces(entries: readonly SessionEntry[]): TraceEntryData[] {
  return entries.flatMap((e) =>
    e.type === "custom" && e.customType === TRACE_CUSTOM_TYPE ? [e.data as TraceEntryData] : [],
  );
}

function setup(script: (call: ScriptCall) => ScriptStep, fallbackModel?: string) {
  const primary = fakeModel();
  const backup = fakeModel({ id: "backup", name: "Backup" });
  const scripted = createScriptedApi(script);
  const slow = (ms: number) => async (_input: unknown, ctx: { signal: AbortSignal }) => {
    await waitOrAbort(ms, ctx.signal);
    return { content: `slept ${ms}` };
  };
  const session = new AgentSessionImpl({
    sessionManager: SessionManager.inMemory("/work"),
    providers: stubRegistry([primary, backup], [scripted.api]),
    model: primary,
    tools: [stubTool({ name: "fast", run: slow(1) }), stubTool({ name: "slow", run: slow(30) })],
    retry: { baseDelayMs: 1, maxDelayMs: 2, maxRetries: 2 },
    extensions: [telemetryFactory(), traceWriterFactory({ now: clock() })],
    ...(fallbackModel === undefined ? {} : { fallbackModel }),
  });
  return { session, scripted };
}

describe("ama.trace 写入（会话）", () => {
  it("一次请求两个并行工具 → 工具批之后恰好一条 step，两工具各有起止", async () => {
    const h = setup((call) =>
      call.index === 0
        ? {
            toolCalls: [
              { id: "c_fast", name: "fast", args: {} },
              { id: "c_slow", name: "slow", args: {} },
            ],
          }
        : { text: "done" },
    );
    await h.session.prompt("go");
    const entries = h.session.entries;
    const steps = traces(entries).filter((t): t is TraceStepData => t.kind === "step");
    expect(steps).toHaveLength(2);
    const first = steps[0]!;
    expect(first.attempt).toBe(1);
    expect(first.tools?.map((t) => t.id).sort()).toEqual(["c_fast", "c_slow"]);
    for (const tool of first.tools ?? []) expect(tool.endedAt).toBeGreaterThan(tool.startedAt);
    const [a, b] = first.tools ?? [];
    expect([a?.startedAt, a?.endedAt]).not.toEqual([b?.startedAt, b?.endedAt]);
    expect(first.requestAt).toBeTypeOf("number");
    expect(first.doneAt).toBeGreaterThanOrEqual(first.requestAt ?? 0);
    // 位置：assistant → toolResult × 2 → ama.trace
    const idx = entries.findIndex((e) => e.type === "custom" && e.customType === TRACE_CUSTOM_TYPE);
    expect(entries[idx - 1]?.type === "message" && entries[idx - 1]).toMatchObject({
      message: { role: "toolResult" },
    });
    const assistant = entries.find((e) => e.id === first.assistantEntryId);
    expect(assistant?.type === "message" && assistant.message.role).toBe("assistant");
    // 无工具的第二次请求：step 紧跟 assistant
    const last = entries.at(-1);
    expect(last?.type === "custom" && last.customType).toBe(TRACE_CUSTOM_TYPE);
    expect(entries.at(-2)?.type === "message" && entries.at(-2)).toMatchObject({
      message: { role: "assistant" },
    });
  });

  it("不进上下文：投影与去掉 ama.trace 后完全相同", async () => {
    const h = setup((call) =>
      call.index === 0 ? { toolCalls: [{ name: "fast", args: {} }] } : { text: "done" },
    );
    await h.session.prompt("go");
    const branch = h.session.entries;
    const without = branch.filter(
      (e) => !(e.type === "custom" && e.customType === TRACE_CUSTOM_TYPE),
    );
    expect(traces(branch).length).toBeGreaterThan(0);
    // 去掉 trace 条目后父指针断开，按「同一顺序的消息」比较投影
    expect(JSON.stringify(buildProjection(branch).messages)).toBe(
      JSON.stringify(buildProjection(relink(without)).messages),
    );
    // 请求里也没有
    for (const call of h.scripted.calls)
      expect(JSON.stringify(call.context)).not.toContain(TRACE_CUSTOM_TYPE);
  });

  it("重试：失败尝试也有 step，随后 retry_wait，再一条 attempt 2 的 step", async () => {
    const h = setup((call) =>
      call.index === 0 ? { kind: "error", message: "502 bad gateway" } : { text: "ok" },
    );
    await h.session.prompt("go");
    const kinds = traces(h.session.entries).map((t) =>
      t.kind === "step" ? `step${t.attempt}` : t.kind,
    );
    expect(kinds).toEqual(["step1", "retry_wait", "step2"]);
    const wait = traces(h.session.entries).find((t) => t.kind === "retry_wait");
    expect(wait).toMatchObject({ attempt: 2, reason: "502 bad gateway" });
  });

  it("回退：写 fallback 条，回退模型的 step 带 fallbackFrom", async () => {
    const h = setup(
      (call) =>
        call.index === 0
          ? { kind: "error", message: "529 overloaded_error: Overloaded" }
          : { text: "rescued" },
      "fake/backup",
    );
    await h.session.prompt("go");
    const all = traces(h.session.entries);
    expect(all.find((t) => t.kind === "fallback")).toMatchObject({
      from: "fake/echo",
      to: "fake/backup",
    });
    const steps = all.filter((t): t is TraceStepData => t.kind === "step");
    expect(steps.at(-1)).toMatchObject({ attempt: 2, fallbackFrom: "fake/echo" });
  });
});

/** 去掉条目后按原顺序重新接父指针（只为比较投影）。 */
function relink(entries: readonly SessionEntry[]): SessionEntry[] {
  let parent: string | null = null;
  return entries.map((e) => {
    const next = { ...e, parentId: parent } as SessionEntry;
    parent = e.id;
    return next;
  });
}

describe("ama.trace 写入（单元）", () => {
  function fakeCore() {
    const appended: TraceEntryData[] = [];
    let n = 0;
    const core = {
      appendEntry: (input: { data?: unknown }) => {
        appended.push(input.data as TraceEntryData);
        return { id: `e${++n}` };
      },
      log: () => undefined,
    } as unknown as SessionCore;
    return { core, appended };
  }

  it("审批等待：permission_request 带 toolCallId → approvalMs；被拒标 denied", () => {
    const { core, appended } = fakeCore();
    const writer = createTraceWriter(core, { now: clock() });
    const emit = (event: SessionEvent): void => writer.onEvent?.(event);
    emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} });
    emit({
      type: "permission_request",
      requestId: "r1",
      toolName: "bash",
      input: {},
      reason: "mode",
      timeoutMs: 1,
      context: { toolCallId: "c1" },
    });
    emit({ type: "permission_resolved", requestId: "r1", decision: "deny" });
    emit({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { content: "denied" },
      isError: true,
      denied: true,
    });
    emit({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
      } as never,
      toolResults: [],
    });
    expect(appended).toEqual([
      {
        kind: "step",
        attempt: 1,
        tools: [{ id: "c1", startedAt: 1007, endedAt: 1028, approvalMs: 7, denied: true }],
      },
    ]);
  });

  it("codemode 内层调用进 subcalls；中断没有 turn_end 时 agent_end 兜底写 aborted", () => {
    const { core, appended } = fakeCore();
    const writer = createTraceWriter(core, { now: clock() });
    const emit = (event: SessionEvent): void => writer.onEvent?.(event);
    emit({ type: "tool_execution_start", toolCallId: "cm1", toolName: "codemode", args: {} });
    emit({
      type: "tool_execution_start",
      toolCallId: "cm1_n1",
      toolName: "read",
      args: {},
      parentToolCallId: "cm1",
    });
    emit({
      type: "tool_execution_end",
      toolCallId: "cm1_n1",
      toolName: "read",
      result: { content: "x" },
      isError: false,
      parentToolCallId: "cm1",
    });
    emit({ type: "agent_end", stopReason: "aborted", willRetry: false });
    expect(appended).toEqual([
      {
        kind: "step",
        attempt: 1,
        status: "aborted",
        tools: [{ id: "cm1", startedAt: 1007 }],
        subcalls: [{ id: "cm1_n1", parentId: "cm1", name: "read", startedAt: 1014, endedAt: 1021 }],
      },
    ]);
    // 干净时 agent_end 不写
    emit({ type: "agent_end", stopReason: "stop", willRetry: false });
    expect(appended).toHaveLength(1);
  });

  it("压缩与辅助请求", () => {
    const { core, appended } = fakeCore();
    const writer = createTraceWriter(core, { now: clock() });
    const emit = (event: SessionEvent): void => writer.onEvent?.(event);
    emit({ type: "compaction_start", trigger: "manual" });
    emit({
      type: "entry_appended",
      entry: {
        type: "compaction",
        id: "cmp1",
        parentId: null,
        timestamp: "",
        summary: "s",
        firstKeptEntryId: "x",
        tokensBefore: 1,
      } as SessionEntry,
    });
    emit({ type: "compaction_end", trigger: "manual", aborted: false, willRetry: false });
    emit({
      type: "entry_appended",
      entry: {
        type: "usage",
        kind: "cache_warm",
        id: "u1",
        parentId: null,
        timestamp: "",
        provider: "p",
        model: "m",
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
      },
    });
    expect(appended).toEqual([
      {
        kind: "compaction",
        trigger: "manual",
        startedAt: 1007,
        endedAt: 1014,
        compactionEntryId: "cmp1",
      },
      { kind: "aux", purpose: "cache_warm", usageEntryId: "u1", endedAt: 1021 },
    ]);
  });
});
