/**
 * RuntimeDeps：bootstrap 对其它批次能力的依赖注入接口。[B5]
 *
 * 第一波各批次并行实施，B5 不 import B1 / B2 / B3 / B6 / B7 的实现文件；bootstrap 只编排流程、
 * 失败处理与退出码，具体实现由集成批次在 cli/main.ts 用 `registerRuntimeDeps()` 注入
 * （SDK 的 `createRuntime()` 直接把 deps 传给 `bootstrap()`）。测试用桩。
 *
 * 错误约定：注入实现抛 `StartupError` 时原样透传（用它的退出码）；抛 `AmaError` 时按 code
 * 映射（`session_not_found / session_corrupt` → 5、`model_not_found / provider_not_found /
 * no_api_key` → 4、`config_invalid` → 3、`tool_not_found` → 2）；其它异常按所在步骤的缺省退出码。
 */

import type { ModelThinkingLevel, Model, ProviderData, ProviderRegistryApi } from "../ai/types.js";
import type { AgentSession } from "../agent/types.js";
import type { AmaConfig } from "../config/types.js";
import type { PermissionRuleSpec } from "../config/merge.js";
import type { TrustPromptAnswer } from "../config/trust.js";
import type { HookDispatcherApi } from "../hooks/types.js";
import type { WarmingDecisionHandler } from "../ai/cache/types.js";
import type { AgentEventBus } from "../host/api-impl.js";
import type { ApprovalBroker, HostAdapterHandle, InstructionSource } from "../host/types.js";
import type { PermissionMode, PermissionPipelineApi } from "../permissions/types.js";
import type { SessionEntry, SessionListItem, SessionManagerApi } from "../session/types.js";
import type { ToolRegistryApi } from "../tools/types.js";
import type {
  LoadedResources,
  ResolvedPaths,
  Runtime,
  RuntimeMode,
  TrustState,
} from "./runtime.js";
import type { ParsedArgs } from "./args.js";

/** 第 7 步的会话请求。 */
export type SessionRequest =
  | { kind: "new" }
  | { kind: "continue" }
  | { kind: "resume"; id: string }
  | { kind: "session-id"; id: string }
  | { kind: "fork"; id: string };

export interface ProviderBuildInput {
  config: AmaConfig;
  cwd: string;
  /** 解析后的 auth.json 路径：`--auth-file` > profile.authFile > `<configDir>/auth.json`。 */
  authFile: string;
  /** 是否读环境变量（profile.authEnv=false 时为 false，§11.2）。 */
  authEnv: boolean;
  /** `--api-key`：只作用于 `modelRef` 所属的供应商（§3.5 ①）。 */
  cliApiKey?: { apiKey: string; modelRef: string; provider?: string };
  /** 数据目录：读 models.dev 缓存（`<dataDir>/models-dev.json`，只读不联网）；缺省不补元数据。 */
  dataDir?: string;
}

export interface ResourceDiscoveryInput {
  cwd: string;
  configDir: string;
  trusted: boolean;
  /** 按 §5.3 顺序：`--skill-dir` → profile.skillDirs → config.skills.dirs。 */
  extraSkillDirs: readonly string[];
  promptDirs: readonly string[];
}

export interface ResourceDiscoveryResult {
  skills: LoadedResources["skills"];
  prompts: LoadedResources["prompts"];
  warnings: string[];
}

/** 第 14 步交给 AgentSession 实现（B2）的全部装配材料。 */
export interface SessionAssembly {
  mode: RuntimeMode;
  paths: ResolvedPaths;
  config: AmaConfig;
  trust: TrustState;
  resources: LoadedResources;
  providers: ProviderRegistryApi;
  model: Model;
  provider: ProviderData;
  thinkingLevel: ModelThinkingLevel;
  sessionManager: SessionManagerApi;
  /** session_start 的 reason。 */
  source: "startup" | "resume" | "new" | "fork";
  hooks: HookDispatcherApi;
  permission: PermissionPipelineApi;
  tools: ToolRegistryApi;
  /** 宿主事件总线：AgentSession 把 AgentEvents 发到这里（session_start 由 bootstrap 发）。 */
  events: AgentEventBus;
  host: {
    handle: HostAdapterHandle | undefined;
    /** 宿主 broker（链首）；undefined 交给 UI / 无人值守。 */
    broker(): ApprovalBroker | undefined;
    /** 系统提示 host 节。 */
    instructions: readonly InstructionSource[];
    /** [W3-C1b] 宿主 `cache.onWarmingDecision` 的当前处理器（每次保温前现取）。 */
    warmingDecider?(): WarmingDecisionHandler | undefined;
  };
  /** `Runtime.approvals.setUiBroker` 设置的 UI broker（链尾）；每次审批现取，未设置为 undefined。 */
  uiBroker(): ApprovalBroker | undefined;
  /**
   * 模式层把当前会话换成另一个（`/new`、`/resume`、`/fork`、RPC `switch_session`）后调用：
   * bootstrap 让 HostApi.session.*、宿主 sendUser、Hook 公共字段与退出时的 dispose 跟随 `next`。
   * 旧会话由调用方自行 dispose；`Runtime.session` 仍指初始会话。
   */
  onSessionReplaced(next: AgentSession): void;
  /** SessionStart Hook 的 additionalContext（系统提示 hooks 节）；首次装配系统提示时读取。 */
  sessionStartContext(): string | undefined;
  /** print：ask → deny。 */
  unattended: boolean;
  warn(message: string): void;
}

export interface ModeContext {
  args: ParsedArgs;
  /** 位置参数拼成的首条提示。 */
  prompt: string | undefined;
  io: CliIo;
}

/** 第 15–16 步：模式实现（B6 line / print / rpc，B7 interactive）；返回退出码。 */
export type ModeRunner = (runtime: Runtime, context: ModeContext) => Promise<number>;

/** 交互 UI 回调（B7 / B6 line 提供）；全部可选，缺省按非交互处理。 */
export interface InteractiveUi {
  promptTrust?(cwd: string, resources: readonly string[]): Promise<TrustPromptAnswer>;
  /** `--resume` 无 id：返回会话 id，undefined = 用户取消（退出码 5）。 */
  pickSession?(items: readonly SessionListItem[]): Promise<string | undefined>;
  /** 无 key / 无模型时选择模型；返回 `provider/id`，undefined = 取消（退出码 4）。 */
  pickModel?(providers: ProviderRegistryApi, reason: string): Promise<string | undefined>;
  /** 会话 cwd 不存在：返回新 cwd，undefined = 取消（退出码 5）。 */
  askCwd?(missing: string): Promise<string | undefined>;
}

export interface RuntimeDeps {
  /** B1：ProviderRegistry.build(builtin, config.providers) + auth。 */
  providers: {
    create(input: ProviderBuildInput): ProviderRegistryApi | Promise<ProviderRegistryApi>;
  };
  /** B2：SessionManager。 */
  sessions: {
    open(
      request: SessionRequest,
      context: { sessionDir: string; cwd: string },
    ): SessionManagerApi | Promise<SessionManagerApi>;
    /** `--resume` 选择器与 `ama sessions` 用。 */
    list?(context: { sessionDir: string; cwd?: string }): Promise<SessionListItem[]>;
    /** `ama sessions show`：id 可为前缀；找不到抛 AmaError{code:"session_not_found"}。 */
    show?(
      id: string,
      context: { sessionDir: string },
    ): Promise<{ item: SessionListItem; entries: readonly SessionEntry[] }>;
    /** `ama sessions prune`：把超过 olderThanDays 天未修改的会话移到 trash（§8）。 */
    prune?(context: {
      sessionDir: string;
      cwd?: string;
      olderThanDays: number;
      dryRun: boolean;
    }): Promise<{ moved: string[] }>;
  };
  /** B3：ToolRegistry（内置工具已注册）。 */
  tools: { create(input: { config: AmaConfig; cwd: string; mode: RuntimeMode }): ToolRegistryApi };
  /** B3：权限管线。 */
  permissions: {
    create(input: {
      mode: PermissionMode;
      rules: readonly PermissionRuleSpec[];
      unattended: boolean;
      /** 会话 cwd：规则里的相对路径以它为基准。 */
      cwd: string;
      /** config `permission.builtinDeny`（只来自用户级 / profile）；缺省 = 启用全部内置 deny。 */
      builtinDeny?: boolean | string[];
      /** config `permission.autoSafeCommands`（auto 模式安全名单追加）。 */
      autoSafeCommands?: string[];
    }): PermissionPipelineApi;
  };
  /** B3：skills / prompts 发现；缺省为空。 */
  resources?: {
    discover(
      input: ResourceDiscoveryInput,
    ): ResourceDiscoveryResult | Promise<ResourceDiscoveryResult>;
  };
  /** B2：组装 AgentSession。 */
  session: { create(assembly: SessionAssembly): AgentSession | Promise<AgentSession> };
  /** B6 / B7。 */
  modes: Partial<Record<RuntimeMode, ModeRunner>>;
  ui?: InteractiveUi;
  /** 宿主 `messages.sendUser` 的实现；缺省：运行中 steer，空闲时 prompt。 */
  sendUser?(session: AgentSession, text: string, origin: string): Promise<"started" | "queued">;
}

/** 进程 I/O（测试注入）。 */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /** 读取 stdin 全部内容（auth set）。 */
  readStdin(): Promise<string>;
}
