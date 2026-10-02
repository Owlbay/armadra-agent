/**
 * anthropic-messages 请求体（设计 §3.1、§3.3、§3.6）：消息转换、三断点缓存、thinking、工具。
 *
 * compat 按主机推断见 anthropic-compat.ts（[W5-M2]）。
 *
 * 缓存断点（`sendCacheControl` 关时不打；cacheRetention 缺省 short，未指定时读 `AMA_CACHE_RETENTION`；none 不打；long 加
 * `ttl: "1h"`，仅 `supportsLongCacheRetention`——官方端点缺省开，中转缺省关、降为 short；最后做 TTL
 * 顺序校验，5m 之后出现 1h 则全部降为 5m）按优先级取前
 * `maxCacheBreakpoints` 个：① 最后一条 user 消息（含工具结果）的最后一个块 ② system 末块
 * ③ 最后一个工具定义（`supportsCacheControlOnTools`）。
 *
 * thinking：`adaptiveThinking` 模型发 `{type:"adaptive"}` + `output_config.effort`；
 * 其余推理模型按预算发 `{type:"enabled", budget_tokens}`，预算计入 max_tokens（有工具时带交错思考 beta 头，
 * `sendInterleavedThinkingBeta` 关时不带）；off 发
 * `{type:"disabled"}`（映射表 off 为 null 的模型不发）。思考开启时不发 temperature，
 * 除非 `supportsTemperatureWithThinking`。`toolChoice: "none"`（有工具时）→ `tool_choice:{type:"none"}`。
 */

import { contentText, normalizeContext, sanitizeText } from "../context.js";
import {
  budgetedMaxTokens,
  clampThinkingLevel,
  mappedThinkingValue,
  thinkingBudget,
} from "../thinking.js";
import { detectAnthropicCompat } from "./anthropic-compat.js";
import type {
  AnthropicMessagesCompat,
  AssistantMessage,
  ContentBlock,
  Model,
  ModelThinkingLevel,
  StreamOptions,
  ToolDecl,
  ToolResultMessage,
  TranscriptContext,
  UserMessage,
} from "../types.js";
import {
  effectiveRetention,
  resolveCacheRetention,
  resolvePromptCacheCompat,
} from "./cache-params.js";

export const ANTHROPIC_VERSION = "2023-06-01";
export const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

export { DEFAULT_ANTHROPIC_COMPAT, detectAnthropicCompat } from "./anthropic-compat.js";

type Json = Record<string, unknown>;

export interface AnthropicRequest {
  body: Json;
  betas: string[];
  thinkingLevel: ModelThinkingLevel;
  providerThinkingLevel: string | undefined;
}

export function cacheControlFor(
  retention: StreamOptions["cacheRetention"],
): { type: "ephemeral"; ttl?: "1h" } | undefined {
  if (retention === "none") return undefined;
  return retention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/**
 * TTL 顺序校验：Anthropic 按 tools → system → messages 的顺序处理断点，要求 1h 条目都在 5m 之前。
 * 出现「5m 之后的 1h」→ 全部降为 5m（去掉 ttl）。返回是否做了降级。
 */
export function enforceCacheTtlOrder(body: Json): boolean {
  const marks: Json[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === "object" && value !== null) {
      const record = value as Json;
      const mark = record["cache_control"];
      if (typeof mark === "object" && mark !== null) marks.push(mark as Json);
      if (Array.isArray(record["content"])) collect(record["content"]);
    }
  };
  collect(body["tools"]);
  collect(body["system"]);
  collect(body["messages"]);
  const firstShort = marks.findIndex((mark) => mark["ttl"] !== "1h");
  if (firstShort < 0 || !marks.slice(firstShort).some((mark) => mark["ttl"] === "1h")) return false;
  for (const mark of marks) delete mark["ttl"];
  return true;
}

/** `{baseUrl}/v1/messages`；baseUrl 已以 `/v1` 结尾（中转常见写法）时不再重复。 */
export function anthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v1$/i.test(trimmed) ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
}

/** Anthropic 要求 tool_use id 匹配 `^[a-zA-Z0-9_-]+$` 且 ≤ 64。 */
export function normalizeToolId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "tool_call";
}

function convertBlocks(content: ContentBlock[]): Json[] {
  const blocks: Json[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text.trim().length > 0)
        blocks.push({ type: "text", text: sanitizeText(block.text) });
    } else {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: block.mimeType, data: block.data },
      });
    }
  }
  return blocks;
}

function convertUser(message: UserMessage): Json | undefined {
  if (typeof message.content === "string") {
    if (message.content.trim().length === 0) return undefined;
    return { role: "user", content: sanitizeText(message.content) };
  }
  const blocks = convertBlocks(message.content);
  return blocks.length > 0 ? { role: "user", content: blocks } : undefined;
}

function convertAssistant(message: AssistantMessage): Json | undefined {
  const blocks: Json[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text.trim().length > 0)
        blocks.push({ type: "text", text: sanitizeText(block.text) });
    } else if (block.type === "thinking") {
      const signature = block.thinkingSignature ?? "";
      if (block.redacted && signature) {
        blocks.push({ type: "redacted_thinking", data: signature });
      } else if (signature.trim().length > 0) {
        blocks.push({ type: "thinking", thinking: sanitizeText(block.thinking), signature });
      } else if (block.thinking.trim().length > 0) {
        // 无签名（中止或来自别家）的思考不能作为 thinking 回放，降级为文本
        blocks.push({ type: "text", text: sanitizeText(block.thinking) });
      }
    } else {
      blocks.push({
        type: "tool_use",
        id: normalizeToolId(block.id),
        name: block.name,
        input: block.arguments,
      });
    }
  }
  return blocks.length > 0 ? { role: "assistant", content: blocks } : undefined;
}

function convertToolResult(message: ToolResultMessage): Json {
  const content =
    typeof message.content === "string" || !message.content.some((b) => b.type === "image")
      ? sanitizeText(contentText(message.content))
      : convertBlocks(message.content);
  return {
    type: "tool_result",
    tool_use_id: normalizeToolId(message.toolCallId),
    content,
    ...(message.isError ? { is_error: true } : {}),
  };
}

export function convertMessages(
  messages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[],
): Json[] {
  const out: Json[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "toolResult") {
      const results: Json[] = [];
      while (i < messages.length && messages[i]?.role === "toolResult") {
        results.push(convertToolResult(messages[i] as ToolResultMessage));
        i++;
      }
      i--;
      out.push({ role: "user", content: results });
      continue;
    }
    const converted = message.role === "user" ? convertUser(message) : convertAssistant(message);
    if (converted) out.push(converted);
  }
  return out;
}

function convertTools(tools: readonly ToolDecl[]): Json[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: { ...tool.parameters, type: "object" },
  }));
}

/** 在最后一条 user 消息的最后一个块上打断点；返回是否打上。 */
function markLastUser(messages: Json[], cacheControl: Json): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message["role"] !== "user") continue;
    const content = message["content"];
    if (typeof content === "string") {
      message["content"] = [{ type: "text", text: content, cache_control: cacheControl }];
      return true;
    }
    if (Array.isArray(content) && content.length > 0) {
      const last = content[content.length - 1] as Json;
      last["cache_control"] = cacheControl;
      return true;
    }
    return false;
  }
  return false;
}

const DEFAULT_EFFORT: Record<Exclude<ModelThinkingLevel, "off">, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

function applyThinking(
  body: Json,
  model: Model,
  compat: AnthropicMessagesCompat,
  level: ModelThinkingLevel,
  requestedMax: number | undefined,
  hasTools: boolean,
  betas: string[],
): string | undefined {
  if (!model.reasoning) return undefined;
  if (level === "off") {
    if (model.thinkingLevelMap?.off !== null) body["thinking"] = { type: "disabled" };
    return undefined;
  }
  if (compat.adaptiveThinking) {
    const mapped = mappedThinkingValue(model, level);
    const effort = typeof mapped === "string" ? mapped : DEFAULT_EFFORT[level];
    body["thinking"] = { type: "adaptive", display: "summarized" };
    body["output_config"] = { effort };
    return effort;
  }
  const plan = budgetedMaxTokens(model.maxTokens, requestedMax, thinkingBudget(model, level));
  body["max_tokens"] = plan.maxTokens;
  if (plan.budget < 1024) return undefined; // 回答上限太小，放弃思考
  body["thinking"] = { type: "enabled", budget_tokens: plan.budget, display: "summarized" };
  if (hasTools && compat.sendInterleavedThinkingBeta !== false)
    betas.push(INTERLEAVED_THINKING_BETA);
  return String(plan.budget);
}

export function buildAnthropicRequest(
  model: Model,
  context: TranscriptContext,
  options: StreamOptions,
): AnthropicRequest {
  const compat = detectAnthropicCompat(model);
  const normalized = normalizeContext(context, { model });
  const cacheCompat = resolvePromptCacheCompat(model, "anthropic-messages");
  const retention = effectiveRetention(resolveCacheRetention(options.cacheRetention), cacheCompat);
  // sendCacheControl:false（端点忽略 cache_control，如 DeepSeek）：不打断点
  const cacheControl = compat.sendCacheControl === false ? undefined : cacheControlFor(retention);
  const messages = convertMessages(normalized.messages);
  const level = clampThinkingLevel(model, options.thinkingLevel ?? "off");
  const betas: string[] = [];
  const body: Json = {
    model: model.id,
    max_tokens: options.maxTokens ?? model.maxTokens,
    stream: true,
  };
  const system: Json[] = normalized.systemSections.map((section) => ({
    type: "text",
    text: sanitizeText(section.text),
  }));
  const tools = convertTools(normalized.tools);

  let budget = cacheControl ? Math.max(0, compat.maxCacheBreakpoints) : 0;
  if (cacheControl && budget > 0 && markLastUser(messages, cacheControl)) budget--;
  const lastSystem = system[system.length - 1];
  if (cacheControl && budget > 0 && lastSystem) {
    lastSystem["cache_control"] = cacheControl;
    budget--;
  }
  const lastTool = tools[tools.length - 1];
  if (cacheControl && budget > 0 && lastTool && compat.supportsCacheControlOnTools) {
    lastTool["cache_control"] = cacheControl;
  }

  if (system.length > 0) body["system"] = system;
  body["messages"] = messages;
  if (tools.length > 0) body["tools"] = tools;
  if (tools.length > 0 && options.toolChoice === "none") body["tool_choice"] = { type: "none" };
  const providerLevel = applyThinking(
    body,
    model,
    compat,
    level,
    options.maxTokens,
    tools.length > 0,
    betas,
  );
  const thinkingOn = body["thinking"] !== undefined && level !== "off";
  if (
    options.temperature !== undefined &&
    (!thinkingOn || compat.supportsTemperatureWithThinking)
  ) {
    body["temperature"] = options.temperature;
  }
  if (model.samplingParams) Object.assign(body, model.samplingParams);
  enforceCacheTtlOrder(body);
  return { body, betas, thinkingLevel: level, providerThinkingLevel: providerLevel };
}
