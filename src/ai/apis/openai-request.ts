/**
 * openai-completions 请求体（设计 §3.1、§3.3）：消息转换、compat 开关、思考字段、缓存。
 *
 * compat 开关在这里生效的位置：
 * - maxTokensField / supportsDeveloperRole / supportsUsageInStreaming（stream_options）/
 *   supportsStore（store:false）/ supportsStrictTools（strict:true，仅对严格兼容的 schema）；
 * - thinkingFormat：openai → reasoning_effort；openrouter → reasoning.effort；deepseek →
 *   thinking.type（+ reasoning_effort）；zai → thinking.type（+ reasoning_effort）；qwen →
 *   enable_thinking（+ thinkingTokenBudgetField 预算）；none → 不发；
 * - requiresReasoningContentOnAssistantMessages：推理模型的助手消息一律带 reasoning_content；
 * - requiresToolResultName / requiresAssistantAfterToolResult / supportsMidConvoSystemMessages；
 * - cacheControlFormat "anthropic"：system 末、最后一个工具、最后一条 user / tool 消息打
 *   cache_control（OpenRouter 上的 anthropic/* 模型）。
 * 缓存（第三波 §1.3）：`prompt_cache_key = sessionId` 只在 `sendPromptCacheKey`（官方端点缺省开）时发；
 * `long` 在 `supportsLongCacheRetention` 时发 `prompt_cache_retention: "24h"`，否则降为 short；
 * 保留层级未指定时读 `AMA_CACHE_RETENTION`。`toolChoice: "none"`（有工具时）→ `tool_choice: "none"`。
 */

import {
  contentText,
  normalizeContext,
  normalizeContextInline,
  sanitizeText,
  type InlineSystemUpdate,
} from "../context.js";
import {
  DEFAULT_THINKING_BUDGETS,
  clampBudgetToAnswerRoom,
  clampThinkingLevel,
  mappedThinkingValue,
} from "../thinking.js";
import type {
  AssistantMessage,
  ContentBlock,
  JsonSchema,
  Model,
  ModelThinkingLevel,
  OpenAICompletionsCompat,
  StreamOptions,
  ToolDecl,
  ToolResultMessage,
  TranscriptContext,
  UserMessage,
} from "../types.js";
import { cacheControlFor } from "./anthropic-request.js";
import {
  effectiveRetention,
  resolveCacheRetention,
  resolvePromptCacheCompat,
} from "./cache-params.js";
import { detectCompat } from "./openai-compat.js";

type Json = Record<string, unknown>;
type Conversation = UserMessage | AssistantMessage | ToolResultMessage;

/** 思考文本回放用的字段名；thinkingSignature 记录来源字段，回放时原样放回。 */
export const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

export const ASSISTANT_BRIDGE_TEXT = "Tool results received.";

export interface OpenAIRequest {
  body: Json;
  compat: OpenAICompletionsCompat;
  thinkingLevel: ModelThinkingLevel;
  providerThinkingLevel: string | undefined;
}

function imagePart(block: Extract<ContentBlock, { type: "image" }>): Json {
  return { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } };
}

function convertUser(message: UserMessage): Json | undefined {
  if (typeof message.content === "string") {
    return { role: "user", content: sanitizeText(message.content) };
  }
  const parts: Json[] = [];
  for (const block of message.content) {
    if (block.type === "image") parts.push(imagePart(block));
    else if (block.text.length > 0) parts.push({ type: "text", text: sanitizeText(block.text) });
  }
  return parts.length > 0 ? { role: "user", content: parts } : undefined;
}

function normalizeCallId(model: Model, id: string): string {
  const base = id.includes("|") ? (id.split("|")[0] ?? id) : id;
  return model.provider === "openai" && base.length > 40 ? base.slice(0, 40) : base;
}

function convertAssistant(
  model: Model,
  message: AssistantMessage,
  compat: OpenAICompletionsCompat,
): Json | undefined {
  const text = message.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .filter((t) => t.trim().length > 0)
    .join("");
  const thinking = message.content.filter(
    (b): b is Extract<typeof b, { type: "thinking" }> => b.type === "thinking" && !b.redacted,
  );
  const calls = message.content.filter(
    (b): b is Extract<typeof b, { type: "toolCall" }> => b.type === "toolCall",
  );
  const out: Json = { role: "assistant", content: text.length > 0 ? sanitizeText(text) : null };
  const thinkingText = thinking
    .map((b) => b.thinking)
    .filter((t) => t.trim().length > 0)
    .join("\n");
  const field = thinking.find((b) =>
    (REASONING_FIELDS as readonly string[]).includes(b.thinkingSignature ?? ""),
  )?.thinkingSignature;
  if (compat.requiresReasoningContentOnAssistantMessages && model.reasoning) {
    out["reasoning_content"] = thinkingText;
  } else if (field && thinkingText.length > 0) {
    out[field] = thinkingText;
  }
  if (calls.length > 0) {
    out["tool_calls"] = calls.map((call) => ({
      id: normalizeCallId(model, call.id),
      type: "function",
      function: { name: call.name, arguments: call.rawArguments ?? JSON.stringify(call.arguments) },
    }));
  }
  if (out["content"] === null && calls.length === 0) return undefined;
  return out;
}

function convertToolResults(
  model: Model,
  results: ToolResultMessage[],
  compat: OpenAICompletionsCompat,
): { messages: Json[]; images: Json[] } {
  const messages: Json[] = [];
  const images: Json[] = [];
  for (const result of results) {
    const text = contentText(result.content);
    const blocks = typeof result.content === "string" ? [] : result.content;
    const hasImages = blocks.some((b) => b.type === "image");
    const message: Json = {
      role: "tool",
      tool_call_id: normalizeCallId(model, result.toolCallId),
      content: sanitizeText(
        text.length > 0 ? text : hasImages ? "(see attached image)" : "(no output)",
      ),
    };
    if (compat.requiresToolResultName) message["name"] = result.toolName;
    messages.push(message);
    if (hasImages && model.input.includes("image")) {
      for (const block of blocks) if (block.type === "image") images.push(imagePart(block));
    }
  }
  return { messages, images };
}

export function convertMessages(
  model: Model,
  messages: readonly Conversation[],
  compat: OpenAICompletionsCompat,
  instructionRole: "system" | "developer",
  updates: readonly InlineSystemUpdate[] = [],
): Json[] {
  const out: Json[] = [];
  let afterToolResult = false;
  const flushUpdates = (index: number): void => {
    for (const update of updates) {
      if (update.beforeIndex === index) out.push({ role: instructionRole, content: update.text });
    }
  };
  for (let i = 0; i < messages.length; i++) {
    flushUpdates(i);
    const message = messages[i];
    if (!message) continue;
    if (message.role === "toolResult") {
      const batch: ToolResultMessage[] = [];
      while (messages[i]?.role === "toolResult") batch.push(messages[i++] as ToolResultMessage);
      i--;
      const converted = convertToolResults(model, batch, compat);
      out.push(...converted.messages);
      afterToolResult = true;
      if (converted.images.length > 0) {
        if (compat.requiresAssistantAfterToolResult) {
          out.push({ role: "assistant", content: ASSISTANT_BRIDGE_TEXT });
        }
        out.push({
          role: "user",
          content: [{ type: "text", text: "Images from the tool results:" }, ...converted.images],
        });
        afterToolResult = false;
      }
      continue;
    }
    if (message.role === "user") {
      const converted = convertUser(message);
      if (!converted) continue;
      if (afterToolResult && compat.requiresAssistantAfterToolResult) {
        out.push({ role: "assistant", content: ASSISTANT_BRIDGE_TEXT });
      }
      out.push(converted);
    } else {
      const converted = convertAssistant(model, message, compat);
      if (converted) out.push(converted);
    }
    afterToolResult = false;
  }
  flushUpdates(messages.length);
  return out;
}

/** strict 模式要求：object 关闭 additionalProperties 且全部属性必填（递归）。 */
export function isStrictCompatible(schema: JsonSchema): boolean {
  if (schema.type === "object" || schema.properties) {
    if (schema.additionalProperties !== false) return false;
    const keys = Object.keys(schema.properties ?? {});
    const required = new Set(schema.required ?? []);
    if (!keys.every((key) => required.has(key))) return false;
    return Object.values(schema.properties ?? {}).every(isStrictCompatible);
  }
  if (schema.type === "array" && schema.items) return isStrictCompatible(schema.items);
  return true;
}

function convertTools(tools: readonly ToolDecl[], compat: OpenAICompletionsCompat): Json[] {
  return tools.map((tool) => {
    const parameters = { ...tool.parameters, type: "object" as const };
    const fn: Json = { name: tool.name, description: tool.description, parameters };
    if (compat.supportsStrictTools && isStrictCompatible(parameters)) fn["strict"] = true;
    return { type: "function", function: fn };
  });
}

function addCacheControlToText(message: Json, cacheControl: Json): boolean {
  const content = message["content"];
  if (typeof content === "string" && content.length > 0) {
    message["content"] = [{ type: "text", text: content, cache_control: cacheControl }];
    return true;
  }
  if (!Array.isArray(content)) return false;
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i] as Json;
    if (part["type"] === "text") {
      part["cache_control"] = cacheControl;
      return true;
    }
  }
  return false;
}

function applyAnthropicCache(
  messages: Json[],
  tools: Json[] | undefined,
  cacheControl: Json,
): void {
  const system = messages.find((m) => m["role"] === "system" || m["role"] === "developer");
  if (system) addCacheControlToText(system, cacheControl);
  const lastTool = tools?.[tools.length - 1];
  if (lastTool) lastTool["cache_control"] = cacheControl;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && (message["role"] === "user" || message["role"] === "tool")) {
      if (addCacheControlToText(message, cacheControl)) return;
    }
  }
}

/** 写思考相关字段；返回实际发出的级别值（effort 字串或预算）。 */
function applyThinking(
  body: Json,
  model: Model,
  compat: OpenAICompletionsCompat,
  level: ModelThinkingLevel,
  maxTokens: number,
): string | undefined {
  if (!model.reasoning || compat.thinkingFormat === "none") return undefined;
  const on = level !== "off";
  const mapped = mappedThinkingValue(model, level);
  const effort = on ? (typeof mapped === "string" ? mapped : level) : undefined;
  const offValue = model.thinkingLevelMap?.off;
  let sent: string | undefined;
  switch (compat.thinkingFormat) {
    case "openai":
      if (compat.supportsReasoningEffort && effort) sent = effort;
      else if (compat.supportsReasoningEffort && !on && typeof offValue === "string")
        sent = offValue;
      if (sent !== undefined) body["reasoning_effort"] = sent;
      break;
    case "openrouter":
      if (effort) sent = effort;
      else if (offValue !== null) sent = typeof offValue === "string" ? offValue : "none";
      if (sent !== undefined) body["reasoning"] = { effort: sent };
      break;
    case "deepseek":
    case "zai":
      if (on || offValue !== null) body["thinking"] = { type: on ? "enabled" : "disabled" };
      if (on && compat.supportsReasoningEffort && effort) {
        body["reasoning_effort"] = effort;
        sent = effort;
      }
      break;
    case "qwen":
      body["enable_thinking"] = on;
      if (on && compat.supportsReasoningEffort && effort) {
        body["reasoning_effort"] = effort;
        sent = effort;
      }
      break;
  }
  if (compat.thinkingTokenBudgetField && level !== "off") {
    const budget = clampBudgetToAnswerRoom(
      typeof mapped === "number" ? mapped : DEFAULT_THINKING_BUDGETS[level],
      maxTokens,
    );
    if (budget > 0) {
      body[compat.thinkingTokenBudgetField] = budget;
      sent ??= String(budget);
    }
  }
  return sent;
}

export function buildOpenAIRequest(
  model: Model,
  context: TranscriptContext,
  options: StreamOptions,
): OpenAIRequest {
  const compat = detectCompat(model);
  const normalized = compat.supportsMidConvoSystemMessages
    ? normalizeContextInline(context, { model })
    : { ...normalizeContext(context, { model }), systemUpdates: [] };
  const role = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";
  const messages: Json[] = [];
  if (normalized.systemPrompt.length > 0) {
    messages.push({ role, content: sanitizeText(normalized.systemPrompt) });
  }
  messages.push(
    ...convertMessages(model, normalized.messages, compat, role, normalized.systemUpdates),
  );
  const maxTokens = options.maxTokens ?? model.maxTokens;
  const level = clampThinkingLevel(model, options.thinkingLevel ?? "off");
  const body: Json = { model: model.id, messages, stream: true };
  if (compat.supportsUsageInStreaming) body["stream_options"] = { include_usage: true };
  if (compat.supportsStore) body["store"] = false;
  body[compat.maxTokensField] = maxTokens;
  if (options.temperature !== undefined) body["temperature"] = options.temperature;
  const tools = normalized.tools.length > 0 ? convertTools(normalized.tools, compat) : undefined;
  if (tools) body["tools"] = tools;
  if (tools && options.toolChoice === "none") body["tool_choice"] = "none";
  const cacheCompat = resolvePromptCacheCompat(model, "openai-completions");
  const retention = effectiveRetention(resolveCacheRetention(options.cacheRetention), cacheCompat);
  if (options.sessionId && retention !== "none" && cacheCompat.sendPromptCacheKey) {
    body["prompt_cache_key"] = options.sessionId.slice(0, 64);
  }
  if (retention === "long" && compat.cacheControlFormat !== "anthropic") {
    body["prompt_cache_retention"] = "24h";
  }
  const cacheControl = cacheControlFor(retention);
  if (compat.cacheControlFormat === "anthropic" && cacheControl) {
    applyAnthropicCache(messages, tools, cacheControl);
  }
  const providerLevel = applyThinking(body, model, compat, level, maxTokens);
  if (model.samplingParams) Object.assign(body, model.samplingParams);
  return { body, compat, thinkingLevel: level, providerThinkingLevel: providerLevel };
}
