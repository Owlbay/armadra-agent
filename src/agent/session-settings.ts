/**
 * 会话的可变设置：模型、思考级别、工具表与活动集、系统提示静态部分（从 session.ts 搬出，
 * docs/wave5-plan.md §9「session.ts → session-settings.ts」）。[W5-C0]
 *
 * 纯搬迁：`setModel / setThinkingLevel / setPermissionMode / setActiveTools / addTool /
 * updateSystem / announceStart / getTools` 的行为与事件顺序不变；`AgentSessionImpl` 以同名成员转发。
 */

import type { Model, ModelThinkingLevel, ProviderRegistryApi } from "../ai/types.js";
import { followChatGptLogin } from "../auth/chatgpt/follow.js";
import { AmaError } from "../errors.js";
import type { PermissionMode } from "../permissions/types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { StreamFn } from "./loop.js";
import type { AgentSessionOptions, SessionCore } from "./session-core.js";
import { appendModelChange, findModelOrThrow, sessionStartEvent } from "./session-sync.js";
import type { SystemPromptInput } from "./system-prompt.js";

/**
 * 按模型的协议分派到已注册的实现（会话流的最内层）。ChatGPT 订阅模型先按本次 token 的登录方式改渠道
 * （没写 `@渠道` 时；auth/chatgpt/follow.ts），会话中途换登录方式不用重启。
 */
export function providerStream(providers: ProviderRegistryApi): StreamFn {
  return (requested, context, streamOptions) => {
    const model = followChatGptLogin(
      requested,
      providers.get(requested.provider),
      streamOptions.apiKey,
    );
    const api = providers.getApi(model.api);
    if (api === undefined) {
      throw new AmaError("provider_not_found", `no implementation registered for api ${model.api}`);
    }
    return api.stream(model, context, streamOptions);
  };
}

export type StaticSystemInput = Omit<SystemPromptInput, "tools" | "cwd">;

export interface SessionSettingsDeps {
  /** 会话本身（构造完成后才会被调用）。 */
  core: SessionCore;
  assertUsable(): void;
  /** 换模型后刷新压缩阈值。 */
  onModelChanged(): void;
}

export class SessionSettings {
  model: Model;
  thinking: ModelThinkingLevel;
  systemInput: StaticSystemInput;
  private readonly allTools = new Map<string, ToolDefinition>();
  private activeNames: string[];

  constructor(
    private readonly options: AgentSessionOptions,
    private readonly deps: SessionSettingsDeps,
  ) {
    this.model = options.model;
    this.thinking = options.thinkingLevel ?? "off";
    for (const tool of options.tools ?? []) this.allTools.set(tool.name, tool);
    this.activeNames = [...(options.activeTools ?? this.allTools.keys())].filter((name) =>
      this.allTools.has(name),
    );
    this.systemInput = { ...(options.system ?? {}) };
  }

  activeTool(name: string): ToolDefinition | undefined {
    return this.activeNames.includes(name) ? this.allTools.get(name) : undefined;
  }

  tool(name: string): ToolDefinition | undefined {
    return this.allTools.get(name);
  }

  activeToolNames(): string[] {
    return [...this.activeNames];
  }

  /** 子会话 / fork 继承的活动集（同一数组引用，与搬迁前一致）。 */
  activeNamesRef(): string[] {
    return this.activeNames;
  }

  async setModel(ref: string): Promise<void> {
    this.deps.assertUsable();
    this.model = findModelOrThrow(this.options.providers, ref);
    this.deps.onModelChanged();
    const core = this.deps.core;
    core.emit({ type: "model_changed", model: appendModelChange(core, this.model) });
  }

  setThinkingLevel(level: ModelThinkingLevel): void {
    this.thinking = level;
    this.deps.core.appendEntry({ type: "thinking_level_change", thinkingLevel: level });
    this.deps.core.emit({ type: "thinking_level_changed", level });
  }

  setPermissionMode(mode: PermissionMode): void {
    this.options.permission?.setMode(mode);
    this.deps.core.emit({ type: "permission_mode_changed", mode });
  }

  setActiveTools(names: string[]): void {
    const unknown = names.filter((name) => !this.allTools.has(name));
    if (unknown.length > 0)
      throw new AmaError("tool_not_found", `unknown tools: ${unknown.join(", ")}`);
    this.activeNames = [...new Set(names)];
  }

  /** 宿主 / SDK 在会话创建后追加工具（下次请求前以 system 补丁声明）。 */
  addTool(tool: ToolDefinition, active = true): void {
    if (this.allTools.has(tool.name))
      throw new AmaError("tool_exists", `tool ${tool.name} already exists`);
    this.allTools.set(tool.name, tool);
    if (active) this.activeNames.push(tool.name);
  }

  /** 更新系统提示的静态部分（SessionStart Hook 的 hookContext、宿主 instructions 等）。 */
  updateSystem(patch: Partial<StaticSystemInput>): void {
    this.systemInput = { ...this.systemInput, ...patch };
  }

  getTools(): readonly ToolDefinition[] {
    return this.activeNames
      .map((name) => this.allTools.get(name))
      .filter((tool): tool is ToolDefinition => tool !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 发 session_start（bootstrap / SDK 在会话就绪后调用一次）。 */
  announceStart(reason: "startup" | "resume" | "new" | "fork"): void {
    this.deps.core.emit(sessionStartEvent(this.deps.core.manager, reason));
  }
}
