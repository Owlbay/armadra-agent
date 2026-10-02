/**
 * google-generative-ai 请求体（设计 §3.1、§3.3、§3.6）：contents 转换、thoughtSignature 回放、
 * 工具声明、thinkingConfig。
 *
 * - 角色：user / model；工具结果是 user 回合里的 `functionResponse` part，连续多条合进同一回合；
 * - thoughtSignature：只回放同 provider / 同模型、且是合法 base64 的签名（Gemini 要求 bytes）；
 *   签名可能挂在空文本 part 上，此时空 part 也要原样送回；跨模型的思考由 transform.ts 降级为文本；
 * - Gemini 3 起 functionCall / functionResponse 带 `id`，并支持把工具结果图片放进
 *   `functionResponse.parts`（`supportsFunctionResponseParts`）；更早的模型图片另起一个 user 回合；
 * - thinkingConfig：级别映射到字串（或模型属于 Gemini 3 族且映射缺省）→ 离散 `thinkingLevel`；
 *   映射到数字或其它模型 → `thinkingBudget`（不超过回答上限留白）；off → `thinkingBudget: 0`；
 * - 缓存：Gemini 的隐式缓存自动生效，请求里没有可设的字段；`cacheRetention` 不影响请求体；
 * - `toolChoice: "none"`（有工具时）→ `toolConfig.functionCallingConfig.mode: "NONE"`。
 */

import { contentText, normalizeContext, sanitizeText } from "../context.js";
import {
  DEFAULT_THINKING_BUDGETS,
  clampBudgetToAnswerRoom,
  clampThinkingLevel,
  discreteThinkingLevel,
} from "../thinking.js";
import type {
  AssistantMessage,
  ContentBlock,
  GoogleCompat,
  JsonSchema,
  Model,
  ModelThinkingLevel,
  ProviderCompat,
  ProviderData,
  StreamOptions,
  ToolDecl,
  ToolResultMessage,
  TranscriptContext,
  UserMessage,
} from "../types.js";

type Json = Record<string, unknown>;
type Conversation = UserMessage | AssistantMessage | ToolResultMessage;

export const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const GOOGLE_COMPAT_KEYS = [
  "supportsThoughtSignature",
  "supportsFunctionResponseParts",
] as const satisfies readonly (keyof GoogleCompat)[];

/** `gemini-3.1-pro-preview` → 3；不是 Gemini 版本号命名返回 undefined。 */
export function geminiMajorVersion(modelId: string): number | undefined {
  const match = /^(?:models\/)?gemini(?:-live)?-(\d+)/.exec(modelId.toLowerCase());
  return match?.[1] !== undefined ? Number.parseInt(match[1], 10) : undefined;
}

/** Gemini 3 起 functionCall / functionResponse 要带 id。 */
export function requiresToolCallId(modelId: string): boolean {
  return (geminiMajorVersion(modelId) ?? 0) >= 3;
}

/** 缺省按模型族推断离散级别：Gemini 3 Pro / Flash 及 `gemini-flash(-lite)-latest`。 */
export function usesDiscreteThinkingLevel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return /gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) || /^gemini-flash(?:-lite)?-latest$/.test(id);
}

function pick(compat: ProviderCompat | undefined): Partial<GoogleCompat> {
  const out: Record<string, unknown> = {};
  for (const key of GOOGLE_COMPAT_KEYS) {
    const value = compat?.[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<GoogleCompat>;
}

/**
 * compat：推断 ← provider.compat ← model.compat。原生协议的实现都认 thoughtSignature，缺省开；
 * 工具结果内嵌图片只有 Gemini 3 起支持，非 Gemini 命名的模型保守关。
 */
export function detectGoogleCompat(model: Model, provider?: ProviderData): GoogleCompat {
  const major = geminiMajorVersion(model.id);
  return {
    supportsThoughtSignature: true,
    supportsFunctionResponseParts: major !== undefined && major >= 3,
    ...pick(provider?.compat),
    ...pick(model.compat),
  };
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function validSignature(signature: string | undefined): signature is string {
  return (
    signature !== undefined &&
    signature.length > 0 &&
    signature.length % 4 === 0 &&
    BASE64.test(signature)
  );
}

function inlineData(block: Extract<ContentBlock, { type: "image" }>): Json {
  return { inlineData: { mimeType: block.mimeType, data: block.data } };
}

function convertUser(message: UserMessage): Json | undefined {
  if (typeof message.content === "string") {
    return message.content.length > 0
      ? { role: "user", parts: [{ text: sanitizeText(message.content) }] }
      : undefined;
  }
  const parts: Json[] = [];
  for (const block of message.content) {
    if (block.type === "image") parts.push(inlineData(block));
    else if (block.text.length > 0) parts.push({ text: sanitizeText(block.text) });
  }
  return parts.length > 0 ? { role: "user", parts } : undefined;
}

function convertAssistant(
  model: Model,
  message: AssistantMessage,
  compat: GoogleCompat,
): Json | undefined {
  const sameModel = message.provider === model.provider && message.model === model.id;
  const signatureOf = (value: string | undefined): string | undefined =>
    sameModel && compat.supportsThoughtSignature && validSignature(value) ? value : undefined;
  const parts: Json[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      const signature = signatureOf(block.textSignature);
      if (block.text.trim().length === 0 && !signature) continue;
      parts.push({
        text: sanitizeText(block.text),
        ...(signature ? { thoughtSignature: signature } : {}),
      });
    } else if (block.type === "thinking") {
      if (block.redacted) continue;
      const signature = signatureOf(block.thinkingSignature);
      if (sameModel) {
        if (block.thinking.trim().length === 0 && !signature) continue;
        parts.push({
          thought: true,
          text: sanitizeText(block.thinking),
          ...(signature ? { thoughtSignature: signature } : {}),
        });
      } else if (block.thinking.trim().length > 0) {
        parts.push({ text: sanitizeText(block.thinking) });
      }
    } else {
      const signature = signatureOf(block.thoughtSignature);
      parts.push({
        functionCall: {
          name: block.name,
          args: block.arguments,
          ...(requiresToolCallId(model.id) ? { id: block.id } : {}),
        },
        ...(signature ? { thoughtSignature: signature } : {}),
      });
    }
  }
  return parts.length > 0 ? { role: "model", parts } : undefined;
}

function convertToolResult(
  model: Model,
  message: ToolResultMessage,
  compat: GoogleCompat,
): { part: Json; extra: Json | undefined } {
  const text = contentText(message.content);
  const images =
    typeof message.content === "string" || !model.input.includes("image")
      ? []
      : message.content.filter(
          (b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image",
        );
  const value = sanitizeText(
    text.length > 0 ? text : images.length > 0 ? "(see attached image)" : "(no output)",
  );
  const nested = images.length > 0 && compat.supportsFunctionResponseParts;
  const part: Json = {
    functionResponse: {
      name: message.toolName,
      response: message.isError ? { error: value } : { output: value },
      ...(nested ? { parts: images.map(inlineData) } : {}),
      ...(requiresToolCallId(model.id) ? { id: message.toolCallId } : {}),
    },
  };
  const extra =
    images.length > 0 && !nested
      ? { role: "user", parts: [{ text: "Tool result images:" }, ...images.map(inlineData)] }
      : undefined;
  return { part, extra };
}

export function convertGoogleContents(
  model: Model,
  messages: readonly Conversation[],
  compat: GoogleCompat,
): Json[] {
  const contents: Json[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "toolResult") {
      const parts: Json[] = [];
      const extras: Json[] = [];
      while (messages[i]?.role === "toolResult") {
        const converted = convertToolResult(model, messages[i] as ToolResultMessage, compat);
        parts.push(converted.part);
        if (converted.extra) extras.push(converted.extra);
        i++;
      }
      i--;
      contents.push({ role: "user", parts }, ...extras);
      continue;
    }
    const converted =
      message.role === "user" ? convertUser(message) : convertAssistant(model, message, compat);
    if (converted) contents.push(converted);
  }
  return contents;
}

/** Gemini 的 schema 是 OpenAPI 子集：去掉它不认的 `additionalProperties`。 */
export function toGoogleSchema(schema: JsonSchema): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties") continue;
    if (key === "properties" && value && typeof value === "object") {
      const props: Json = {};
      for (const [name, sub] of Object.entries(value as Record<string, JsonSchema>)) {
        props[name] = toGoogleSchema(sub);
      }
      out[key] = props;
    } else if (key === "items" && value && typeof value === "object") {
      out[key] = toGoogleSchema(value as JsonSchema);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function convertTools(tools: readonly ToolDecl[]): Json[] {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: toGoogleSchema({ ...tool.parameters, type: "object" }),
      })),
    },
  ];
}

/** 写 thinkingConfig；返回实际发出的值（离散级别名或预算）。 */
function applyThinking(
  config: Json,
  model: Model,
  level: ModelThinkingLevel,
  maxTokens: number,
): string | undefined {
  if (!model.reasoning) return undefined;
  if (level === "off") {
    const off = model.thinkingLevelMap?.off;
    const discrete = typeof off === "string" ? off.toUpperCase() : undefined;
    config["thinkingConfig"] = discrete ? { thinkingLevel: discrete } : { thinkingBudget: 0 };
    return discrete ?? "0";
  }
  const mapped = model.thinkingLevelMap?.[level];
  const discrete =
    typeof mapped === "string" || (mapped === undefined && usesDiscreteThinkingLevel(model.id))
      ? discreteThinkingLevel(model, level)
      : undefined;
  if (discrete) {
    const value = discrete.toUpperCase();
    config["thinkingConfig"] = { includeThoughts: true, thinkingLevel: value };
    return value;
  }
  const requested = typeof mapped === "number" ? mapped : DEFAULT_THINKING_BUDGETS[level];
  // -1 = 动态预算（Gemini 自行决定），不参与留白钳位
  const budget = requested < 0 ? -1 : clampBudgetToAnswerRoom(requested, maxTokens);
  config["thinkingConfig"] = { includeThoughts: true, thinkingBudget: budget };
  return String(budget);
}

export interface GoogleRequest {
  body: Json;
  compat: GoogleCompat;
  thinkingLevel: ModelThinkingLevel;
  providerThinkingLevel: string | undefined;
}

export function buildGoogleRequest(
  model: Model,
  context: TranscriptContext,
  options: StreamOptions,
): GoogleRequest {
  const compat = detectGoogleCompat(model);
  const normalized = normalizeContext(context, { model });
  const maxTokens = options.maxTokens ?? model.maxTokens;
  const level = clampThinkingLevel(model, options.thinkingLevel ?? "off");
  const body: Json = { contents: convertGoogleContents(model, normalized.messages, compat) };
  if (normalized.systemPrompt.length > 0) {
    body["systemInstruction"] = { parts: [{ text: sanitizeText(normalized.systemPrompt) }] };
  }
  if (normalized.tools.length > 0) {
    body["tools"] = convertTools(normalized.tools);
    if (options.toolChoice === "none") {
      body["toolConfig"] = { functionCallingConfig: { mode: "NONE" } };
    }
  }
  const config: Json = { maxOutputTokens: maxTokens };
  if (options.temperature !== undefined) config["temperature"] = options.temperature;
  const providerLevel = applyThinking(config, model, level, maxTokens);
  if (model.samplingParams) Object.assign(config, model.samplingParams);
  body["generationConfig"] = config;
  return { body, compat, thinkingLevel: level, providerThinkingLevel: providerLevel };
}
