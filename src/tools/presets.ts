/**
 * 工具预设（设计 §5.6）：模型直接看到哪些内置工具。
 *
 * | 预设          | 模型直接看到                              |
 * | ------------- | ----------------------------------------- |
 * | `default`     | read、edit、write、bash、grep、glob       |
 * | `minimal`     | read、edit、write、bash                   |
 * | `codemode-only` | 只有 codemode（其余工具在脚本里调用）   |
 * | `coordinator` | read + 宿主注册的工具                     |
 *
 * - 预设只管**内置**工具；宿主 / SDK 注册的工具（`canvas_*` 等）总在活动集里，除非用户
 *   `--tools a,b,c` 整组替换（之后只用列出的名字）。
 * - `tools.default`：`+name` / `-name` 在预设上增减；不带前缀的名字整组替换预设的内置工具，
 *   之后再应用带前缀的项。未注册的名字记 warning 并忽略。
 * - `codemode` 是 `codemode-only` 的旧名（0.3.0），配置合并与命令行解析时折成规范名。
 * - codemode 开关跟随预设（`presetCodemodeMode`）：`default` → `on`（只在沙箱 strict，即 Node ≥ 25 隔离
 *   网络时；Node 22 / 24 → `off`），`codemode-only` → `only`，`minimal` / `coordinator` → `off`。
 *   `codemode.mode` 显式配置覆盖（缺省配置不写这个键，以后调整映射能惠及老用户）。
 * - `coordinator` 预设即使显式 `on`，脚本里能调用的工具也只限活动集（read + 宿主工具），见
 *   `codemodeCallableFilter`：协调者「不写文件、不跑 bash」的约定不能经 codemode 绕过。
 * - codemode 工具由 B10 经组装根的 `toolFactories` 注册（生效模式为 off 时不注册）；不可用
 *   （例如 `codemode.requireStrict` 而运行时 Node 不隔离网络）时 codemode-only 预设**回退到 default 并
 *   warning**（不报错：零配置用户不应因此起不来），显式 `on` 同样忽略；跟随预设得到的 `on` 静默回退。
 * - `only` 模式活动集独占：宿主 / SDK 工具也不直接暴露，只能在脚本里调用（`exclusive`）。
 */

import { detectSandboxCapability } from "../codemode/capability.js";
import {
  canonicalPreset,
  type AmaConfig,
  type CodemodeMode,
  type ToolsPreset,
} from "../config/types.js";
import { ToolRegistry } from "./registry.js";
import type { ToolDefinition, ToolSource } from "./types.js";

export const CODEMODE_TOOL = "codemode";

/** 各预设下模型直接看到的内置工具（codemode-only 预设见 `resolvePreset`）。 */
export const PRESET_TOOLS: Readonly<Record<ToolsPreset, readonly string[]>> = Object.freeze({
  default: ["bash", "edit", "glob", "grep", "read", "write"],
  minimal: ["bash", "edit", "read", "write"],
  "codemode-only": [CODEMODE_TOOL],
  coordinator: ["read"],
});

/**
 * 预设对应的 codemode 模式（没有显式 `codemode.mode` 时）。`default` 只在沙箱 strict（Node ≥ 25，
 * 权限模型同时隔离网络）时开 `on`：Node 22 / 24 下 codemode 属 execute 类，每次都要审批，`-p` 下
 * 直接被拒，所以缺省关闭（启动时提示一次，见 cli/codemode-notice.ts）。
 */
export function presetCodemodeMode(preset: ToolsPreset, strict: boolean): CodemodeMode {
  switch (preset) {
    case "codemode-only":
      return "only";
    case "default":
      return strict ? "on" : "off";
    default:
      return "off";
  }
}

export interface CodemodeModeResolution {
  mode: CodemodeMode;
  /** `config`：显式 `codemode.mode`；`preset`：跟随预设。 */
  source: "config" | "preset";
  preset: ToolsPreset;
  strict: boolean;
}

/** 生效的 codemode 模式及其来源；`strict` 缺省按运行时探测（测试与组装根可注入）。 */
export function resolveCodemodeMode(
  config: Pick<AmaConfig, "tools" | "codemode">,
  strict: boolean = detectSandboxCapability().strict,
): CodemodeModeResolution {
  const preset = canonicalPreset(config.tools?.preset) ?? "default";
  const explicit = config.codemode?.mode;
  if (explicit !== undefined) return { mode: explicit, source: "config", preset, strict };
  return { mode: presetCodemodeMode(preset, strict), source: "preset", preset, strict };
}

/** 生效的 codemode 模式：显式配置优先，否则跟随预设。 */
export function effectiveCodemodeMode(
  config: Pick<AmaConfig, "tools" | "codemode">,
  strict?: boolean,
): CodemodeMode {
  return resolveCodemodeMode(config, strict).mode;
}

/**
 * codemode 脚本里可调用工具的范围：`coordinator` 预设只能调活动集里的工具（`"active"`），其它预设
 * 不限（`undefined`；`on` 模式下脚本还能调没直接暴露的 ls / task / todo 等）。
 */
export function codemodeCallableFilter(config: Pick<AmaConfig, "tools">): "active" | undefined {
  return canonicalPreset(config.tools?.preset) === "coordinator" ? "active" : undefined;
}

/**
 * `tools.default` 微调：不带前缀的名字整组替换 `base`，再依次应用 `+name` / `-name`。
 * 返回去重后的名字（保持首次出现顺序）。
 */
export function applyToolAdjustments(
  base: readonly string[],
  adjustments: readonly string[] | undefined,
): string[] {
  if (adjustments === undefined || adjustments.length === 0) return [...base];
  const plain = adjustments.filter((a) => !a.startsWith("+") && !a.startsWith("-"));
  const names = new Set(plain.length > 0 ? plain.map((a) => a.trim()) : base);
  for (const item of adjustments) {
    const name = item.slice(1).trim();
    if (item.startsWith("+")) names.add(name);
    else if (item.startsWith("-")) names.delete(name);
  }
  names.delete("");
  return [...names];
}

export interface PresetResolution {
  /** 生效的预设（codemode 工具缺失时回退为 default）。 */
  preset: ToolsPreset;
  codemode: CodemodeMode;
  /** 活动的内置工具名（按名排序）。 */
  builtin: string[];
  warnings: string[];
}

export function resolvePreset(input: {
  config: Pick<AmaConfig, "tools" | "codemode">;
  /** 该名字是否已注册（且未禁用）。 */
  available(name: string): boolean;
  /** 沙箱是否 strict；缺省按运行时探测。 */
  strict?: boolean;
}): PresetResolution {
  const warnings: string[] = [];
  const resolved = resolveCodemodeMode(input.config, input.strict);
  let preset: ToolsPreset = resolved.preset;
  let codemode = resolved.mode;
  // 跟随预设得到的 on（default 预设）在 codemode 不可用时静默回退：零配置不该因此出 warning。
  if (codemode === "on" && resolved.source === "preset" && !input.available(CODEMODE_TOOL)) {
    codemode = "off";
  }
  if (codemode !== "off" && !input.available(CODEMODE_TOOL)) {
    warnings.push(
      preset === "codemode-only"
        ? "工具预设 codemode-only 需要 codemode 工具（不可用），已回退到 default"
        : `codemode.mode ${codemode} 需要 codemode 工具（不可用），已忽略`,
    );
    if (preset === "codemode-only") preset = "default";
    codemode = "off";
  }
  let base: string[];
  if (codemode === "only") base = [CODEMODE_TOOL];
  else {
    base = [...PRESET_TOOLS[preset === "codemode-only" ? "default" : preset]];
    if (codemode === "on") base.push(CODEMODE_TOOL);
  }
  const names: string[] = [];
  for (const name of applyToolAdjustments(base, input.config.tools?.default)) {
    if (input.available(name)) names.push(name);
    else warnings.push(`tools.default：未知工具 ${name}，已忽略`);
  }
  return { preset, codemode, builtin: names.sort(), warnings };
}

type RegisterListener = (tool: ToolDefinition, source: ToolSource) => void;

/**
 * 带预设的注册表：活动集 = 预设里的内置工具 + 全部非内置工具；`setActive()`（`--tools`）之后
 * 退回整组替换语义。`onRegister` 让组装根把会话创建之后才注册的宿主工具追加进会话。
 */
export class PresetToolRegistry extends ToolRegistry {
  private presetNames: ReadonlySet<string> | undefined;
  private exclusive = false;
  private explicit = false;
  private readonly listeners = new Set<RegisterListener>();

  /**
   * 设预设的内置工具；undefined = 全部内置工具。`exclusive`（codemode only）：活动集只有这些名字，
   * 宿主 / SDK 工具也不进活动集。
   */
  setPresetTools(
    names: readonly string[] | undefined,
    options: { exclusive?: boolean } = {},
  ): void {
    this.presetNames = names === undefined ? undefined : new Set(names);
    this.exclusive = names !== undefined && options.exclusive === true;
  }

  /** 是否被 `setActive` 整组替换过。 */
  get hasExplicitActive(): boolean {
    return this.explicit;
  }

  override setActive(names: readonly string[]): void {
    super.setActive(names);
    this.explicit = true;
  }

  override active(): readonly ToolDefinition[] {
    const preset = this.presetNames;
    if (this.explicit || preset === undefined) return super.active();
    return this.list()
      .filter((name) => preset.has(name) || (!this.exclusive && this.sourceOf(name) !== "builtin"))
      .map((name) => this.get(name))
      .filter((tool): tool is ToolDefinition => tool !== undefined);
  }

  override register(tool: ToolDefinition, source: ToolSource): void {
    super.register(tool, source);
    for (const listener of [...this.listeners]) listener(tool, source);
  }

  onRegister(listener: RegisterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
