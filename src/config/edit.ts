/**
 * Settings edit core (docs/wave6-plan.md §6.2, D24-D26). [W6-S]
 *
 * Shared by the `/config` panel, `/config key=value` and `ama config get | set | unset | list`:
 * - `readSnapshot()` reads the user and project files fresh and merges them with the profile / command
 *   line layers the same way bootstrap does (default <- user <- profile <- project, tighten only <- cli);
 * - `getConfigValue()` gives the effective value of a key and which layer it came from (env vars that
 *   override a key count as a layer `env`);
 * - `setConfigValue()` / `unsetConfigValue()` re-read the target file right before writing, change one
 *   path, run `validateConfig`, check project writes with `restrictProjectConfig` (anything that would be
 *   ignored there -- a loosening or a user-only key -- is refused), then write atomically with `.bak`
 *   (`writeConfigFile`). Refusals leave the file byte-for-byte untouched.
 * There is no file lock: a concurrent `ama config edit` between our read and write is lost (R12).
 */

import { readFileSync } from "node:fs";
import { AmaError } from "../errors.js";
import { msg } from "../i18n/index.js";
import { minimalConfig } from "./init.js";
import { DISPLAY_DEFAULTS } from "./key-docs.js";
import { loadConfigFile, parseJsonText } from "./load.js";
import {
  PROFILE_DEFAULTS,
  cliOverridesToConfig,
  mergeBaseLayers,
  mergeProjectAndCli,
  restrictProjectConfig,
  type CliConfigOverrides,
  type ConfigLayerName,
} from "./merge.js";
import { CONFIG_FILE, projectFile, userFile } from "./paths.js";
import { hasErrors, validateConfig } from "./schema.js";
import {
  schemaAt,
  settableKeys,
  settingDefault,
  settingSpec,
  type SettingApply,
  type SettingSpec,
} from "./settings-registry.js";
import { CONFIG_FILE_VERSION, DEFAULT_CHECKPOINTS_CONFIG, type AmaConfig } from "./types.js";
import { writeConfigFile } from "./write.js";

export type SettingSource = ConfigLayerName | "env";
export type EditScope = "user" | "project";

export type ConfigEditCode =
  | "config_unknown_key"
  | "config_invalid_value"
  | "config_project_denied"
  | "config_locked"
  | "config_read_failed"
  | "config_write_failed";

/** Refused edit; `exitCode` 3 (`ExitCode.Config`) except write failures (1). */
export class ConfigEditError extends AmaError {
  declare readonly code: ConfigEditCode;
  constructor(code: ConfigEditCode, message: string) {
    super(code, message, { exitCode: code === "config_write_failed" ? 1 : 3 });
    this.name = "ConfigEditError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;
type Obj = Record<string, unknown>;

export interface ConfigLayerInput {
  /** User config directory (`AMA_CONFIG_DIR` / XDG). */
  configDir: string;
  /** Project root (`.ama/config.json` lives here). */
  cwd: string;
  env: Env;
  /** Embedded host profile: its `config` layer (PROFILE_DEFAULTS are added when `hasProfile`). */
  profile?: { config?: AmaConfig | undefined } | undefined;
  hasProfile?: boolean;
  /** Command line overrides of this process. */
  cli?: CliConfigOverrides | undefined;
}

export interface ConfigSnapshot {
  input: ConfigLayerInput;
  userPath: string;
  projectPath: string;
  user: AmaConfig | undefined;
  project: AmaConfig | undefined;
  /** default <- user <- profile (the baseline project-level tightening is measured against). */
  base: AmaConfig;
  /** Effective config (what bootstrap would build now). */
  config: AmaConfig;
  /** Each layer as it contributes (project = accepted part only), lowest first. */
  layers: readonly { name: ConfigLayerName; value: unknown }[];
}

export interface SettingValue {
  key: string;
  /** Effective value (built-in default when no layer sets it; undefined = unset / decided at run time). */
  value: unknown;
  source: SettingSource;
  /** Env var that overrides it (when source is `env`). */
  envName?: string;
}

export interface EditResult {
  key: string;
  scope: EditScope;
  path: string;
  before: SettingValue;
  after: SettingValue;
  apply: SettingApply | undefined;
  /** The key changes the cache prefix and its effective value changed. */
  prefixChanged: boolean;
  /** The written value is still hidden by a higher layer. */
  overriddenBy: SettingSource | undefined;
  snapshot: ConfigSnapshot;
}

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getPath(value: unknown, key: string): unknown {
  let node = value;
  for (const part of key.split(".")) {
    if (!isObject(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** Set (or with `undefined` delete) one dotted path; empty parent objects are removed. */
export function setPath(target: Obj, key: string, value: unknown): void {
  const parts = key.split(".");
  const chain: Obj[] = [target];
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!isObject(next)) {
      if (value === undefined) return;
      node[part] = {};
    }
    node = node[part] as Obj;
    chain.push(node);
  }
  const leaf = parts.at(-1) as string;
  if (value !== undefined) {
    node[leaf] = value;
    return;
  }
  delete node[leaf];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]!).length > 0) break;
    delete chain[i - 1]![parts[i - 1]!];
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function loadLayerFile(path: string): AmaConfig | undefined {
  try {
    return loadConfigFile("config", path)?.value;
  } catch (error) {
    throw new ConfigEditError(
      "config_read_failed",
      msg().settings.errors.readFailed(errorText(error)),
    );
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read both files and merge all layers. */
export function readSnapshot(input: ConfigLayerInput): ConfigSnapshot {
  const userPath = userFile({ configDir: input.configDir }, CONFIG_FILE);
  const projectPath = projectFile(input.cwd, CONFIG_FILE);
  const user = loadLayerFile(userPath);
  const project = loadLayerFile(projectPath);
  const hasProfile = input.hasProfile ?? input.profile !== undefined;
  const base = mergeBaseLayers({ user, profile: input.profile?.config, hasProfile });
  const merged = mergeProjectAndCli(base, project, input.cli);
  const layers: { name: ConfigLayerName; value: unknown }[] = [
    { name: "default", value: DISPLAY_DEFAULTS },
  ];
  if (user !== undefined) layers.push({ name: "user", value: user });
  if (hasProfile) layers.push({ name: "profile", value: PROFILE_DEFAULTS });
  if (input.profile?.config !== undefined)
    layers.push({ name: "profile", value: input.profile.config });
  if (project !== undefined)
    layers.push({ name: "project", value: restrictAgainst(project, base.config) });
  if (input.cli !== undefined) layers.push({ name: "cli", value: cliOverridesToConfig(input.cli) });
  return {
    input,
    userPath,
    projectPath,
    user,
    project,
    base: base.config,
    config: merged.config,
    layers,
  };
}

function restrictAgainst(project: AmaConfig, base: AmaConfig): Partial<AmaConfig> {
  return restrictProjectConfig(
    project,
    base.permission?.mode ?? "default",
    ".ama/config.json",
    base.tools?.preset ?? "default",
    base.checkpoints?.maxFileBytes ?? DEFAULT_CHECKPOINTS_CONFIG.maxFileBytes,
    base.plan?.bash ?? "readonly",
  ).accepted;
}

/** Effective value and source of one key. */
export function getConfigValue(snapshot: ConfigSnapshot, key: string): SettingValue {
  const envName = settingSpec(key)?.envOverride;
  const envValue = envName === undefined ? undefined : snapshot.input.env[envName]?.trim();
  if (envName !== undefined && envValue !== undefined && envValue !== "")
    return { key, value: envValue, source: "env", envName };
  let source: SettingSource = "default";
  for (const layer of snapshot.layers) {
    if (getPath(layer.value, key) !== undefined) source = layer.name;
  }
  const value = getPath(snapshot.config, key) ?? settingDefault(key);
  return { key, value, source };
}

/** Layers above the write scope: a value from one of them hides what the scope writes. */
const ABOVE: Record<EditScope, readonly SettingSource[]> = {
  user: ["profile", "project", "cli", "env"],
  project: ["cli", "env"],
};

export function overriddenFor(value: SettingValue, scope: EditScope): SettingSource | undefined {
  return ABOVE[scope].includes(value.source) ? value.source : undefined;
}

// ---- parsing ---------------------------------------------------------------

const TRUE = new Set(["true", "on", "1", "yes"]);
const FALSE = new Set(["false", "off", "0", "no"]);
const UNSET = new Set(["none", "unset"]);

function invalid(message: string): ConfigEditError {
  return new ConfigEditError("config_invalid_value", message);
}

function rangeText(spec: Pick<SettingSpec, "minimum" | "maximum">): string {
  if (spec.minimum !== undefined && spec.maximum !== undefined)
    return `${spec.minimum}–${spec.maximum}`;
  if (spec.minimum !== undefined) return `≥ ${spec.minimum}`;
  return `≤ ${spec.maximum}`;
}

function parseNumber(key: string, raw: string, spec: Partial<SettingSpec>): number {
  const text = raw.trim().replace(/_/g, "");
  const value = text === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(value)) throw invalid(msg().settings.errors.invalidNumber(key, raw));
  if (
    (spec.minimum !== undefined && value < spec.minimum) ||
    (spec.maximum !== undefined && value > spec.maximum)
  )
    throw invalid(msg().settings.errors.outOfRange(key, rangeText(spec)));
  return value;
}

/** Registry spec, or one derived from the schema for documented keys outside the panel. */
function specFor(key: string): SettingSpec | { key: string; schema: Obj } {
  const spec = settingSpec(key);
  if (spec !== undefined) return spec;
  if (!settableKeys().includes(key))
    throw new ConfigEditError("config_unknown_key", msg().settings.errors.unknownKey(key));
  return { key, schema: schemaAt(key) ?? {} };
}

/**
 * Parse a command line / panel value. `undefined` means unset (`none`, `unset`; `default` too unless it
 * is a valid enum value). `jsonValue` takes JSON (lists and objects need it).
 */
export function parseValue(key: string, raw: string, jsonValue = false): unknown {
  const m = msg().settings.errors;
  const spec = specFor(key);
  if (jsonValue) {
    try {
      return (JSON.parse(raw) as unknown) ?? undefined;
    } catch (error) {
      throw invalid(m.invalidJson(key, errorText(error)));
    }
  }
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (UNSET.has(lower)) return undefined;
  if (!("kind" in spec)) {
    const type = spec.schema["type"];
    if (type === "array" || type === "object" || spec.schema["anyOf"] !== undefined)
      throw invalid(m.needsJson(key));
    if (type === "boolean") return parseBool(key, text);
    if (type === "number") return parseNumber(key, text, spec.schema as Partial<SettingSpec>);
    if (Array.isArray(spec.schema["enum"]))
      return parseEnum(key, text, spec.schema["enum"] as string[]);
    if (text === "") throw invalid(m.emptyText(key));
    return text;
  }
  switch (spec.kind) {
    case "bool":
      if (lower === "default") return undefined;
      return parseBool(key, text);
    case "enum":
      return parseEnum(key, text, spec.options ?? []);
    case "number":
      if (lower === "default") return undefined;
      return parseNumber(key, text, spec);
    case "optionalNumber": {
      const keyword = spec.keywords?.find((k) => k.toLowerCase() === lower);
      if (keyword !== undefined) return keyword;
      if (lower === "default" || lower === "unlimited" || lower === "off") return undefined;
      return parseNumber(key, text, spec);
    }
    case "model":
      if (lower === "default") return undefined;
      if (!/^[^/\s]+\/\S+$/.test(text)) throw invalid(m.invalidModel(key, raw));
      return text;
    case "text":
      if (text === "") throw invalid(m.emptyText(key));
      return text;
  }
}

function parseBool(key: string, text: string): boolean {
  const lower = text.toLowerCase();
  if (TRUE.has(lower)) return true;
  if (FALSE.has(lower)) return false;
  throw invalid(msg().settings.errors.invalidBool(key, text));
}

function parseEnum(key: string, text: string, options: readonly string[]): string | undefined {
  const lower = text.toLowerCase();
  const hit = options.find((o) => o.toLowerCase() === lower);
  if (hit !== undefined) return hit;
  if (lower === "default") return undefined;
  throw invalid(msg().settings.errors.invalidEnum(key, text, options.join(" | ")));
}

// ---- writing ---------------------------------------------------------------

export interface SetOptions extends ConfigLayerInput {
  scope: EditScope;
  key: string;
  /** Parsed value; `undefined` unsets. */
  value: unknown;
}

function readTarget(path: string, scope: EditScope): Obj {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return scope === "user"
        ? (minimalConfig() as unknown as Obj)
        : { version: CONFIG_FILE_VERSION };
    throw new ConfigEditError(
      "config_read_failed",
      msg().settings.errors.readFailed(errorText(error)),
    );
  }
  try {
    const parsed = parseJsonText(text);
    if (isObject(parsed)) return parsed;
  } catch (error) {
    throw new ConfigEditError(
      "config_read_failed",
      msg().settings.errors.readFailed(`${path}: ${errorText(error)}`),
    );
  }
  throw new ConfigEditError("config_read_failed", msg().settings.errors.readFailed(path));
}

/** Refuse a project write that `restrictProjectConfig` would ignore. */
function checkProject(key: string, value: unknown, next: Obj, base: AmaConfig): void {
  if (value === undefined) return;
  const accepted = restrictAgainst(next as unknown as AmaConfig, base);
  const got = getPath(accepted, key);
  const ok = Array.isArray(value) ? Array.isArray(got) : same(got, value);
  if (ok) return;
  const m = msg().settings.errors;
  const spec = settingSpec(key);
  if (spec?.project === "tighten") {
    const current = getPath(base, key) ?? settingDefault(key);
    throw new ConfigEditError(
      "config_project_denied",
      m.projectTighten(key, current === undefined ? "-" : String(current)),
    );
  }
  throw new ConfigEditError("config_project_denied", m.projectDenied(key));
}

/** Write one key into the user or project file (or unset it with `value: undefined`). */
export function setConfigValue(options: SetOptions): EditResult {
  const { scope, key, value } = options;
  const spec = specFor(key);
  const before = readSnapshot(options);
  const beforeValue = getConfigValue(before, key);
  const path = scope === "user" ? before.userPath : before.projectPath;
  const current = readTarget(path, scope);
  const next = structuredClone(current);
  setPath(next, key, value);
  const errors = validateConfig(next).filter((d) => d.severity === "error");
  if (hasErrors(errors)) {
    const first = errors.find((d) => d.path === key) ?? errors[0]!;
    throw invalid(msg().settings.errors.invalid(key, first.message));
  }
  if (scope === "project") checkProject(key, value, next, before.base);
  if (!same(current, next)) {
    try {
      writeConfigFile(path, next as unknown as AmaConfig, { backup: true });
    } catch (error) {
      throw new ConfigEditError(
        "config_write_failed",
        msg().settings.errors.writeFailed(path, errorText(error)),
      );
    }
  }
  const snapshot = readSnapshot(options);
  const after = getConfigValue(snapshot, key);
  const registry = "kind" in spec ? spec : undefined;
  return {
    key,
    scope,
    path,
    before: beforeValue,
    after,
    apply: registry?.apply,
    prefixChanged: registry?.prefix === true && !same(beforeValue.value, after.value),
    overriddenBy: overriddenFor(after, scope),
    snapshot,
  };
}

export function unsetConfigValue(options: Omit<SetOptions, "value">): EditResult {
  return setConfigValue({ ...options, value: undefined });
}

/** Display text of a value (JSON for lists / objects, plain otherwise). */
export function formatSettingValue(value: unknown): string {
  if (value === undefined) return msg().settings.unset;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
