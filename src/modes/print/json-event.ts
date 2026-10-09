/**
 * 线上事件形状（设计 §13.2、src/rpc.ts）：RPC 与 `--output-format stream-json` 共用。[B6]
 *
 * - `message_update` 变成纯增量：去掉累计消息与 `partial`，附最新 `usage`；`done / error`
 *   保留最终 `message`。`tool_execution_end` 去掉 `result.fileChange`（[ACP-C0] 改前 / 改后全文只给
 *   ACP 映射用，不上 RPC / stream-json 线）。其余 `SessionEvent` 原样。
 * - [M-G] `compact`（RPC 客户端声明 `compact_events`，docs/memory-plan.md D9）：`compactEvent()` 去掉
 *   重复的大正文——`turn_end.toolResults[]` 每项只留 `{ toolCallId, toolName, isError, timestamp,
 *   contentOmitted }`；`message_start` 与 `entry_appended`（`message` 条目）里的 toolResult / 带图片的 user
 *   消息 `content` 换成 `""` 并加 `contentOmitted: true`。`message_end` 与 `tool_execution_end` 保持全量。
 *   `stream-json` 不传 compact，输出不变。
 * - `toJsonLine()`：一行 JSON；Error 序列化为 `{ name, message }`，bigint 转字符串，
 *   U+2028 / U+2029 转义（部分 JSONL 客户端会把它们当换行）；图片 base64 不截断。
 */

import type { SessionEvent } from "../../agent/types.js";
import type { AssistantEvent, ToolResultMessage } from "../../ai/types.js";
import type { RpcEvent, WireAssistantEvent } from "../../rpc.js";
import type { AgentMessage } from "../../session/types.js";

export interface WireOptions {
  /** [M-G] 客户端声明了 `compact_events`。 */
  compact?: boolean;
}

export function toWireAssistantEvent(event: AssistantEvent): WireAssistantEvent {
  if (!("partial" in event)) return event;
  const { partial: _partial, ...rest } = event;
  return rest as WireAssistantEvent;
}

/** toolResult 与带图片的 user 消息：正文换成 `""` 并标 `contentOmitted`；其它消息原样。 */
function omitContent<M extends AgentMessage>(message: M): M {
  const omit =
    message.role === "toolResult" ||
    (message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "image"));
  return omit ? { ...message, content: "", contentOmitted: true } : message;
}

/** [M-G] 精简事件：只改 turn_end / message_start / entry_appended，其余（含 message_end）原样。 */
export function compactEvent(event: SessionEvent): SessionEvent {
  switch (event.type) {
    case "turn_end":
      if (event.toolResults.length === 0) return event;
      return {
        ...event,
        // 线上形状（docs/rpc.md）不是完整的 ToolResultMessage：正文与 details 都不带
        toolResults: event.toolResults.map(
          ({ toolCallId, toolName, isError, timestamp }) =>
            ({
              toolCallId,
              toolName,
              isError,
              timestamp,
              contentOmitted: true,
            }) as unknown as ToolResultMessage,
        ),
      };
    case "message_start": {
      const message = omitContent(event.message);
      return message === event.message ? event : { ...event, message };
    }
    case "entry_appended": {
      if (event.entry.type !== "message") return event;
      const message = omitContent(event.entry.message);
      return message === event.entry.message
        ? event
        : { ...event, entry: { ...event.entry, message } };
    }
    default:
      return event;
  }
}

export function toWireEvent(input: SessionEvent, options: WireOptions = {}): RpcEvent {
  const event = options.compact === true ? compactEvent(input) : input;
  if (event.type === "tool_execution_end" && event.result.fileChange !== undefined) {
    const { fileChange: _fileChange, ...result } = event.result;
    return { ...event, result };
  }
  if (event.type !== "message_update") return event;
  const wire: RpcEvent = {
    type: "message_update",
    assistantMessageEvent: toWireAssistantEvent(event.assistantMessageEvent),
  };
  const usage = event.message.usage;
  if (usage !== undefined) wire.usage = usage;
  return wire;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

/** 一行 JSON（不含换行符）。 */
export function toJsonLine(value: unknown): string {
  return JSON.stringify(value, replacer)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
