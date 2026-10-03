/**
 * 配置层级合并（设计 §7.2、§10.2）。[B5]
 *
 * 顺序：内置缺省 ← 用户级 ← profile.config ← 项目级（受限字段，只能收紧）← 命令行。
 * - 对象深合并；数组整体替换，例外是「累加型」列表：`permission.allow / deny / autoSafeCommands`、
 *   `tools.disabled`、`skills.dirs` 跨层拼接去重。
 * - 项目级 `.ama/config.json` 只接受：`permission.deny`（追加）、`permission.mode`（只能更严，且不能是
 *   auto / full-auto）、
 *   `compaction`、`tools.disabled`、`tools.preset`（只能更严）、`codemode.mode: "off"`、`ui`、
 *   `checkpoints.mode: "off"`、`checkpoints.maxFileBytes`（只能调小）、（W5-C0）`plan.bash`（只能更严）、
 *   `reminders`；`compaction.prune / pruneExclude` 与第五波其余段只认用户级；（W6-C0）`ui.language` /
 *   `ui.agentBar` 随 `ui` 段、`memory.enabled: false`；（W7-B2）`subagents.background / autoBackgroundAfterMs`；`ui.replyLanguage`、`memory` 其余键、`auth` 只认用户级；
 *   其它字段与放宽项（含 `permission.builtinDeny / autoModel / autoSafeCommands`）被忽略并记 warning。
 * - 同时产出带来源的权限规则清单（`ruleSpecs`），交给权限管线（B3 的 rules.ts 解析）。
 */

import type {
  AmaConfig,
  CheckpointsConfig,
  CodemodeMode,
  PermissionConfig,
  PlanBashMode,
  PlanConfig,
  SubagentsConfig,
  ToolsConfig,
  ToolsPresetInput,
} from "./types.js";
import {
  CONFIG_FILE_VERSION,
  DEFAULT_CHECKPOINTS_CONFIG,
  PLAN_BASH_MODES_STRICT_FIRST,
  TOOLS_PRESETS_STRICT_FIRST,
  canonicalPreset,
} from "./types.js";
import type { PermissionMode, RuleSource } from "../permissions/types.js";
import { isAtLeastAsStrict } from "../permissions/rules.js";
import { msg } from "../i18n/index.js";
import type { ModelThinkingLevel } from "../ai/types.js";

export const DEFAULT_CONFIG: Readonly<AmaConfig> = Object.freeze({
  version: CONFIG_FILE_VERSION,
  thinkingLevel: "medium",
  permission: { mode: "default", allow: [], deny: [] },
  compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000, maxDelayMs: 60_000 },
  tools: { preset: "default", maxToolResultChars: 30_000, bashTimeoutMs: 120_000, disabled: [] },
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
  // [W5-A] 嵌入宿主以「最后一行 = 状态栏」锚定，底部信息行缺省单行；[W7-A] Agent 栏不再缺省关，
  // 宿主要关就在自己的 profile 写 `ui.agentBar: "off"`
  ui: { quietStartup: "header", statusLine: "compact" },
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
  "permission.autoSafeCommands",
  "tools.disabled",
  "skills.dirs",
  "agents.dirs",
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
  // 别名（`codemode`）在合并后折成规范名：下游只见规范名。
  if (merged.tools?.preset !== undefined)
    merged.tools.preset = canonicalPreset(merged.tools.preset);
  return merged;
}

export interface RestrictResult {
  /** 只含被接受的字段。 */
  accepted: Partial<AmaConfig>;
  warnings: string[];
}

/** 预设 a 是否比 b 更严或相同（coordinator 最严，codemode-only 最宽；别名按规范名比）。 */
export function isPresetStricterOrEqual(a: ToolsPresetInput, b: ToolsPresetInput): boolean {
  return (
    TOOLS_PRESETS_STRICT_FIRST.indexOf(canonicalPreset(a)) <=
    TOOLS_PRESETS_STRICT_FIRST.indexOf(canonicalPreset(b))
  );
}

/**
 * 把项目级配置裁剪为受限字段（§7.2）；`currentMode` / `currentPreset` 是合并到此为止的
 * 权限模式与工具预设。
 */
export function restrictProjectConfig(
  project: AmaConfig,
  currentMode: PermissionMode,
  label = ".ama/config.json",
  currentPreset: ToolsPresetInput = "default",
  currentMaxFileBytes: number = DEFAULT_CHECKPOINTS_CONFIG.maxFileBytes,
  currentPlanBash: PlanBashMode = "readonly",
): RestrictResult {
  const warnings: string[] = [];
  const accepted: Partial<AmaConfig> = {};
  for (const [key, value] of Object.entries(project)) {
    if (key === "version" || key === "$schema" || value === undefined) continue;
    switch (key) {
      case "compaction":
        if (project.compaction !== undefined) {
          const { prune, pruneExclude, ...rest } = structuredClone(project.compaction);
          if (prune !== undefined || pruneExclude !== undefined)
            warnings.push(
              msg().config.merge.projectIgnored(label, "compaction.prune / pruneExclude"),
            );
          if (Object.keys(rest).length > 0) accepted.compaction = rest;
        }
        break;
      case "reminders":
        if (project.reminders !== undefined)
          accepted.reminders = structuredClone(project.reminders);
        break;
      case "subagents": {
        // [W7-B2] 前台 / 后台只影响呈现与等待，不放宽权限：项目级可设；并发、模型仍只认用户级
        const subagents = project.subagents ?? {};
        const result: SubagentsConfig = {};
        for (const sub of Object.keys(subagents)) {
          if (sub !== "background" && sub !== "autoBackgroundAfterMs")
            warnings.push(
              msg().config.merge.projectOnlyKeys(
                label,
                "subagents.background / subagents.autoBackgroundAfterMs",
                `subagents.${sub}`,
              ),
            );
        }
        if (subagents.background !== undefined) result.background = subagents.background;
        if (subagents.autoBackgroundAfterMs !== undefined)
          result.autoBackgroundAfterMs = subagents.autoBackgroundAfterMs;
        if (Object.keys(result).length > 0) accepted.subagents = result;
        break;
      }
      case "plan": {
        const plan = restrictPlan(project.plan ?? {}, currentPlanBash, label, warnings);
        if (plan !== undefined) accepted.plan = plan;
        break;
      }
      case "ui":
        if (project.ui !== undefined) {
          // [W6-C0] 回复语言改的是发给模型的规则，只认用户级 / profile
          const { replyLanguage, ...rest } = structuredClone(project.ui);
          if (replyLanguage !== undefined)
            warnings.push(msg().config.merge.projectIgnored(label, "ui.replyLanguage"));
          accepted.ui = rest;
        }
        break;
      case "memory": {
        // [W6-C0] 记忆不由仓库决定：项目级只能关闭（D9）
        const memory = project.memory ?? {};
        if (Object.keys(memory).some((k) => k !== "enabled") || memory.enabled === true)
          warnings.push(msg().config.merge.projectMemoryOnlyDisable(label));
        if (memory.enabled === false) accepted.memory = { enabled: false };
        break;
      }
      case "tools": {
        const tools = project.tools ?? {};
        const result: ToolsConfig = {};
        for (const sub of Object.keys(tools)) {
          if (sub !== "disabled" && sub !== "preset")
            warnings.push(
              msg().config.merge.projectOnlyKeys(
                label,
                "tools.disabled / tools.preset",
                `tools.${sub}`,
              ),
            );
        }
        if (tools.disabled !== undefined) result.disabled = [...tools.disabled];
        if (tools.preset !== undefined) {
          if (isPresetStricterOrEqual(tools.preset, currentPreset)) result.preset = tools.preset;
          else
            warnings.push(
              msg().config.merge.projectPresetLoosen(label, tools.preset, currentPreset),
            );
        }
        if (Object.keys(result).length > 0) accepted.tools = result;
        break;
      }
      case "codemode": {
        const codemode = project.codemode ?? {};
        for (const [sub, v] of Object.entries(codemode)) {
          if (sub === "mode" && v === "off") continue;
          const ignored = `codemode.${sub}${sub === "mode" ? ` ${String(v)}` : ""}`;
          warnings.push(
            msg().config.merge.projectOnlyValue(label, "codemode.mode", "off", ignored),
          );
        }
        if (codemode.mode === "off") accepted.codemode = { mode: "off" };
        break;
      }
      case "checkpoints": {
        const checkpoints = restrictCheckpoints(
          project.checkpoints ?? {},
          currentMaxFileBytes,
          label,
          warnings,
        );
        if (checkpoints !== undefined) accepted.checkpoints = checkpoints;
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
      case "sandbox": {
        // [S2] 只能收紧：network "deny"。enabled / bash 两个方向都不是单纯更严（打开 bash 沙箱会让 default
        // 模式免审批，关闭会让命令裸跑），writable 是放宽，一律忽略。
        const sandbox = project.sandbox ?? {};
        for (const [sub, v] of Object.entries(sandbox)) {
          if (sub === "network" && v === "deny") continue;
          const ignored = `sandbox.${sub}${sub === "network" ? ` ${String(v)}` : ""}`;
          warnings.push(
            msg().config.merge.projectOnlyValue(label, "sandbox.network", "deny", ignored),
          );
        }
        if (sandbox.network === "deny") accepted.sandbox = { network: "deny" };
        break;
      }
      default:
        warnings.push(msg().config.merge.projectIgnored(label, key));
    }
  }
  return { accepted, warnings };
}

/** [W5-C0] 项目级 plan：只接受 `bash`，且只能更严（deny < readonly < ask）。 */
function restrictPlan(
  plan: PlanConfig,
  current: PlanBashMode,
  label: string,
  warnings: string[],
): PlanConfig | undefined {
  for (const sub of Object.keys(plan)) {
    if (sub !== "bash")
      warnings.push(msg().config.merge.projectOnlyKeys(label, "plan.bash", `plan.${sub}`));
  }
  if (plan.bash === undefined) return undefined;
  const order = PLAN_BASH_MODES_STRICT_FIRST;
  if (order.indexOf(plan.bash) <= order.indexOf(current)) return { bash: plan.bash };
  warnings.push(msg().config.merge.projectPlanBashTighten(label, plan.bash, current));
  return undefined;
}

/** 项目级检查点：只能关闭、只能调小单文件上限（多备份即多占用户磁盘）；`keep` 只认用户级。 */
function restrictCheckpoints(
  checkpoints: CheckpointsConfig,
  currentMaxFileBytes: number,
  label: string,
  warnings: string[],
): CheckpointsConfig | undefined {
  const result: CheckpointsConfig = {};
  for (const [sub, v] of Object.entries(checkpoints)) {
    if (sub === "mode") {
      if (v === "off") result.mode = "off";
      else
        warnings.push(
          msg().config.merge.projectOnlyValue(label, "checkpoints.mode", "off", String(v)),
        );
    } else if (sub === "maxFileBytes" && typeof v === "number") {
      if (v <= currentMaxFileBytes) result.maxFileBytes = v;
      else
        warnings.push(
          msg().config.merge.projectLowerOnly(
            label,
            "checkpoints.maxFileBytes",
            v,
            currentMaxFileBytes,
          ),
        );
    } else {
      warnings.push(msg().config.merge.projectIgnored(label, `checkpoints.${sub}`));
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function restrictPermission(
  permission: PermissionConfig,
  currentMode: PermissionMode,
  label: string,
  warnings: string[],
): PermissionConfig | undefined {
  const result: PermissionConfig = {};
  if (permission.allow !== undefined && permission.allow.length > 0) {
    warnings.push(msg().config.merge.projectNoAllow(label, permission.allow.join(", ")));
  }
  if (permission.deny !== undefined && permission.deny.length > 0)
    result.deny = [...permission.deny];
  if (permission.builtinDeny !== undefined) {
    warnings.push(msg().config.merge.projectNoBuiltinDeny(label));
  }
  if (permission.autoModel !== undefined) {
    warnings.push(msg().config.merge.projectIgnored(label, "permission.autoModel"));
  }
  if (permission.autoSafeCommands !== undefined && permission.autoSafeCommands.length > 0) {
    warnings.push(msg().config.merge.projectNoAutoSafe(label));
  }
  if (permission.mode === "auto" || permission.mode === "full-auto") {
    warnings.push(msg().config.merge.projectModeLoosen(label, permission.mode));
  } else if (permission.mode !== undefined) {
    if (isAtLeastAsStrict(permission.mode, currentMode)) {
      result.mode = permission.mode;
    } else {
      warnings.push(msg().config.merge.projectModeTighten(label, permission.mode, currentMode));
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
  /** `--tools-preset`。 */
  toolsPreset?: ToolsPresetInput | undefined;
  /** `--codemode`。 */
  codemode?: CodemodeMode | undefined;
  /** [W6-C0] `--memory` / `--no-memory`：覆盖 `memory.enabled`。 */
  memory?: boolean | undefined;
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
  if (cli.toolsPreset !== undefined) out.tools = { preset: cli.toolsPreset };
  if (cli.codemode !== undefined) out.codemode = { mode: cli.codemode };
  if (cli.memory !== undefined) out.memory = { enabled: cli.memory };
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
    const restricted = restrictProjectConfig(
      project,
      baseline,
      projectLabel,
      config.tools?.preset ?? "default",
      config.checkpoints?.maxFileBytes ?? DEFAULT_CHECKPOINTS_CONFIG.maxFileBytes,
      config.plan?.bash ?? "readonly",
    );
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
