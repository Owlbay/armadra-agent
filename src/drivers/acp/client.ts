/**
 * ACP 客户端（docs/wave5-plan.md §5.1，D14）。[W5-E]
 *
 * JSON-RPC over NDJSON（{@link JsonRpcPeer}），手写零依赖；`@armadra/agent/acp` 导出供 Armadra 复用。
 *
 * - 不声明 `fs` / `terminal` 能力：Agent 发来的 `fs/*`、`terminal/*` 请求一律 method not found。
 * - `session/request_permission` 交给 `onPermission`（驱动再交给 ama 的审批通道，只交给人）；
 *   没有处理器时按无人值守回首个 `reject_once`（没有则 cancelled）。
 * - `cancel(sessionId)` 发 `session/cancel` 通知，并让该会话所有挂起的权限请求回 `cancelled`
 *   （规范要求：客户端取消回合后必须以 cancelled 回答挂起的请求）。
 * - 开会话（new / resume / load）的 `mcpServers` 缺省为空数组；宿主可经 {@link AcpSessionOptions}
 *   传入，原样转发。
 * - `elicitation/create` 交给 `onElicitation`；给了它 `initialize` 才声明 `clientCapabilities.elicitation`，
 *   没给时线路与旧版相同（不声明，Agent 发来的请求回 method not found）。`cancel(sessionId)`、连接关闭时
 *   挂起的 elicitation 一律回 `{ action: "cancel" }`；ama 从不替人填表。
 * - `setConfigOption(sessionId, configId, value)` 发 `session/set_config_option`；开会话答的 `configOptions`
 *   原样交回。
 */

import { JsonRpcPeer, RpcError } from "../jsonrpc.js";
import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  RPC_ERRORS,
  type AcpAgentCapabilities,
  type AcpContentBlock,
  type AcpElicitationParams,
  type AcpElicitationResult,
  type AcpImplementationInfo,
  type AcpInitializeResult,
  type AcpListSessionsResult,
  type AcpLoadSessionResult,
  type AcpNewSessionResult,
  type AcpPromptResult,
  type AcpRequestPermissionParams,
  type AcpRequestPermissionResult,
  type AcpSessionNotification,
  type AcpSessionOptions,
  type AcpSetConfigOptionResult,
} from "./types.js";

export interface AcpClientHandlers {
  onUpdate?(notification: AcpSessionNotification): void;
  /** `signal`：该会话被 cancel、连接关闭时 abort（此时应尽快回 cancelled）。 */
  onPermission?(
    params: AcpRequestPermissionParams,
    signal: AbortSignal,
  ): Promise<AcpRequestPermissionResult>;
  /**
   * `elicitation/create`：Agent 向人要结构化输入。给了它才声明 `clientCapabilities.elicitation`。
   * `signal`：该会话被 cancel、连接关闭时 abort（此时回 `{ action: "cancel" }`，不必再答）。
   */
  onElicitation?(params: AcpElicitationParams, signal: AbortSignal): Promise<AcpElicitationResult>;
  onProtocolError?(line: string, reason: string): void;
  onClose?(): void;
}

export interface AcpClientOptions extends AcpClientHandlers {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  clientInfo?: AcpImplementationInfo;
}

/** 开会话参数里的 `mcpServers`：拷一份，缺省空数组。 */
function mcpServersOf(options: AcpSessionOptions | undefined) {
  return [...(options?.mcpServers ?? [])];
}

const ELICITATION_ACTIONS = new Set(["accept", "decline", "cancel"]);

/** 处理器的答复收成规范形状：动作不认识当 cancel，`content` 只随 accept。 */
function elicitationAnswer(answer: AcpElicitationResult | undefined): AcpElicitationResult {
  const action = answer?.action;
  if (action === undefined || !ELICITATION_ACTIONS.has(action)) return { action: "cancel" };
  if (action !== "accept" || answer?.content === undefined) return { action };
  return { action, content: answer.content };
}

/** 无人值守的回答：首个 reject_once，没有就 cancelled。 */
export function unattendedOutcome(params: AcpRequestPermissionParams): AcpRequestPermissionResult {
  const reject = params.options.find((o) => o.kind === "reject_once");
  return {
    outcome:
      reject !== undefined
        ? { outcome: "selected", optionId: reject.optionId }
        : { outcome: "cancelled" },
  };
}

export class AcpClient {
  /**
   * 本版客户端支持的可选能力，供宿主做特性检测（旧版没有这个字段，旧一点的只有 `mcpServers`）：
   * - `mcpServers`：开会话时可经 {@link AcpSessionOptions} 传 MCP 服务器；
   * - `elicitation`：构造参数 `onElicitation` 接 `elicitation/create`；
   * - `configOptions`：`setConfigOption` 与开会话答的 `configOptions`。
   */
  static readonly features: {
    readonly mcpServers: true;
    readonly elicitation: true;
    readonly configOptions: true;
  } = { mcpServers: true, elicitation: true, configOptions: true };

  private readonly peer: JsonRpcPeer;
  /** sessionId → 挂起权限请求的取消器。 */
  private readonly pendingPermissions = new Map<string, Set<AbortController>>();
  /** sessionId（没给就是空串）→ 挂起 elicitation 的取消器。 */
  private readonly pendingElicitations = new Map<string, Set<AbortController>>();
  private initResult: AcpInitializeResult | undefined;

  constructor(private readonly options: AcpClientOptions) {
    this.peer = new JsonRpcPeer({
      input: options.input,
      output: options.output,
      onRequest: (method, params, ctx) => this.onRequest(method, params, ctx.signal),
      onNotification: (method, params) => {
        if (method === ACP_METHODS.sessionUpdate)
          options.onUpdate?.(params as AcpSessionNotification);
      },
      onClose: () => {
        for (const set of this.pendingPermissions.values()) for (const c of set) c.abort();
        for (const set of this.pendingElicitations.values()) for (const c of set) c.abort();
        options.onClose?.();
      },
      ...(options.onProtocolError !== undefined
        ? { onProtocolError: options.onProtocolError }
        : {}),
    });
  }

  get closed(): Promise<void> {
    return this.peer.closed;
  }

  get isOpen(): boolean {
    return this.peer.isOpen;
  }

  get agentCapabilities(): AcpAgentCapabilities {
    return this.initResult?.agentCapabilities ?? {};
  }

  get agentInfo(): AcpImplementationInfo | undefined {
    return this.initResult?.agentInfo;
  }

  async initialize(signal?: AbortSignal): Promise<AcpInitializeResult> {
    const result = await this.peer.request<AcpInitializeResult>(
      ACP_METHODS.initialize,
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          ...(this.options.onElicitation !== undefined ? { elicitation: {} } : {}),
        },
        ...(this.options.clientInfo !== undefined ? { clientInfo: this.options.clientInfo } : {}),
      },
      signal,
    );
    if (result.protocolVersion !== ACP_PROTOCOL_VERSION)
      throw new RpcError(
        RPC_ERRORS.invalidRequest,
        `incompatible ACP protocol version: agent ${String(result.protocolVersion)}, client ${ACP_PROTOCOL_VERSION}`,
      );
    this.initResult = result;
    return result;
  }

  supportsResume(): boolean {
    return this.agentCapabilities.sessionCapabilities?.resume != null;
  }
  supportsLoad(): boolean {
    return this.agentCapabilities.loadSession === true;
  }
  supportsList(): boolean {
    return this.agentCapabilities.sessionCapabilities?.list != null;
  }
  supportsClose(): boolean {
    return this.agentCapabilities.sessionCapabilities?.close != null;
  }
  supportsImages(): boolean {
    return this.agentCapabilities.promptCapabilities?.image === true;
  }

  newSession(
    cwd: string,
    signal?: AbortSignal,
    options?: AcpSessionOptions,
  ): Promise<AcpNewSessionResult> {
    return this.peer.request(
      ACP_METHODS.sessionNew,
      { cwd, mcpServers: mcpServersOf(options) },
      signal,
    );
  }

  /** 不回放历史（优先，R13：v2 计划取消 load）。 */
  resumeSession(
    sessionId: string,
    cwd: string,
    signal?: AbortSignal,
    options?: AcpSessionOptions,
  ): Promise<AcpLoadSessionResult> {
    return this.peer.request(
      ACP_METHODS.sessionResume,
      { sessionId, cwd, mcpServers: mcpServersOf(options) },
      signal,
    );
  }

  /** 回放历史（以 session/update 通知）。 */
  loadSession(
    sessionId: string,
    cwd: string,
    signal?: AbortSignal,
    options?: AcpSessionOptions,
  ): Promise<AcpLoadSessionResult> {
    return this.peer.request(
      ACP_METHODS.sessionLoad,
      { sessionId, cwd, mcpServers: mcpServersOf(options) },
      signal,
    );
  }

  listSessions(cwd?: string, cursor?: string): Promise<AcpListSessionsResult> {
    return this.peer.request(ACP_METHODS.sessionList, {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
  }

  closeSession(sessionId: string): Promise<unknown> {
    return this.peer.request(ACP_METHODS.sessionClose, { sessionId });
  }

  prompt(
    sessionId: string,
    prompt: AcpContentBlock[],
    signal?: AbortSignal,
  ): Promise<AcpPromptResult> {
    return this.peer.request(ACP_METHODS.sessionPrompt, { sessionId, prompt }, signal);
  }

  setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.peer.request(ACP_METHODS.sessionSetMode, { sessionId, modeId });
  }

  /** 改一个会话配置项（如模型）；答复是全部配置项的新状态。 */
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<AcpSetConfigOptionResult> {
    return this.peer.request(ACP_METHODS.sessionSetConfigOption, { sessionId, configId, value });
  }

  /** 协议级取消：发通知，并让挂起的权限请求回 cancelled、挂起的 elicitation 回 cancel。 */
  async cancel(sessionId: string): Promise<void> {
    for (const controller of this.pendingPermissions.get(sessionId) ?? []) controller.abort();
    for (const controller of this.pendingElicitations.get(sessionId) ?? []) controller.abort();
    await this.peer.notify(ACP_METHODS.sessionCancel, { sessionId });
  }

  close(): void {
    this.peer.close();
  }

  private async onRequest(
    method: string,
    params: unknown,
    connection: AbortSignal,
  ): Promise<unknown> {
    if (method === ACP_METHODS.elicitationCreate && this.options.onElicitation !== undefined)
      return this.onElicitation(params, connection);
    if (method !== ACP_METHODS.requestPermission)
      throw new RpcError(RPC_ERRORS.methodNotFound, `client does not support ${method}`);
    const request = params as AcpRequestPermissionParams;
    if (typeof request?.sessionId !== "string" || !Array.isArray(request.options))
      throw new RpcError(RPC_ERRORS.invalidParams, "invalid session/request_permission params");
    const handler = this.options.onPermission;
    if (handler === undefined) return unattendedOutcome(request);
    const controller = new AbortController();
    const set = this.pendingPermissions.get(request.sessionId) ?? new Set();
    set.add(controller);
    this.pendingPermissions.set(request.sessionId, set);
    const signal = AbortSignal.any([controller.signal, connection]);
    try {
      const answer = await Promise.race([
        handler(request, signal),
        new Promise<AcpRequestPermissionResult>((resolve) => {
          const cancelled = (): void => resolve({ outcome: { outcome: "cancelled" } });
          if (signal.aborted) cancelled();
          else signal.addEventListener("abort", cancelled, { once: true });
        }),
      ]);
      if (signal.aborted) return { outcome: { outcome: "cancelled" } };
      // 只认 Agent 自己给的选项
      if (
        answer.outcome.outcome === "selected" &&
        !request.options.some(
          (o) => answer.outcome.outcome === "selected" && o.optionId === answer.outcome.optionId,
        )
      )
        return { outcome: { outcome: "cancelled" } };
      return answer;
    } finally {
      set.delete(controller);
    }
  }

  private async onElicitation(params: unknown, connection: AbortSignal): Promise<unknown> {
    const request = params as AcpElicitationParams;
    if (request === null || typeof request !== "object" || typeof request.message !== "string")
      throw new RpcError(RPC_ERRORS.invalidParams, "invalid elicitation/create params");
    const handler = this.options.onElicitation!;
    const key = typeof request.sessionId === "string" ? request.sessionId : "";
    const controller = new AbortController();
    const set = this.pendingElicitations.get(key) ?? new Set();
    set.add(controller);
    this.pendingElicitations.set(key, set);
    const signal = AbortSignal.any([controller.signal, connection]);
    try {
      const answer = await Promise.race([
        handler(request, signal),
        new Promise<AcpElicitationResult>((resolve) => {
          const cancelled = (): void => resolve({ action: "cancel" });
          if (signal.aborted) cancelled();
          else signal.addEventListener("abort", cancelled, { once: true });
        }),
      ]);
      if (signal.aborted) return { action: "cancel" };
      return elicitationAnswer(answer);
    } finally {
      set.delete(controller);
    }
  }
}
