/**
 * `ama --mode acp`：把 ama 的会话暴露为 ACP Agent（docs/wave5-plan.md §5.6，D14；多会话见
 * docs/acp-plan.md D1、D2、D11、D12、§2.1）。[W5-E，ACP-B]
 *
 * 与 `--mode rpc` 同一引擎（Runtime + 组装根）。多会话：
 * - 每个 ACP sessionId 一个常驻会话（会话池，acp-sessions.ts），各有自己的事件映射器与权限模式；
 *   启动时那个空会话由第一个 `session/new` 认领，之后的 new / load / resume 建兄弟会话（不 dispose 旧的）。
 * - 同一时刻只跑一个回合：其它会话的 `session/prompt` 进 FIFO 队列；出队时把该会话切为前台
 *   （宿主 / Hook / 工具工厂跟随，清「本会话允许」记忆），并把它自己的权限模式重放到共享管线。
 * - `session/cancel`：在跑 → abort；排队中 → 直接回 cancelled。`session/close`：中断、释放并出池，
 *   之后对该 id 发 prompt 回 -32002。`$/cancel_request` 撤回 prompt 等价 cancel，答复 -32800。
 * - `session/set_mode`：记在会话上；是前台就立即生效，否则出队时生效（仍发 `current_mode_update`）。
 * - `session/list`：按 cwd 过滤（别的目录 → 空列表），每页 50 条，cursor 翻页；标题去掉嵌入资源块。
 * - 回合结束：stopReason（中断 → cancelled、截断 → max_tokens、拒答 → refusal、出错 → JSON-RPC 错误），
 *   并发 `session_info_update`。
 * - 审批经 `session/request_permission` 交给客户端；不声明 / 不使用客户端的 `fs`、`terminal` 能力。
 * - cwd 固定为启动目录；客户端给的 `mcpServers` / `additionalDirectories` 忽略（stderr 一行）。
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ImageBlock } from "../../ai/types.js";
import { stopReasonOf } from "../../ai/apis/shared.js";
import type { AgentSession, SessionEvent } from "../../agent/types.js";
import {
  createSessionAlongside,
  currentSession,
  disposeSessionAlongside,
  setForegroundSession,
} from "../../cli/compose-session.js";
import { listSessions } from "../../cli/compose-store.js";
import type { Runtime } from "../../cli/runtime.js";
import { AgentSessionImpl } from "../../agent/session.js";
import { RpcError, type IncomingRequestContext, type JsonRpcPeer } from "../../drivers/jsonrpc.js";
import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  RPC_ERRORS,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpPromptResult,
  type AcpRequestPermissionResult,
  type AcpSessionConfigOption,
  type AcpSetConfigOptionParams,
} from "../../drivers/acp/types.js";
import { isPermissionMode } from "../../permissions/modes.js";
import type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalRequest,
  PermissionMode,
} from "../../permissions/types.js";
import { AMA_VERSION } from "../../version.js";
import { errorText } from "../shared.js";
import {
  AcpEventMapper,
  permissionModes,
  toolKind,
  toolLocations,
  toolTitle,
} from "./acp-events.js";
import { msg } from "../../i18n/index.js";
import {
  applyConfigOption,
  availableCommands,
  buildConfigOptions,
  prepareConfigOptions,
} from "./acp-config.js";
import { clientCapabilitiesOf, type AcpConnection } from "./acp-connection.js";
import {
  PromptQueue,
  cancelledResult,
  pageSessions,
  sessionTitle,
  type PooledSession,
  type PromptJob,
} from "./acp-sessions.js";

export const ACP_AGENT_CAPABILITIES = {
  loadSession: true,
  promptCapabilities: { image: true, audio: false, embeddedContext: true },
  mcpCapabilities: { http: false, sse: false },
  sessionCapabilities: { list: {}, resume: {}, close: {} },
};

export type Params = Record<string, unknown>;

/** 解析符号链接后的绝对路径（macOS 的 /var → /private/var 等）；不存在时退回 resolve。 */
function canonical(path: string): string {
  try {
    return realpathSync.native(resolve(path));
  } catch {
    return resolve(path);
  }
}

function str(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "")
    throw new RpcError(RPC_ERRORS.invalidParams, msg().acp.core.missingParam(key));
  return value;
}

/** ACP 提示 → ama 的文本与图片。 */
export function promptOf(blocks: unknown): { text: string; images: ImageBlock[] } {
  if (!Array.isArray(blocks))
    throw new RpcError(RPC_ERRORS.invalidParams, msg().acp.core.promptNotArray);
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

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export class AcpServer {
  readonly peer: JsonRpcPeer;
  private readonly cwd: string;
  /** ACP sessionId → 常驻会话。 */
  private readonly pool = new Map<string, PooledSession>();
  /** 还没交给客户端的会话（启动时那个；关掉最后一个前台会话后补的）：`session/new` 认领。 */
  private standby: AgentSessionImpl | undefined;
  /** 新会话的初始权限模式（启动参数 / 配置给的）。 */
  private readonly initialMode: PermissionMode;
  private readonly queue = new PromptQueue((job) => this.runPrompt(job));

  /**
   * 连接由调用方建（`createAcpConnection`），其 handlers 转到 {@link handle} 与
   * {@link handleNotification}；认证门在 bootstrap 成功后以同一条连接构造服务端。
   */
  constructor(
    private readonly runtime: Runtime,
    readonly connection: AcpConnection,
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.cwd = canonical(runtime.paths.cwd);
    this.peer = connection.peer;
    const startup = currentSession(runtime);
    if (startup instanceof AgentSessionImpl) this.standby = startup;
    this.initialMode = startup.state.permissionMode;
  }

  /** 前台会话（宿主 / Hook / 工具工厂当前操作的那个）。 */
  session(): AgentSession {
    return currentSession(this.runtime);
  }

  /** 会话池里的全部会话（含未认领的待命会话）；stdin 关闭时逐个收尾。 */
  sessions(): AgentSession[] {
    const all: AgentSession[] = [...this.pool.values()].map((entry) => entry.session);
    if (this.standby !== undefined) all.push(this.standby);
    return all;
  }

  /** 审批交给客户端：ama 的 UI broker。 */
  readonly broker: ApprovalBroker = {
    ask: (request, signal) => this.askClient(request, signal),
  };

  private extras(session: AgentSession) {
    return {
      configOptions: this.configOptions(session),
      commands: availableCommands(this.runtime.resources),
    };
  }

  private configOptions(session: AgentSession): AcpSessionConfigOption[] {
    return buildConfigOptions(session, this.runtime.providers, process.env, {
      enabled: this.runtime.config.models?.enabled,
    });
  }

  /** 把会话放进池：自己的映射器（`session/update` 带它自己的 id）与订阅。 */
  private adopt(session: AgentSessionImpl, mode: PermissionMode): PooledSession {
    const id = session.state.sessionId;
    const mapper = new AcpEventMapper(
      this.cwd,
      (update) => void this.peer.notify(ACP_METHODS.sessionUpdate, { sessionId: id, update }),
      () => session,
      () => this.extras(session),
    );
    const unsubscribe = session.subscribe((event: SessionEvent) => mapper.onEvent(event));
    const entry: PooledSession = { id, session, mapper, unsubscribe, mode };
    this.pool.set(id, entry);
    return entry;
  }

  /**
   * 释放全部会话（stdin 关闭后由模式调用）：排队的回 cancelled，等在跑的结束，兄弟会话依次
   * dispose（跑 SessionEnd Hook）；前台会话留给 `Runtime.dispose`。
   */
  async dispose(abort = false): Promise<void> {
    this.queue.cancelQueued();
    if (abort)
      await this.session()
        .abort()
        .catch(() => undefined);
    await this.queue.settled();
    for (const session of this.sessions()) await session.waitForIdle().catch(() => undefined);
    const foreground = this.session();
    for (const entry of this.pool.values()) entry.unsubscribe();
    for (const session of this.sessions()) {
      if (session === foreground || !(session instanceof AgentSessionImpl)) continue;
      if (!(foreground instanceof AgentSessionImpl)) continue;
      await disposeSessionAlongside(this.runtime, session, foreground).catch(() => undefined);
    }
    this.pool.clear();
    this.standby = undefined;
  }

  /** 客户端通知（`session/cancel`）。 */
  handleNotification(method: string, params: unknown): void {
    if (method === ACP_METHODS.sessionCancel) void this.cancel((params ?? {}) as Params);
  }

  /** 客户端请求；认证门交接时也由它处理当次请求。 */
  async handle(method: string, params: Params, ctx?: IncomingRequestContext): Promise<unknown> {
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
        return this.list(params);
      case ACP_METHODS.sessionClose:
        return this.close(params);
      case ACP_METHODS.sessionPrompt:
        return this.prompt(params, ctx?.signal);
      case ACP_METHODS.sessionSetMode:
        return this.setMode(params);
      case ACP_METHODS.sessionSetConfigOption:
        return this.setConfigOption(params);
      default:
        throw new RpcError(RPC_ERRORS.methodNotFound, `method not found: ${method}`);
    }
  }

  private initialize(params: Params): AcpInitializeResult {
    if (typeof params["protocolVersion"] !== "number")
      throw new RpcError(RPC_ERRORS.invalidParams, msg().acp.core.missingProtocolVersion);
    this.connection.markInitialized(clientCapabilitiesOf(params));
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: ACP_AGENT_CAPABILITIES,
      authMethods: [],
      agentInfo: { name: "ama", title: "ama", version: AMA_VERSION },
    };
  }

  /** 开会话请求的公共检查：cwd 固定；`mcpServers` / `additionalDirectories` 忽略并在 stderr 说一行。 */
  private checkOpen(params: Params): void {
    const cwd = params["cwd"];
    if (cwd !== undefined && (typeof cwd !== "string" || canonical(cwd) !== this.cwd))
      throw new RpcError(RPC_ERRORS.invalidParams, msg().acp.core.fixedCwd(this.cwd, String(cwd)));
    const mcp = countOf(params["mcpServers"]);
    if (mcp > 0) this.log(msg().acp.session.ignoredMcp(mcp));
    const dirs = countOf(params["additionalDirectories"]);
    if (dirs > 0) this.log(msg().acp.session.ignoredDirs(dirs));
  }

  /** new / load / resume 的答复：模式与配置项；答复发出后再公布命令表与配置项。 */
  private opened(entry: PooledSession): { modes: ReturnType<typeof permissionModes> } & {
    configOptions?: AcpSessionConfigOption[];
  } {
    const configOptions = this.configOptions(entry.session);
    setImmediate(() => entry.mapper.announce());
    return {
      modes: permissionModes(entry.mode),
      ...(configOptions.length > 0 ? { configOptions } : {}),
    };
  }

  private async newSession(params: Params): Promise<unknown> {
    this.checkOpen(params);
    await prepareConfigOptions(this.runtime.providers);
    let session: AgentSessionImpl;
    if (this.standby !== undefined && this.standby.messages.length === 0) {
      session = this.standby;
      this.standby = undefined;
    } else {
      session = await createSessionAlongside(this.runtime, { kind: "new" });
    }
    const entry = this.adopt(session, this.initialMode);
    // 兄弟会话自己的 session_start 在订阅之后发（认领的启动会话早已发过）
    if (session !== currentSession(this.runtime)) session.announceStart("new");
    return { sessionId: entry.id, ...this.opened(entry) };
  }

  private async openSession(params: Params, replay: boolean): Promise<unknown> {
    const id = str(params, "sessionId");
    this.checkOpen(params);
    await prepareConfigOptions(this.runtime.providers);
    let entry = this.pool.get(id);
    if (entry === undefined) {
      if (this.standby !== undefined && this.standby.state.sessionId === id) {
        entry = this.adopt(this.standby, this.initialMode);
        this.standby = undefined;
      } else {
        let session: AgentSessionImpl;
        try {
          session = await createSessionAlongside(this.runtime, { kind: "resume", id });
        } catch (error) {
          throw new RpcError(
            RPC_ERRORS.resourceNotFound,
            msg().acp.core.sessionNotFound(id, errorText(error)),
          );
        }
        entry = this.pool.get(id) ?? this.adopt(session, this.initialMode);
        session.announceStart("resume");
      }
    }
    if (replay) {
      entry.mapper.replay(entry.session.messages);
      await this.peer.flush();
    }
    return this.opened(entry);
  }

  private list(params: Params): unknown {
    const cwd = params["cwd"];
    if (
      cwd !== undefined &&
      cwd !== null &&
      (typeof cwd !== "string" || canonical(cwd) !== this.cwd)
    )
      return { sessions: [] };
    // 会话目录按 ama 启动时的 cwd 字串分组（不是 realpath）
    const items = listSessions({
      sessionDir: this.runtime.paths.sessionDir,
      cwd: this.runtime.paths.cwd,
    });
    return pageSessions(items, params["cursor"]);
  }

  private entryOf(params: Params): PooledSession {
    const id = str(params, "sessionId");
    const entry = this.pool.get(id);
    if (entry === undefined)
      throw new RpcError(RPC_ERRORS.resourceNotFound, msg().acp.session.notOpen(id));
    return entry;
  }

  private async close(params: Params): Promise<unknown> {
    const id = str(params, "sessionId");
    const entry = this.pool.get(id);
    if (entry === undefined) return {};
    this.pool.delete(id);
    this.queue.cancelQueued(id);
    const running = this.queue.running;
    if (running?.sessionId === id) {
      running.cancelRequested = true;
      await entry.session.abort().catch(() => undefined);
      await this.queue.settled(id);
    }
    entry.unsubscribe();
    let fallback = this.session();
    if (fallback === entry.session) {
      const next = [...this.pool.values()][0]?.session ?? this.standby;
      if (next !== undefined) fallback = next;
      else {
        // 关掉的是唯一的会话：补一个待命会话当前台，下一个 session/new 认领它
        this.standby = await createSessionAlongside(this.runtime, { kind: "new" });
        fallback = this.standby;
      }
    }
    if (fallback instanceof AgentSessionImpl)
      await disposeSessionAlongside(this.runtime, entry.session, fallback);
    return {};
  }

  private async prompt(params: Params, signal?: AbortSignal): Promise<AcpPromptResult> {
    const entry = this.entryOf(params);
    const { text, images } = promptOf(params["prompt"]);
    const result = new Promise<AcpPromptResult>((resolve, reject) => {
      const job: PromptJob = {
        sessionId: entry.id,
        text,
        images,
        cancelRequested: false,
        resolve,
        reject,
      };
      // 客户端以 $/cancel_request 撤回：等价 session/cancel，答复由对等端改成 -32800。
      // 连接关闭（stdin 结束）也会 abort 这个 signal——那时不算撤回，已开始的运行照常跑完。
      signal?.addEventListener(
        "abort",
        () => {
          if (this.peer.isOpen) this.cancelJob(job);
        },
        { once: true },
      );
      this.queue.push(job);
    });
    const answer = await result;
    if (signal?.aborted === true && this.peer.isOpen)
      throw new RpcError(RPC_ERRORS.requestCancelled, "session/prompt: request cancelled");
    return answer;
  }

  /** 出队：切前台、重放权限模式、跑回合、算 stopReason，再发 `session_info_update`。 */
  private async runPrompt(job: PromptJob): Promise<AcpPromptResult> {
    const entry = this.pool.get(job.sessionId);
    if (entry === undefined || job.cancelRequested) return cancelledResult();
    const { session } = entry;
    setForegroundSession(this.runtime, session);
    if (this.runtime.permission.mode !== entry.mode) session.setPermissionMode(entry.mode);
    const before = session.getStats().tokens;
    let failure: unknown;
    try {
      await session.prompt(job.text, job.images.length > 0 ? { images: job.images } : {});
    } catch (error) {
      failure = error;
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
    entry.mapper.emitSessionInfo(
      sessionTitle(session.state.sessionName, session.messages),
      new Date().toISOString(),
    );
    if (job.cancelRequested) return { stopReason: "cancelled", usage };
    if (failure !== undefined) throw new RpcError(RPC_ERRORS.internalError, errorText(failure));
    const last = [...session.messages].reverse().find((m) => "role" in m && m.role === "assistant");
    const reason = last !== undefined && "stopReason" in last ? stopReasonOf(last) : "stop";
    if (reason === "aborted") return { stopReason: "cancelled", usage };
    if (reason === "refusal") return { stopReason: "refusal", usage };
    if (reason === "error") {
      const message = last !== undefined && "errorMessage" in last ? last.errorMessage : undefined;
      throw new RpcError(RPC_ERRORS.internalError, message ?? msg().acp.core.modelFailed);
    }
    return { stopReason: reason === "length" ? "max_tokens" : "end_turn", usage };
  }

  /** 中断一个提示：在跑 → abort；排队中 → 出队后立即回 cancelled（`runPrompt` 见标记直接返回）。 */
  private cancelJob(job: PromptJob): void {
    job.cancelRequested = true;
    if (this.queue.running === job) {
      const entry = this.pool.get(job.sessionId);
      void entry?.session.abort().catch(() => undefined);
    }
  }

  private async cancel(params: Params): Promise<void> {
    const id = params["sessionId"];
    if (typeof id !== "string") return;
    this.queue.cancelQueued(id);
    const running = this.queue.running;
    if (running?.sessionId === id) this.cancelJob(running);
  }

  private setMode(params: Params): unknown {
    const entry = this.entryOf(params);
    const mode = params["modeId"];
    if (!isPermissionMode(mode))
      throw new RpcError(RPC_ERRORS.invalidParams, msg().acp.core.unknownMode(String(mode)));
    entry.mode = mode;
    if (entry.session === this.session()) entry.session.setPermissionMode(mode);
    else
      void this.peer.notify(ACP_METHODS.sessionUpdate, {
        sessionId: entry.id,
        update: { sessionUpdate: "current_mode_update", currentModeId: mode },
      });
    return {};
  }

  private async setConfigOption(params: Params): Promise<unknown> {
    const entry = this.entryOf(params);
    str(params, "configId");
    await applyConfigOption(entry.session, params as unknown as AcpSetConfigOptionParams);
    return { configOptions: this.configOptions(entry.session) };
  }

  private async askClient(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<ApprovalDecision | undefined> {
    // 审批来自在跑的那个回合（它就是前台）；不在回合里时按前台会话
    const running = this.queue.running;
    const foreground = this.session();
    const entry =
      running !== undefined
        ? this.pool.get(running.sessionId)
        : [...this.pool.values()].find((e) => e.session === foreground);
    if (entry === undefined || !this.peer.isOpen) return undefined;
    // 本会话（含 codemode 内层）的调用 id 就是已发 tool_call 的 id；子 Agent（depth > 0）的 id 属于
    // 子会话、客户端没见过，退回按工具名 + 参数匹配
    const context = request.context;
    const own = (context?.depth ?? 0) === 0 && context?.taskId === undefined;
    const toolCallId =
      (own ? context?.toolCallId : undefined) ??
      entry.mapper.toolCallIdFor(request.toolName, request.input) ??
      request.requestId;
    // 映射器记得的标题优先（codemode 内层带前缀，客户端不会被改成无前缀的标题）
    const title = entry.mapper.titleFor(toolCallId) ?? toolTitle(request.toolName, request.input);
    const locations = toolLocations(request.input, this.cwd);
    let answer: AcpRequestPermissionResult;
    try {
      answer = await this.peer.request<AcpRequestPermissionResult>(
        ACP_METHODS.requestPermission,
        {
          sessionId: entry.id,
          toolCall: {
            toolCallId,
            title,
            kind: toolKind(request.toolName),
            status: "pending",
            rawInput: request.input,
            ...(locations !== undefined ? { locations } : {}),
          },
          options: [
            { optionId: "allow_once", name: msg().acp.core.allowOnce, kind: "allow_once" },
            { optionId: "allow_always", name: msg().acp.core.allowAlways, kind: "allow_always" },
            { optionId: "reject_once", name: msg().acp.core.rejectOnce, kind: "reject_once" },
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
