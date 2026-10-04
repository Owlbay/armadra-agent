/**
 * 组装根：会话事件 → 宿主事件总线（实施计划 §1.4 表）。[B6，ACP-C0 从 compose-session.ts 迁出]
 *
 * hook_executed、session_start / session_shutdown 由 bootstrap 与会话切换发，不在这里桥接；
 * 第三波加 `cache_miss` / `context_pressure`，第五波加子 Agent 与计划事件。
 */

import type { SessionEvent } from "../agent/types.js";
import type { AgentEventBus } from "../host/api-impl.js";

/** §1.4：SessionEvent → AgentEvents。 */
export function bridgeEvent(event: SessionEvent, bus: AgentEventBus): void {
  switch (event.type) {
    case "before_agent_start":
      void bus.emit("before_agent_start", { prompt: event.prompt });
      return;
    case "agent_start":
    case "turn_start":
    case "turn_end":
    case "agent_before_settle":
      void bus.emit(event.type, {});
      return;
    case "agent_end":
      void bus.emit("agent_end", { stopReason: event.stopReason, willRetry: event.willRetry });
      return;
    case "agent_settled":
      void bus.emit("agent_settled", event.warning === undefined ? {} : { warning: event.warning });
      return;
    case "tool_execution_start":
      void bus.emit("tool_call", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.args,
      });
      return;
    case "tool_execution_end":
      void bus.emit("tool_result", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      });
      return;
    case "permission_request":
      void bus.emit("tool_approval_requested", {
        requestId: event.requestId,
        toolName: event.toolName,
      });
      return;
    case "permission_resolved":
      void bus.emit("tool_approval_resolved", {
        requestId: event.requestId,
        decision: event.decision,
      });
      return;
    case "compaction_end":
      if (event.result !== undefined)
        void bus.emit("session_compact", { tokensBefore: event.result.tokensBefore });
      return;
    case "model_changed":
      void bus.emit("model_select", { model: event.model });
      return;
    case "cache_miss": {
      const { type: _type, ...miss } = event;
      void bus.emit("cache_miss", miss);
      return;
    }
    case "context_pressure": {
      const { type: _type, ...pressure } = event;
      void bus.emit("context_pressure", pressure);
      return;
    }
    case "quota_update": {
      const { type: _type, ...quota } = event;
      void bus.emit("quota_update", quota);
      return;
    }
    // [W5-C0] 子 Agent 与计划事件
    case "subagent_start": {
      const { type: _type, ...payload } = event;
      void bus.emit("subagent_start", payload);
      return;
    }
    case "subagent_end": {
      const { type: _type, ...payload } = event;
      void bus.emit("subagent_end", payload);
      return;
    }
    case "plan_proposed": {
      const { type: _type, ...payload } = event;
      void bus.emit("plan_proposed", payload);
      return;
    }
    case "plan_resolved": {
      const { type: _type, ...payload } = event;
      void bus.emit("plan_resolved", payload);
      return;
    }
    default:
      return;
  }
}
