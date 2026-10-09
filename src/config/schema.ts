/**
 * 配置文件校验（设计 §10、§6.1、§7.3）。[B5]
 *
 * 形状定义在 config/types.ts（B0）与 hooks/types.ts（HookConfig）；这里只做校验并再导出。
 * 校验结果是诊断列表：`severity: "error"` 拒绝该文件（启动退出码 3），`"warning"` 只提示
 * （未知字段等）。`path` 是 JSON 指针风格的字段路径（`permission.mode`、`hooks.PreToolUse[0]`）。
 */

import { isAbsolute } from "node:path";
import { msg } from "../i18n/index.js";
import type { AmaConfig, AuthFile, ProfileFile, TrustFile } from "./types.js";
import {
  Checker,
  THINKING_LEVELS,
  checkSection,
  join,
  type Diagnostic,
  type Obj,
} from "./checker.js";
import {
  W5_COMPACTION_KEYS,
  W5_CONFIG_KEYS,
  W5_UI_KEYS,
  checkCompactionW5,
  checkUiW5,
  validateConfigW5,
} from "./schema-w5.js";
import {
  W6_CONFIG_KEYS,
  W6_UI_KEYS,
  checkOAuthEntry,
  checkProfileMemory,
  checkUiW6,
  validateConfigW6,
} from "./schema-w6.js";
import type { HookConfig } from "../hooks/types.js";
import { HOOK_EVENTS } from "../hooks/types.js";
import { PERMISSION_MODES_STRICT_FIRST } from "../permissions/types.js";
import { WARMING_MODES } from "../ai/cache/types.js";
import { BUILTIN_PROVIDERS } from "../ai/providers/builtin.js";
import {
  CACHE_RETENTIONS,
  CHANNEL_NAME_PATTERN,
  CHECKPOINT_MODES,
  SANDBOX_ENABLED_MODES,
  SANDBOX_NETWORK_MODES,
  CODEMODE_MODES,
  TOOLS_PRESET_INPUTS,
} from "./types.js";

export type {
  AmaConfig,
  AuthFile,
  ProfileFile,
  TrustFile,
  TrustEntry,
  ProviderConfig,
  PermissionConfig,
  CompactionConfig,
  RetryConfig,
  ToolsConfig,
  ToolsPreset,
  ToolsPresetInput,
  CodemodeConfig,
  CodemodeMode,
  HooksSettings,
  UiConfig,
  SkillsConfig,
  CacheConfig,
  CheckpointsConfig,
  ModelConfig,
  ModelOverride,
  ChannelConfig,
} from "./types.js";
export { CONFIG_FILE_VERSION } from "./types.js";
export type { HookConfig } from "../hooks/types.js";
export type { Diagnostic } from "./checker.js";

export { THINKING_LEVELS } from "./checker.js";
export const HOOK_TIMEOUT_MAX_MS = 600_000;

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

// ---------------------------------------------------------------------------
// config.json
// ---------------------------------------------------------------------------

const CONFIG_KEYS = [
  "version",
  "defaultModel",
  "thinkingLevel",
  "providers",
  "permission",
  "compaction",
  "retry",
  "tools",
  "codemode",
  "hooks",
  "ui",
  "skills",
  "cache",
  "request",
  "checkpoints",
  "sandbox",
  ...W5_CONFIG_KEYS,
  ...W6_CONFIG_KEYS,
  "$schema",
] as const;

const PROVIDER_KEYS = [
  "name",
  "api",
  "baseUrl",
  "apiKey",
  "envKeys",
  "authHeader",
  "headers",
  "compat",
  "requiresApiKey",
  "channels",
  "defaultChannel",
  "models",
  "modelOverrides",
] as const;

const CHANNEL_KEYS = ["api", "baseUrl", "apiKey", "authHeader", "headers", "compat"] as const;

/** 第三波 §1.3 的缓存兼容开关（其余 compat 字段按协议各异，只查是对象）。 */
const CACHE_COMPAT_FLAGS = [
  "sendPromptCacheKey",
  "sendSessionAffinityHeaders",
  "supportsLongCacheRetention",
  "supportsExplicitPromptCacheMode",
] as const;

function checkModels(
  c: Checker,
  value: unknown,
  path: string,
  channels: ReadonlySet<string> | undefined,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    c.error(path, msg().config.schema.array);
    return;
  }
  value.forEach((item: unknown, index) => {
    const p = join(path, index);
    if (!c.object(item, p)) return;
    c.string(item, "id", p, true);
    c.string(item, "name", p);
    c.number(item, "contextWindow", p, 1);
    c.number(item, "maxTokens", p, 1);
    c.boolean(item, "reasoning", p);
    c.string(item, "api", p);
    c.string(item, "baseUrl", p);
    c.stringRecord(item, "headers", p);
    const modelsDev = item["modelsDev"];
    if (
      modelsDev !== undefined &&
      modelsDev !== false &&
      (typeof modelsDev !== "string" || !/^[^/]+\/.+$/.test(modelsDev))
    ) {
      c.error(join(p, "modelsDev"), msg().config.schema.modelsDev);
    }
    c.stringArray(item, "channels", p);
    const used = item["channels"];
    if (Array.isArray(used)) {
      used.forEach((name: unknown, i) => {
        if (typeof name !== "string") return;
        if (channels === undefined)
          c.error(join(join(p, "channels"), i), msg().config.schema.noChannels);
        else if (!channels.has(name))
          c.error(
            join(join(p, "channels"), i),
            msg().config.schema.unknownChannelOf(name, [...channels]),
          );
      });
    }
    const promptCache = item["promptCache"];
    if (promptCache !== undefined && c.object(promptCache, join(p, "promptCache"))) {
      const pp = join(p, "promptCache");
      c.keys(promptCache, pp, ["short", "long", "minTokens"]);
      for (const key of ["short", "long", "minTokens"]) c.number(promptCache, key, pp);
    }
    const input = item["input"];
    if (
      input !== undefined &&
      (!Array.isArray(input) || input.some((m) => m !== "text" && m !== "image"))
    ) {
      c.error(join(p, "input"), msg().config.schema.modelInput);
    }
  });
}

function checkCompat(c: Checker, compat: unknown, path: string): void {
  if (compat === undefined || !c.object(compat, path)) return;
  for (const key of CACHE_COMPAT_FLAGS) c.boolean(compat, key, path);
  c.oneOf(compat, "cacheReporting", path, ["auto", "silent", "reported"]);
}

/**
 * 返回合法的渠道名集合；没有 `channels`（也没有内置渠道）时 undefined。`builtin` 是内置供应商的内置渠道名
 * （[W5-M2]）：同名渠道可只写要改的字段，`defaultChannel` 与模型 `channels` 也可引用它们。
 */
function checkChannels(
  c: Checker,
  value: Obj,
  path: string,
  builtin: readonly string[],
): Set<string> | undefined {
  const channels = value["channels"];
  if (channels === undefined) {
    if (builtin.length === 0) return undefined;
    checkDefaultChannel(c, value, path, new Set(builtin));
    return new Set(builtin);
  }
  const cp = join(path, "channels");
  if (!c.object(channels, cp)) return new Set();
  const names = new Set<string>(builtin);
  for (const [name, channel] of Object.entries(channels)) {
    const p = join(cp, name);
    if (!CHANNEL_NAME_PATTERN.test(name)) {
      c.error(p, msg().config.schema.channelName);
      continue;
    }
    names.add(name);
    if (!c.object(channel, p)) continue;
    c.keys(channel, p, CHANNEL_KEYS);
    c.string(channel, "api", p, !builtin.includes(name));
    c.string(channel, "baseUrl", p, !builtin.includes(name));
    c.string(channel, "apiKey", p);
    c.stringRecord(channel, "headers", p);
    if (channel["authHeader"] !== undefined) c.object(channel["authHeader"], join(p, "authHeader"));
    checkCompat(c, channel["compat"], join(p, "compat"));
  }
  if (names.size === 0 && Object.keys(channels).length === 0)
    c.error(cp, msg().config.schema.atLeastOneChannel);
  checkDefaultChannel(c, value, path, names);
  return names;
}

function checkDefaultChannel(c: Checker, value: Obj, path: string, names: Set<string>): void {
  const preferred = value["defaultChannel"];
  if (preferred === undefined) return;
  if (typeof preferred !== "string")
    c.error(join(path, "defaultChannel"), msg().config.schema.string);
  else if (!names.has(preferred))
    c.error(join(path, "defaultChannel"), msg().config.schema.unknownChannel(preferred));
}

function checkProvider(c: Checker, value: unknown, path: string, id: string): void {
  if (!c.object(value, path)) return;
  c.keys(value, path, PROVIDER_KEYS);
  for (const key of ["name", "api", "baseUrl", "apiKey"]) c.string(value, key, path);
  c.stringArray(value, "envKeys", path);
  c.stringRecord(value, "headers", path);
  c.boolean(value, "requiresApiKey", path);
  checkCompat(c, value["compat"], join(path, "compat"));
  if (value["authHeader"] !== undefined) c.object(value["authHeader"], join(path, "authHeader"));
  const builtin = BUILTIN_PROVIDERS.find((p) => p.id === id)?.channels?.map((ch) => ch.name);
  const channels = checkChannels(c, value, path, builtin ?? []);
  if (channels === undefined && value["defaultChannel"] !== undefined)
    c.error(join(path, "defaultChannel"), msg().config.schema.defaultChannelWithoutChannels);
  checkModels(c, value["models"], join(path, "models"), channels);
  checkModels(c, value["modelOverrides"], join(path, "modelOverrides"), channels);
}

export function validateConfig(value: unknown): Diagnostic[] {
  const c = new Checker();
  if (!c.object(value, "")) return c.diagnostics;
  c.version(value, "");
  c.keys(value, "", CONFIG_KEYS);
  c.string(value, "defaultModel", "");
  c.oneOf(value, "thinkingLevel", "", THINKING_LEVELS);
  const providers = value["providers"];
  if (providers !== undefined && c.object(providers, "providers")) {
    for (const [id, provider] of Object.entries(providers)) {
      checkProvider(c, provider, join("providers", id), id);
    }
  }
  const permissionKeys = ["mode", "allow", "deny", "builtinDeny", "autoModel", "autoSafeCommands"];
  checkSection(c, value, "permission", permissionKeys, (s, p) => {
    c.oneOf(s, "mode", p, PERMISSION_MODES_STRICT_FIRST);
    c.stringArray(s, "allow", p);
    c.stringArray(s, "deny", p);
    c.string(s, "autoModel", p);
    c.stringArray(s, "autoSafeCommands", p);
    const builtinDeny = s["builtinDeny"];
    if (
      builtinDeny !== undefined &&
      typeof builtinDeny !== "boolean" &&
      (!Array.isArray(builtinDeny) || builtinDeny.some((item) => typeof item !== "string"))
    ) {
      c.error(join(p, "builtinDeny"), msg().config.schema.builtinDeny);
    }
  });
  const compactionKeys = ["enabled", "reserveTokens", "keepRecentTokens", ...W5_COMPACTION_KEYS];
  checkSection(c, value, "compaction", compactionKeys, (s, p) => {
    c.boolean(s, "enabled", p);
    c.number(s, "reserveTokens", p);
    c.number(s, "keepRecentTokens", p);
    checkCompactionW5(c, s, p);
  });
  checkSection(
    c,
    value,
    "retry",
    ["enabled", "maxRetries", "baseDelayMs", "maxDelayMs"],
    (s, p) => {
      c.boolean(s, "enabled", p);
      c.number(s, "maxRetries", p, 0, 100);
      c.number(s, "baseDelayMs", p);
      c.number(s, "maxDelayMs", p);
    },
  );
  checkSection(
    c,
    value,
    "tools",
    ["preset", "default", "maxToolResultChars", "bashTimeoutMs", "disabled"],
    (s, p) => {
      c.oneOf(s, "preset", p, TOOLS_PRESET_INPUTS);
      c.stringArray(s, "default", p);
      c.number(s, "maxToolResultChars", p, 1);
      c.number(s, "bashTimeoutMs", p, 1);
      c.stringArray(s, "disabled", p);
    },
  );
  checkSection(c, value, "codemode", ["mode", "inlineBudget", "requireStrict"], (s, p) => {
    c.oneOf(s, "mode", p, CODEMODE_MODES);
    c.number(s, "inlineBudget", p, 0);
    c.boolean(s, "requireStrict", p);
  });
  checkSection(c, value, "hooks", ["timeoutMs"], (s, p) => {
    c.number(s, "timeoutMs", p, 1, HOOK_TIMEOUT_MAX_MS);
  });
  checkSection(
    c,
    value,
    "ui",
    [
      "theme",
      "markdown",
      "showThinking",
      "tuiMode",
      "quietStartup",
      "ascii",
      "compact",
      "logo",
      "animation",
      "restoreOnCancel",
      "enterWhileRunning",
      "programStatus",
      ...W5_UI_KEYS,
      ...W6_UI_KEYS,
    ],
    (s, p) => {
      c.oneOf(s, "theme", p, ["dark", "light", "auto"]);
      c.boolean(s, "markdown", p);
      c.oneOf(s, "showThinking", p, ["full", "collapsed", "hidden"]);
      c.oneOf(s, "tuiMode", p, ["regular"]);
      c.oneOf(s, "quietStartup", p, ["normal", "header", "silent"]);
      c.boolean(s, "ascii", p);
      c.boolean(s, "compact", p);
      c.oneOf(s, "logo", p, ["auto", "off"]);
      c.boolean(s, "animation", p);
      c.boolean(s, "restoreOnCancel", p);
      c.oneOf(s, "enterWhileRunning", p, ["queue", "interrupt"]);
      c.oneOf(s, "programStatus", p, ["auto", "on", "off"]);
      checkUiW5(c, s, p);
      checkUiW6(c, s, p);
    },
  );
  checkSection(c, value, "skills", ["dirs"], (s, p) => c.stringArray(s, "dirs", p));
  checkSection(c, value, "request", ["idleTimeoutMs"], (s, p) => {
    c.number(s, "idleTimeoutMs", p, 0);
  });
  checkSection(c, value, "checkpoints", ["mode", "maxFileBytes", "keep"], (s, p) => {
    c.oneOf(s, "mode", p, CHECKPOINT_MODES);
    c.number(s, "maxFileBytes", p, 0);
    c.number(s, "keep", p, 1);
  });
  checkSection(c, value, "sandbox", ["enabled", "bash", "network", "writable"], (s, p) => {
    c.oneOf(s, "enabled", p, SANDBOX_ENABLED_MODES);
    c.oneOf(s, "bash", p, SANDBOX_ENABLED_MODES);
    c.oneOf(s, "network", p, SANDBOX_NETWORK_MODES);
    c.stringArray(s, "writable", p);
    const writable = s["writable"];
    if (Array.isArray(writable))
      writable.forEach((item, i) => {
        if (typeof item === "string" && !isAbsolute(item) && item !== "~" && !item.startsWith("~/"))
          c.warn(`${p}.writable[${i}]`, msg().config.schema.writablePath);
      });
  });
  checkSection(
    c,
    value,
    "cache",
    ["warming", "retention", "minSavingsUsd", "missNotices", "warmSubagents"],
    (s, p) => {
      c.oneOf(s, "warming", p, WARMING_MODES);
      c.oneOf(s, "retention", p, CACHE_RETENTIONS);
      c.number(s, "minSavingsUsd", p, 0);
      c.boolean(s, "missNotices", p);
      c.boolean(s, "warmSubagents", p);
    },
  );
  validateConfigW5(c, value);
  validateConfigW6(c, value);
  return c.diagnostics;
}

// ---------------------------------------------------------------------------
// auth.json / profile.json / trust.json / hooks.json
// ---------------------------------------------------------------------------

export function validateAuthFile(value: unknown): Diagnostic[] {
  const c = new Checker();
  if (!c.object(value, "")) return c.diagnostics;
  c.version(value, "");
  c.keys(value, "", ["version", "providers"]);
  const providers = value["providers"];
  if (providers === undefined) {
    c.error("providers", msg().config.schema.providersMissing);
    return c.diagnostics;
  }
  if (!c.object(providers, "providers")) return c.diagnostics;
  for (const [id, entry] of Object.entries(providers)) {
    const p = join("providers", id);
    if (!c.object(entry, p)) continue;
    if (entry["type"] === "oauth") {
      checkOAuthEntry(c, entry, p);
      continue;
    }
    c.keys(entry, p, ["apiKey", "env", "baseUrl"]);
    c.string(entry, "apiKey", p, true);
    c.stringRecord(entry, "env", p);
    c.string(entry, "baseUrl", p);
  }
  return c.diagnostics;
}

export const PROFILE_PATH_FIELDS = [
  "host",
  "hooksFile",
  "authFile",
  "sessionDir",
  "config",
] as const;
export const PROFILE_PATH_LIST_FIELDS = [
  "instructions",
  "skillDirs",
  "promptDirs",
  "agentDirs",
] as const;

export function validateProfile(value: unknown): Diagnostic[] {
  const c = new Checker();
  if (!c.object(value, "")) return c.diagnostics;
  c.version(value, "");
  c.keys(value, "", [
    "version",
    ...PROFILE_PATH_FIELDS,
    ...PROFILE_PATH_LIST_FIELDS,
    "authEnv",
    "trustProject",
    "language",
    "memory",
    "$schema",
  ]);
  for (const key of PROFILE_PATH_FIELDS) c.string(value, key, "");
  for (const key of PROFILE_PATH_LIST_FIELDS) c.stringArray(value, key, "");
  c.boolean(value, "authEnv", "");
  c.boolean(value, "trustProject", "");
  c.oneOf(value, "language", "", ["zh", "en"]);
  checkProfileMemory(c, value);
  return c.diagnostics;
}

export function validateTrustFile(value: unknown): Diagnostic[] {
  const c = new Checker();
  if (!c.object(value, "")) return c.diagnostics;
  c.version(value, "");
  const entries = value["entries"];
  if (!Array.isArray(entries)) {
    c.error("entries", msg().config.schema.array);
    return c.diagnostics;
  }
  entries.forEach((entry: unknown, index) => {
    const p = join("entries", index);
    if (!c.object(entry, p)) return;
    c.string(entry, "path", p, true);
    c.string(entry, "at", p, true);
    if (typeof entry["trusted"] !== "boolean")
      c.error(join(p, "trusted"), msg().config.schema.boolean);
  });
  return c.diagnostics;
}

export function validateHookConfig(value: unknown): Diagnostic[] {
  const c = new Checker();
  if (!c.object(value, "")) return c.diagnostics;
  c.version(value, "");
  c.keys(value, "", ["version", "hooks", "$schema"]);
  const hooks = value["hooks"];
  if (hooks === undefined) return c.diagnostics;
  if (!c.object(hooks, "hooks")) return c.diagnostics;
  for (const [event, groups] of Object.entries(hooks)) {
    const p = join("hooks", event);
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      c.error(p, msg().config.schema.hookEvent(HOOK_EVENTS));
      continue;
    }
    if (!Array.isArray(groups)) {
      c.error(p, msg().config.schema.array);
      continue;
    }
    groups.forEach((group: unknown, gi) => {
      const gp = join(p, gi);
      if (!c.object(group, gp)) return;
      c.keys(group, gp, ["matcher", "hooks"]);
      c.string(group, "matcher", gp);
      const commands = group["hooks"];
      if (!Array.isArray(commands)) {
        c.error(join(gp, "hooks"), msg().config.schema.array);
        return;
      }
      commands.forEach((command: unknown, ci) => {
        const cp = join(join(gp, "hooks"), ci);
        if (!c.object(command, cp)) return;
        c.keys(command, cp, ["type", "command", "timeoutMs"]);
        if (command["type"] !== "command") c.error(join(cp, "type"), msg().config.schema.hookType);
        c.string(command, "command", cp, true);
        if (typeof command["command"] === "string" && command["command"].trim() === "") {
          c.error(join(cp, "command"), msg().config.schema.hookCommandEmpty);
        }
        c.number(command, "timeoutMs", cp, 1, HOOK_TIMEOUT_MAX_MS);
      });
    });
  }
  return c.diagnostics;
}

/** 校验通过后的类型断言（调用方保证 `hasErrors()` 为 false）。 */
export function asConfig(value: unknown): AmaConfig {
  return value as AmaConfig;
}
export function asAuthFile(value: unknown): AuthFile {
  return value as AuthFile;
}
export function asProfile(value: unknown): ProfileFile {
  return value as ProfileFile;
}
export function asTrustFile(value: unknown): TrustFile {
  return value as TrustFile;
}
export function asHookConfig(value: unknown): HookConfig {
  return value as HookConfig;
}
