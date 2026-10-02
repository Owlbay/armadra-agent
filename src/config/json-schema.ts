/**
 * config.json 的 JSON Schema（draft-07 子集），写到配置目录的 `config.schema.json` 给编辑器补全与校验
 * （docs/providers.md「配置目录」）。规则与 schema.ts 的 `validateConfig` 一一对应：未知字段在那里是
 * warning、这里是 `additionalProperties: false`；渠道引用（模型 `channels` 指向已定义的渠道）这类跨字段
 * 规则 JSON Schema 表达不了，只在 `validateConfig` 里查。一致性由 json-schema.test.ts 的正反例守住。
 * 顶层与各段的键（供应商内部除外）的 description / default 来自 key-docs.ts（`annotate`）；说明跟随界面
 * 语言（D21），`ama init` 按当前语言重写。
 */

import { WARMING_MODES } from "../ai/cache/types.js";
import { PERMISSION_MODES_STRICT_FIRST } from "../permissions/types.js";
import { msg } from "../i18n/index.js";
import { defaultFor, isDynamicDefault, keyDoc } from "./key-docs.js";
import { HOOK_TIMEOUT_MAX_MS, THINKING_LEVELS } from "./schema.js";
import {
  CACHE_RETENTIONS,
  CHANNEL_NAME_PATTERN,
  CHECKPOINT_MODES,
  SANDBOX_ENABLED_MODES,
  SANDBOX_NETWORK_MODES,
  CODEMODE_MODES,
  IMAGE_RESIZE_MODES,
  PLAN_BASH_MODES_STRICT_FIRST,
  PLAN_UNATTENDED_MODES,
  STATUS_LINE_MODES,
  TOOLS_PRESET_INPUTS,
  LANGUAGE_SETTINGS,
  AGENT_BAR_MODES,
  CHATGPT_FLAVORS,
  MEMORY_SCOPES,
  MEMORY_SUBAGENT_MODES,
} from "./types.js";
import { AGENT_ID_PATTERN } from "./schema-w5.js";
import { AGENTS_RESERVED_KEYS } from "./types-w5.js";

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
/** 供应商的 schema（说明按当前界面语言，每次生成时现取）。 */
function providerSchema(): Schema {
  const m = msg().config.jsonSchema;
  /** api 只查是字符串（与 validateConfig 一致），enum 给编辑器补全。 */
  const api: Schema = {
    type: "string",
    description: m.api,
    examples: KNOWN_APIS,
    anyOf: [{ enum: KNOWN_APIS }, { type: "string" }],
  };

  const compat: Schema = {
    type: "object",
    description: m.compat,
    properties: {
      sendPromptCacheKey: bool(),
      sendSessionAffinityHeaders: bool(),
      supportsLongCacheRetention: bool(),
      supportsExplicitPromptCacheMode: bool(),
      cacheReporting: oneOf(["auto", "silent", "reported"]),
    },
  };

  const model = (description: string): Schema => ({
    type: "object",
    description,
    required: ["id"],
    properties: {
      id: str(m.modelId),
      name: str(),
      api,
      baseUrl: str(m.modelBaseUrl),
      contextWindow: num(1, undefined, m.contextWindow),
      maxTokens: num(1, undefined, m.maxTokens),
      reasoning: bool(),
      input: {
        type: "array",
        items: { enum: ["text", "image"] },
        description: m.input,
      },
      channels: { ...strings, description: m.modelChannels },
      modelsDev: {
        description: m.modelsDev,
        anyOf: [{ type: "string", pattern: "^[^/]+/.+$" }, { const: false }],
      },
      headers: stringRecord,
      compat,
      promptCache: object({ short: num(), long: num(), minTokens: num() }),
      cost: { type: "object", description: "$/M token" },
      thinkingLevelMap: { type: "object" },
      samplingParams: { type: "object" },
    },
  });

  const channel: Schema = object(
    {
      api,
      baseUrl: str(m.baseUrl),
      apiKey: str(m.channelApiKey),
      authHeader: { type: "object" },
      headers: stringRecord,
      compat,
    },
    { required: ["api", "baseUrl"] },
  );

  return object({
    name: str(),
    api,
    baseUrl: str(),
    apiKey: str(m.apiKey),
    envKeys: strings,
    authHeader: { type: "object" },
    headers: stringRecord,
    compat,
    requiresApiKey: bool(),
    channels: {
      type: "object",
      description: m.channels,
      minProperties: 1,
      propertyNames: { pattern: CHANNEL_NAME_PATTERN.source },
      additionalProperties: channel,
    },
    defaultChannel: str(m.defaultChannel),
    models: { type: "array", items: model(m.models) },
    modelOverrides: { type: "array", items: model(m.modelOverrides) },
  });
}

// [W5-C0] 第五波的段（规则同 schema-w5.ts）
const agentEntry: Schema = object({
  maxConcurrent: num(1, 64),
  maxMode: oneOf(PERMISSION_MODES_STRICT_FIRST),
  model: str(),
  env: object({ passthrough: strings }),
});

function w5Sections(): Record<string, Schema> {
  return {
    images: object({ resize: oneOf(IMAGE_RESIZE_MODES) }),
    plan: object({
      bash: oneOf(PLAN_BASH_MODES_STRICT_FIRST),
      directory: str(),
      unattended: oneOf(PLAN_UNATTENDED_MODES),
      model: str(),
      thinkingLevel: oneOf(THINKING_LEVELS),
    }),
    agents: object(
      { maxConcurrent: num(1, 64), sessionBudgetUsd: num(0), dirs: strings },
      {
        additionalProperties: agentEntry,
        propertyNames: {
          pattern: `^(${AGENTS_RESERVED_KEYS.join("|")}|${AGENT_ID_PATTERN.source.slice(1, -1)})$`,
        },
      },
    ),
    subagents: object({ maxConcurrent: num(1, 64), maxPending: num(0, 1024), defaultModel: str() }),
    models: object({ aliases: object({ fast: str(), strong: str() }) }),
    fallbackModel: str(),
    limits: object({ maxTurns: num(1), maxCostUsd: num(0) }),
    reminders: object({
      todo: bool(),
      fileChanges: bool(),
      contextPressure: bool(),
      budget: bool(),
    }),
    todo: object({ reminder: num(0) }),
  };
}

// [W6-C0] 第六波的段（规则同 schema-w6.ts）
function w6Sections(): Record<string, Schema> {
  return {
    memory: object({
      enabled: bool(),
      scopes: { type: "array", items: { enum: [...MEMORY_SCOPES] } },
      indexMaxBytes: num(0, 1_048_576),
      fileMaxBytes: num(1, 1_048_576),
      maxFiles: num(1, 10_000),
      subagents: oneOf(MEMORY_SUBAGENT_MODES),
    }),
    auth: object({
      chatgpt: object({
        flavor: oneOf(CHATGPT_FLAVORS),
        clientId: str(),
        issuer: str(),
        originator: str(),
        redirectPorts: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 65535 },
        },
      }),
    }),
  };
}

/** 给顶层与各段的键写上 description 与 default（key-docs.ts）；供应商内部不动。 */
function annotate(properties: Record<string, Schema>, prefix = ""): void {
  for (const [key, shared] of Object.entries(properties)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    // 片段（strings、bool() 等）在多处复用：先浅拷贝再写说明
    const schema: Schema = { ...shared };
    properties[key] = schema;
    const description = keyDoc(path);
    if (description !== undefined) schema["description"] = description;
    const nested = schema["properties"] as Record<string, Schema> | undefined;
    if (nested !== undefined && path !== "providers") {
      annotate(nested, path);
      continue;
    }
    const value = defaultFor(path);
    if (value !== undefined && !isDynamicDefault(path)) schema["default"] = value;
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
      defaultModel: str(),
      thinkingLevel: oneOf(THINKING_LEVELS),
      providers: { type: "object", additionalProperties: providerSchema() },
      permission: object({
        mode: oneOf(PERMISSION_MODES_STRICT_FIRST),
        allow: strings,
        deny: strings,
        builtinDeny: { anyOf: [{ type: "boolean" }, strings] },
        autoModel: str(),
        autoSafeCommands: strings,
      }),
      compaction: object({
        enabled: bool(),
        reserveTokens: num(0),
        keepRecentTokens: num(0),
        prune: object({
          keepResults: num(0),
          clearAtLeast: { anyOf: [{ const: "auto" }, { type: "number", minimum: 0 }] },
        }),
        pruneExclude: strings,
      }),
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
        restoreOnCancel: bool(),
        statusLine: oneOf(STATUS_LINE_MODES),
        language: oneOf(LANGUAGE_SETTINGS),
        replyLanguage: str(),
        agentBar: oneOf(AGENT_BAR_MODES),
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
      checkpoints: object({
        mode: oneOf(CHECKPOINT_MODES),
        maxFileBytes: num(0),
        keep: num(1),
      }),
      sandbox: object({
        enabled: oneOf(SANDBOX_ENABLED_MODES),
        bash: oneOf(SANDBOX_ENABLED_MODES),
        network: oneOf(SANDBOX_NETWORK_MODES),
        writable: strings,
      }),
      ...w5Sections(),
      ...w6Sections(),
    }),
    required: ["version"],
  };
}

/** 写进文件的文本（2 空格缩进 + 换行结尾）。 */
export function configSchemaText(): string {
  return `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`;
}
