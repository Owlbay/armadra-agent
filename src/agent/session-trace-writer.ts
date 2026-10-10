/**
 * 轨迹写入（docs/history/wave6-plan.md §2.2、D5）。[W6-C0]
 *
 * 会话扩展：订阅事件，把计时写成 `custom{customType:"ama.trace"}` 条目（`trace/types.ts` 的 `TraceEntryData`）。
 * - `step`：每个 turn 请求一条（成功、失败、被重试掉的都写），在 `turn_end` 时写——此时 assistant 与该批
 *   toolResult 都已落盘，所以条目在 toolResult 之后（无工具时紧跟 assistant）。请求计时来自遥测扩展
 *   （`telemetryOf(core).onRequestEnd`），工具起止来自 `tool_execution_start / end`，审批等待来自带
 *   `context.toolCallId` 的 `permission_request` → `permission_resolved`；中断而没有 `turn_end` 时由
 *   `agent_end` 兜底写一条 `status: "aborted"`。
 * - `retry_wait`（`auto_retry_start`）、`fallback`（`model_fallback`）、`compaction`（`compaction_start / end`）、
 *   `aux`（`usage` 条目：保温 / 分类器请求）、`external_turn`（外部 Agent 回合骨架，由任务注册表经
 *   `appendTraceEntry` 写，见 `agents/task-record.ts`）。
 *
 * 约束：只追加、不改已落条目；`custom` 不进上下文（投影跳过），所以请求字节与缓存前缀不变；只记 id、
 * 时间与计数，**不记正文**（提示、参数、结果、外部工具标题）。depth > 0 的子会话也装（只落盘，不发事件）。
 */

import { formatModelRef } from "../ai/providers/channels.js";
import type { AssistantMessage } from "../ai/types.js";
import {
  TRACE_CUSTOM_TYPE,
  TRACE_REASON_MAX,
  type TraceEntryData,
  type TraceStepData,
  type TraceSubcallTiming,
  type TraceToolTiming,
} from "../trace/types.js";
import type { StreamFn } from "./loop.js";
import type { SessionCore } from "./session-core.js";
import type { SessionExtension, SessionExtensionFactory } from "./session-extensions.js";
import { telemetryOf } from "./session-telemetry.js";
import type { SessionEvent } from "./types.js";
import type { RequestTelemetry } from "./types-w5.js";

export interface TraceWriterDeps {
  now?(): number;
}

/** 追加一条 `ama.trace`（不发 `entry_appended` 以外的事件）。 */
export function appendTraceEntry(
  core: Pick<SessionCore, "appendEntry">,
  data: TraceEntryData,
): void {
  core.appendEntry({ type: "custom", customType: TRACE_CUSTOM_TYPE, data });
}

function clip(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > TRACE_REASON_MAX ? `${one.slice(0, TRACE_REASON_MAX - 1)}…` : one;
}

const AUX_PURPOSE: Readonly<Record<string, string>> = {
  warm: "cache_warm",
  classify: "permission_classify",
};

export function createTraceWriter(core: SessionCore, deps: TraceWriterDeps = {}): SessionExtension {
  const now = deps.now ?? Date.now;
  let request: RequestTelemetry | undefined;
  let assistantEntryId: string | undefined;
  let attempt = 1;
  let fallbackFrom: string | undefined;
  /** 本次 turn 请求发出时是否处于回退（切回主模型可能早于 turn_end）。 */
  let requestFallbackFrom: string | undefined;
  const tools = new Map<string, TraceToolTiming>();
  const subcalls = new Map<string, TraceSubcallTiming>();
  /** toolCallId → 审批等待（请求可能早于 tool_execution_start）。 */
  const approvals = new Map<string, number>();
  const pendingApprovals = new Map<string, { toolCallId: string; at: number }>();
  let compaction: { trigger: "threshold" | "overflow" | "manual"; at: number } | undefined;
  let compactionEntryId: string | undefined;
  /** 非 turn 请求（保温 / 分类器）最近一次的开始时刻。 */
  const auxStarted = new Map<string, number>();
  let unsubscribe: (() => void) | undefined;

  const write = (data: TraceEntryData): void => {
    try {
      appendTraceEntry(core, data);
    } catch (error) {
      core.log("warn", `ama.trace append failed: ${String(error)}`);
    }
  };

  const subscribe = (): void => {
    if (unsubscribe !== undefined) return;
    unsubscribe = telemetryOf(core)?.onRequestEnd((record) => {
      request = record;
    });
  };

  const dirty = (): boolean => request !== undefined || tools.size > 0 || subcalls.size > 0;

  const writeStep = (message: AssistantMessage | undefined, aborted: boolean): void => {
    const ids = new Set(
      message?.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])) ?? [],
    );
    const stepTools: TraceToolTiming[] = [];
    for (const [id, timing] of tools) {
      if (ids.size > 0 && !ids.has(id) && !aborted) continue;
      const approvalMs = approvals.get(id);
      stepTools.push(approvalMs === undefined ? timing : { ...timing, approvalMs });
      tools.delete(id);
      approvals.delete(id);
    }
    const step: TraceStepData = { kind: "step", attempt };
    if (assistantEntryId !== undefined) step.assistantEntryId = assistantEntryId;
    const r = request;
    if (r !== undefined) {
      step.requestAt = r.requestAt;
      if (r.firstTokenAt !== undefined) step.firstTokenAt = r.firstTokenAt;
      if (r.doneAt !== undefined) step.doneAt = r.doneAt;
      if (r.outputTokens !== undefined) step.outputTokens = r.outputTokens;
      if (r.tps !== undefined) step.tps = Math.round(r.tps * 10) / 10;
    }
    if (requestFallbackFrom !== undefined) step.fallbackFrom = requestFallbackFrom;
    requestFallbackFrom = undefined;
    if (aborted) step.status = "aborted";
    if (stepTools.length > 0) step.tools = stepTools;
    if (subcalls.size > 0) step.subcalls = [...subcalls.values()];
    subcalls.clear();
    request = undefined;
    assistantEntryId = undefined;
    write(step);
    // 成功的请求之后，下一次请求重新从第 1 次尝试算
    if (!aborted && message !== undefined && message.stopReason !== "error") attempt = 1;
  };

  const onEvent = (event: SessionEvent): void => {
    subscribe();
    switch (event.type) {
      case "entry_appended": {
        const entry = event.entry;
        if (entry.type === "message" && entry.message.role === "assistant")
          assistantEntryId = entry.id;
        else if (entry.type === "compaction") compactionEntryId = entry.id;
        else if (entry.type === "usage") {
          const startedAt = auxStarted.get(entry.kind);
          auxStarted.delete(entry.kind);
          write({
            kind: "aux",
            purpose: entry.kind,
            usageEntryId: entry.id,
            ...(startedAt !== undefined ? { startedAt } : {}),
            endedAt: now(),
          });
        }
        return;
      }
      case "tool_execution_start":
        if (event.parentToolCallId !== undefined)
          subcalls.set(event.toolCallId, {
            id: event.toolCallId,
            parentId: event.parentToolCallId,
            name: event.toolName,
            startedAt: now(),
          });
        else tools.set(event.toolCallId, { id: event.toolCallId, startedAt: now() });
        return;
      case "tool_execution_end": {
        const sub = subcalls.get(event.toolCallId);
        if (event.parentToolCallId !== undefined && sub !== undefined) {
          sub.endedAt = now();
          if (event.isError) sub.isError = true;
          return;
        }
        const timing = tools.get(event.toolCallId) ?? { id: event.toolCallId, startedAt: now() };
        timing.endedAt = now();
        if (event.denied === true) timing.denied = true;
        tools.set(event.toolCallId, timing);
        return;
      }
      case "permission_request": {
        const toolCallId = event.context?.toolCallId;
        if (toolCallId !== undefined)
          pendingApprovals.set(event.requestId, { toolCallId, at: now() });
        return;
      }
      case "permission_resolved": {
        const pending = pendingApprovals.get(event.requestId);
        if (pending === undefined) return;
        pendingApprovals.delete(event.requestId);
        approvals.set(
          pending.toolCallId,
          (approvals.get(pending.toolCallId) ?? 0) + (now() - pending.at),
        );
        return;
      }
      case "turn_end":
        writeStep(event.message, false);
        return;
      case "agent_end":
        if (dirty()) writeStep(undefined, true);
        return;
      case "auto_retry_start":
        attempt = event.attempt + 1;
        write({
          kind: "retry_wait",
          attempt,
          delayMs: event.delayMs,
          startedAt: now(),
          ...(event.errorMessage !== "" ? { reason: clip(event.errorMessage) as string } : {}),
        });
        return;
      case "model_fallback": {
        const from = formatModelRef(event.from);
        fallbackFrom = from;
        attempt += 1;
        const reason = clip(event.reason);
        write({
          kind: "fallback",
          from,
          to: formatModelRef(event.to),
          ...(reason !== undefined && reason !== "" ? { reason } : {}),
        });
        return;
      }
      case "model_changed":
        // 回退结束切回主模型（或用户换模型）：之后的请求不再算回退
        if (fallbackFrom !== undefined && formatModelRef(event.model) === fallbackFrom)
          fallbackFrom = undefined;
        return;
      case "compaction_start":
        compaction = { trigger: event.trigger, at: now() };
        compactionEntryId = undefined;
        return;
      case "compaction_end": {
        const started = compaction;
        compaction = undefined;
        write({
          kind: "compaction",
          trigger: event.trigger,
          startedAt: started?.at ?? now(),
          endedAt: now(),
          ...(compactionEntryId !== undefined ? { compactionEntryId } : {}),
          ...(event.aborted ? { aborted: true } : {}),
        });
        compactionEntryId = undefined;
        return;
      }
      default:
        return;
    }
  };

  return {
    id: "trace-writer",
    wrapStream(stream: StreamFn): StreamFn {
      return (model, context, options) => {
        const kind = options.purpose ?? "turn";
        if (kind === "turn") requestFallbackFrom = fallbackFrom;
        const purpose = AUX_PURPOSE[kind];
        if (purpose !== undefined) auxStarted.set(purpose, now());
        return stream(model, context, options);
      };
    },
    onEvent,
    dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

/** 组装表用的工厂：主会话与子会话都装。 */
export function traceWriterFactory(deps: TraceWriterDeps = {}): SessionExtensionFactory {
  return ({ core }) => createTraceWriter(core, deps);
}
