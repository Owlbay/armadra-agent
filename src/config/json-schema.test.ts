import { describe, expect, it } from "vitest";
import { buildConfigJsonSchema, configSchemaText } from "./json-schema.js";
import {
  CONFIG_KEY_DOCS,
  DISPLAY_DEFAULTS,
  DYNAMIC_DEFAULTS,
  defaultFor,
  documentedLeaves,
} from "./key-docs.js";
import { DEFAULT_CONFIG } from "./merge.js";
import { DEFAULT_CACHE_CONFIG } from "./types.js";
import { validateConfig } from "./schema.js";

type Schema = Record<string, unknown>;

/** 测试用的 draft-07 子集校验器（只覆盖 buildConfigJsonSchema 用到的关键字）。 */
function valid(schema: Schema, value: unknown): boolean {
  if ("const" in schema && JSON.stringify(schema["const"]) !== JSON.stringify(value)) return false;
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) return false;
  if (Array.isArray(schema["anyOf"]) && !(schema["anyOf"] as Schema[]).some((s) => valid(s, value)))
    return false;
  const type = schema["type"];
  if (type !== undefined) {
    const actual = Array.isArray(value)
      ? "array"
      : value === null
        ? "null"
        : typeof value === "object"
          ? "object"
          : typeof value;
    if (type === "integer" ? !Number.isInteger(value) : actual !== type) return false;
  }
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) return false;
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) return false;
  }
  if (typeof value === "string" && typeof schema["pattern"] === "string")
    if (!new RegExp(schema["pattern"]).test(value)) return false;
  if (Array.isArray(value) && schema["items"] !== undefined)
    if (!value.every((item) => valid(schema["items"] as Schema, item))) return false;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema["properties"] ?? {}) as Record<string, Schema>;
    for (const key of (schema["required"] ?? []) as string[]) if (!(key in obj)) return false;
    if (
      typeof schema["minProperties"] === "number" &&
      Object.keys(obj).length < schema["minProperties"]
    )
      return false;
    for (const [key, child] of Object.entries(obj)) {
      if (schema["propertyNames"] !== undefined && !valid(schema["propertyNames"] as Schema, key))
        return false;
      if (props[key] !== undefined) {
        if (!valid(props[key], child)) return false;
      } else if (schema["additionalProperties"] === false) return false;
      else if (typeof schema["additionalProperties"] === "object")
        if (!valid(schema["additionalProperties"] as Schema, child)) return false;
    }
  }
  return true;
}

const SCHEMA = buildConfigJsonSchema();

/** 两边都应接受。 */
const GOOD: unknown[] = [
  { version: 1 },
  { $schema: "./config.schema.json", version: 1, thinkingLevel: "medium", providers: {} },
  {
    version: 1,
    defaultModel: "packy/kimi-k2.5@messages",
    permission: { mode: "auto-edit", allow: ["bash(git *)"], builtinDeny: [".git/**"] },
    tools: { preset: "codemode", disabled: ["task"] },
    cache: { warming: "idle", retention: "long", minSavingsUsd: 0.1 },
    ui: { theme: "light", quietStartup: "silent" },
    hooks: { timeoutMs: 1000 },
    codemode: { mode: "on", inlineBudget: 0 },
    retry: { maxRetries: 5 },
    compaction: { enabled: false },
    skills: { dirs: ["~/s"] },
  },
  {
    version: 1,
    providers: {
      packy: {
        apiKey: "$PACKY_API_KEY",
        compat: { cacheReporting: "silent", maxTokensField: "max_tokens" },
        channels: {
          chat: { api: "openai-completions", baseUrl: "https://r.example/v1" },
          messages: { api: "anthropic-messages", baseUrl: "https://r.example", apiKey: "$K" },
        },
        defaultChannel: "chat",
        models: [
          {
            id: "kimi-k2.5",
            channels: ["chat", "messages"],
            contextWindow: 262144,
            maxTokens: 32768,
            input: ["text", "image"],
            modelsDev: "moonshotai/kimi-k2.5",
          },
          { id: "glm-5", modelsDev: false, promptCache: { short: 300 } },
        ],
      },
      legacy: { baseUrl: "https://x/v1", models: [{ id: "a", api: "openai-responses" }] },
      deepseek: { modelOverrides: [{ id: "deepseek-flash", contextWindow: 131072 }] },
    },
  },
];

/** 两边都应拒绝（validateConfig 有诊断；schema 不通过）。 */
const BAD: unknown[] = [
  { version: 2 },
  {},
  { version: 1, thinkingLevel: "max" },
  { version: 1, unknownTop: true },
  { version: 1, permission: { mode: "yolo" } },
  { version: 1, permission: { builtinDeny: "no" } },
  { version: 1, retry: { maxRetries: 101 } },
  { version: 1, tools: { preset: "everything" } },
  { version: 1, hooks: { timeoutMs: 0 } },
  { version: 1, cache: { warming: "always" } },
  { version: 1, ui: { theme: "blue" } },
  { version: 1, providers: { p: { baseUrl: 3 } } },
  { version: 1, providers: { p: { baseUrl: "https://x", bogus: 1 } } },
  { version: 1, providers: { p: { models: [{ name: "no id" }] } } },
  { version: 1, providers: { p: { models: [{ id: "m", contextWindow: 0 }] } } },
  { version: 1, providers: { p: { models: [{ id: "m", input: ["audio"] }] } } },
  { version: 1, providers: { p: { models: [{ id: "m", modelsDev: "no-slash" }] } } },
  { version: 1, providers: { p: { models: [{ id: "m", modelsDev: true }] } } },
  { version: 1, providers: { p: { channels: {} } } },
  { version: 1, providers: { p: { channels: { "a@b": { api: "x", baseUrl: "y" } } } } },
  { version: 1, providers: { p: { channels: { chat: { api: "openai-completions" } } } } },
  { version: 1, providers: { p: { channels: { chat: { api: "x", baseUrl: "y", extra: 1 } } } } },
  { version: 1, providers: { p: { compat: { cacheReporting: "maybe" } } } },
  { version: 1, providers: { p: { models: [{ id: "m", promptCache: { forever: 1 } }] } } },
];

describe("config.schema.json 与 validateConfig 一致", () => {
  it.each(GOOD.map((value, i) => [i, value]))("正例 %i：两边都接受", (_i, value) => {
    expect(validateConfig(value)).toEqual([]);
    expect(valid(SCHEMA, value)).toBe(true);
  });

  it.each(BAD.map((value, i) => [i, value]))("反例 %i：两边都拒绝", (_i, value) => {
    expect(validateConfig(value).length).toBeGreaterThan(0);
    expect(valid(SCHEMA, value)).toBe(false);
  });

  it("draft-07、带 $id；文本是 2 空格缩进", () => {
    expect(SCHEMA["$schema"]).toBe("http://json-schema.org/draft-07/schema#");
    expect(configSchemaText()).toMatch(/^\{\n {2}"\$schema"/);
    expect(configSchemaText().endsWith("}\n")).toBe(true);
  });
});

/** schema 里顶层与各段的键路径（供应商内部不算）；`leaf` 为 false 的是段落。 */
function schemaKeys(): { path: string; schema: Schema; leaf: boolean }[] {
  const out: { path: string; schema: Schema; leaf: boolean }[] = [];
  const walk = (properties: Record<string, Schema>, prefix: string): void => {
    for (const [key, schema] of Object.entries(properties)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      const nested = schema["properties"] as Record<string, Schema> | undefined;
      out.push({ path, schema, leaf: nested === undefined || path === "providers" });
      if (nested !== undefined && path !== "providers") walk(nested, path);
    }
  };
  walk(SCHEMA["properties"] as Record<string, Schema>, "");
  return out;
}

describe("config.schema.json 的说明与缺省值（key-docs.ts）", () => {
  it("每个键都有 description；表里的键与 schema 一一对应", () => {
    const keys = schemaKeys();
    for (const { path, schema } of keys) {
      expect(schema["description"], path).toBe(CONFIG_KEY_DOCS[path]);
      expect(typeof schema["description"], path).toBe("string");
    }
    expect(keys.map((k) => k.path).sort()).toEqual(Object.keys(CONFIG_KEY_DOCS).sort());
    expect(
      keys
        .filter((k) => k.leaf)
        .map((k) => k.path)
        .sort(),
    ).toEqual(documentedLeaves().sort());
  });

  it("每个叶子都有 default（运行时决定的除外），与 DEFAULT_CONFIG / DEFAULT_CACHE_CONFIG 相同", () => {
    for (const { path, schema, leaf } of schemaKeys()) {
      if (!leaf) continue;
      if (DYNAMIC_DEFAULTS[path] !== undefined) {
        expect(schema["default"], path).toBeUndefined();
        continue;
      }
      expect(schema["default"], path).toEqual(defaultFor(path));
      expect(schema["default"], path).toBeDefined();
      // 缺省值本身合法
      expect(valid(schema, schema["default"]), path).toBe(true);
    }
    const props = SCHEMA["properties"] as Record<string, Schema>;
    const section = (name: string) => (props[name]?.["properties"] ?? {}) as Record<string, Schema>;
    expect(section("tools")["preset"]?.["default"]).toBe(DEFAULT_CONFIG.tools?.preset);
    expect(section("compaction")["reserveTokens"]?.["default"]).toBe(
      DEFAULT_CONFIG.compaction?.reserveTokens,
    );
    expect(section("cache")["warming"]?.["default"]).toBe(DEFAULT_CACHE_CONFIG.warming);
    expect(section("codemode")["inlineBudget"]?.["default"]).toBe(3000);
    expect(section("codemode")["mode"]?.["default"]).toBeUndefined();
  });

  it("DISPLAY_DEFAULTS 合法、覆盖全部有缺省值的叶子", () => {
    expect(validateConfig(DISPLAY_DEFAULTS)).toEqual([]);
    expect(valid(SCHEMA, DISPLAY_DEFAULTS)).toBe(true);
    for (const path of documentedLeaves()) {
      if (DYNAMIC_DEFAULTS[path] === undefined) expect(defaultFor(path), path).toBeDefined();
    }
  });
});
