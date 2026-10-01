/**
 * 配置层级合并（设计 §7.2、§10.2）。[B5]
 *
 * 顺序：内置缺省 ← 用户级 ← profile.config ← 项目级（受限字段，只能收紧）← 命令行。
 * - 对象深合并；数组整体替换，例外是「累加型」列表：`permission.allow / deny`、
 *   `tools.disabled`、`skills.dirs` 跨层拼接去重。
 * - 项目级 `.ama/config.json` 只接受：`permission.deny`（追加）、`permission.mode`（只能更严）、
 *   `compaction`、`tools.disabled`、`ui`；其它字段与放宽项被忽略并记 warning。
 * - 同时产出带来源的权限规则清单（`ruleSpecs`），交给权限管线（B3 的 rules.ts 解析）。
 */

import type { AmaConfig, PermissionConfig } from "./types.js";
import { CONFIG_FILE_VERSION } from "./types.js";
import type { PermissionMode, RuleSource } from "../permissions/types.js";
import { PERMISSION_MODES_STRICT_FIRST } from "../permissions/types.js";
import type { ModelThinkingLevel } from "../ai/types.js";

export const DEFAULT_CONFIG: Readonly<AmaConfig> = Object.freeze({
  version: CONFIG_FILE_VERSION,
  thinkingLevel: "medium",
  permission: { mode: "default", allow: [], deny: [] },
  compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000, maxDelayMs: 60_000 },
  tools: { maxToolResultChars: 30_000, bashTimeoutMs: 120_000, disabled: [] },
  hooks: { timeoutMs: 60_000 },
  ui: {
    theme: "dark",
    markdown: true,
    showThinking: "collapsed",
    tuiMode: "regular",
    quietStartup: "normal",
  },
  skills: { dirs: [] },
} satisfies AmaConfig);

/** 嵌入宿主（有 profile）时的缺省覆盖（§12.10）。 */
export const PROFILE_DEFAULTS: Readonly<Partial<AmaConfig>> = Object.freeze({
  ui: { quietStartup: "header" },
} satisfies Partial<AmaConfig>);

export type ConfigLayerName = "default" | "user" | "profile" | "project" | "cli";

export interface PermissionRuleSpec {
  effect: "allow" | "deny";
  raw: string;
  source: RuleSource;
}

/** 层名 → 规则来源（RuleSource）。 */
const RULE_SOURCE: Record<ConfigLayerName, RuleSource> = {
  default: "builtin",
  user: "user",
  profile: "profile",
  project: "project",
  cli: "cli",
};

const ACCUMULATING = new Set([
  "permission.allow",
  "permission.deny",
  "tools.disabled",
  "skills.dirs",
]);

type Obj = Record<string, unknown>;

function isPlainObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: readonly unknown[]): unknown[] {
  return [...new Set(values)];
}

function mergeValue(base: unknown, over: unknown, path: string): unknown {
  if (over === undefined) return structuredCloneSafe(base);
  if (Array.isArray(over)) {
    if (ACCUMULATING.has(path) && Array.isArray(base)) return unique([...base, ...over]);
    return [...over];
  }
  if (isPlainObject(over)) {
    const result: Obj = isPlainObject(base) ? { ...(structuredCloneSafe(base) as Obj) } : {};
    for (const [key, value] of Object.entries(over)) {
      result[key] = mergeValue(result[key], value, path === "" ? key : `${path}.${key}`);
    }
    return result;
  }
  return over;
}

function structuredCloneSafe<T>(value: T): T {
  return value === undefined ? value : (structuredClone(value) as T);
}

/** 深合并两层配置（不改入参）。 */
export function mergeConfig(base: AmaConfig, over: Partial<AmaConfig> | undefined): AmaConfig {
  if (over === undefined) return structuredCloneSafe(base);
  const merged = mergeValue(base, over, "") as AmaConfig;
  merged.version = CONFIG_FILE_VERSION;
  return merged;
}

export function strictness(mode: PermissionMode): number {
  return PERMISSION_MODES_STRICT_FIRST.indexOf(mode);
}

/** a 是否比 b 更严或相同（plan 最严）。 */
export function isStricterOrEqual(a: PermissionMode, b: PermissionMode): boolean {
  return strictness(a) <= strictness(b);
}

export interface RestrictResult {
  /** 只含被接受的字段。 */
  accepted: Partial<AmaConfig>;
  warnings: string[];
}

/** 把项目级配置裁剪为受限字段（§7.2）；`currentMode` 是合并到此为止的模式。 */
export function restrictProjectConfig(
  project: AmaConfig,
  currentMode: PermissionMode,
  label = ".ama/config.json",
): RestrictResult {
  const warnings: string[] = [];
  const accepted: Partial<AmaConfig> = {};
  for (const [key, value] of Object.entries(project)) {
    if (key === "version" || key === "$schema" || value === undefined) continue;
    switch (key) {
      case "compaction":
        if (project.compaction !== undefined)
          accepted.compaction = structuredClone(project.compaction);
        break;
      case "ui":
        if (project.ui !== undefined) accepted.ui = structuredClone(project.ui);
        break;
      case "tools": {
        const tools = project.tools ?? {};
        for (const sub of Object.keys(tools)) {
          if (sub !== "disabled")
            warnings.push(`${label}: 项目级只能设 tools.disabled，忽略 tools.${sub}`);
        }
        if (tools.disabled !== undefined) accepted.tools = { disabled: [...tools.disabled] };
        break;
      }
      case "permission": {
        const permission = restrictPermission(
          project.permission ?? {},
          currentMode,
          label,
          warnings,
        );
        if (permission !== undefined) accepted.permission = permission;
        break;
      }
      default:
        warnings.push(`${label}: 项目级不能设 ${key}，已忽略`);
    }
  }
  return { accepted, warnings };
}

function restrictPermission(
  permission: PermissionConfig,
  currentMode: PermissionMode,
  label: string,
  warnings: string[],
): PermissionConfig | undefined {
  const result: PermissionConfig = {};
  if (permission.allow !== undefined && permission.allow.length > 0) {
    warnings.push(`${label}: 项目级不能加 allow 规则，忽略 ${permission.allow.join(", ")}`);
  }
  if (permission.deny !== undefined && permission.deny.length > 0)
    result.deny = [...permission.deny];
  if (permission.mode !== undefined) {
    if (isStricterOrEqual(permission.mode, currentMode)) {
      result.mode = permission.mode;
    } else {
      warnings.push(
        `${label}: 项目级只能收紧权限模式，忽略 ${permission.mode}（当前 ${currentMode}）`,
      );
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 命令行对配置的覆盖（只含与 config 同名的那部分参数）。 */
export interface CliConfigOverrides {
  thinkingLevel?: ModelThinkingLevel | undefined;
  permissionMode?: PermissionMode | undefined;
  allow?: readonly string[] | undefined;
  deny?: readonly string[] | undefined;
  quietStartup?: "normal" | "header" | "silent" | undefined;
  tuiMode?: "regular" | undefined;
  skillDirs?: readonly string[] | undefined;
}

export function cliOverridesToConfig(cli: CliConfigOverrides): Partial<AmaConfig> {
  const out: Partial<AmaConfig> = {};
  if (cli.thinkingLevel !== undefined) out.thinkingLevel = cli.thinkingLevel;
  const permission: PermissionConfig = {};
  if (cli.permissionMode !== undefined) permission.mode = cli.permissionMode;
  if (cli.allow !== undefined && cli.allow.length > 0) permission.allow = [...cli.allow];
  if (cli.deny !== undefined && cli.deny.length > 0) permission.deny = [...cli.deny];
  if (Object.keys(permission).length > 0) out.permission = permission;
  const ui: NonNullable<AmaConfig["ui"]> = {};
  if (cli.quietStartup !== undefined) ui.quietStartup = cli.quietStartup;
  if (cli.tuiMode !== undefined) ui.tuiMode = cli.tuiMode;
  if (Object.keys(ui).length > 0) out.ui = ui;
  return out;
}

export interface ConfigLayers {
  user?: AmaConfig | undefined;
  /** profile.config 指向的文件内容；`hasProfile` 为 true 时还会叠加 PROFILE_DEFAULTS。 */
  profile?: AmaConfig | undefined;
  hasProfile?: boolean;
  project?: AmaConfig | undefined;
  cli?: CliConfigOverrides | undefined;
}

export interface MergeResult {
  config: AmaConfig;
  warnings: string[];
  ruleSpecs: PermissionRuleSpec[];
  /** 各层是否存在（doctor 显示）。 */
  layers: ConfigLayerName[];
}

function collectRules(
  layer: ConfigLayerName,
  permission: PermissionConfig | undefined,
): PermissionRuleSpec[] {
  const source = RULE_SOURCE[layer];
  const specs: PermissionRuleSpec[] = [];
  for (const raw of permission?.allow ?? []) specs.push({ effect: "allow", raw, source });
  for (const raw of permission?.deny ?? []) specs.push({ effect: "deny", raw, source });
  return specs;
}

/** 第 6 步：缺省 ← 用户级 ← profile。 */
export function mergeBaseLayers(
  layers: Pick<ConfigLayers, "user" | "profile" | "hasProfile">,
): MergeResult {
  let config = mergeConfig(DEFAULT_CONFIG as AmaConfig, undefined);
  const present: ConfigLayerName[] = ["default"];
  const ruleSpecs: PermissionRuleSpec[] = [];
  if (layers.user !== undefined) {
    config = mergeConfig(config, layers.user);
    present.push("user");
    ruleSpecs.push(...collectRules("user", layers.user.permission));
  }
  if (layers.hasProfile === true) config = mergeConfig(config, PROFILE_DEFAULTS);
  if (layers.profile !== undefined) {
    config = mergeConfig(config, layers.profile);
    present.push("profile");
    ruleSpecs.push(...collectRules("profile", layers.profile.permission));
  }
  return { config, warnings: [], ruleSpecs, layers: present };
}

/** 第 9 步：叠加项目级（受限）与命令行。 */
export function mergeProjectAndCli(
  base: MergeResult,
  project: AmaConfig | undefined,
  cli: CliConfigOverrides | undefined,
  projectLabel?: string,
): MergeResult {
  let config = base.config;
  const warnings = [...base.warnings];
  const ruleSpecs = [...base.ruleSpecs];
  const present = [...base.layers];
  if (project !== undefined) {
    const baseline = config.permission?.mode ?? "default";
    const restricted = restrictProjectConfig(project, baseline, projectLabel);
    warnings.push(...restricted.warnings);
    config = mergeConfig(config, restricted.accepted);
    present.push("project");
    ruleSpecs.push(...collectRules("project", restricted.accepted.permission));
  }
  // 命令行是用户的显式选择，最后叠加（可以放宽项目级收紧过的 mode，§7.2「放宽只认用户级 / 命令行 / profile」）。
  const cliConfig = cli === undefined ? undefined : cliOverridesToConfig(cli);
  if (cliConfig !== undefined && Object.keys(cliConfig).length > 0) {
    config = mergeConfig(config, cliConfig);
    present.push("cli");
    ruleSpecs.push(...collectRules("cli", cliConfig.permission));
  }
  return { config, warnings, ruleSpecs, layers: present };
}

/** 一次合并全部层（SDK / 测试用）。 */
export function mergeConfigLayers(layers: ConfigLayers): MergeResult {
  return mergeProjectAndCli(mergeBaseLayers(layers), layers.project, layers.cli);
}
