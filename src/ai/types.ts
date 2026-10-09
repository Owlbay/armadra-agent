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
 * - [W3-C0] 第三波 §1.3 的五个缓存兼容开关单列为 `PromptCacheCompat`（各协议共用），只并入
 *   `ProviderCompat`（全部可选），不改各协议 compat 接口——`detectCompat` 的返回形状不变，
 *   缺省值由 C1a 在协议层按端点推断。
 * - [W5-C0] 第五波（docs/wave5-plan.md §2.1、§3.1）：`Model` 加 models.dev 元数据字段
 *   （`family / knowledge / releaseDate / inputLimit / status`）；`AnthropicMessagesCompat` 加
 *   `sendInterleavedThinkingBeta / sendCacheControl`、`OpenAIResponsesCompat` 加
 *   `explicitCacheField`，全部可选（缺省由 W5-M2 的主机推断表给出）；`ProviderData.channels /
 *   defaultChannel` 已有，内置供应商（`BuiltinProvider`）同样可带。
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

/**
 * [W3-C0] 一次请求的用途（第三波 §1.2）：会话层按用途分开记录请求链——`turn` 是循环里的
 * 真实回合，`summary` 是压缩 / 分支摘要，`warm` 是缓存保温重放，`probe` 是 `models check` /
 * `cache-probe` 一类的探测。缺省视为 `turn`。协议层只透传，不改变请求体。
 */
/** `classify`：auto 权限模式的分类请求（独立请求，不经会话层缓存观测、不触发保温）。 */
export type RequestPurpose = "turn" | "summary" | "warm" | "probe" | "classify";

/** `provider/model-id` 拆开后的引用。 */
export interface ModelRef {
  provider: string;
  id: string;
  /** 所选渠道（多渠道供应商；单渠道 / 隐式渠道不填）。 */
  channel?: string;
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
// 内容块与消息（会话 `message` 字段名见 §8 / D9）
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
  /** 模型输出的原始 arguments 字符串（严格 JSON 可解析时才有）；同协议回放时原样发回。 */
  rawArguments?: string;
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
  /**
   * [W3-C0] 原始响应里**出现过**任何缓存字段（即使值为 0）为 true；字段缺失为 false；
   * 协议尚未解析该标记时缺省（第三波 §1.6，「值为 0」与「不报」由此区分）。
   */
  cacheReported?: boolean;
  /** [W6-C0] 订阅计费（ChatGPT 登录，W6-O）：`cost` 为 0，统计单列「订阅」不折算美元。 */
  billing?: "subscription";
}

/** `refusal`：供应商以安全理由拒答（目前只有 Anthropic 的 `stop_reason: "refusal"` 会映射到它）。 */
export type StopReason = "stop" | "length" | "toolUse" | "aborted" | "error" | "refusal";

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

/** `interrupt`：打断当前回合并立即发送（`prompt / steer` 的 `interrupt: true`）开的新回合。 */
export type KnownMessageOrigin = "steer" | "followUp" | "host" | "interrupt";
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
  /** 失败响应的 Retry-After（毫秒）；会话层退避取 max(退避, 它)。可选字段，落盘与 RPC 原样透传。 */
  retryAfterMs?: number;
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
  /**
   * [W5-C0] 发 `interleaved-thinking` beta 头；缺省（W5-M2 主机表）：官方端点 true、其它主机 false。
   */
  sendInterleavedThinkingBeta?: boolean;
  /** [W5-C0] 打 `cache_control`；缺省 true，忽略它的端点（DeepSeek 等）可关以减小请求体。 */
  sendCacheControl?: boolean;
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
  /** [W5-C0] 端点私有的显式缓存字段：`volcengine` = 火山方舟 `caching: { type: "enabled" }`。 */
  explicitCacheField?: "volcengine";
  /** [W6-C0] ChatGPT 订阅后端（W6-O）：决定请求体白名单、请求头与配额解析。 */
  chatgptBackend?: "siwc" | "codex";
  /** [W6-C0] 系统提示的放法：native（`instructions`）/ developer-message（codex flavor 400 回退）。 */
  instructionsMode?: "native" | "developer-message";
  /** [W6-C0] 工具放进 namespace（SIWC 待实测）。 */
  toolsInNamespace?: boolean;
}

/**
 * [W3-C0] 供应商不报缓存时的处理（第三波 §1.6）：`auto` 按响应自动判定三态；`silent` /
 * `reported` 强制（`ama models cache-probe` 给出建议写法）。
 */
export type CacheReportingSetting = "auto" | "silent" | "reported";

/**
 * [W3-C0] 缓存相关的兼容开关（第三波 §1.3），各协议共用；这里是解析后的完整形状，
 * `ProviderCompat` 里全部可选。缺省值由协议层按端点推断（官方端点开、自定义供应商关）。
 */
export interface PromptCacheCompat {
  /** 发 `prompt_cache_key`（OpenAI 系）；官方端点缺省 true，其余缺省 false。 */
  sendPromptCacheKey: boolean;
  /** 发 `x-session-affinity` / `x-client-request-id`（OpenRouter 为 `x-session-id`）亲和头。 */
  sendSessionAffinityHeaders: boolean;
  /** `cacheRetention: "long"` 可用（Anthropic 1h、OpenAI 24h）；不支持时降为 short。 */
  supportsLongCacheRetention: boolean;
  /** Responses 的 `prompt_cache_options`（30m 显式缓存）。 */
  supportsExplicitPromptCacheMode: boolean;
  cacheReporting: CacheReportingSetting;
}

export type ProviderCompat = Partial<
  OpenAICompletionsCompat &
    AnthropicMessagesCompat &
    GoogleCompat &
    OpenAIResponsesCompat &
    PromptCacheCompat
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

/** 模型目录 `promptCache`：只写有公开依据的值，留空 = 不承诺（不保温、归因用启发值）。 */
export interface ModelPromptCache {
  /** `short` 档 TTL（秒）。 */
  short?: number;
  /** `long` 档 TTL（秒）。 */
  long?: number;
  /** [W3-C0] 最小可缓存长度（token）；未命中检测的噪声下限取 max(1024, minTokens)。 */
  minTokens?: number;
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
  /** 各档缓存的 TTL（秒）与最小可缓存长度（第三波 §1.4）。 */
  promptCache?: ModelPromptCache;
  headers?: Record<string, string>;
  samplingParams?: Record<string, unknown>;
  compat?: ProviderCompat;
  /**
   * [B1 追加] 鉴权头形状；registry 从 `ProviderData.authHeader` 填入。缺省按协议
   * （anthropic-messages → x-api-key，其余 → Authorization: Bearer）。
   */
  authHeader?: AuthHeader;
  /**
   * [B1 追加] false = 无 key 也能调用（本地服务）；registry 从 `ProviderData.requiresApiKey`
   * 填入。缺省视为 true：流函数缺 key 时同步抛 `AmaError{code:"no_api_key"}`。
   */
  requiresApiKey?: boolean;
  /** 所选渠道名（registry 物化时填入；隐式 `default` 渠道不填）。 */
  channel?: string;
  /**
   * 渠道是引用里显式写的 `@渠道`（`findModel("p/m@c")` 填 true）。ChatGPT 订阅供应商据此区分：没写的渠道在
   * 请求时跟随当前登录方式，写了的不跟随（不符时报 `chatgpt_flavor_mismatch`）。
   */
  channelPinned?: boolean;
  /** 该模型挂载的全部渠道，首个为首选（多渠道供应商才有）。 */
  channels?: string[];
  // [W5-C0] models.dev 元数据（docs/wave5-plan.md §2.1；快照与目录物化时填入，缺省 = 未知）
  /** 模型家族（如 `claude-sonnet`）。 */
  family?: string;
  /** 知识截止（`YYYY-MM` 或 `YYYY-MM-DD`）。 */
  knowledge?: string;
  /** 发布日期（`YYYY-MM-DD`）。 */
  releaseDate?: string;
  /** 输入上限（token），与 `contextWindow` 不同的模型才有。 */
  inputLimit?: number;
  /** 发布状态；正式版不填（deprecated 的模型在快照里已过滤）。 */
  status?: "beta";
}

/** 物化后的渠道（docs/providers.md「渠道」）；key 不在这里，经 `resolveApiKey(provider, channel)` 取。 */
export interface ProviderChannel {
  name: string;
  api: Api;
  baseUrl: string;
  authHeader?: AuthHeader;
  headers?: Record<string, string>;
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
  /**
   * 渠道（没有 `channels` 的供应商不填，按单渠道处理）。[W5-C0] 内置供应商也可带内置渠道，
   * 用户配置同名字段级覆盖、新名追加（物化归 W5-M2）。
   */
  channels?: ProviderChannel[];
  /** 首选渠道名（有 `channels` 时；用户配置优先）。 */
  defaultChannel?: string;
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
  /**
   * 等响应头的空闲超时（毫秒）。缺省 300 000，0 关闭。超时报 `idle timeout` 错误，会话层按可重试处理。
   */
  idleTimeoutMs?: number;
  /**
   * [ME-C] 流开始后两块数据之间的最长间隔（毫秒，每收到字节即重新计时）。缺省 180 000，0 关闭。
   */
  streamIdleTimeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  thinkingLevel?: ModelThinkingLevel;
  cacheRetention?: CacheRetention;
  sessionId?: string;
  /** [W3-C0] 请求用途（第三波 §1.2）；缺省 `turn`。协议层只透传给观测方，不进请求体。 */
  purpose?: RequestPurpose;
  /**
   * [W3-C0] `"none"`：本次请求带工具表但禁止调用（压缩摘要走会话前缀续写，第三波 §1.8）。
   * 映射：Anthropic `tool_choice:{type:"none"}`、Completions / Responses `tool_choice:"none"`、
   * Google `toolConfig.functionCallingConfig.mode:"NONE"`。缺省不发。
   */
  toolChoice?: "none";
  /** 观测 / 替换请求体：返回非 undefined 即替换。 */
  onPayload?(payload: unknown): unknown;
  onResponse?(status: number, headers: Headers): void;
  /**
   * [W6-O] 订阅配额更新（ChatGPT 后端的响应头 / `codex.rate_limits` / 429）；会话层转成 `quota_update` 事件。
   * 窗口时间为 epoch 毫秒，usedPercent 0–100。
   */
  onQuota?(update: {
    planType?: string;
    primary?: { usedPercent: number; resetsAt?: number; windowMinutes?: number };
    secondary?: { usedPercent: number; resetsAt?: number; windowMinutes?: number };
  }): void;
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

/** [W6-C0] `oauth`：auth.json 的 OAuth 条目（W6-O）。 */
export type KeySource = "cli" | "auth-file" | "config" | "env" | "oauth" | "none";

/** 密钥只存在于 `apiKey` 字段，不进日志、会话、事件。 */
export interface ApiKeyResolution {
  apiKey: string | undefined;
  source: KeySource;
  /** source 为 env 时的变量名；auth-file 时的文件路径。 */
  origin?: string;
}

export type ModelLookup =
  | { ok: true; model: Model; provider: ProviderData }
  | {
      ok: false;
      /** `channel_not_found`：模型在，`@渠道` 不在（候选是该模型可用的 `provider/model@渠道`）。 */
      reason: "not_found" | "ambiguous" | "provider_not_found" | "channel_not_found";
      candidates: string[];
    };

export interface ProviderRegistryApi {
  list(): readonly ProviderData[];
  get(providerId: string): ProviderData | undefined;
  /** 解析 `provider/model-id` 或无斜杠的模型 id（§3.4）。 */
  findModel(ref: string): ModelLookup;
  /** `channel`：渠道自己配了 key 时用渠道的，否则用供应商的。 */
  resolveApiKey(providerId: string, channel?: string): Promise<ApiKeyResolution>;
  getApi(api: Api): ApiImplementation | undefined;
}
