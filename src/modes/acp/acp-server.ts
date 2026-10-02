/**
 * `ama --mode acp`：把 ama 的会话暴露为 ACP Agent（docs/wave5-plan.md §5.6，D14）。[W5-E]
 *
 * 与 `--mode rpc` 同一引擎（Runtime + 组装根的会话切换），一次只有一个活动会话：
 * - `session/new` 新开（启动时那个空会话第一次直接认领）；`session/load` 切到该会话并回放历史；
 *   `session/resume` 切换不回放；`session/list` 列本 cwd 的会话；`session/close` 中断并释放；
 *   对非活动会话发 `session/prompt` 时（空闲）先切过去。
 * - `session/prompt` → `prompt`（文本 + 图片；资源链接以 `@uri` 文本给出，嵌入资源取文本）；
 *   回合结束按会话状态给 stopReason：中断 → cancelled，输出截断 → max_tokens，出错 → JSON-RPC 错误。
 * - `session/cancel` → `abort`；`session/set_mode` → `setPermissionMode`（模式 id = ama 权限模式）。
 * - 审批：ama 的审批请求经 `session/request_permission` 交给客户端（允许 / 本会话允许 / 拒绝）；
 *   客户端回 cancelled、连接断开或回合被中断 → 交给链上下一个回答者（无人 → 拒绝）。
 * - 不声明 / 不使用客户端的 `fs`、`terminal` 能力（Armadra Q5）；ama 自己读写、自己跑命令。
 * - cwd 固定为启动目录（信任与项目配置都按它判定）；客户端给别的 cwd → invalid params。
 */

import { resolve } from "node:path";
import type { ImageBlock } from "../../ai/types.js";
import type { AgentSession, SessionEvent } from "../../agent/types.js";
import { currentSession, switchSession } from "../../cli/compose-session.js";
import { listSessions } from "../../cli/compose-store.js";
import type { Runtime } from "../../cli/runtime.js";
import { AgentSessionImpl } from "../../agent/session.js";
import { JsonRpcPeer, RpcError } from "../../drivers/jsonrpc.js";
import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  RPC_ERRORS,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpPromptResult,
  type AcpRequestPermissionResult,
  type AcpSessionUpdate,
} from "../../drivers/acp/types.js";
import { isPermissionMode } from "../../permissions/modes.js";
import type { ApprovalBroker, ApprovalDecision, ApprovalRequest } from "../../permissions/types.js";
import { AMA_VERSION } from "../../version.js";
import { errorText } from "../shared.js";
import {
  AcpEventMapper,
  permissionModes,
  toolKind,
  toolLocations,
  toolTitle,
} from "./acp-events.js";

export const ACP_AGENT_CAPABILITIES = {
  loadSession: true,
  promptCapabilities: { image: true, audio: false, embeddedContext: true },
  mcpCapabilities: { http: false, sse: false },
  sessionCapabilities: { list: {}, resume: {}, close: {} },
};

type Params = Record<string, unknown>;

function str(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "")
    throw new RpcError(RPC_ERRORS.invalidParams, `缺少 ${key}`);
  return value;
}

/** ACP 提示 → ama 的文本与图片。 */
export function promptOf(blocks: unknown): { text: string; images: ImageBlock[] } {
  if (!Array.isArray(blocks)) throw new RpcError(RPC_ERRORS.invalidParams, "prompt 应为内容块数组");
  const parts: string[] = [];
  const images: ImageBlock[] = [];
  for (const block of blocks as AcpContentBlock[]) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image")
      images.push({ type: "image", data: block.data, mimeType: block.mimeType });
    else if (block.type === "resource_link") parts.push(`@${block.uri}`);
    else if (block.type === "resource" && typeof block.resource.text === "string")
      parts.push(`<resource uri="${block.resource.uri}">\n${block.resource.text}\n</resource>`);
  }
  return { text: parts.join("\n"), images };
}

export class AcpServer {
  readonly peer: JsonRpcPeer;
  private activeId: string | undefined;
  /** 启动时的空会话还没被 session/new 认领。 */
  private freshUnclaimed = true;
  private mapper: AcpEventMapper;
  private unsubscribe: () => void = () => undefined;
  private cancelRequested = false;
  private readonly cwd: string;

  constructor(
    private readonly runtime: Runtime,
    streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.cwd = resolve(runtime.paths.cwd);
    this.mapper = this.makeMapper();
    this.peer = new JsonRpcPeer({
      input: streams.input,
      output: streams.output,
      onRequest: (method, params) => this.handle(method, (params ?? {}) as Params),
      onNotification: (method, params) => {
        if (method === ACP_METHODS.sessionCancel) void this.cancel((params ?? {}) as Params);
      },
      onProtocolError: (_line, reason) => this.log(`ACP：无法解析的输入（${reason}）`),
    });
    this.subscribe();
  }

  session(): AgentSession {
    return currentSession(this.runtime);
  }

  /** 审批交给客户端：ama 的 UI broker。 */
  readonly broker: ApprovalBroker = {
    ask: (request, signal) => this.askClient(request, signal),
  };

  private makeMapper(): AcpEventMapper {
    return new AcpEventMapper(
      this.cwd,
      (update) => this.emit(update),
      () => this.session(),
    );
  }

  private emit(update: AcpSessionUpdate): void {
    if (this.activeId === undefined) return;
    void this.peer.notify(ACP_METHODS.sessionUpdate, { sessionId: this.activeId, update });
  }

  private subscribe(): void {
    this.unsubscribe();
    const mapper = this.mapper;
    this.unsubscribe = this.session().subscribe((event: SessionEvent) => mapper.onEvent(event));
  }

  dispose(): void {
    this.unsubscribe();
  }

  private async handle(method: string, params: Params): Promise<unknown> {
    switch (method) {
      case ACP_METHODS.initialize:
        return this.initialize(params);
      case ACP_METHODS.sessionNew:
        return this.newSession(params);
      case ACP_METHODS.sessionLoad:
        return this.openSession(params, true);
      case ACP_METHODS.sessionResume:
        return this.openSession(params, false);
      case ACP_METHODS.sessionList:
        return this.list();
      case ACP_METHODS.sessionClose:
        return this.close(params);
      case ACP_METHODS.sessionPrompt:
        return this.prompt(params);
      case ACP_METHODS.sessionSetMode:
        return this.setMode(params);
      default:
        throw new RpcError(RPC_ERRORS.methodNotFound, `method not found: ${method}`);
    }
  }

  private initialize(params: Params): AcpInitializeResult {
    if (typeof params["protocolVersion"] !== "number")
      throw new RpcError(RPC_ERRORS.invalidParams, "缺少 protocolVersion");
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: ACP_AGENT_CAPABILITIES,
      authMethods: [],
      agentInfo: { name: "ama", title: "ama", version: AMA_VERSION },
    };
  }

  private checkCwd(params: Params): void {
    const cwd = params["cwd"];
    if (cwd === undefined) return;
    if (typeof cwd !== "string" || resolve(cwd) !== this.cwd)
      throw new RpcError(
        RPC_ERRORS.invalidParams,
        `ama --mode acp 的会话目录固定为启动目录 ${this.cwd}（收到 ${String(cwd)}）`,
      );
  }

  private modes() {
    return permissionModes(this.session().state.permissionMode);
  }

  private async switchTo(next: Promise<AgentSession>, reason: "new" | "resume"): Promise<void> {
    const session = await next;
    this.mapper = this.makeMapper();
    this.subscribe();
    if (session instanceof AgentSessionImpl) session.announceStart(reason);
  }

  private async newSession(params: Params): Promise<unknown> {
    this.checkCwd(params);
    const current = this.session();
    if (this.freshUnclaimed && current.messages.length === 0) {
      this.freshUnclaimed = false;
    } else {
      this.ensureIdle();
      await this.switchTo(switchSession(this.runtime, { kind: "new" }), "new");
    }
    this.activeId = this.session().state.sessionId;
    return { sessionId: this.activeId, modes: this.modes() };
  }

  private async openSession(params: Params, replay: boolean): Promise<unknown> {
    const id = str(params, "sessionId");
    this.checkCwd(params);
    if (this.session().state.sessionId !== id) {
      this.ensureIdle();
      try {
        await this.switchTo(switchSession(this.runtime, { kind: "resume", id }), "resume");
      } catch (error) {
        throw new RpcError(RPC_ERRORS.resourceNotFound, `找不到会话 ${id}：${errorText(error)}`);
      }
    }
    this.freshUnclaimed = false;
    this.activeId = id;
    if (replay) {
      this.mapper.replay(this.session().messages);
      await this.peer.flush();
    }
    return { modes: this.modes() };
  }

  private list(): unknown {
    const items = listSessions({ sessionDir: this.runtime.paths.sessionDir, cwd: this.cwd });
    return {
      sessions: items.map((item) => ({
        sessionId: item.id,
        cwd: item.cwd,
        title: item.name ?? item.firstPrompt ?? null,
        updatedAt: item.modifiedAt,
      })),
    };
  }

  private async close(params: Params): Promise<unknown> {
    const id = str(params, "sessionId");
    if (id === this.activeId) {
      if (this.session().state.isStreaming) await this.session().abort();
      this.activeId = undefined;
    }
    return {};
  }

  private ensureIdle(): void {
    if (this.session().state.isStreaming)
      throw new RpcError(RPC_ERRORS.invalidRequest, "当前会话正在运行，先 session/cancel");
  }

  private async prompt(params: Params): Promise<AcpPromptResult> {
    const id = str(params, "sessionId");
    if (id !== this.activeId) await this.openSession({ sessionId: id }, false);
    const { text, images } = promptOf(params["prompt"]);
    const session = this.session();
    const before = session.getStats().tokens;
    this.cancelRequested = false;
    try {
      await session.prompt(text, images.length > 0 ? { images } : {});
    } catch (error) {
      throw new RpcError(RPC_ERRORS.internalError, errorText(error));
    }
    await this.peer.flush();
    const after = session.getStats().tokens;
    const usage = {
      inputTokens: after.input - before.input,
      outputTokens: after.output - before.output,
      cachedReadTokens: after.cacheRead - before.cacheRead,
      cachedWriteTokens: after.cacheWrite - before.cacheWrite,
      totalTokens: after.total - before.total,
    };
    const last = [...session.messages].reverse().find((m) => "role" in m && m.role === "assistant");
    const reason = last !== undefined && "stopReason" in last ? last.stopReason : "stop";
    if (this.cancelRequested || reason === "aborted") return { stopReason: "cancelled", usage };
    if (reason === "error") {
      const message = last !== undefined && "errorMessage" in last ? last.errorMessage : undefined;
      throw new RpcError(RPC_ERRORS.internalError, message ?? "模型请求失败");
    }
    return { stopReason: reason === "length" ? "max_tokens" : "end_turn", usage };
  }

  private async cancel(params: Params): Promise<void> {
    if (params["sessionId"] !== this.activeId) return;
    this.cancelRequested = true;
    await this.session()
      .abort()
      .catch(() => undefined);
  }

  private setMode(params: Params): unknown {
    str(params, "sessionId");
    const mode = params["modeId"];
    if (!isPermissionMode(mode))
      throw new RpcError(RPC_ERRORS.invalidParams, `未知模式：${String(mode)}`);
    this.session().setPermissionMode(mode);
    return {};
  }

  private async askClient(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalDecision | undefined> {
    const sessionId = this.activeId;
    if (sessionId === undefined || !this.peer.isOpen) return undefined;
    const toolCallId =
      this.mapper.toolCallIdFor(request.toolName, request.input) ?? request.requestId;
    const locations = toolLocations(request.input, this.cwd);
    let answer: AcpRequestPermissionResult;
    try {
      answer = await this.peer.request<AcpRequestPermissionResult>(
        ACP_METHODS.requestPermission,
        {
          sessionId,
          toolCall: {
            toolCallId,
            title: toolTitle(request.toolName, request.input),
            kind: toolKind(request.toolName),
            status: "pending",
            rawInput: request.input,
            ...(locations !== undefined ? { locations } : {}),
          },
          options: [
            { optionId: "allow_once", name: "允许", kind: "allow_once" },
            { optionId: "allow_always", name: "本会话允许", kind: "allow_always" },
            { optionId: "reject_once", name: "拒绝", kind: "reject_once" },
          ],
        },
        signal,
      );
    } catch {
      return undefined;
    }
    const outcome = answer?.outcome;
    if (outcome?.outcome !== "selected") return undefined;
    if (outcome.optionId === "allow_once") return "allow";
    if (outcome.optionId === "allow_always") return "allow_session";
    if (outcome.optionId === "reject_once") return "deny";
    return undefined;
  }
}
