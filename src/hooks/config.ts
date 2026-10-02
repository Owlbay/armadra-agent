/**
 * 命令式 Hook 的发现与合并（设计 §6.1「配置位置与合并」「信任边界」）。[B5]
 *
 * - 三层：`<configDir>/hooks.json`（user）→ profile `hooksFile`（profile，视同用户级）→
 *   `<cwd>/.ama/hooks.json`（project，需信任）；事件数组按此顺序**拼接**，不覆盖。
 * - 未信任时项目级跳过（`skippedProject` 交给 doctor / 状态栏提示）。
 * - 语法 / 字段错误抛 StartupError（退出码 3）；非法 matcher 同样按字段错误处理。
 */

import { existsSync } from "node:fs";
import { StartupError } from "../errors.js";
import { loadConfigFile } from "../config/load.js";
import { HOOKS_FILE, projectFile, userFile } from "../config/paths.js";
import { HOOK_TIMEOUT_MAX_MS } from "../config/schema.js";
import { checkMatcher } from "./matcher.js";
import type { HookConfig, HookEvent, HookSource } from "./types.js";
import { HOOK_EVENTS } from "./types.js";
import { msg } from "../i18n/index.js";

export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/** 展平后的一条 Hook 命令。 */
export interface LoadedHook {
  event: HookEvent;
  matcher?: string;
  command: string;
  timeoutMs: number;
  source: HookSource;
  /** 来源文件（SDK 为 "sdk"）。 */
  file: string;
  /** 全局配置顺序（additionalContext 拼接顺序）。 */
  order: number;
}

export interface HookLayer {
  source: HookSource;
  file: string;
  config: HookConfig;
}

export function clampTimeout(value: number | undefined, fallback: number): number {
  const v = value ?? fallback;
  return Math.min(Math.max(1, Math.floor(v)), HOOK_TIMEOUT_MAX_MS);
}

/** 把若干层按顺序展平；`defaultTimeoutMs` 来自 config.hooks.timeoutMs。 */
export function flattenHookLayers(
  layers: readonly HookLayer[],
  defaultTimeoutMs = DEFAULT_HOOK_TIMEOUT_MS,
): LoadedHook[] {
  const hooks: LoadedHook[] = [];
  let order = 0;
  for (const layer of layers) {
    for (const event of HOOK_EVENTS) {
      for (const group of layer.config.hooks[event] ?? []) {
        for (const command of group.hooks) {
          const hook: LoadedHook = {
            event,
            command: command.command,
            timeoutMs: clampTimeout(command.timeoutMs, defaultTimeoutMs),
            source: layer.source,
            file: layer.file,
            order: order++,
          };
          if (group.matcher !== undefined) hook.matcher = group.matcher;
          hooks.push(hook);
        }
      }
    }
  }
  return hooks;
}

function validateMatchers(file: string, config: HookConfig): void {
  const problems: string[] = [];
  for (const event of HOOK_EVENTS) {
    (config.hooks[event] ?? []).forEach((group, index) => {
      const error = checkMatcher(group.matcher);
      if (error !== undefined) problems.push(`hooks.${event}[${index}].matcher: ${error}`);
    });
  }
  if (problems.length > 0) {
    throw new StartupError(
      "config_invalid",
      msg().drivers.hooks.configInvalid(problems.map((p) => `${file}: ${p}`).join("\n  ")),
      3,
    );
  }
}

function readLayer(source: HookSource, file: string, required: boolean): HookLayer | undefined {
  const loaded = loadConfigFile("hooks", file, { required });
  if (loaded === undefined) return undefined;
  validateMatchers(file, loaded.value);
  return { source, file, config: loaded.value };
}

export interface LoadHookConfigsInput {
  configDir: string;
  cwd: string;
  /** profile.hooksFile（必须存在）。 */
  profileHooksFile?: string | undefined;
  trusted: boolean;
  /** config.hooks.timeoutMs。 */
  defaultTimeoutMs?: number | undefined;
}

export interface LoadHookConfigsResult {
  hooks: LoadedHook[];
  layers: HookLayer[];
  /** 项目级存在但因未信任被跳过的文件。 */
  skippedProject?: string;
  warnings: string[];
}

export function loadHookConfigs(input: LoadHookConfigsInput): LoadHookConfigsResult {
  const layers: HookLayer[] = [];
  const warnings: string[] = [];
  const user = readLayer("user", userFile(input, HOOKS_FILE), false);
  if (user !== undefined) layers.push(user);
  if (input.profileHooksFile !== undefined) {
    const profile = readLayer("profile", input.profileHooksFile, true);
    if (profile !== undefined) layers.push(profile);
  }
  const projectPath = projectFile(input.cwd, HOOKS_FILE);
  let skippedProject: string | undefined;
  if (input.trusted) {
    const project = readLayer("project", projectPath, false);
    if (project !== undefined) layers.push(project);
  } else if (existsSync(projectPath)) {
    // 未信任时不解析内容（不让不可信文件的语法错误阻断启动），只看存在性。
    skippedProject = projectPath;
    warnings.push(msg().drivers.hooks.projectUntrusted(projectPath));
  }
  const result: LoadHookConfigsResult = {
    hooks: flattenHookLayers(layers, input.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS),
    layers,
    warnings,
  };
  if (skippedProject !== undefined) result.skippedProject = skippedProject;
  return result;
}

/** SDK 传入的 HookConfig（视同用户级，不经过信任）。 */
export function hooksFromConfig(
  config: HookConfig,
  defaultTimeoutMs = DEFAULT_HOOK_TIMEOUT_MS,
): LoadedHook[] {
  validateMatchers("sdk", config);
  return flattenHookLayers([{ source: "sdk", file: "sdk", config }], defaultTimeoutMs);
}
