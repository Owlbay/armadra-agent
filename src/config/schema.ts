/**
 * 配置文件校验（设计 §10、§6.1、§7.3）。[B5]
 *
 * 形状定义在 config/types.ts（B0）与 hooks/types.ts（HookConfig）；这里只做校验并再导出。
 * 校验结果是诊断列表：`severity: "error"` 拒绝该文件（启动退出码 3），`"warning"` 只提示
 * （未知字段等）。`path` 是 JSON 指针风格的字段路径（`permission.mode`、`hooks.PreToolUse[0]`）。
 */

import type { AmaConfig, AuthFile, ProfileFile, TrustFile } from "./types.js";
import type { HookConfig } from "../hooks/types.js";
import { HOOK_EVENTS } from "../hooks/types.js";
import { PERMISSION_MODES_STRICT_FIRST } from "../permissions/types.js";
import { CODEMODE_MODES, TOOLS_PRESETS_STRICT_FIRST } from "./types.js";

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
  CodemodeConfig,
  CodemodeMode,
  HooksSettings,
  UiConfig,
  SkillsConfig,
  ModelConfig,
  ModelOverride,
} from "./types.js";
export { CONFIG_FILE_VERSION } from "./types.js";
export type { HookConfig } from "../hooks/types.js";

export interface Diagnostic {
  severity: "error" | "warning";
  /** 字段路径；文件级问题为 ""。 */
  path: string;
  message: string;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const HOOK_TIMEOUT_MAX_MS = 600_000;

type Obj = Record<string, unknown>;

class Checker {
  readonly diagnostics: Diagnostic[] = [];

  error(path: string, message: string): void {
    this.diagnostics.push({ severity: "error", path, message });
  }

  warn(path: string, message: string): void {
    this.diagnostics.push({ severity: "warning", path, message });
  }

  object(value: unknown, path: string): value is Obj {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return true;
    this.error(path, "应为对象");
    return false;
  }

  /** 未知字段只警告（前向兼容）。 */
  keys(value: Obj, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.warn(join(path, key), "未知字段，已忽略");
    }
  }

  version(value: Obj, path: string): void {
    if (value["version"] !== 1) this.error(join(path, "version"), "version 必须为 1");
  }

  string(value: Obj, key: string, path: string, required = false): void {
    const v = value[key];
    if (v === undefined) {
      if (required) this.error(join(path, key), "缺少必填字符串");
      return;
    }
    if (typeof v !== "string") this.error(join(path, key), "应为字符串");
  }

  boolean(value: Obj, key: string, path: string): void {
    const v = value[key];
    if (v !== undefined && typeof v !== "boolean") this.error(join(path, key), "应为布尔值");
  }

  number(value: Obj, key: string, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): void {
    const v = value[key];
    if (v === undefined) return;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.error(join(path, key), "应为数字");
    } else if (v < min || v > max) {
      this.error(join(path, key), `应在 ${min}–${max} 之间`);
    }
  }

  oneOf(value: Obj, key: string, path: string, choices: readonly string[]): void {
    const v = value[key];
    if (v === undefined) return;
    if (typeof v !== "string" || !choices.includes(v)) {
      this.error(join(path, key), `取值应为 ${choices.join(" | ")}`);
    }
  }

  stringArray(value: Obj, key: string, path: string): void {
    const v = value[key];
    if (v === undefined) return;
    if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
      this.error(join(path, key), "应为字符串数组");
    }
  }

  stringRecord(value: Obj, key: string, path: string): void {
    const v = value[key];
    if (v === undefined) return;
    if (!this.object(v, join(path, key))) return;
    for (const [k, item] of Object.entries(v)) {
      if (typeof item !== "string") this.error(join(join(path, key), k), "应为字符串");
    }
  }
}

function join(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return path === "" ? key : `${path}.${key}`;
}

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
  "models",
  "modelOverrides",
] as const;

function checkModels(c: Checker, value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    c.error(path, "应为数组");
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
    c.string(item, "baseUrl", p);
    c.stringRecord(item, "headers", p);
    const input = item["input"];
    if (
      input !== undefined &&
      (!Array.isArray(input) || input.some((m) => m !== "text" && m !== "image"))
    ) {
      c.error(join(p, "input"), `应为 ("text" | "image")[]`);
    }
  });
}

function checkProvider(c: Checker, value: unknown, path: string): void {
  if (!c.object(value, path)) return;
  c.keys(value, path, PROVIDER_KEYS);
  for (const key of ["name", "api", "baseUrl", "apiKey"]) c.string(value, key, path);
  c.stringArray(value, "envKeys", path);
  c.stringRecord(value, "headers", path);
  c.boolean(value, "requiresApiKey", path);
  if (value["compat"] !== undefined) c.object(value["compat"], join(path, "compat"));
  if (value["authHeader"] !== undefined) c.object(value["authHeader"], join(path, "authHeader"));
  checkModels(c, value["models"], join(path, "models"));
  checkModels(c, value["modelOverrides"], join(path, "modelOverrides"));
}

function checkSection(
  c: Checker,
  config: Obj,
  key: string,
  allowed: readonly string[],
  body: (section: Obj, path: string) => void,
): void {
  const section = config[key];
  if (section === undefined) return;
  if (!c.object(section, key)) return;
  c.keys(section, key, allowed);
  body(section, key);
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
      checkProvider(c, provider, join("providers", id));
    }
  }
  checkSection(c, value, "permission", ["mode", "allow", "deny", "builtinDeny"], (s, p) => {
    c.oneOf(s, "mode", p, PERMISSION_MODES_STRICT_FIRST);
    c.stringArray(s, "allow", p);
    c.stringArray(s, "deny", p);
    const builtinDeny = s["builtinDeny"];
    if (
      builtinDeny !== undefined &&
      typeof builtinDeny !== "boolean" &&
      (!Array.isArray(builtinDeny) || builtinDeny.some((item) => typeof item !== "string"))
    ) {
      c.error(join(p, "builtinDeny"), "应为布尔值或字符串数组");
    }
  });
  checkSection(c, value, "compaction", ["enabled", "reserveTokens", "keepRecentTokens"], (s, p) => {
    c.boolean(s, "enabled", p);
    c.number(s, "reserveTokens", p);
    c.number(s, "keepRecentTokens", p);
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
      c.oneOf(s, "preset", p, TOOLS_PRESETS_STRICT_FIRST);
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
    ["theme", "markdown", "showThinking", "tuiMode", "quietStartup"],
    (s, p) => {
      c.oneOf(s, "theme", p, ["dark", "light"]);
      c.boolean(s, "markdown", p);
      c.oneOf(s, "showThinking", p, ["full", "collapsed", "hidden"]);
      c.oneOf(s, "tuiMode", p, ["regular"]);
      c.oneOf(s, "quietStartup", p, ["normal", "header", "silent"]);
    },
  );
  checkSection(c, value, "skills", ["dirs"], (s, p) => c.stringArray(s, "dirs", p));
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
    c.error("providers", "缺少 providers");
    return c.diagnostics;
  }
  if (!c.object(providers, "providers")) return c.diagnostics;
  for (const [id, entry] of Object.entries(providers)) {
    const p = join("providers", id);
    if (!c.object(entry, p)) continue;
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
export const PROFILE_PATH_LIST_FIELDS = ["instructions", "skillDirs", "promptDirs"] as const;

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
    "$schema",
  ]);
  for (const key of PROFILE_PATH_FIELDS) c.string(value, key, "");
  for (const key of PROFILE_PATH_LIST_FIELDS) c.stringArray(value, key, "");
  c.boolean(value, "authEnv", "");
  c.boolean(value, "trustProject", "");
  return c.diagnostics;
}

export function validateTrustFile(value: unknown): Diagnostic[] {
  const c = new Checker();
  if (!c.object(value, "")) return c.diagnostics;
  c.version(value, "");
  const entries = value["entries"];
  if (!Array.isArray(entries)) {
    c.error("entries", "应为数组");
    return c.diagnostics;
  }
  entries.forEach((entry: unknown, index) => {
    const p = join("entries", index);
    if (!c.object(entry, p)) return;
    c.string(entry, "path", p, true);
    c.string(entry, "at", p, true);
    if (typeof entry["trusted"] !== "boolean") c.error(join(p, "trusted"), "应为布尔值");
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
      c.error(p, `未知事件（可用：${HOOK_EVENTS.join(", ")}）`);
      continue;
    }
    if (!Array.isArray(groups)) {
      c.error(p, "应为数组");
      continue;
    }
    groups.forEach((group: unknown, gi) => {
      const gp = join(p, gi);
      if (!c.object(group, gp)) return;
      c.keys(group, gp, ["matcher", "hooks"]);
      c.string(group, "matcher", gp);
      const commands = group["hooks"];
      if (!Array.isArray(commands)) {
        c.error(join(gp, "hooks"), "应为数组");
        return;
      }
      commands.forEach((command: unknown, ci) => {
        const cp = join(join(gp, "hooks"), ci);
        if (!c.object(command, cp)) return;
        c.keys(command, cp, ["type", "command", "timeoutMs"]);
        if (command["type"] !== "command") c.error(join(cp, "type"), `type 必须为 "command"`);
        c.string(command, "command", cp, true);
        if (typeof command["command"] === "string" && command["command"].trim() === "") {
          c.error(join(cp, "command"), "命令为空");
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
