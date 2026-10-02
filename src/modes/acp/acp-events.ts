/**
 * `ama --mode acp`：ama 的会话事件 → ACP `session/update`（docs/wave5-plan.md §5.6）。[W5-E]
 *
 * | ama                                  | ACP                                                        |
 * | ------------------------------------ | ---------------------------------------------------------- |
 * | message_update text_delta            | agent_message_chunk                                        |
 * | message_update thinking_delta        | agent_thought_chunk                                        |
 * | message_update toolcall_end          | tool_call（pending，带 rawInput 与 locations）             |
 * | tool_execution_start / end           | tool_call_update（in_progress → completed / failed）       |
 * | todo_updated                         | plan                                                       |
 * | turn_end                             | usage_update（上下文用量、窗口、会话累计美元）             |
 * | permission_mode_changed              | current_mode_update                                        |
 *
 * 工具结果只回前 4 KB 文本（完整结果在 ama 会话里），codemode 内层调用（带 parentToolCallId）
 * 不单列。`session/load` 回放同一套映射（用户消息 → user_message_chunk）。
 */

import { isAbsolute, resolve } from "node:path";
import type { ContentBlock } from "../../ai/types.js";
import type { AgentMessage } from "../../session/types.js";
import type { AgentSession, SessionEvent } from "../../agent/types.js";
import type {
  AcpContentBlock,
  AcpPlanEntry,
  AcpSessionUpdate,
  AcpToolCallLocation,
  AcpToolKind,
} from "../../drivers/acp/types.js";
import { PERMISSION_MODES_STRICT_FIRST } from "../../permissions/types.js";
import { oneLine } from "../../drivers/turn.js";
import type { ToolResult } from "../../tools/types.js";

export const TOOL_OUTPUT_LIMIT = 4 * 1024;

const KINDS: Record<string, AcpToolKind> = {
  read: "read",
  write: "edit",
  edit: "edit",
  bash: "execute",
  grep: "search",
  glob: "search",
  ls: "search",
  find: "search",
  web_fetch: "fetch",
  web_search: "fetch",
  todo: "think",
};

export function toolKind(name: string): AcpToolKind {
  return KINDS[name] ?? "other";
}

function argOf(args: unknown, ...keys: string[]): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  for (const key of keys) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

export function toolTitle(name: string, args: unknown): string {
  const detail =
    argOf(args, "command") ??
    argOf(args, "path", "file_path", "filePath") ??
    argOf(args, "pattern", "query", "url", "prompt");
  return detail === undefined ? name : `${name}: ${oneLine(detail, 100)}`;
}

export function toolLocations(args: unknown, cwd: string): AcpToolCallLocation[] | undefined {
  const path = argOf(args, "path", "file_path", "filePath");
  if (path === undefined) return undefined;
  return [{ path: isAbsolute(path) ? path : resolve(cwd, path) }];
}

function resultText(result: ToolResult): string {
  const text =
    typeof result.content === "string"
      ? result.content
      : result.content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("");
  return text.length > TOOL_OUTPUT_LIMIT
    ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n…（已截断，共 ${text.length} 字符）`
    : text;
}

export function permissionModes(currentModeId: string) {
  return {
    currentModeId,
    availableModes: PERMISSION_MODES_STRICT_FIRST.map((id) => ({ id, name: id })),
  };
}

/** 一个会话的事件映射器（记住模型发出的工具调用，供权限请求关联 toolCallId）。 */
export class AcpEventMapper {
  /** 模型已发出、尚未执行完的工具调用。 */
  private readonly pendingCalls: { id: string; name: string; args: string }[] = [];

  constructor(
    private readonly cwd: string,
    private readonly emit: (update: AcpSessionUpdate) => void,
    private readonly session: () => AgentSession,
  ) {}

  /** 权限请求对应的工具调用 id（按工具名与参数匹配最近一个）。 */
  toolCallIdFor(toolName: string, input: unknown): string | undefined {
    const args = JSON.stringify(input ?? null);
    for (let i = this.pendingCalls.length - 1; i >= 0; i--) {
      const call = this.pendingCalls[i]!;
      if (call.name === toolName && call.args === args) return call.id;
    }
    return undefined;
  }

  onEvent(event: SessionEvent): void {
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta")
          this.emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: e.delta },
          });
        else if (e.type === "thinking_delta")
          this.emit({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: e.delta },
          });
        else if (e.type === "toolcall_end") {
          const call = e.toolCall;
          this.pendingCalls.push({
            id: call.id,
            name: call.name,
            args: JSON.stringify(call.arguments),
          });
          this.emitToolCall(call.id, call.name, call.arguments, "pending");
        }
        return;
      }
      case "tool_execution_start":
        if (event.parentToolCallId !== undefined) return;
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: "in_progress",
        });
        return;
      case "tool_execution_end": {
        if (event.parentToolCallId !== undefined) return;
        const at = this.pendingCalls.findIndex((c) => c.id === event.toolCallId);
        if (at >= 0) this.pendingCalls.splice(at, 1);
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: event.isError ? "failed" : "completed",
          content: [{ type: "content", content: { type: "text", text: resultText(event.result) } }],
        });
        return;
      }
      case "todo_updated":
        this.emit({
          sessionUpdate: "plan",
          entries: event.items.map((item): AcpPlanEntry => ({
            content: item.text,
            priority: "medium",
            status: item.status === "done" ? "completed" : item.status,
          })),
        });
        return;
      case "turn_end":
        this.emitUsage();
        return;
      case "permission_mode_changed":
        this.emit({ sessionUpdate: "current_mode_update", currentModeId: event.mode });
        return;
      default:
        return;
    }
  }

  emitUsage(): void {
    const stats = this.session().getStats();
    if (stats.contextWindow === undefined) return;
    this.emit({
      sessionUpdate: "usage_update",
      used: stats.contextTokens ?? 0,
      size: stats.contextWindow,
      ...(stats.cost !== undefined ? { cost: { amount: stats.cost, currency: "USD" } } : {}),
    });
  }

  /** `session/load`：按消息回放历史。 */
  replay(messages: readonly AgentMessage[]): void {
    for (const message of messages) {
      if (!("role" in message)) continue;
      if (message.role === "user") {
        for (const block of contentOf(message.content))
          this.emit({ sessionUpdate: "user_message_chunk", content: block });
      } else if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "text")
            this.emit({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: block.text },
            });
          else if (block.type === "thinking" && block.redacted !== true)
            this.emit({
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: block.thinking },
            });
          else if (block.type === "toolCall")
            this.emitToolCall(block.id, block.name, block.arguments, "pending");
        }
      } else if (message.role === "toolResult") {
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: message.toolCallId,
          status: message.isError ? "failed" : "completed",
        });
      }
    }
  }

  private emitToolCall(id: string, name: string, args: unknown, status: "pending"): void {
    const locations = toolLocations(args, this.cwd);
    this.emit({
      sessionUpdate: "tool_call",
      toolCallId: id,
      title: toolTitle(name, args),
      kind: toolKind(name),
      status,
      rawInput: args,
      ...(locations !== undefined ? { locations } : {}),
    });
  }
}

function contentOf(content: string | readonly ContentBlock[]): AcpContentBlock[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  const out: AcpContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") out.push({ type: "text", text: block.text });
    else if (block.type === "image") {
      out.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  return out;
}
