/**
 * config.json 的 JSON Schema（draft-07 子集），写到配置目录的 `config.schema.json` 给编辑器补全与校验
 * （docs/providers.md「配置目录」）。规则与 schema.ts 的 `validateConfig` 一一对应：未知字段在那里是
 * warning、这里是 `additionalProperties: false`；渠道引用（模型 `channels` 指向已定义的渠道）这类跨字段
 * 规则 JSON Schema 表达不了，只在 `validateConfig` 里查。一致性由 json-schema.test.ts 的正反例守住。
 * 顶层与各段的键（供应商内部除外）的 description / default 来自 key-docs.ts（`annotate`）。
 */

import { WARMING_MODES } from "../ai/cache/types.js";
import { PERMISSION_MODES_STRICT_FIRST } from "../permissions/types.js";
import { CONFIG_KEY_DOCS, DYNAMIC_DEFAULTS, defaultFor } from "./key-docs.js";
import { HOOK_TIMEOUT_MAX_MS, THINKING_LEVELS } from "./schema.js";
import {
  CACHE_RETENTIONS,
  CHANNEL_NAME_PATTERN,
  CODEMODE_MODES,
  TOOLS_PRESET_INPUTS,
} from "./types.js";

type Schema = Record<string, unknown>;

export const CONFIG_SCHEMA_FILE = "config.schema.json";
export const CONFIG_SCHEMA_ID = "https://github.com/Owlbay/armadra-agent/config.schema.json";

const KNOWN_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

function object(properties: Record<string, Schema>, extra: Schema = {}): Schema {
  return { type: "object", properties, additionalProperties: false, ...extra };
}

const str = (description?: string): Schema => ({
  type: "string",
  ...(description ? { description } : {}),
});
const bool = (description?: string): Schema => ({
  type: "boolean",
  ...(description ? { description } : {}),
});
const num = (minimum?: number, maximum?: number, description?: string): Schema => ({
  type: "number",
  ...(minimum !== undefined ? { minimum } : {}),
  ...(maximum !== undefined ? { maximum } : {}),
  ...(description ? { description } : {}),
});
const strings: Schema = { type: "array", items: { type: "string" } };
const stringRecord: Schema = { type: "object", additionalProperties: { type: "string" } };
const oneOf = (values: readonly string[], description?: string): Schema => ({
  type: "string",
  enum: [...values],
  ...(description ? { description } : {}),
});
/** api 只查是字符串（与 validateConfig 一致），enum 给编辑器补全。 */
const api: Schema = {
  type: "string",
  description: "协议",
  examples: KNOWN_APIS,
  anyOf: [{ enum: KNOWN_APIS }, { type: "string" }],
};

const compat: Schema = {
  type: "object",
  description: "协议兼容开关（docs/providers.md「compat」）",
  properties: {
    sendPromptCacheKey: bool(),
    sendSessionAffinityHeaders: bool(),
    supportsLongCacheRetention: bool(),
    supportsExplicitPromptCacheMode: bool(),
    cacheReporting: oneOf(["auto", "silent", "reported"]),
  },
};

function model(description: string): Schema {
  return {
    type: "object",
    description,
    required: ["id"],
    properties: {
      id: str("模型 id（发给上游的名字）"),
      name: str(),
      api,
      baseUrl: str("覆盖渠道 / 供应商的地址"),
      contextWindow: num(1, undefined, "上下文 token；缺省从 models.dev 补，匹配不到不猜"),
      maxTokens: num(1, undefined, "单次输出上限；缺省 min(models.dev, 64k) 或 8192"),
      reasoning: bool(),
      input: {
        type: "array",
        items: { enum: ["text", "image"] },
        description: '["text"] 或 ["text", "image"]（收图片）',
      },
      channels: { ...strings, description: "挂载的渠道，第一个是首选" },
      modelsDev: {
        description: 'models.dev 条目 "provider/model"；false 关闭补全',
        anyOf: [{ type: "string", pattern: "^[^/]+/.+$" }, { const: false }],
      },
      headers: stringRecord,
      compat,
      promptCache: object({ short: num(), long: num(), minTokens: num() }),
      cost: { type: "object", description: "$/M token" },
      thinkingLevelMap: { type: "object" },
      samplingParams: { type: "object" },
    },
  };
}

const channel: Schema = object(
  {
    api,
    baseUrl: str("接口地址"),
    apiKey: str("$ENV / ${ENV} / !command / 字面量；缺省用供应商的 key"),
    authHeader: { type: "object" },
    headers: stringRecord,
    compat,
  },
  { required: ["api", "baseUrl"] },
);

const provider: Schema = object({
  name: str(),
  api,
  baseUrl: str(),
  apiKey: str("$ENV / ${ENV} / !command / 字面量"),
  envKeys: strings,
  authHeader: { type: "object" },
  headers: stringRecord,
  compat,
  requiresApiKey: bool(),
  channels: {
    type: "object",
    description: "渠道：一个供应商下的多种接口",
    minProperties: 1,
    propertyNames: { pattern: CHANNEL_NAME_PATTERN.source },
    additionalProperties: channel,
  },
  defaultChannel: str("首选渠道；缺省 channels 的第一个"),
  models: { type: "array", items: model("自定义模型（同 id 整条替换）") },
  modelOverrides: { type: "array", items: model("只改已有模型的元数据") },
});

/** 给顶层与各段的键写上 description 与 default（key-docs.ts）；供应商内部不动。 */
function annotate(properties: Record<string, Schema>, prefix = ""): void {
  for (const [key, shared] of Object.entries(properties)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    // 片段（strings、bool() 等）在多处复用：先浅拷贝再写说明
    const schema: Schema = { ...shared };
    properties[key] = schema;
    const description = CONFIG_KEY_DOCS[path];
    if (description !== undefined) schema["description"] = description;
    const nested = schema["properties"] as Record<string, Schema> | undefined;
    if (nested !== undefined && path !== "providers") {
      annotate(nested, path);
      continue;
    }
    const value = defaultFor(path);
    if (value !== undefined && DYNAMIC_DEFAULTS[path] === undefined) schema["default"] = value;
  }
}

/** 生成 config.json 的 JSON Schema。 */
export function buildConfigJsonSchema(): Schema {
  const schema = buildBaseSchema();
  annotate(schema["properties"] as Record<string, Schema>);
  return schema;
}

function buildBaseSchema(): Schema {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: CONFIG_SCHEMA_ID,
    title: "ama config.json",
    ...object({
      $schema: str(),
      version: { const: 1 },
      defaultModel: str("provider/model 或 provider/model@channel"),
      thinkingLevel: oneOf(THINKING_LEVELS),
      providers: { type: "object", additionalProperties: provider },
      permission: object({
        mode: oneOf(PERMISSION_MODES_STRICT_FIRST),
        allow: strings,
        deny: strings,
        builtinDeny: { anyOf: [{ type: "boolean" }, strings] },
        autoModel: str("auto 模式分类器的模型 provider/model；缺省用当前会话模型"),
        autoSafeCommands: strings,
      }),
      compaction: object({ enabled: bool(), reserveTokens: num(0), keepRecentTokens: num(0) }),
      retry: object({
        enabled: bool(),
        maxRetries: num(0, 100),
        baseDelayMs: num(0),
        maxDelayMs: num(0),
      }),
      tools: object({
        preset: oneOf(TOOLS_PRESET_INPUTS),
        default: strings,
        maxToolResultChars: num(1),
        bashTimeoutMs: num(1),
        disabled: strings,
      }),
      codemode: object({
        mode: oneOf(CODEMODE_MODES),
        inlineBudget: num(0),
        requireStrict: bool(),
      }),
      hooks: object({ timeoutMs: num(1, HOOK_TIMEOUT_MAX_MS) }),
      ui: object({
        theme: oneOf(["dark", "light", "auto"]),
        markdown: bool(),
        showThinking: oneOf(["full", "collapsed", "hidden"]),
        tuiMode: oneOf(["regular"]),
        quietStartup: oneOf(["normal", "header", "silent"]),
        ascii: bool(),
        compact: bool(),
        animation: bool(),
      }),
      skills: object({ dirs: strings }),
      cache: object({
        warming: oneOf(WARMING_MODES),
        retention: oneOf(CACHE_RETENTIONS),
        minSavingsUsd: num(0),
        missNotices: bool(),
        warmSubagents: bool(),
      }),
      request: object({ idleTimeoutMs: num(0) }),
    }),
    required: ["version"],
  };
}

/** 写进文件的文本（2 空格缩进 + 换行结尾）。 */
export function configSchemaText(): string {
  return `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`;
}
