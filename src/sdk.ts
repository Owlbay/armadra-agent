/**
 * SDK（设计 §13.1、实施计划 §1.3 C2）。[B6]
 *
 * - `createRuntime(options)`：与 CLI 同一条启动序列（bootstrap 第 3–14 步 + 组装根），读用户级 /
 *   项目级配置、AGENTS.md、Skill、hooks.json、auth.json；不进入任何模式。参数可以写成字段，
 *   也可以直接给 `argv`（与 `ama` 命令行同语法）。
 * - `createAgentSession(options)`：不读文件系统配置的轻量装配——内存会话（或传入的
 *   SessionManager）、选定的工具、规则与回调审批，直接返回 `AgentSessionImpl`
 *   （含 `addTool / updateSystem / navigate` 等扩展方法；回滚 `rewindPoints / rewind /
 *   summarizeFrom / summarizeUpTo / undoAbortedTurn`，内存会话只能仅对话）。
 *
 * 两者共用组装根（cli/compose*.ts），审批链、系统提示装配、工具预设与缓存行为与 CLI 一致。
 * - [W5-F] 计划（docs/guides/plan.md）：`CreateSessionOptions.plan`（plan.* 配置 + `onProposed` 审批回调）；
 *   返回的会话带 `plan.current() / respond() / todos()`。没有 `onProposed` 时按 `plan.unattended`
 *   （缺省 stop：计划落盘后停下，不替人批准）。
 * - [W6-C0] `language`（两个入口都有）：界面语言，跟随宿主界面（docs/guides/i18n.md）；进程级，`AMA_LANG` 仍优先。
 */

import { resolve } from "node:path";
import type { ApiRegistry } from "./ai/apis/api.js";
import { ProviderRegistry } from "./ai/providers/registry.js";
import type { KeyResolverOptions } from "./ai/providers/auth.js";
import type { ModelThinkingLevel, ProviderData } from "./ai/types.js";
import type { AgentSessionImpl } from "./agent/session.js";
import {
  planController,
  type PlanDecision,
  type PlanResponse,
  type PlanResponseResult,
} from "./agent/session-plan.js";
import type { PlanData, TodoItemView } from "./agent/types.js";
import type { PlanConfig } from "./config/types-w5.js";
import { parseArgs, type ParsedArgs } from "./cli/args.js";
import { bootstrap } from "./cli/bootstrap.js";
import { resolveMemory } from "./cli/compose-memory.js";
import { withExtraProviders } from "./cli/compose-providers.js";
import { composeSession, emptyComposeState, type LogFn } from "./cli/compose-session.js";
import { buildRules, createRuntimeDeps, createTools, type ComposeOptions } from "./cli/compose.js";
import { pickDefaultModel } from "./cli/default-model.js";
import type { CliIo, SessionAssembly } from "./cli/deps.js";
import type { Runtime } from "./cli/runtime.js";
import { findContextFiles } from "./config/context-files.js";
import { DEFAULT_CONFIG, mergeConfig } from "./config/merge.js";
import { resolveConfigDir, resolveDataDir } from "./config/paths.js";
import {
  canonicalPreset,
  type AmaConfig,
  type ProfileMemoryOptions,
  type ToolsPresetInput,
} from "./config/types.js";
import type { Trace, TraceOptions } from "./trace/types.js";
import { sdkSessionTrace } from "./trace/query-session.js";
import { AmaError } from "./errors.js";
import { msg, resolveLocale, setLocale, type Locale } from "./i18n/index.js";
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
export type { SessionCacheStats, SessionContextStats, SessionStats } from "./agent/types.js";
/** [RW-B] 回滚：`session.rewindPoints()`、`session.rewind()`、`summarizeFrom / summarizeUpTo`。 */
export type {
  CodeRestoreResult,
  RewindMode,
  RewindPoint,
  RewindRequest,
  RewindResult,
} from "./checkpoints/types.js";
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
  /** `codemode` 是 `codemode-only` 的别名。 */
  toolsPreset?: ToolsPresetInput;
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
  /** [W6-C0] 界面语言（等价 `--lang`）；进程级。 */
  language?: Locale;
  /** [W6-C0] 记忆开关（等价 `--memory` / `--no-memory`；W6-M 实现）。 */
  memory?: boolean;
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const parsed = parseArgs(options.argv ?? []);
  if (parsed.kind !== "run") throw new AmaError("invalid_arguments", msg().errors.sdk.noSubcommand);
  const args: ParsedArgs = parsed.args;
  if (options.model !== undefined) args.model = options.model;
  if (options.thinkingLevel !== undefined) args.thinking = options.thinkingLevel;
  if (options.permissionMode !== undefined) args.permissionMode = options.permissionMode;
  if (options.toolsPreset !== undefined) args.toolsPreset = canonicalPreset(options.toolsPreset);
  if (options.trust !== undefined) args.trust = options.trust;
  if (options.sessionDir !== undefined) args.sessionDir = options.sessionDir;
  if (options.profile !== undefined) args.profile = options.profile;
  if (options.unattended === true) args.print = true;
  if (options.language !== undefined) args.lang = options.language;
  if (options.memory !== undefined) args.memory = options.memory;
  const env = options.env ?? process.env;
  if (args.lang !== undefined) setLocale(resolveLocale(env, undefined, args.lang));
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

/** [W5-F] 计划：类型与 RPC 同形（`plan_proposed` / `plan_response`）。 */
export type { PlanData, PlanDecision, PlanResponse, PlanResponseResult, TodoItemView };

/** [W5-F] `CreateSessionOptions.plan`：plan.* 配置 + 审批回调。 */
export interface SessionPlanOptions extends PlanConfig {
  /**
   * 计划待审批时调用（运行结束后；不阻塞运行）。返回回答即生效；返回 undefined 留待
   * `session.plan.respond()`。不给时按 `unattended`（缺省 stop）。
   */
  onProposed?(plan: PlanData): Promise<PlanDecision | undefined>;
}

/** [W5-F] `session.plan`。 */
export interface SessionPlanApi {
  /** 分支上最近的计划；没有为 null。 */
  current(): PlanData | null;
  respond(response: PlanResponse): Promise<PlanResponseResult>;
  todos(): TodoItemView[];
}

export type SdkAgentSession = AgentSessionImpl & {
  readonly plan: SessionPlanApi;
  /** [W6-C0] 本会话的轨迹（[W6-T2] 实现，见 trace/query-session.ts）。 */
  trace?(options?: TraceOptions): Trace;
};

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
  /** `codemode` 是 `codemode-only` 的别名。 */
  toolsPreset?: ToolsPresetInput;
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
    /** auto 模式分类器的模型（`provider/model`）；缺省 config `permission.autoModel`，再缺省当前模型。 */
    autoModel?: string;
    /** auto 模式安全名单追加（与 config `permission.autoSafeCommands` 合并）。 */
    autoSafeCommands?: string[];
    /** 审批回调；缺省无人作答 → deny。 */
    ask?(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
  };
  /** 命令式 Hook（缺省不加载文件系统里的 hooks.json）。 */
  hooks?: HookConfig | false;
  config?: Partial<AmaConfig>;
  /** [W5-F] 计划（plan.* 配置与审批回调），见 docs/guides/plan.md。 */
  plan?: SessionPlanOptions;
  unattended?: boolean;
  onWarning?: (message: string) => void;
  log?: LogFn;
  /** [W6-C0] 界面语言（跟随宿主界面）；进程级，`AMA_LANG` 仍优先。不影响发给模型的文本。 */
  language?: Locale;
  /**
   * [W6-C0] 记忆（W6-M 实现，D11）：缺省禁用；`enabled: true` 时 `dir` 必填（按工作空间隔离的绝对路径），
   * 作用域只有 workspace，不读用户级记忆。
   */
  memory?: ProfileMemoryOptions;
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
): Promise<SdkAgentSession> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const warn = options.onWarning ?? (() => undefined);
  if (options.language !== undefined)
    setLocale(resolveLocale(process.env, undefined, options.language));
  let config = mergeConfig(DEFAULT_CONFIG as AmaConfig, options.config);
  const { onProposed, ...planConfig } = options.plan ?? {};
  if (options.plan !== undefined) config = { ...config, plan: { ...config.plan, ...planConfig } };
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
      throw new AmaError("model_not_found", msg().errors.sdk.modelNotFound(ref), {
        detail: found.candidates,
      });
    choice = found;
  } else {
    choice = await pickDefaultModel(providers);
    if (choice === undefined) throw new AmaError("no_api_key", msg().errors.sdk.noModel);
  }
  const state = emptyComposeState();
  let tools: PresetToolRegistry;
  if (options.tools === undefined || options.tools === "default") {
    // [W6-M] SDK 同嵌入宿主：只有 `options.memory = { enabled, dir }` 开启（workspace 作用域）
    const memory = resolveMemory({
      config,
      cwd,
      dataDir: resolveDataDir(),
      trusted: true,
      embedded: { memory: options.memory },
    });
    tools = createTools(
      { config, cwd, mode: "line", memory },
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
  const autoSafeCommands = [
    ...(config.permission?.autoSafeCommands ?? []),
    ...(options.permission?.autoSafeCommands ?? []),
  ];
  const permission = new PermissionPipeline({ mode, rules, cwd, autoSafeCommands });
  const autoModel = options.permission?.autoModel;
  if (autoModel !== undefined) config.permission = { ...config.permission, autoModel };
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
  return withPlanApi(session, onProposed);
}

/** SDK 会话：审批交给 `onProposed`（没有则无人值守策略），并挂上 `session.plan`。 */
function withPlanApi(
  session: AgentSessionImpl,
  onProposed: SessionPlanOptions["onProposed"],
): SdkAgentSession {
  const controller = planController(session);
  controller?.setAttendance(onProposed === undefined ? "unattended" : "callback", onProposed);
  const missing = (): never => {
    throw new AmaError("not_implemented", msg().errors.sdk.noPlan);
  };
  const plan: SessionPlanApi = {
    current: () => controller?.current() ?? null,
    respond: (response) => (controller ?? missing()).respond(response),
    todos: () => controller?.todos() ?? [],
  };
  return Object.assign(session, { plan, trace: (o?: TraceOptions) => sdkSessionTrace(session, o) }); // [W6-T2]
}
