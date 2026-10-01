/**
 * Runtime：bootstrap（§11.1 第 5–14 步）的产物，各模式与 SDK `createRuntime()` 共用。
 * [B0] 契约文件，组装归 B5（cli/bootstrap.ts），消费者是 B6 / B7。
 *
 * 补全说明：设计只列了字段名（config、providers、session、hooks、host、permission、tools），
 * 这里补全为各批次的最小接口类型（`*Api`），不依赖任何实现文件。
 */

import type { Model, ModelThinkingLevel, ProviderRegistryApi } from "../ai/types.js";
import type { AgentSession } from "../agent/types.js";
import type { AmaConfig } from "../config/types.js";
import type { HookDispatcherApi } from "../hooks/types.js";
import type {
  ApprovalBroker,
  HostAdapterHandle,
  HostMode,
  InstructionSource,
} from "../host/types.js";
import type { PermissionPipelineApi } from "../permissions/types.js";
import type { SessionManagerApi } from "../session/types.js";
import type { ToolRegistryApi } from "../tools/types.js";

export type RuntimeMode = HostMode;

export interface ResolvedPaths {
  /** 用户级配置目录（`AMA_CONFIG_DIR` / XDG / `%APPDATA%\ama`）。 */
  configDir: string;
  /** 数据目录（`AMA_DATA_DIR` / `~/.local/share/ama`）。 */
  dataDir: string;
  /** `--session-dir` > profile > `<dataDir>/sessions`。 */
  sessionDir: string;
  /** 会话 cwd。 */
  cwd: string;
}

export interface TrustState {
  trusted: boolean;
  /** 决策来源。 */
  source: "flag" | "trust-file" | "prompt" | "profile" | "default";
  /** 命中 trust.json 的祖先目录。 */
  matchedPath?: string;
}

export interface LoadedResources {
  /** AGENTS.md 等，外层在前。 */
  contextFiles: readonly { path: string; content: string }[];
  /** 发现的 Skill（name → SKILL.md 绝对路径）。 */
  skills: readonly { name: string; description: string; location: string }[];
  /** 提示模板（命令名 → 文件）。 */
  prompts: readonly { name: string; path: string }[];
  instructions: readonly InstructionSource[];
}

/** UI 通知：交互模式显示在 TUI，rpc 模式转成事件。 */
export type UiNotify = (message: string, level: "info" | "warn" | "error") => void;

/** 模式层晚绑定的审批 UI（B6 / B7 在界面就绪后设置）。 */
export interface RuntimeApprovals {
  /**
   * 设置 UI broker：排在宿主 broker 之后，宿主不作答（返回 undefined）时由它询问用户；
   * undefined = 撤下（回到无人值守处理）。组装出的会话每次审批现取，设置立即生效。
   */
  setUiBroker(broker: ApprovalBroker | undefined): void;
}

/** 模式层晚绑定的通知出口：宿主 `ui.notify` 转到这里；undefined 恢复为写 stderr。 */
export interface RuntimeNotifier {
  set(fn?: UiNotify): void;
}

export interface Runtime {
  readonly mode: RuntimeMode;
  readonly paths: ResolvedPaths;
  /** 合并后的有效配置。 */
  readonly config: AmaConfig;
  readonly trust: TrustState;
  readonly resources: LoadedResources;
  readonly providers: ProviderRegistryApi;
  readonly model: Model;
  readonly thinkingLevel: ModelThinkingLevel;
  readonly sessionManager: SessionManagerApi;
  readonly session: AgentSession;
  readonly hooks: HookDispatcherApi;
  /** 未激活宿主适配器时为 undefined。 */
  readonly host: HostAdapterHandle | undefined;
  readonly permission: PermissionPipelineApi;
  readonly tools: ToolRegistryApi;
  readonly approvals: RuntimeApprovals;
  readonly notifier: RuntimeNotifier;
  /** 启动期收集的 warning（被忽略的放宽项、文件读错等）。 */
  readonly warnings: readonly string[];
  /** 发 session_shutdown、SessionEnd Hook、适配器 dispose；幂等。 */
  dispose(reason?: "exit" | "new" | "switch"): Promise<void>;
}
