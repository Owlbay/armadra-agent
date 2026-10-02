/**
 * 组装根（composition root，实施计划 §1）：`createRuntimeDeps()` 把各批次的实现装成 bootstrap 要的
 * `RuntimeDeps`。CLI（main.ts 动态 import）与 SDK（sdk.ts）共用。[B6]
 *
 * | 字段                 | 实现                                                                 |
 * | -------------------- | -------------------------------------------------------------------- |
 * | providers.create     | compose-providers.ts（ProviderRegistry + auth + 零配置本地探测）     |
 * | sessions.*           | compose-store.ts（SessionManager 五种请求、list / show / prune）     |
 * | tools.create         | PresetToolRegistry：内置 + 工具工厂 + extraTools，按预设定活动集     |
 * | permissions.create   | 内置 deny（按 builtinDeny 过滤）+ 逐条 parseRule → PermissionPipeline |
 * | resources.discover   | skills / 提示模板发现，完整对象存进闭包状态                          |
 * | session.create       | compose-session.ts                                                   |
 * | modes                | line / print / rpc 懒加载；interactive 在 B7 之前回落到 line         |
 *
 * **工具注册点（给 B10 等）**：`ComposeOptions.toolFactories` 与 `DEFAULT_TOOL_FACTORIES`。工厂在
 * 第 12 步建注册表时调用，产物以 `builtin` 来源注册（受预设管理）；工厂拿不到会话对象本身，执行期
 * 需要会话时用 `ctx.session()`，嵌套调用其它工具用 `ToolContext.tools.executeTool`（走完整门禁）。
 */

import type { ApiRegistry } from "../ai/apis/api.js";
import type { ProviderData } from "../ai/types.js";
import type { AgentSession } from "../agent/types.js";
import type { AmaConfig } from "../config/types.js";
import { PermissionPipeline } from "../permissions/pipeline.js";
import { BUILTIN_DENY_RULES, parseRule } from "../permissions/rules.js";
import type { Rule } from "../permissions/types.js";
import { discoverSkills, skillSources } from "../skills/discover.js";
import { discoverPromptTemplates, promptSources } from "../skills/templates.js";
import { PresetToolRegistry, resolvePreset } from "../tools/presets.js";
import { builtinTools } from "../tools/registry.js";
import type { ToolDefinition, ToolRegistryApi } from "../tools/types.js";
import { buildProviderRegistry } from "./compose-providers.js";
import {
  composeSession,
  emptyComposeState,
  type ComposeState,
  type LogFn,
} from "./compose-session.js";
import { createSessionStore } from "./compose-store.js";
import type { InteractiveUi, ModeRunner, RuntimeDeps } from "./deps.js";
import type { RuntimeMode } from "./runtime.js";
import { defaultSendUser } from "./startup-steps.js";

export interface ToolFactoryContext {
  config: AmaConfig;
  cwd: string;
  mode: RuntimeMode;
  registry: ToolRegistryApi;
  /** 会话组装之后才有值；工具执行期取用。 */
  session(): AgentSession | undefined;
}

/** 返回 undefined = 本次不注册（例如配置关闭）。 */
export type ToolFactory = (ctx: ToolFactoryContext) => ToolDefinition | undefined;

/** 缺省工具工厂（B10 在这里加 codemode）。 */
export const DEFAULT_TOOL_FACTORIES: readonly ToolFactory[] = [];

export interface ComposeOptions {
  /** 追加 / 覆盖供应商（SDK）。 */
  providers?: ProviderData[];
  apis?: ApiRegistry;
  /** SDK 追加的工具（来源 sdk，总在活动集里）。 */
  extraTools?: ToolDefinition[];
  /** 缺省 DEFAULT_TOOL_FACTORIES。 */
  toolFactories?: readonly ToolFactory[];
  ui?: InteractiveUi;
  modes?: Partial<Record<RuntimeMode, ModeRunner>>;
  /** key 发现用的环境（缺省 process.env）。 */
  env?: NodeJS.ProcessEnv;
  approvalTimeoutMs?: number;
  /** 零配置时探测本地 ollama / lmstudio（缺省 true，`AMA_NO_LOCAL_PROBE=1` 关闭）。 */
  probeLocal?: boolean;
  includeFake?: boolean;
  log?: LogFn;
}

export function lazyMode(load: () => Promise<ModeRunner>): ModeRunner {
  return async (runtime, context) => (await load())(runtime, context);
}

/** 缺省模式（懒加载：子命令与 --version 不加载模式实现）。 */
export const DEFAULT_MODES: Readonly<Partial<Record<RuntimeMode, ModeRunner>>> = {
  print: lazyMode(async () => (await import("../modes/print/print-mode.js")).runPrintMode),
  rpc: lazyMode(async () => (await import("../modes/rpc/rpc-mode.js")).runRpcMode),
  line: lazyMode(async () => (await import("../modes/interactive/line/line-mode.js")).runLineMode),
  interactive: lazyMode(
    async () => (await import("../modes/interactive/interactive-mode.js")).runInteractiveMode,
  ),
};

/** 第 12 步：内置工具 + 工厂 + extraTools，按预设定活动集；warning 留给组装会话时报告。 */
export function createTools(
  input: { config: AmaConfig; cwd: string; mode: RuntimeMode },
  options: ComposeOptions,
  state: ComposeState,
): PresetToolRegistry {
  const registry = new PresetToolRegistry();
  const bash =
    input.config.tools?.bashTimeoutMs !== undefined
      ? { defaultTimeoutMs: input.config.tools.bashTimeoutMs }
      : {};
  for (const tool of builtinTools({ bash })) registry.register(tool, "builtin");
  const ctx: ToolFactoryContext = { ...input, registry, session: () => state.session };
  for (const factory of options.toolFactories ?? DEFAULT_TOOL_FACTORIES) {
    try {
      const tool = factory(ctx);
      if (tool !== undefined) registry.register(tool, "builtin");
    } catch (error) {
      state.warnings.push(`工具工厂失败：${(error as Error).message}`);
    }
  }
  for (const tool of options.extraTools ?? []) registry.register(tool, "sdk");
  const preset = resolvePreset({
    config: input.config,
    available: (name) => registry.get(name) !== undefined,
  });
  registry.setPresetTools(preset.builtin);
  state.warnings.push(...preset.warnings);
  return registry;
}

/** 第 14 步前：内置 deny（builtinDeny 过滤）+ 用户规则；非法规则 warning 后跳过。 */
export function buildRules(
  specs: readonly { effect: "allow" | "deny"; raw: string; source: Rule["source"] }[],
  builtinDeny: boolean | readonly string[] | undefined,
  warn: (message: string) => void,
): Rule[] {
  const rules: Rule[] = [];
  if (builtinDeny !== false) {
    for (const raw of BUILTIN_DENY_RULES) {
      if (Array.isArray(builtinDeny) && builtinDeny.includes(raw)) continue;
      rules.push(parseRule(raw, "deny", "builtin"));
    }
  }
  for (const spec of specs) {
    try {
      rules.push(parseRule(spec.raw, spec.effect, spec.source));
    } catch (error) {
      warn(`权限规则（${spec.source}）：${(error as Error).message}，已忽略`);
    }
  }
  return rules;
}

export function createRuntimeDeps(options: ComposeOptions = {}): RuntimeDeps {
  const state = emptyComposeState();
  const deps: RuntimeDeps = {
    providers: {
      create: (input) =>
        buildProviderRegistry(input, {
          providers: options.providers,
          apis: options.apis,
          env: options.env,
          includeFake: options.includeFake,
          probeLocal: options.probeLocal,
          warn: (message) => state.warnings.push(message),
        }),
    },
    sessions: createSessionStore(),
    tools: { create: (input) => createTools(input, options, state) },
    permissions: {
      create: (input) =>
        new PermissionPipeline({
          mode: input.mode,
          rules: buildRules(input.rules, input.builtinDeny, (m) => state.warnings.push(m)),
          cwd: input.cwd,
        }),
    },
    resources: {
      async discover(input) {
        const skills = await discoverSkills(
          skillSources({
            cwd: input.cwd,
            configDir: input.configDir,
            cliDirs: input.extraSkillDirs,
          }),
          { trusted: input.trusted },
        );
        const prompts = await discoverPromptTemplates(
          promptSources({
            cwd: input.cwd,
            configDir: input.configDir,
            profileDirs: input.promptDirs,
          }),
          { trusted: input.trusted },
        );
        state.skills = skills.skills;
        state.templates = prompts.templates;
        const skipped = [...new Set([...skills.skippedUntrusted, ...prompts.skippedUntrusted])];
        const warnings = [...skills.warnings, ...prompts.warnings];
        if (skipped.length > 0)
          warnings.push(`${skipped.length} 个项目级目录因未信任被跳过（--trust 加载）`);
        return {
          skills: skills.skills.map((s) => ({
            name: s.name,
            description: s.description,
            location: s.location,
          })),
          prompts: prompts.templates.map((t) => ({ name: t.name, path: t.path })),
          warnings,
        };
      },
    },
    session: {
      create: (assembly) =>
        composeSession(assembly, state, {
          approvalTimeoutMs: options.approvalTimeoutMs,
          log: options.log,
        }),
    },
    modes: { ...DEFAULT_MODES, ...options.modes },
    sendUser: defaultSendUser,
  };
  if (options.ui !== undefined) deps.ui = options.ui;
  return deps;
}
