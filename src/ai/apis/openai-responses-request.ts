/**
 * openai-responses 请求体（设计 §3.1、§3.3、§3.6）：input items、instructions、工具、reasoning、
 * 缓存键、无状态回放。
 *
 * - 系统提示折叠后放 `instructions`（不进 input，前缀稳定利于缓存）；
 * - 助手消息拆成 items：思考块的 `thinkingSignature` 是完整的 reasoning item（JSON，含
 *   `encrypted_content`），只回放给同 provider / 同模型 / 同协议；文本块的 `textSignature` 记
 *   message item 的 id（与 phase），同模型时以带 id 的 message item 回放，否则退回
 *   `{role:"assistant", content}`；工具调用 `id` 是 `call_id`，`thoughtSignature` 记 function_call
 *   item 的 `fc_…` id（同模型才带回，跨模型由 transform.ts 去掉）；
 * - `supportsStore`：发 `store: false`，推理模型同时要 `include: ["reasoning.encrypted_content"]`
 *   （不落服务端也能多轮回放推理）；
 * - reasoning：`{effort, summary:"auto"}`（summary 需 `supportsReasoningSummary`）；off 只在映射表
 *   给了 off 的字串时发（例如 "none"），否则不发（服务端缺省）；
 * - 工具 `strict` 显式给出：Responses 缺省按严格模式校验 schema，非严格兼容的 schema 必须发 false；
 * - 缓存（第三波 §1.3）：`prompt_cache_key = sessionId` 只在 `sendPromptCacheKey`（官方端点缺省开）
 *   时发，`cacheRetention: "none"` 不发；`long` 在 `supportsExplicitPromptCacheMode` 时发
 *   `prompt_cache_options: {ttl:"30m"}`，否则在 `supportsLongCacheRetention` 时发
 *   `prompt_cache_retention: "24h"`，两者都不支持按 short。
 */

import { contentText, normalizeContext, sanitizeText } from "../context.js";
import { clampThinkingLevel, mappedThinkingValue } from "../thinking.js";
import type {
  AssistantMessage,
  ContentBlock,
  Model,
  ModelThinkingLevel,
  OpenAIResponsesCompat,
  ProviderCompat,
  ProviderData,
  StreamOptions,
  ToolDecl,
  ToolResultMessage,
  TranscriptContext,
  UserMessage,
} from "../types.js";
import { resolveCacheRetention, resolvePromptCacheCompat } from "./cache-params.js";
import { isStrictCompatible } from "./openai-request.js";

type Json = Record<string, unknown>;
type Conversation = UserMessage | AssistantMessage | ToolResultMessage;

export const RESPONSES_API = "openai-responses";

const RESPONSES_COMPAT_KEYS = [
  "supportsReasoningSummary",
  "supportsStore",
] as const satisfies readonly (keyof OpenAIResponsesCompat)[];

/** 缺省（未知的 Responses 兼容服务）：不要 summary、不发 store。 */
export const CONSERVATIVE_RESPONSES_COMPAT: Readonly<OpenAIResponsesCompat> = {
  supportsReasoningSummary: false,
  supportsStore: false,
};

/** 推断表：先 provider id，后 baseUrl 子串。 */
export const RESPONSES_INFERENCE_RULES: readonly {
  provider: string;
  baseUrl: string;
  patch: Partial<OpenAIResponsesCompat>;
}[] = [
  {
    provider: "openai",
    baseUrl: "api.openai.com",
    patch: { supportsReasoningSummary: true, supportsStore: true },
  },
  // xAI：store 与 encrypted_content 可用；未验证 reasoning summary，不发
  { provider: "xai", baseUrl: "api.x.ai", patch: { supportsStore: true } },
];

function pick(compat: ProviderCompat | undefined): Partial<OpenAIResponsesCompat> {
  const out: Record<string, unknown> = {};
  for (const key of RESPONSES_COMPAT_KEYS) {
    const value = compat?.[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<OpenAIResponsesCompat>;
}

/** compat：保守缺省 ← 推断表 ← provider.compat ← model.compat。 */
export function detectResponsesCompat(
  model: Model,
  provider?: ProviderData,
): OpenAIResponsesCompat {
  const providerId = provider?.id ?? model.provider;
  const baseUrl = (model.baseUrl ?? provider?.baseUrl ?? "").toLowerCase();
  const rule =
    RESPONSES_INFERENCE_RULES.find((r) => r.provider === providerId) ??
    RESPONSES_INFERENCE_RULES.find((r) => baseUrl.includes(r.baseUrl));
  return {
    ...CONSERVATIVE_RESPONSES_COMPAT,
    ...rule?.patch,
    ...pick(provider?.compat),
    ...pick(model.compat),
  };
}

// ---------------------------------------------------------------------------
// 签名：message item id 与 reasoning item
// ---------------------------------------------------------------------------

export interface MessageSignature {
  id: string;
  phase?: string;
}

export function encodeMessageSignature(id: string, phase?: string): string {
  return JSON.stringify(phase ? { v: 1, id, phase } : { v: 1, id });
}

export function parseMessageSignature(signature: string | undefined): MessageSignature | undefined {
  if (!signature?.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(signature) as Json;
    if (parsed["v"] !== 1 || typeof parsed["id"] !== "string") return undefined;
    return typeof parsed["phase"] === "string"
      ? { id: parsed["id"], phase: parsed["phase"] }
      : { id: parsed["id"] };
  } catch {
    return undefined;
  }
}

/** thinkingSignature → reasoning item（不是 reasoning item 的 JSON 返回 undefined）。 */
export function parseReasoningItem(signature: string | undefined): Json | undefined {
  if (!signature?.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(signature) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const item = parsed as Json;
    return item["type"] === "reasoning" && typeof item["id"] === "string" ? item : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// input items
// ---------------------------------------------------------------------------

function imagePart(block: Extract<ContentBlock, { type: "image" }>): Json {
  return {
    type: "input_image",
    detail: "auto",
    image_url: `data:${block.mimeType};base64,${block.data}`,
  };
}

function convertUser(message: UserMessage): Json | undefined {
  const blocks: ContentBlock[] =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  const content: Json[] = [];
  for (const block of blocks) {
    if (block.type === "image") content.push(imagePart(block));
    else if (block.text.length > 0) {
      content.push({ type: "input_text", text: sanitizeText(block.text) });
    }
  }
  return content.length > 0 ? { role: "user", content } : undefined;
}

function convertAssistant(model: Model, message: AssistantMessage): Json[] {
  const sameModel =
    message.provider === model.provider &&
    message.model === model.id &&
    message.api === RESPONSES_API;
  const items: Json[] = [];
  for (const block of message.content) {
    if (block.type === "thinking") {
      // 推理只能以 reasoning item 回放；没有可用 item 的（别家 / 中止）不发
      const item = sameModel ? parseReasoningItem(block.thinkingSignature) : undefined;
      if (item) items.push(item);
    } else if (block.type === "text") {
      const signature = sameModel ? parseMessageSignature(block.textSignature) : undefined;
      if (signature) {
        items.push({
          type: "message",
          role: "assistant",
          id: signature.id,
          status: "completed",
          content: [{ type: "output_text", text: sanitizeText(block.text), annotations: [] }],
          ...(signature.phase ? { phase: signature.phase } : {}),
        });
      } else if (block.text.trim().length > 0) {
        items.push({ role: "assistant", content: sanitizeText(block.text) });
      }
    } else {
      const itemId = block.thoughtSignature;
      items.push({
        type: "function_call",
        ...(sameModel && itemId?.startsWith("fc") ? { id: itemId } : {}),
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.arguments),
      });
    }
  }
  return items;
}

function convertToolResult(model: Model, message: ToolResultMessage): Json {
  const text = contentText(message.content);
  const images =
    typeof message.content === "string" || !model.input.includes("image")
      ? []
      : message.content.filter(
          (b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image",
        );
  let output: string | Json[];
  if (images.length === 0) {
    const hadImages = typeof message.content !== "string" && message.content.length > 0;
    output = sanitizeText(
      text.length > 0 ? text : hadImages ? "(see attached image)" : "(no output)",
    );
  } else {
    output = [
      ...(text.length > 0 ? [{ type: "input_text", text: sanitizeText(text) }] : []),
      ...images.map(imagePart),
    ];
  }
  return { type: "function_call_output", call_id: message.toolCallId, output };
}

export function convertResponsesInput(model: Model, messages: readonly Conversation[]): Json[] {
  const input: Json[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const converted = convertUser(message);
      if (converted) input.push(converted);
    } else if (message.role === "assistant") {
      input.push(...convertAssistant(model, message));
    } else {
      input.push(convertToolResult(model, message));
    }
  }
  return input;
}

function convertTools(tools: readonly ToolDecl[]): Json[] {
  return tools.map((tool) => {
    const parameters = { ...tool.parameters, type: "object" as const };
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters,
      strict: isStrictCompatible(parameters),
    };
  });
}

/** 写 reasoning；返回实际发出的 effort。 */
function applyReasoning(
  body: Json,
  model: Model,
  compat: OpenAIResponsesCompat,
  level: ModelThinkingLevel,
): string | undefined {
  if (!model.reasoning) return undefined;
  if (level === "off") {
    const off = model.thinkingLevelMap?.off;
    if (typeof off !== "string") return undefined;
    body["reasoning"] = { effort: off };
    return off;
  }
  const mapped = mappedThinkingValue(model, level);
  const effort = typeof mapped === "string" ? mapped : level;
  body["reasoning"] = compat.supportsReasoningSummary ? { effort, summary: "auto" } : { effort };
  return effort;
}

export interface ResponsesRequest {
  body: Json;
  compat: OpenAIResponsesCompat;
  thinkingLevel: ModelThinkingLevel;
  providerThinkingLevel: string | undefined;
}

export function buildResponsesRequest(
  model: Model,
  context: TranscriptContext,
  options: StreamOptions,
): ResponsesRequest {
  const compat = detectResponsesCompat(model);
  const normalized = normalizeContext(context, { model });
  const level = clampThinkingLevel(model, options.thinkingLevel ?? "off");
  const body: Json = { model: model.id, stream: true };
  if (normalized.systemPrompt.length > 0) {
    body["instructions"] = sanitizeText(normalized.systemPrompt);
  }
  body["input"] = convertResponsesInput(model, normalized.messages);
  body["max_output_tokens"] = options.maxTokens ?? model.maxTokens;
  if (compat.supportsStore) {
    body["store"] = false;
    if (model.reasoning) body["include"] = ["reasoning.encrypted_content"];
  }
  if (normalized.tools.length > 0) body["tools"] = convertTools(normalized.tools);
  if (options.temperature !== undefined) body["temperature"] = options.temperature;
  const cacheCompat = resolvePromptCacheCompat(model, RESPONSES_API);
  const retention = resolveCacheRetention(options.cacheRetention);
  if (options.sessionId && retention !== "none" && cacheCompat.sendPromptCacheKey) {
    body["prompt_cache_key"] = options.sessionId.slice(0, 64);
  }
  if (retention === "long" && cacheCompat.supportsExplicitPromptCacheMode) {
    body["prompt_cache_options"] = { ttl: "30m" };
  } else if (retention === "long" && cacheCompat.supportsLongCacheRetention) {
    body["prompt_cache_retention"] = "24h";
  }
  const providerLevel = applyReasoning(body, model, compat, level);
  if (model.samplingParams) Object.assign(body, model.samplingParams);
  return { body, compat, thinkingLevel: level, providerThinkingLevel: providerLevel };
}
