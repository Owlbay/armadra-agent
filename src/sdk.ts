/**
 * SDK（设计 §13.1、实施计划 §1.3 C2）。[B6]
 *
 * - `createRuntime(options)`：与 CLI 同一条启动序列（bootstrap 第 3–14 步 + 组装根），读用户级 /
 *   项目级配置、AGENTS.md、Skill、hooks.json、auth.json；不进入任何模式。参数可以写成字段，
 *   也可以直接给 `argv`（与 `ama` 命令行同语法）。
 * - `createAgentSession(options)`：不读文件系统配置的轻量装配——内存会话（或传入的
 *   SessionManager）、选定的工具、规则与回调审批，直接返回 `AgentSessionImpl`
 *   （含 `addTool / updateSystem / navigate` 等扩展方法）。
 *
 * 两者共用组装根（cli/compose*.ts），审批链、系统提示装配、工具预设与缓存行为与 CLI 一致。
 */

import { resolve } from "node:path";
import type { ApiRegistry } from "./ai/apis/api.js";
import { ProviderRegistry } from "./ai/providers/registry.js";
import type { KeyResolverOptions } from "./ai/providers/auth.js";
import type { ModelThinkingLevel, ProviderData } from "./ai/types.js";
import type { AgentSessionImpl } from "./agent/session.js";
import { parseArgs, type ParsedArgs } from "./cli/args.js";
import { bootstrap } from "./cli/bootstrap.js";
import { withExtraProviders } from "./cli/compose-providers.js";
import { composeSession, emptyComposeState, type LogFn } from "./cli/compose-session.js";
import { buildRules, createRuntimeDeps, createTools, type ComposeOptions } from "./cli/compose.js";
import { pickDefaultModel } from "./cli/default-model.js";
import type { CliIo, SessionAssembly } from "./cli/deps.js";
import type { Runtime } from "./cli/runtime.js";
import { findContextFiles } from "./config/context-files.js";
import { DEFAULT_CONFIG, mergeConfig } from "./config/merge.js";
import { resolveConfigDir, resolveDataDir } from "./config/paths.js";
import type { AmaConfig, ToolsPreset } from "./config/types.js";
import { AmaError } from "./errors.js";
import { hooksFromConfig } from "./hooks/config.js";
import { HookDispatcher } from "./hooks/dispatcher.js";
import type { HookConfig } from "./hooks/types.js";
import { AgentEventBus } from "./host/api-impl.js";
import type { InstructionSource } from "./host/types.js";
import { PermissionPipeline } from "./permissions/pipeline.js";
import type { ApprovalDecision, ApprovalRequest, PermissionMode } from "./permissions/types.js";
import { SessionManager } from "./session/manager.js";
import { discoverSkills } from "./skills/discover.js";
import { PresetToolRegistry } from "./tools/presets.js";
import type { ToolDefinition } from "./tools/types.js";

/** [W3-C2] 统计类型：`session.getStats()`、RPC `get_session_stats`、`-p --output-format json` 的 `cache`。 */
export type { SessionCacheStats, SessionStats } from "./agent/types.js";
export type {
  CacheMiss,
  CacheMissReason,
  CacheReporting,
  WarmerStatus,
  WarmingMode,
} from "./ai/cache/types.js";

export interface RuntimeOptions {
  cwd?: string;
  /** 与 `ama` 命令行同语法的参数（字段优先于这里的同名参数）。 */
  argv?: string[];
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  permissionMode?: PermissionMode;
  toolsPreset?: ToolsPreset;
  /** 信任项目（项目级 Hook / Skill / 提示模板）。 */
  trust?: boolean;
  sessionDir?: string;
  profile?: string;
  /** true：无人值守（ask → deny），同 `ama -p`。 */
  unattended?: boolean;
  env?: NodeJS.ProcessEnv;
  stderr?: (text: string) => void;
  /** 组装根选项：追加供应商 / 协议 / 工具 / 工具工厂。 */
  compose?: ComposeOptions;
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const parsed = parseArgs(options.argv ?? []);
  if (parsed.kind !== "run") throw new AmaError("invalid_arguments", "createRuntime 不接受子命令");
  const args: ParsedArgs = parsed.args;
  if (options.model !== undefined) args.model = options.model;
  if (options.thinkingLevel !== undefined) args.thinking = options.thinkingLevel;
  if (options.permissionMode !== undefined) args.permissionMode = options.permissionMode;
  if (options.toolsPreset !== undefined) args.toolsPreset = options.toolsPreset;
  if (options.trust !== undefined) args.trust = options.trust;
  if (options.sessionDir !== undefined) args.sessionDir = options.sessionDir;
  if (options.profile !== undefined) args.profile = options.profile;
  if (options.unattended === true) args.print = true;
  const env = options.env ?? process.env;
  const io: CliIo = {
    stdout: () => undefined,
    stderr: options.stderr ?? ((text) => void process.stderr.write(text)),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env,
    cwd: options.cwd ?? process.cwd(),
    readStdin: async () => "",
  };
  return bootstrap(args, createRuntimeDeps({ env, ...options.compose }), io);
}

export type SessionAuth =
  | { kind: "file"; path: string }
  | { kind: "env" }
  | { kind: "inline"; keys: Record<string, string> }
  | { kind: "none" };

export interface CreateSessionOptions {
  cwd?: string;
  /** `provider/model-id`；缺省 config.defaultModel，再缺省零配置选择（第一个有 key 的供应商）。 */
  model?: string | { provider: string; id: string };
  thinkingLevel?: ModelThinkingLevel;
  /** 缺省：用户级 auth.json + 环境变量。 */
  auth?: SessionAuth;
  /** 追加 / 覆盖的供应商（fake 总是可用）。 */
  providers?: ProviderData[];
  apis?: ApiRegistry;
  /** 缺省内存会话。 */
  sessionManager?: SessionManager;
  /** `default`（缺省，按预设）/ `none` / 指定工具全集。 */
  tools?: "default" | "none" | ToolDefinition[];
  toolsPreset?: ToolsPreset;
  extraTools?: ToolDefinition[];
  disableTools?: string[];
  /** 进系统提示 host 节。 */
  instructions?: InstructionSource[];
  skillDirs?: string[];
  /** 读 AGENTS.md（缺省 false）。 */
  contextFiles?: boolean;
  permission?: {
    mode?: PermissionMode;
    allow?: string[];
    deny?: string[];
    /** 审批回调；缺省无人作答 → deny。 */
    ask?(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
  };
  /** 命令式 Hook（缺省不加载文件系统里的 hooks.json）。 */
  hooks?: HookConfig | false;
  config?: Partial<AmaConfig>;
  unattended?: boolean;
  onWarning?: (message: string) => void;
  log?: LogFn;
}

function keyOptions(auth: SessionAuth | undefined): KeyResolverOptions {
  switch (auth?.kind) {
    case undefined:
      return {};
    case "file":
      return { authFile: auth.path, userAuthFile: null, useEnv: false };
    case "env":
      return { userAuthFile: null, useEnv: true };
    case "inline":
      return { configKeys: auth.keys, userAuthFile: null, useEnv: false };
    case "none":
      return { userAuthFile: null, useEnv: false };
  }
}

export async function createAgentSession(
  options: CreateSessionOptions = {},
): Promise<AgentSessionImpl> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const warn = options.onWarning ?? (() => undefined);
  let config = mergeConfig(DEFAULT_CONFIG as AmaConfig, options.config);
  if (options.toolsPreset !== undefined)
    config = mergeConfig(config, { tools: { preset: options.toolsPreset } });
  const providers = new ProviderRegistry({
    config: withExtraProviders(config, options.providers),
    apis: options.apis,
    includeFake: true,
    keys: keyOptions(options.auth),
    onWarning: warn,
  });
  const ref =
    typeof options.model === "object"
      ? `${options.model.provider}/${options.model.id}`
      : (options.model ?? config.defaultModel);
  let choice;
  if (ref !== undefined) {
    const found = providers.findModel(ref);
    if (!found.ok)
      throw new AmaError("model_not_found", `模型不存在：${ref}`, { detail: found.candidates });
    choice = found;
  } else {
    choice = await pickDefaultModel(providers);
    if (choice === undefined)
      throw new AmaError("no_api_key", "没有可用模型：传 model，或配置任一供应商的 key");
  }
  const state = emptyComposeState();
  let tools: PresetToolRegistry;
  if (options.tools === undefined || options.tools === "default") {
    tools = createTools(
      { config, cwd, mode: "line" },
      { extraTools: options.extraTools ?? [] },
      state,
    );
  } else {
    tools = new PresetToolRegistry();
    for (const tool of options.tools === "none" ? [] : options.tools) tools.register(tool, "sdk");
    for (const tool of options.extraTools ?? []) tools.register(tool, "sdk");
  }
  for (const name of options.disableTools ?? []) tools.disable(name);
  const mode = options.permission?.mode ?? config.permission?.mode ?? "default";
  const rules = buildRules(
    [
      ...(options.permission?.allow ?? []).map((raw) => ({
        effect: "allow" as const,
        raw,
        source: "sdk" as const,
      })),
      ...(options.permission?.deny ?? []).map((raw) => ({
        effect: "deny" as const,
        raw,
        source: "sdk" as const,
      })),
    ],
    config.permission?.builtinDeny,
    warn,
  );
  const permission = new PermissionPipeline({ mode, rules, cwd });
  const manager = options.sessionManager ?? SessionManager.inMemory(cwd);
  let session: AgentSessionImpl | undefined;
  const hooks = new HookDispatcher({
    hooks:
      options.hooks === undefined || options.hooks === false ? [] : hooksFromConfig(options.hooks),
    context: () => ({
      sessionId: manager.id,
      cwd,
      model: session?.state.model ?? { provider: choice.model.provider, id: choice.model.id },
      permissionMode: permission.mode,
      depth: 0,
    }),
    onWarning: warn,
  });
  const configDir = resolveConfigDir();
  if (options.skillDirs !== undefined && options.skillDirs.length > 0) {
    const sources = options.skillDirs.map((dir) => ({
      dir: resolve(cwd, dir),
      scope: "cli" as const,
      requiresTrust: false,
    }));
    const found = await discoverSkills(sources, { trusted: true });
    state.skills = found.skills;
    found.warnings.forEach((w) => warn(w));
  }
  const context = options.contextFiles === true ? findContextFiles({ cwd, configDir }) : undefined;
  const ask = options.permission?.ask;
  const assembly: SessionAssembly = {
    mode: options.unattended === true ? "print" : "line",
    paths: { configDir, dataDir: resolveDataDir(), sessionDir: manager.directory() ?? cwd, cwd },
    config,
    trust: { trusted: true, source: "default" },
    resources: {
      contextFiles: context?.files.map((f) => ({ path: f.path, content: f.content })) ?? [],
      skills: state.skills.map((s) => ({
        name: s.name,
        description: s.description,
        location: s.location,
      })),
      prompts: [],
      instructions: [],
    },
    providers,
    model: choice.model,
    provider: choice.provider,
    thinkingLevel: options.thinkingLevel ?? config.thinkingLevel ?? "medium",
    sessionManager: manager,
    source: manager.entries().length > 0 ? "resume" : "startup",
    hooks,
    permission,
    tools,
    events: new AgentEventBus(),
    host: { handle: undefined, broker: () => undefined, instructions: options.instructions ?? [] },
    uiBroker: () => (ask === undefined ? undefined : { ask }),
    onSessionReplaced: () => undefined,
    sessionStartContext: () => undefined,
    unattended: options.unattended === true,
    warn,
  };
  session = composeSession(assembly, state, { log: options.log ?? (() => undefined) });
  return session;
}
