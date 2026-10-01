/**
 * 上下文转换与回放修复（设计 §4.1 convertToLlm、§4.2「回放时 transform.ts 再兜底修复旧文件」）。[B2]
 *
 * `convertToLlm(messages, target)`：AgentMessage → Message，三种扩展角色转成 user 消息，再
 * `repairTranscript`。**不得抛错**。
 *
 * `repairTranscript(messages, target)`：
 * 1. 跳过 `stopReason` 为 error / aborted 的助手消息（失败尝试与被中断的半条回复不回放）；
 * 2. tool id 归一化：只留 `[A-Za-z0-9_-]`、≤ 64 字符，同一原 id 映射一致且不撞车；
 * 3. 跨模型思考块降级：来自其它 provider / model 的 thinking 转成普通文本（redacted 丢弃），
 *    并去掉签名类字段；同模型原样保留；
 * 4. 孤儿 tool_call（没有结果）补一条错误结果，紧跟在该助手消息已有结果之后；
 * 5. 孤儿 toolResult（前面没有对应调用）丢弃。
 */

import type {
  AssistantContentBlock,
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "../ai/types.js";
import type { AgentMessage } from "../session/types.js";

export interface TransformTarget {
  provider: string;
  model: string;
}

export const ORPHAN_TOOL_RESULT_TEXT = "No result was recorded for this tool call (interrupted).";

const TOOL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function compactionSummaryText(summary: string): string {
  return `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`;
}

export function branchSummaryText(summary: string): string {
  return `The following is a summary of a branch of this conversation that was left to continue from an earlier point:\n\n<summary>\n${summary}\n</summary>`;
}

function toUserMessage(message: AgentMessage): Message | undefined {
  switch (message.role) {
    case "system":
    case "user":
    case "assistant":
    case "toolResult":
      return message;
    case "custom": {
      const user: UserMessage = {
        role: "user",
        content: message.content,
        timestamp: message.timestamp,
      };
      return user;
    }
    case "compactionSummary":
      return {
        role: "user",
        content: compactionSummaryText(message.summary),
        timestamp: message.timestamp,
      };
    case "branchSummary":
      return {
        role: "user",
        content: branchSummaryText(message.summary),
        timestamp: message.timestamp,
      };
    default:
      return undefined;
  }
}

/** 全局唯一的 tool id 分配；每条助手消息一个局部映射（有的供应商每轮都从 call_0 编号）。 */
class ToolIdMapper {
  private readonly used = new Set<string>();

  scope(): Map<string, string> {
    return new Map<string, string>();
  }

  get(local: Map<string, string>, original: string): string {
    const existing = local.get(original);
    if (existing !== undefined) return existing;
    const base = TOOL_ID_PATTERN.test(original)
      ? original
      : original.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "tool";
    let candidate = base;
    for (let n = 1; this.used.has(candidate); n++) candidate = `${base.slice(0, 56)}_${n}`;
    local.set(original, candidate);
    this.used.add(candidate);
    return candidate;
  }
}

function downgradeBlocks(
  message: AssistantMessage,
  target: TransformTarget | undefined,
  ids: ToolIdMapper,
  local: Map<string, string>,
): AssistantMessage {
  const sameModel =
    target === undefined ||
    (message.provider === target.provider && message.model === target.model);
  const content: AssistantContentBlock[] = [];
  for (const block of message.content) {
    if (block.type === "toolCall") {
      const id = ids.get(local, block.id);
      if (sameModel) content.push(id === block.id ? block : { ...block, id });
      else {
        const { thoughtSignature: _signature, ...rest } = block;
        content.push({ ...rest, id });
      }
    } else if (block.type === "thinking") {
      if (sameModel) content.push(block);
      else if (block.redacted !== true && block.thinking.trim() !== "") {
        content.push({ type: "text", text: block.thinking });
      }
    } else if (sameModel) content.push(block);
    else content.push({ type: "text", text: block.text });
  }
  return { ...message, content };
}

export function repairTranscript(
  messages: readonly Message[],
  target?: TransformTarget,
): Message[] {
  const ids = new ToolIdMapper();
  const out: Message[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i] as Message;
    i++;
    if (message.role === "toolResult") continue; // 孤儿结果：其调用已在前面消费掉
    if (message.role !== "assistant") {
      out.push(message);
      continue;
    }
    const skip = message.stopReason === "error" || message.stopReason === "aborted";
    const calls = message.content.filter((block) => block.type === "toolCall");
    // 收集紧随其后的结果段
    const results: ToolResultMessage[] = [];
    while (i < messages.length && messages[i]?.role === "toolResult") {
      results.push(messages[i] as ToolResultMessage);
      i++;
    }
    if (skip) continue;
    const local = ids.scope();
    out.push(downgradeBlocks(message, target, ids, local));
    if (calls.length === 0) continue;
    const byId = new Map<string, ToolResultMessage>();
    for (const result of results)
      if (!byId.has(result.toolCallId)) byId.set(result.toolCallId, result);
    for (const call of calls) {
      const result = byId.get(call.id);
      const id = ids.get(local, call.id);
      if (result !== undefined)
        out.push(result.toolCallId === id ? result : { ...result, toolCallId: id });
      else {
        out.push({
          role: "toolResult",
          toolCallId: id,
          toolName: call.name,
          content: ORPHAN_TOOL_RESULT_TEXT,
          isError: true,
          timestamp: message.timestamp,
        });
      }
    }
  }
  return out;
}

/** AgentMessage[] → Message[]（扩展角色转 user）+ 回放修复。不抛错。 */
export function convertToLlm(
  messages: readonly AgentMessage[],
  target?: TransformTarget,
): Message[] {
  try {
    const converted: Message[] = [];
    for (const message of messages) {
      const llm = toUserMessage(message);
      if (llm !== undefined) converted.push(llm);
    }
    return repairTranscript(converted, target);
  } catch {
    // 契约：不得抛错。退回只保留基本角色的未修复转录。
    return messages.filter(
      (message): message is Message =>
        message.role === "system" ||
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "toolResult",
    );
  }
}
