/**
 * Settings registry (docs/wave6-plan.md §6.1, D24-D26). [W6-S]
 *
 * One row per key that the `/config` panel and `ama config set` treat as a scalar setting: group, apply
 * tier (now / next session / restart), whether it changes the cache prefix, project-level writability
 * (same rule as `restrictProjectConfig`, cross-checked by settings-registry.test.ts) and the env var that
 * overrides it. Kind and enum options are derived from `buildConfigJsonSchema()` -- the table never
 * repeats them; only `model` / `text` / `optionalNumber` refine the schema type.
 *
 * Keys that are lists or objects (providers, permission rules, tool lists, dirs, agents.<id>, hooks,
 * auth) are not panel rows; `SETTING_HINTS` points to where they are edited instead.
 */

import { buildConfigJsonSchema } from "./json-schema.js";
import {
  defaultFor,
  documentedLeaves,
  dynamicDefaults,
  isDynamicDefault,
  keyDoc,
} from "./key-docs.js";

export type SettingGroup =
  "ui" | "model" | "permission" | "tools" | "context" | "session" | "sandbox" | "agents" | "memory";

export const SETTING_GROUPS: readonly SettingGroup[] = [
  "ui",
  "model",
  "permission",
  "tools",
  "context",
  "session",
  "sandbox",
  "agents",
  "memory",
];

/** `text` is a free string (`ui.replyLanguage`); `optionalNumber` may also be unset / a keyword. */
export type SettingKind = "bool" | "enum" | "number" | "optionalNumber" | "model" | "text";
export type SettingApply = "now" | "nextSession" | "restart";
/** deny: user / profile only; tighten: project may only make it stricter; any: project may set it. */
export type ProjectWritability = "deny" | "tighten" | "any";

export interface SettingSpec {
  key: string;
  group: SettingGroup;
  kind: SettingKind;
  /** Enum values (from the JSON Schema). */
  options?: readonly string[];
  /** Words accepted besides numbers (`compaction.prune.clearAtLeast: "auto"`). */
  keywords?: readonly string[];
  minimum?: number;
  maximum?: number;
  apply: SettingApply;
  /** Changing it changes the cache prefix (system prompt, tool table or model). */
  prefix?: boolean;
  project: ProjectWritability;
  /** Env var that overrides the value (the row shows as locked while it is set). */
  envOverride?: string;
}

type Row = Omit<SettingSpec, "kind" | "options" | "keywords" | "minimum" | "maximum"> & {
  kind?: "model" | "text" | "optionalNumber";
};

const row = (
  key: string,
  group: SettingGroup,
  apply: SettingApply,
  project: ProjectWritability,
  extra: Partial<Row> = {},
): Row => ({ key, group, apply, project, ...extra });

/** Panel order = table order. */
const ROWS: readonly Row[] = [
  row("ui.theme", "ui", "restart", "any"),
  row("ui.markdown", "ui", "now", "any"),
  row("ui.showThinking", "ui", "now", "any"),
  row("ui.compact", "ui", "now", "any"),
  row("ui.animation", "ui", "now", "any"),
  row("ui.logo", "ui", "restart", "any"),
  row("ui.statusLine", "ui", "now", "any"),
  row("ui.restoreOnCancel", "ui", "nextSession", "any"),
  row("ui.quietStartup", "ui", "restart", "any"),
  row("ui.ascii", "ui", "restart", "any", { envOverride: "AMA_ASCII" }),
  row("ui.language", "ui", "restart", "any", { envOverride: "AMA_LANG" }),
  row("ui.replyLanguage", "ui", "nextSession", "deny", { kind: "text", prefix: true }),
  row("ui.agentBar", "ui", "restart", "any"),
  row("defaultModel", "model", "now", "deny", { kind: "model", prefix: true }),
  row("thinkingLevel", "model", "now", "deny", { prefix: true }),
  row("fallbackModel", "model", "nextSession", "deny", { kind: "model" }),
  row("plan.model", "model", "nextSession", "deny", { kind: "model" }),
  row("plan.thinkingLevel", "model", "nextSession", "deny"),
  row("subagents.defaultModel", "model", "nextSession", "deny", { kind: "model" }),
  row("models.aliases.fast", "model", "nextSession", "deny", { kind: "model" }),
  row("models.aliases.strong", "model", "nextSession", "deny", { kind: "model" }),
  row("permission.mode", "permission", "now", "tighten"),
  row("permission.autoModel", "permission", "nextSession", "deny", { kind: "model" }),
  row("plan.bash", "permission", "nextSession", "tighten"),
  row("plan.unattended", "permission", "nextSession", "deny"),
  row("tools.preset", "tools", "restart", "tighten", { prefix: true }),
  row("codemode.mode", "tools", "restart", "tighten", { prefix: true }),
  row("codemode.inlineBudget", "tools", "restart", "deny", { prefix: true }),
  row("codemode.requireStrict", "tools", "restart", "deny"),
  row("tools.maxToolResultChars", "tools", "nextSession", "deny"),
  row("tools.bashTimeoutMs", "tools", "restart", "deny"),
  row("images.resize", "tools", "restart", "deny"),
  row("hooks.timeoutMs", "tools", "restart", "deny"),
  row("compaction.enabled", "context", "now", "any"),
  row("compaction.reserveTokens", "context", "nextSession", "any"),
  row("compaction.keepRecentTokens", "context", "nextSession", "any"),
  row("compaction.prune.keepResults", "context", "nextSession", "deny"),
  row("compaction.prune.clearAtLeast", "context", "nextSession", "deny"),
  row("cache.warming", "context", "now", "deny", { envOverride: "AMA_CACHE_WARMING" }),
  row("cache.retention", "context", "nextSession", "deny", { envOverride: "AMA_CACHE_RETENTION" }),
  row("cache.minSavingsUsd", "context", "nextSession", "deny"),
  row("cache.missNotices", "context", "nextSession", "deny"),
  row("cache.warmSubagents", "context", "nextSession", "deny"),
  row("request.idleTimeoutMs", "context", "nextSession", "deny", {
    envOverride: "AMA_IDLE_TIMEOUT_MS",
  }),
  row("retry.enabled", "context", "now", "deny"),
  row("retry.maxRetries", "context", "nextSession", "deny"),
  row("retry.baseDelayMs", "context", "nextSession", "deny"),
  row("retry.maxDelayMs", "context", "nextSession", "deny"),
  row("limits.maxTurns", "session", "nextSession", "deny", { kind: "optionalNumber" }),
  row("limits.maxCostUsd", "session", "nextSession", "deny", { kind: "optionalNumber" }),
  row("reminders.todo", "session", "nextSession", "any"),
  row("reminders.fileChanges", "session", "nextSession", "any"),
  row("reminders.contextPressure", "session", "nextSession", "any"),
  row("reminders.budget", "session", "nextSession", "any"),
  row("todo.reminder", "session", "nextSession", "deny"),
  row("checkpoints.mode", "session", "restart", "tighten", { envOverride: "AMA_CHECKPOINTS" }),
  row("checkpoints.maxFileBytes", "session", "restart", "tighten"),
  row("checkpoints.keep", "session", "restart", "deny"),
  row("sandbox.enabled", "sandbox", "restart", "deny", { envOverride: "AMA_SANDBOX" }),
  row("sandbox.bash", "sandbox", "restart", "deny"),
  row("sandbox.network", "sandbox", "restart", "tighten"),
  row("agents.maxConcurrent", "agents", "restart", "deny"),
  row("agents.sessionBudgetUsd", "agents", "nextSession", "deny", { kind: "optionalNumber" }),
  row("subagents.maxConcurrent", "agents", "nextSession", "deny"),
  row("subagents.maxPending", "agents", "nextSession", "deny"),
  // [W6-M]
  row("memory.enabled", "memory", "nextSession", "tighten", { envOverride: "AMA_MEMORY" }),
  row("memory.subagents", "memory", "nextSession", "deny"),
];

/** Keys edited elsewhere: key prefix -> hint id (messages `settings.hints`). */
export const SETTING_HINTS = [
  { key: "providers", hint: "providers" },
  { key: "permission.allow", hint: "permissionRules" },
  { key: "tools.default", hint: "tools" },
  { key: "skills.dirs", hint: "dirs" },
  { key: "sandbox.writable", hint: "sandboxWritable" },
  { key: "agents.<id>", hint: "agents" },
  { key: "hooks", hint: "hooks" },
  { key: "auth.chatgpt", hint: "auth" },
  { key: "models.enabled", hint: "modelsEnabled" },
] as const;

export type SettingHintId = (typeof SETTING_HINTS)[number]["hint"];

type Schema = Record<string, unknown>;

/** Schema node of a dotted key (undefined when the key is not in the schema). */
export function schemaAt(key: string, root: Schema = buildConfigJsonSchema()): Schema | undefined {
  let node: Schema | undefined = root;
  for (const part of key.split(".")) {
    const properties = node?.["properties"] as Record<string, Schema> | undefined;
    node = properties?.[part];
    if (node === undefined) return undefined;
  }
  return node;
}

function numberBounds(schema: Schema): Pick<SettingSpec, "minimum" | "maximum"> {
  const out: Pick<SettingSpec, "minimum" | "maximum"> = {};
  if (typeof schema["minimum"] === "number") out.minimum = schema["minimum"];
  if (typeof schema["maximum"] === "number") out.maximum = schema["maximum"];
  return out;
}

/** Fill kind / options / bounds from the schema node. */
function derive(entry: Row, root: Schema): SettingSpec {
  const schema = schemaAt(entry.key, root);
  if (schema === undefined) throw new Error(`settings registry: ${entry.key} is not in the schema`);
  const spec: SettingSpec = { ...entry, kind: entry.kind ?? "text" };
  const anyOf = schema["anyOf"] as Schema[] | undefined;
  if (schema["type"] === "boolean") spec.kind = "bool";
  else if (Array.isArray(schema["enum"])) {
    spec.kind = "enum";
    spec.options = schema["enum"] as string[];
  } else if (schema["type"] === "number") {
    if (entry.kind !== "optionalNumber") spec.kind = "number";
    Object.assign(spec, numberBounds(schema));
  } else if (anyOf !== undefined) {
    spec.kind = "optionalNumber";
    spec.keywords = anyOf.flatMap((s) => (typeof s["const"] === "string" ? [s["const"]] : []));
    const numeric = anyOf.find((s) => s["type"] === "number");
    if (numeric !== undefined) Object.assign(spec, numberBounds(numeric));
  }
  return spec;
}

let cache: readonly SettingSpec[] | undefined;

/** All settings, panel order. */
export function settingsRegistry(): readonly SettingSpec[] {
  if (cache === undefined) {
    const root = buildConfigJsonSchema();
    cache = Object.freeze(ROWS.map((entry) => Object.freeze(derive(entry, root))));
  }
  return cache;
}

export function settingSpec(key: string): SettingSpec | undefined {
  return settingsRegistry().find((spec) => spec.key === key);
}

/** Keys `ama config set` accepts (documented leaves minus file metadata). */
export function settableKeys(): string[] {
  return documentedLeaves().filter((key) => key !== "$schema" && key !== "version");
}

/** Built-in default of a key (undefined when it is unset or decided at run time). */
export function settingDefault(key: string): unknown {
  return isDynamicDefault(key) ? undefined : defaultFor(key);
}

/** Description of a key in the UI language (`keyDoc`, [W6-I4]). */
export function settingDoc(key: string): string | undefined {
  return keyDoc(key);
}

/** Rule text for a key whose default is decided at run time, in the UI language. */
export function settingDynamicDefault(key: string): string | undefined {
  const rules = dynamicDefaults();
  return Object.hasOwn(rules, key) ? rules[key] : undefined;
}
