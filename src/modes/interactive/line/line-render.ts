/**
 * 行式界面的输出：会话事件 → 纯文本（助手文本流式写 stdout，工具 / 重试 / 压缩一行提示）。[B6]
 * 选择器在行式界面里退化为列出候选、提示带参数重发。
 */

import { msg } from "../../../i18n/index.js";
import type { LineApprovalWhy } from "../../../i18n/messages/interactive-line.js";
import type { AgentSession, SessionEvent } from "../../../agent/types.js";
import { THINKING_LEVELS } from "../../../ai/thinking.js";
import { listSessions } from "../../../cli/compose-store.js";
import type { Runtime } from "../../../cli/runtime.js";
import { autoLayerText, permissionModeLines } from "../../../permissions/modes.js";
import type { ApprovalRequest } from "../../../permissions/types.js";
import type { CommandResult } from "../../commands-core.js";
import { cacheEventNotice, warmSentNotice } from "../../session-report.js";
import { isFirstRunRequest, sourceLabel, type TaskAgentLookup } from "../approval-dialog.js";
import {
  LIMIT_WARNING,
  backgroundJobText,
  limitReachedText,
  modelFallbackText,
} from "../event-notices.js";
import { taskStatusText } from "../tasks-report.js";

const SUMMARY_KEYS = ["command", "path", "pattern", "file_path", "url", "description", "name"];

/** 工具参数的一行摘要（第一个常见字段，折叠换行、截到 80 字符）。 */
export function argsSummary(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const record = args as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value !== "") {
      const flat = value.replace(/\s*\n\s*/g, " ⏎ ");
      return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
    }
  }
  return "";
}

export function approvalQuestion(request: ApprovalRequest, taskAgent?: TaskAgentLookup): string {
  const m = msg().interactive.line;
  const label = sourceLabel(request, taskAgent);
  const task = label === undefined ? "" : `${label} `;
  const origin = request.context?.origin;
  if (origin !== undefined) {
    return m.approvalOrigin(task, origin.toolCall.title, origin.toolCall.locations?.[0]);
  }
  if (isFirstRunRequest(request)) {
    const input = request.input as Record<string, unknown>;
    return m.approvalFirstRun(task, String(input["note"]));
  }
  const summary = argsSummary(request.input);
  const auto = request.autoDecision;
  const why: LineApprovalWhy | undefined =
    request.reason === "dangerous"
      ? { kind: "dangerous" }
      : request.hookReason !== undefined
        ? { kind: "hook", reason: request.hookReason }
        : auto !== undefined
          ? { kind: "auto", layer: autoLayerText(auto.layer), reason: auto.reason }
          : undefined;
  return m.approvalTool(task, request.toolName, summary, why);
}

/** [W3-C2] 缓存提示的开关（line 模式由 runLineMode 传入）。 */
export interface EventPrinterOptions {
  /** `cache.missNotices`（每次现取，切换会话后跟随新会话）；缺省 true。 */
  missNotices?(): boolean;
  /** `AMA_LOG` 为 info / debug：保温成功也写一行。 */
  info?: boolean;
}

/** `AMA_LOG=info|debug`。 */
export function logsInfo(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["AMA_LOG"] === "info" || env["AMA_LOG"] === "debug";
}

export class EventPrinter {
  private midLine = false;
  /** 本次运行的模型错误：等 agent_settled 再打（重试中的失败尝试只显示 ↻ 那一行）。 */
  private pendingError: string | undefined;
  /** 最终失败的运行次数（管道模式据此返回退出码 1）。 */
  failures = 0;

  constructor(
    private readonly out: (text: string) => void,
    private readonly err: (text: string) => void,
    private readonly options: EventPrinterOptions = {},
  ) {}

  private line(text: string, toErr = false): void {
    if (this.midLine) {
      this.out("\n");
      this.midLine = false;
    }
    (toErr ? this.err : this.out)(`${text}\n`);
  }

  /** 收尾：保证光标在行首。 */
  endLine(): void {
    if (this.midLine) this.out("\n");
    this.midLine = false;
  }

  handle(event: SessionEvent): void {
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta" && e.delta !== "") {
          this.out(e.delta);
          this.midLine = !e.delta.endsWith("\n");
        }
        return;
      }
      case "message_end":
        if (event.message.role === "assistant") {
          this.endLine();
          if (event.message.stopReason === "error")
            this.pendingError =
              event.message.errorMessage ?? msg().interactive.view.message.modelError;
        }
        return;
      case "agent_end":
        if (event.willRetry) this.pendingError = undefined;
        return;
      case "tool_execution_start": {
        const summary = argsSummary(event.args);
        this.line(`● ${event.toolName}${summary !== "" ? `  ${summary}` : ""}`);
        return;
      }
      case "tool_execution_end":
        if (event.isError) {
          const content = event.result.content;
          const text =
            typeof content === "string"
              ? content
              : content.map((b) => (b.type === "text" ? b.text : "")).join("");
          this.line(`  ✗ ${text.split("\n")[0]?.slice(0, 200) ?? ""}`);
        }
        return;
      case "auto_retry_start":
        this.line(
          msg().interactive.line.retry(
            event.attempt,
            event.maxAttempts,
            Math.round(event.delayMs / 1000),
            event.errorMessage,
          ),
          true,
        );
        return;
      case "compaction_start":
        this.line(msg().interactive.line.compacting, true);
        return;
      case "compaction_end":
        if (event.error !== undefined)
          this.line(msg().interactive.events.compactionFailed(event.error), true);
        return;
      case "cache_miss":
      case "context_pressure": {
        const shown = cacheEventNotice(event, this.options.missNotices?.() ?? true);
        if (shown !== undefined) this.line(`ama: ${shown.text}`, true);
        return;
      }
      case "cache_warm": {
        const text = this.options.info === true ? warmSentNotice(event) : undefined;
        if (text !== undefined) this.line(`ama: ${text}`, true);
        return;
      }
      case "agent_settled": {
        this.endLine();
        const error = this.pendingError;
        this.pendingError = undefined;
        if (error !== undefined) {
          this.failures++;
          this.line(msg().interactive.line.error(error), true);
        }
        // 失败时 warning 就是同一条错误文本，不再重复打印；预算到限已由 limit_reached 说明
        if (
          event.warning !== undefined &&
          event.warning !== error &&
          event.warning !== LIMIT_WARNING
        )
          this.line(`ama: ${event.warning}`, true);
        return;
      }
      // [W5-U] 第五波事件
      case "plan_proposed": {
        this.line(msg().interactive.line.planProposed(event.version, event.filePath));
        return;
      }
      case "subagent_start":
        this.line(
          msg().interactive.line.subagentStart(
            event.taskId,
            event.agent,
            event.background === true,
          ),
        );
        return;
      case "subagent_end":
        this.line(`  ↳ ${event.taskId} ${taskStatusText(event.status)}`);
        return;
      case "limit_reached":
        this.line(`ama: ${limitReachedText(event)}`, true);
        return;
      case "model_fallback":
        this.line(`ama: ${modelFallbackText(event)}`, true);
        return;
      case "background_job":
        this.line(`ama: ${backgroundJobText(event)}`, true);
        return;
      default:
        return;
    }
  }
}

/** `pick` 在行式界面：列出候选，提示带参数重发。 */
export async function pickHint(
  what: Extract<CommandResult, { kind: "pick" }>["what"],
  runtime: Runtime,
  session: AgentSession,
): Promise<string> {
  switch (what) {
    case "model": {
      const refs: string[] = [];
      for (const provider of runtime.providers.list()) {
        const key = await runtime.providers.resolveApiKey(provider.id);
        if (provider.requiresApiKey && key.apiKey === undefined) continue;
        for (const model of provider.models) refs.push(`  ${provider.id}/${model.id}`);
      }
      return [msg().interactive.line.modelsHeading, ...refs.slice(0, 40)].join("\n");
    }
    case "session": {
      const items = listSessions({ sessionDir: runtime.paths.sessionDir, cwd: session.state.cwd });
      if (items.length === 0) return msg().interactive.line.noSessions;
      return [
        msg().interactive.line.sessionsHeading,
        ...items
          .slice(0, 15)
          .map(
            (i) =>
              `  ${i.id.slice(0, 8)}  ${i.modifiedAt.slice(0, 16).replace("T", " ")}  ${(i.name ?? i.firstPrompt ?? "").replace(/\s+/g, " ").slice(0, 50)}`,
          ),
      ].join("\n");
    }
    case "tree": {
      const users = session.entries.filter(
        (e) => e.type === "message" && e.message.role === "user",
      );
      if (users.length === 0) return msg().interactive.line.noForkable;
      return [
        msg().interactive.line.forkHeading,
        ...users.slice(-15).map((e) => {
          const message = e.type === "message" ? e.message : undefined;
          const content = message?.role === "user" ? message.content : "";
          const text =
            typeof content === "string"
              ? content
              : content.map((b) => (b.type === "text" ? b.text : "")).join("");
          return `  ${e.id}  ${text.replace(/\s+/g, " ").slice(0, 60)}`;
        }),
      ].join("\n");
    }
    case "permission":
      return [
        msg().interactive.line.modeHeading,
        ...permissionModeLines(
          session.state.permissionMode,
          runtime.config.permission?.mode ?? "default",
        ).map((line) => `  ${line}`),
      ].join("\n");
    case "thinking":
      return msg().interactive.line.thinking(
        THINKING_LEVELS.join(" | "),
        session.state.thinkingLevel,
      );
  }
}
