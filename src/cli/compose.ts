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
 * | ui                   | 传了 io 时：终端 → 迷你 TUI（懒加载），否则文本问答；stdin 非 TTY 不问 |
 *
 * **跨步骤状态走闭包（表 B·B13，有意保留）**：`RuntimeDeps.tools.create` 的入参没有 skills / 提示模板，
 * 第 13 步 `resources.discover` 把完整对象存进 `ComposeState`，组装会话时（compose-session.ts 的技能
 * 索引与 `/skill:` 展开）再取。不为此扩契约：两步都在同一个 `createRuntimeDeps()` 闭包里，顺序由
 * bootstrap 固定。
 *
 * **工具注册点（给 B10 等）**：`ComposeOptions.toolFactories` 与 `DEFAULT_TOOL_FACTORIES`。工厂在
 * 第 12 步建注册表时调用，产物以 `builtin` 来源注册（受预设管理）；工厂拿不到会话对象本身，执行期
 * 需要会话时用 `ctx.session()`，嵌套调用其它工具用 `ToolContext.tools.executeTool`（走完整门禁）。
 */

import type { ApiRegistry } from "../ai/apis/api.js";
import { formatModelRef } from "../ai/providers/channels.js";
import type { ModelRef, ProviderData } from "../ai/types.js";
import type { AgentSession } from "../agent/types.js";
import type { AmaConfig } from "../config/types.js";
import { PermissionPipeline } from "../permissions/pipeline.js";
import { BUILTIN_DENY_RULES, parseRule } from "../permissions/rules.js";
import type { Rule } from "../permissions/types.js";
import { discoverSkills, skillSources } from "../skills/discover.js";
import { discoverPromptTemplates, promptSources } from "../skills/templates.js";
import { applyCodemodeMode } from "../codemode/modes.js";
import { detectSandboxCapability, type SandboxCapability } from "../codemode/capability.js";
import { codemodeToolFactory } from "../codemode/tool.js";
import { PresetToolRegistry, resolvePreset } from "../tools/presets.js";
import { builtinTools } from "../tools/registry.js";
import type { ToolDefinition, ToolRegistryApi } from "../tools/types.js";
import { takeCodemodeNotice } from "./codemode-notice.js";
import { buildProviderRegistry } from "./compose-providers.js";
import {
  composeSession,
  emptyComposeState,
  type ComposeState,
  type LogFn,
} from "./compose-session.js";
import { createSessionStore } from "./compose-store.js";
import type { CliIo, InteractiveUi, ModeRunner, RuntimeDeps } from "./deps.js";
import type { RuntimeMode } from "./runtime.js";
import { defaultSendUser } from "./startup-steps.js";
import type { StartupUiOptions } from "../modes/interactive/startup-ui.js";
import type { TextUiIo } from "../modes/startup-ui-text.js";

export interface ToolFactoryContext {
  config: AmaConfig;
  cwd: string;
  mode: RuntimeMode;
  registry: ToolRegistryApi;
  /** 会话组装之后才有值；工具执行期取用。 */
  session(): AgentSession | undefined;
  /** 组装期 warning（组装会话时交给 assembly.warn）。 */
  warn(message: string): void;
}

/** 返回 undefined = 本次不注册（例如配置关闭）。 */
export type ToolFactory = (ctx: ToolFactoryContext) => ToolDefinition | undefined;

/** 缺省工具工厂：codemode（生效模式为 off 时不注册；缺省跟随预设，见 tools/presets.ts）。 */
export const DEFAULT_TOOL_FACTORIES: readonly ToolFactory[] = [codemodeToolFactory()];

export interface ComposeOptions {
  /** 追加 / 覆盖供应商（SDK）。 */
  providers?: ProviderData[];
  apis?: ApiRegistry;
  /** SDK 追加的工具（来源 sdk，总在活动集里）。 */
  extraTools?: ToolDefinition[];
  /** 缺省 DEFAULT_TOOL_FACTORIES。 */
  toolFactories?: readonly ToolFactory[];
  /**
   * 沙箱能力（缺省按运行时 Node 探测）。决定 default 预设是否开 codemode；给了且没给
   * `toolFactories` 时 codemode 工厂也用它（测试据此不随 Node 版本变化）。
   */
  sandboxCapability?: SandboxCapability;
  /** 覆盖启动期问答；缺省见 `defaultStartupUi`。 */
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

/**
 * 第 12 步：内置工具 + 工厂 + extraTools，按预设定活动集；warning 留给组装会话时报告。
 *
 * 先跑工厂（产物暂不注册）再解析预设：codemode 是否可用决定预设与模式；`only` 模式活动集独占
 * （codemode/modes.ts）。工厂拿到的 `registry` 在执行期才读，此时已登记完全部工具。default 预设
 * 跟随预设而 codemode 缺省关闭时（非 strict 运行时）提示一次（cli/codemode-notice.ts）。
 */
export function createTools(
  input: {
    config: AmaConfig;
    cwd: string;
    mode: RuntimeMode;
    paths?: { configDir: string; dataDir: string } | undefined;
  },
  options: ComposeOptions,
  state: ComposeState,
): PresetToolRegistry {
  const registry = new PresetToolRegistry();
  const capability = options.sandboxCapability ?? detectSandboxCapability();
  const factories =
    options.toolFactories ??
    (options.sandboxCapability !== undefined
      ? [codemodeToolFactory({ capability })]
      : DEFAULT_TOOL_FACTORIES);
  const bash =
    input.config.tools?.bashTimeoutMs !== undefined
      ? { defaultTimeoutMs: input.config.tools.bashTimeoutMs }
      : {};
  const builtins = builtinTools({
    bash,
    read: { supportsImages: (ctx) => modelAcceptsImages(state, ctx.model) },
  });
  const ctx: ToolFactoryContext = {
    ...input,
    registry,
    session: () => state.session,
    warn: (message) => state.warnings.push(message),
  };
  const produced: ToolDefinition[] = [];
  for (const factory of factories) {
    try {
      const tool = factory(ctx);
      if (tool !== undefined) produced.push(tool);
    } catch (error) {
      state.warnings.push(`工具工厂失败：${(error as Error).message}`);
    }
  }
  const extra = options.extraTools ?? [];
  const names = new Set([...builtins, ...produced, ...extra].map((tool) => tool.name));
  const preset = resolvePreset({
    config: input.config,
    available: (name) => names.has(name),
    strict: capability.strict,
  });
  for (const tool of [...builtins, ...produced]) {
    try {
      registry.register(tool, "builtin");
    } catch (error) {
      state.warnings.push(`工具 ${tool.name} 注册失败：${(error as Error).message}`);
    }
  }
  for (const tool of extra) registry.register(tool, "sdk");
  applyCodemodeMode(registry, preset);
  state.warnings.push(...preset.warnings);
  // 一次性提示只给有人看的界面（交互 / 行式）；-p 与 RPC 的 stderr 常被脚本解析，不打扰。
  if (input.paths !== undefined && (input.mode === "interactive" || input.mode === "line")) {
    const notice = takeCodemodeNotice({ config: input.config, capability, ...input.paths });
    if (notice !== undefined) state.warnings.push(notice);
  }
  return registry;
}

/** 当前模型是否收图片（read 工具用）；查不到模型时按收（交给协议层过滤）。 */
export function modelAcceptsImages(state: ComposeState, model: ModelRef | undefined): boolean {
  if (model === undefined || state.providers === undefined) return true;
  const found = state.providers.findModel(formatModelRef(model));
  return found.ok ? found.model.input.includes("image") : true;
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

type UiIo = Pick<CliIo, "stdinIsTTY" | "stdoutIsTTY" | "env">;

/** 回调先于模式运行；终端界面只在加载时 import，文本回退不加载终端组件库。 */
function lazyUi(load: () => Promise<Required<InteractiveUi>>): Required<InteractiveUi> {
  let ui: Promise<Required<InteractiveUi>> | undefined;
  const get = (): Promise<Required<InteractiveUi>> => (ui ??= load());
  return {
    promptTrust: async (cwd, resources) => (await get()).promptTrust(cwd, resources),
    pickSession: async (items) => (await get()).pickSession(items),
    pickModel: async (providers, reason) => (await get()).pickModel(providers, reason),
    askCwd: async (missing) => (await get()).askCwd(missing),
  };
}

/**
 * CLI 缺省的启动期问答（第 7 / 8 / 11 步，只在 interactive / line 模式被调用）：
 * stdin 非 TTY 时不问（管道里的输入留给行式界面，保持非交互分支）；stdout 也是终端、
 * `TERM` 不是 dumb 且没有 `--no-tui` 时用迷你 TUI，否则写 stderr、从 stdin 读一行。
 */
export function defaultStartupUi(
  io: UiIo,
  options: { noTui?: boolean | undefined; tui?: StartupUiOptions; text?: TextUiIo } = {},
): InteractiveUi | undefined {
  if (!io.stdinIsTTY) return undefined;
  if (io.stdoutIsTTY && io.env["TERM"] !== "dumb" && options.noTui !== true) {
    return lazyUi(async () =>
      (await import("../modes/interactive/startup-ui.js")).createStartupUi(options.tui),
    );
  }
  return lazyUi(async () =>
    (await import("../modes/startup-ui-text.js")).createTextStartupUi(
      options.text ?? { stdin: process.stdin, write: (text) => process.stderr.write(text) },
    ),
  );
}

export function createRuntimeDeps(
  options: ComposeOptions & { io?: UiIo; noTui?: boolean | undefined } = {},
): RuntimeDeps {
  const state = emptyComposeState();
  const deps: RuntimeDeps = {
    providers: {
      create: async (input) => {
        const registry = await buildProviderRegistry(input, {
          providers: options.providers,
          apis: options.apis,
          env: options.env,
          includeFake: options.includeFake,
          probeLocal: options.probeLocal,
          warn: (message) => state.warnings.push(message),
        });
        state.providers = registry;
        return registry;
      },
    },
    sessions: createSessionStore(),
    tools: { create: (input) => createTools(input, options, state) },
    permissions: {
      create: (input) =>
        new PermissionPipeline({
          mode: input.mode,
          rules: buildRules(input.rules, input.builtinDeny, (m) => state.warnings.push(m)),
          cwd: input.cwd,
          ...(input.autoSafeCommands !== undefined
            ? { autoSafeCommands: input.autoSafeCommands }
            : {}),
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
  const ui =
    options.ui ??
    (options.io !== undefined ? defaultStartupUi(options.io, { noTui: options.noTui }) : undefined);
  if (ui !== undefined) deps.ui = ui;
  return deps;
}
