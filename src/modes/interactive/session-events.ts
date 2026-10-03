/**
 * 交互界面的会话事件分派：`SessionEvent` → 消息区、工具视图、状态栏、运行指示。[B7]
 * 从 interactive-mode.ts 拆出（W5-U：第五波事件先交给 agent-ui.ts，预算到限的 agent_settled warning 不重复显示）。
 */

import { msg } from "../../i18n/index.js";
import type { AgentSession, SessionEvent } from "../../agent/types.js";
import { cacheEventNotice, cacheNoticesEnabled } from "../session-report.js";
import type { AgentUi } from "./agent-ui.js";
import { compactionErrorText, ImageBudgetNotices, LIMIT_WARNING } from "./event-notices.js";
import type { MessageView, NoticeLevel } from "./message-view.js";
import type { RunIndicator } from "./run-indicator.js";
import type { StatusArea } from "./status-area.js";
import type { StatusBar } from "./status-bar.js";
import type { ToolTracker } from "./tool-view.js";

export interface SessionEventDeps {
  view: MessageView;
  tools: ToolTracker;
  status: StatusBar;
  area: StatusArea;
  agentUi(): AgentUi;
  indicator: RunIndicator;
  session(): AgentSession;
  setQueue(steering: readonly string[], followUp: readonly string[]): void;
  notice(level: NoticeLevel, text: string): void;
  render(): void;
}

export function createSessionEventHandler(deps: SessionEventDeps): (event: SessionEvent) => void {
  const { view, tools, status, area, agentUi, indicator, session, setQueue, notice, render } = deps;
  const images = new ImageBudgetNotices((text) => notice("info", text));
  return (event: SessionEvent): void => {
    if (area.onEvent(event) || agentUi().onEvent(event)) {
      // [W7-A] 子任务出现 / 结束：运行提示行的「↓ Agent 栏」跟着变
      if (event.type === "subagent_start" || event.type === "subagent_end") indicator.sync();
      return render();
    }
    images.onEvent(event);
    switch (event.type) {
      case "agent_settled":
        // 预算到限已由 limit_reached 给出友好提示
        if (event.warning !== undefined && event.warning !== LIMIT_WARNING)
          view.addNotice("warn", event.warning);
        status.refresh();
        break;
      case "message_start": {
        const message = event.message;
        if (message.role === "user") view.addUser(message);
        else if (message.role === "assistant") view.startAssistant(message);
        else if (message.role === "custom" && message.display) {
          view.addNotice("info", typeof message.content === "string" ? message.content : "");
        }
        break;
      }
      case "message_update":
        view.updateAssistant(event.message);
        break;
      case "message_end":
        if (event.message.role === "assistant") {
          view.endAssistant(event.message);
          status.refresh();
        }
        break;
      case "tool_execution_start": {
        const started = tools.start(event);
        if (started.topLevel) view.addTool(started.view);
        break;
      }
      case "tool_execution_update":
        tools.update(event.toolCallId, event.partial);
        render();
        return;
      case "tool_execution_end":
        tools.end(event.toolCallId, event.result, event.isError);
        break;
      case "queue_update":
        setQueue(event.steering, event.followUp);
        return;
      case "compaction_end":
        if (event.result !== undefined) view.addCompaction(event.result);
        else if (event.error !== undefined)
          view.addNotice(
            "error",
            msg().interactive.events.compactionFailed(compactionErrorText(event.error)),
          );
        else if (event.aborted)
          view.addNotice("info", msg().interactive.events.compactionCancelled);
        status.refresh();
        break;
      case "auto_retry_start":
        view.addRetry(event.attempt, event.maxAttempts, event.delayMs, event.errorMessage);
        break;
      case "auto_retry_end":
        if (!event.success) view.addRetryFailed(event.finalError);
        break;
      case "cache_miss":
      case "context_pressure": {
        const shown = cacheEventNotice(event, cacheNoticesEnabled(session()));
        if (shown !== undefined) view.addNotice(shown.level, shown.text);
        status.refresh();
        render();
        return;
      }
      case "cache_warm":
      case "permission_mode_changed":
      case "model_changed":
      case "thinking_level_changed":
      case "session_changed":
        status.refresh();
        render();
        return;
      default:
        break;
    }
    indicator.onEvent(event);
    render();
  };
}
