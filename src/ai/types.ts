/**
 * 模型接入层契约（设计 §3.1–§3.2、§3.5、§3.6）。[B0] 契约文件，实现归 B1 / B8。
 *
 * 补全与偏差（相对设计正文）：
 * - 内容块（TextBlock / ThinkingBlock / ImageBlock / ToolCallBlock）、`Usage`、`StopReason`、
 *   LLM 消息（`Message`）定义在这里而不是 agent/types.ts：依赖方向是 agent → ai，协议层
 *   必须能拿到这些类型。agent/types.ts 原样再导出它们。
 * - `JsonSchema`（工具参数子集）也定义在这里，因为 `ToolDecl` 要发给供应商；
 *   tools/types.ts 与 agent/schema.ts 再导出。
 * - `TranscriptContext` = 循环交给协议的原始转录（含 `system` 节补丁消息）；协议实现先调
 *   `normalizeContext()`（ai/context.ts，B1）得到 `NormalizedContext` 再拼请求体。
 * - `GoogleCompat` / `OpenAIResponsesCompat` 只列出已知字段，B8 按需追加（走契约变更流程）。
 * - `ProviderRegistryApi` / `ApiKeyResolution` 是 Runtime（cli/runtime.ts）需要的最小接口，
 *   B1 的 `ProviderRegistry` 类实现它。
 */

// ---------------------------------------------------------------------------
// 协议 id、思考级别
// ---------------------------------------------------------------------------

export type KnownApi =
  "anthropic-messages" | "openai-completions" | "openai-responses" | "google-generative-ai";
export type Api = KnownApi | (string & {});

export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
/** 除 off 以外的级别。 */
export type ThinkingLevel = Exclude<ModelThinkingLevel, "off">;
export type CacheRetention = "none" | "short" | "long";

/** `provider/model-id` 拆开后的引用。 */
export interface ModelRef {
  provider: string;
  id: string;
}

// ---------------------------------------------------------------------------
// JSON Schema 子集（工具参数，§5.1）
// ---------------------------------------------------------------------------

export type JsonSchemaType = "object" | "string" | "number" | "integer" | "boolean" | "array";
export type JsonPrimitive = string | number | boolean | null;

/**
 * 支持的关键字：type / properties / required / items / enum / description /
 * additionalProperties（只接受布尔）/ default / title。其它关键字不在子集内，
 * `checkSchemaSubset()`（agent/schema.ts）会报出来。
 */
export interface JsonSchema {
  type?: JsonSchemaType;
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly JsonPrimitive[];
  default?: unknown;
}

// ---------------------------------------------------------------------------
// 内容块与消息（会话 `message` 字段名与 Pi v3 一致，§8 / D9）
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: "text";
  text: string;
  /** 供应商给的文本签名（原样回放）。 */
  textSignature?: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /** Anthropic signature 等；跨模型回放时由 transform.ts 降级为文本。 */
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ImageBlock {
  type: "image";
  /** base64，不含 data: 前缀。 */
  data: string;
  mimeType: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  /** `toolcall_end` 时保证是合法对象（§3.1 流契约）。 */
  arguments: Record<string, unknown>;
  /** Google thoughtSignature 等。 */
  thoughtSignature?: string;
}

/** 用户消息与工具结果可携带的块。 */
export type ContentBlock = TextBlock | ImageBlock;
/** 助手消息的块。 */
export type AssistantContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** `input` 不含缓存部分（§3.6）。 */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 1 小时缓存写入（按 2× 计价），已包含在 cacheWrite 中。 */
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  /** 由 ai/cost.ts 写回；模型无 cost 时缺省。 */
  cost?: UsageCost;
}

export type StopReason = "stop" | "length" | "toolUse" | "aborted" | "error";

/** 工具声明（发给供应商的形状）。 */
export interface ToolDecl {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/**
 * 系统提示与工具表作为 `system` 消息落盘：首条给全量 `sections`，之后是补丁
 * （节名级替换，`null` 删除；`toolsAdded` / `toolsRemoved` 为工具表差异）。
 */
export interface SystemMessage {
  role: "system";
  sections: Record<string, string | null>;
  toolsAdded?: ToolDecl[];
  toolsRemoved?: string[];
  timestamp: number;
}

export type KnownMessageOrigin = "steer" | "followUp" | "host";
export type MessageOrigin = KnownMessageOrigin | (string & {});

export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
  /** 无 = 普通用户输入；宿主 `sendUser(text, origin)` 的 origin 原样记录。 */
  origin?: MessageOrigin;
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  api: Api;
  provider: string;
  model: string;
  responseId?: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  /** 用户面级别（钳位后）。 */
  thinkingLevel?: ModelThinkingLevel;
  /** 实际发给供应商的值（effort 字串或预算）。 */
  providerThinkingLevel?: string;
  /** 供应商原始 finish / stop reason。 */
  rawStopReason?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: string | ContentBlock[];
  isError: boolean;
  /** 落盘，不进上下文。 */
  details?: unknown;
  timestamp: number;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

/** 循环交给协议的转录（未折叠的 system 补丁也在其中）。 */
export interface TranscriptContext {
  readonly messages: readonly Message[];
}

/** normalizeContext() 的输出：system 已折叠为一段文本，工具表已重装，模态已过滤。 */
export interface NormalizedContext {
  systemPrompt: string;
  /** 节名 → 文本（按装配顺序），供 Anthropic 打缓存断点。 */
  systemSections: readonly { name: string; text: string }[];
  tools: ToolDecl[];
  messages: (UserMessage | AssistantMessage | ToolResultMessage)[];
}

// ---------------------------------------------------------------------------
// compat（§3.3）
// ---------------------------------------------------------------------------

export type OpenAIThinkingFormat = "openai" | "openrouter" | "deepseek" | "zai" | "qwen" | "none";

export interface OpenAICompletionsCompat {
  maxTokensField: "max_tokens" | "max_completion_tokens";
  supportsDeveloperRole: boolean;
  supportsUsageInStreaming: boolean;
  supportsFinishReason: boolean;
  supportsReasoningEffort: boolean;
  thinkingFormat: OpenAIThinkingFormat;
  /** 预算型思考的字段名（qwen: thinking_budget）；无则不发预算。 */
  thinkingTokenBudgetField?: string;
  requiresReasoningContentOnAssistantMessages: boolean;
  requiresToolResultName: boolean;
  requiresAssistantAfterToolResult: boolean;
  supportsMidConvoSystemMessages: boolean;
  /** `anthropic`：OpenRouter 上的 anthropic/* 模型在消息块上打 cache_control。 */
  cacheControlFormat: "none" | "anthropic";
  supportsStrictTools: boolean;
  supportsStore: boolean;
}

export interface AnthropicMessagesCompat {
  supportsCacheControlOnTools: boolean;
  supportsTemperatureWithThinking: boolean;
  /** true：新模型用 `effort` 参数；false：老模型用 `budget_tokens`。 */
  adaptiveThinking: boolean;
  maxCacheBreakpoints: number;
}

/** B8 补全。 */
export interface GoogleCompat {
  supportsThoughtSignature: boolean;
  supportsFunctionResponseParts: boolean;
}

/** B8 补全。 */
export interface OpenAIResponsesCompat {
  supportsReasoningSummary: boolean;
  supportsStore: boolean;
}

export type ProviderCompat = Partial<
  OpenAICompletionsCompat & AnthropicMessagesCompat & GoogleCompat & OpenAIResponsesCompat
>;

// ---------------------------------------------------------------------------
// 供应商与模型（§3.2）
// ---------------------------------------------------------------------------

export type AuthHeader =
  "authorization-bearer" | "x-api-key" | "x-goog-api-key" | { header: string; prefix?: string };

export interface CostTier {
  /** 当 input + cacheRead + cacheWrite 超过该值时使用本档价格。 */
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 单位：美元 / 百万 token。 */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: CostTier[];
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  api: Api;
  /** 覆盖供应商 baseUrl。 */
  baseUrl?: string;
  input: ("text" | "image")[];
  reasoning: boolean;
  /** null = 该级别不支持。 */
  thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | number | null>>;
  /** 缺省 → 关自动压缩并警告。 */
  contextWindow?: number;
  maxTokens: number;
  cost?: ModelCost;
  /** 各档缓存的 TTL（秒）。 */
  promptCache?: { short?: number; long?: number };
  headers?: Record<string, string>;
  samplingParams?: Record<string, unknown>;
  compat?: ProviderCompat;
}

export interface ProviderData {
  id: string;
  name: string;
  api: Api;
  baseUrl: string;
  /** API Key 环境变量候选，顺序即优先级；首项是各家标准名。 */
  envKeys: string[];
  authHeader?: AuthHeader;
  headers?: Record<string, string>;
  compat?: ProviderCompat;
  models: Model[];
  /** 本地服务 false：无 key 也能用。 */
  requiresApiKey: boolean;
  builtin: boolean;
}

/** `catalog/*.json` 文件形状（§3.4）。 */
export interface ModelCatalogFile {
  version: 1;
  provider: string;
  models: Omit<Model, "provider" | "api">[];
}

// ---------------------------------------------------------------------------
// 流（§3.1）
// ---------------------------------------------------------------------------

export interface StreamOptions {
  signal: AbortSignal;
  apiKey?: string;
  /** 值为 null 表示删除该头。 */
  headers?: Record<string, string | null>;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  thinkingLevel?: ModelThinkingLevel;
  cacheRetention?: CacheRetention;
  sessionId?: string;
  /** 观测 / 替换请求体：返回非 undefined 即替换。 */
  onPayload?(payload: unknown): unknown;
  onResponse?(status: number, headers: Headers): void;
}

export type AssistantEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start" | "text_end"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_start" | "thinking_end"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | {
      type: "toolcall_start";
      contentIndex: number;
      id: string;
      name: string;
      partial: AssistantMessage;
    }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: ToolCallBlock;
      partial: AssistantMessage;
    }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; message: AssistantMessage };

export type AssistantEventType = AssistantEvent["type"];

/**
 * 流契约：成功后先 `start`；块事件配对；恰好一个终止事件（done / error）；
 * 流函数不抛错（缺 key 例外：同步抛 AmaError{code:"no_api_key"}）。
 * `result()` 在终止事件后 resolve 为最终消息（error 时也 resolve，不 reject）。
 */
export interface AssistantEventStream extends AsyncIterable<AssistantEvent> {
  result(): Promise<AssistantMessage>;
}

export interface ApiImplementation<C = unknown> {
  readonly id: Api;
  stream(model: Model, context: TranscriptContext, options: StreamOptions): AssistantEventStream;
  /** 推断缺省 compat。 */
  detectCompat?(model: Model, provider: ProviderData): C;
}

// ---------------------------------------------------------------------------
// 密钥与注册表（§3.5；Runtime 需要的最小接口）
// ---------------------------------------------------------------------------

export type KeySource = "cli" | "auth-file" | "config" | "env" | "none";

/** 密钥只存在于 `apiKey` 字段，不进日志、会话、事件。 */
export interface ApiKeyResolution {
  apiKey: string | undefined;
  source: KeySource;
  /** source 为 env 时的变量名；auth-file 时的文件路径。 */
  origin?: string;
}

export type ModelLookup =
  | { ok: true; model: Model; provider: ProviderData }
  | { ok: false; reason: "not_found" | "ambiguous" | "provider_not_found"; candidates: string[] };

export interface ProviderRegistryApi {
  list(): readonly ProviderData[];
  get(providerId: string): ProviderData | undefined;
  /** 解析 `provider/model-id` 或无斜杠的模型 id（§3.4）。 */
  findModel(ref: string): ModelLookup;
  resolveApiKey(providerId: string): Promise<ApiKeyResolution>;
  getApi(api: Api): ApiImplementation | undefined;
}
