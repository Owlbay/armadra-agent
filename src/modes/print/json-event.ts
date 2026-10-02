/**
 * 线上事件形状（设计 §13.2、src/rpc.ts）：RPC 与 `--output-format stream-json` 共用。[B6]
 *
 * - `message_update` 变成纯增量：去掉累计消息与 `partial`，附最新 `usage`；`done / error`
 *   保留最终 `message`。其余 `SessionEvent` 原样。
 * - `toJsonLine()`：一行 JSON；Error 序列化为 `{ name, message }`，bigint 转字符串，
 *   U+2028 / U+2029 转义（部分 JSONL 客户端会把它们当换行）；图片 base64 不截断。
 */

import type { SessionEvent } from "../../agent/types.js";
import type { AssistantEvent } from "../../ai/types.js";
import type { RpcEvent, WireAssistantEvent } from "../../rpc.js";

export function toWireAssistantEvent(event: AssistantEvent): WireAssistantEvent {
  if (!("partial" in event)) return event;
  const { partial: _partial, ...rest } = event;
  return rest as WireAssistantEvent;
}

export function toWireEvent(event: SessionEvent): RpcEvent {
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
