/**
 * Codex 原生驱动：`codex app-server`（stdio JSON-RPC，docs/wave5-plan.md §5.1，R2 §1.3）。[W5-E]
 *
 * - `initialize{clientInfo}` → `initialized` 通知 → `thread/start`（或 `thread/resume`，带
 *   `excludeTurns` 不回放）→ 每回合 `turn/start`，以对应 turn 的 `turn/completed` 结束；
 *   运行中追加用 `turn/steer{expectedTurnId}`；中断 `turn/interrupt`（15 s 看门狗）。
 * - 审批（服务端请求，只交给人）：`item/commandExecution/requestApproval`、
 *   `item/fileChange/requestApproval` → accept / acceptForSession / decline（回合取消 → cancel；
 *   execpolicy 与网络策略修订会改持久配置，不提供）；`item/permissions/requestApproval` →
 *   按人的选择授予本回合 / 本会话或不授予；`item/tool/requestUserInput` 与
 *   `mcpServer/elicitation/request` 不代答（错误 / cancel，并发提示）。
 * - 用量：`thread/tokenUsage/updated` 的 `total` 差值记本回合（订阅 token，不换算美元）。
 * - 每个会话一个子进程，不连共享 daemon（隔离清楚）。
 */

import type { ContentBlock } from "../../ai/types.js";
import { AmaError } from "../../errors.js";
import { AMA_VERSION } from "../../version.js";
import { armCancelWatchdog, probeCandidate, spawnOf, type DriverDeps } from "../base.js";
import type { CatalogCandidate } from "../catalog.js";
import { JsonRpcPeer, RpcError } from "../jsonrpc.js";
import { stderrHint, type AgentTransport } from "../process.js";
import { TurnCollector, oneLine } from "../turn.js";
import type {
  AgentDriver,
  DriverOpenOptions,
  DriverPermissionRequest,
  DriverProbe,
  DriverPromptHooks,
  DriverSession,
  DriverTurnResult,
} from "../types.js";
import {
  codexDecision,
  codexPlan,
  codexPolicy,
  codexToolEvent,
  grantedProfile,
  readTokens,
  type CodexTokens,
} from "./codex-normalize.js";
import { msg } from "../../i18n/index.js";

type Json = Record<string, unknown>;

const DECISION_OPTIONS: DriverPermissionRequest["options"] = [
  { optionId: "accept", kind: "allow_once" },
  { optionId: "acceptForSession", kind: "allow_always" },
  { optionId: "decline", kind: "reject_once" },
];

function textInput(content: readonly ContentBlock[]): Json[] {
  return content.flatMap((b) =>
    b.type === "text" ? [{ type: "text", text: b.text, text_elements: [] }] : [],
  );
}

export class CodexAppServerDriver implements AgentDriver {
  readonly kind = "codex-app-server" as const;

  constructor(
    readonly agentId: string,
    private readonly candidate: CatalogCandidate,
    private readonly deps: DriverDeps = {},
  ) {}

  probe(): Promise<DriverProbe> {
    return probeCandidate(this.candidate, this.deps);
  }

  async open(options: DriverOpenOptions): Promise<DriverSession> {
    const probed = await probeCandidate(this.candidate, this.deps);
    const transport = spawnOf(this.deps)({
      program: probed.path ?? this.candidate.program,
      args: this.candidate.args,
      cwd: options.cwd,
      env: options.env,
    });
    const session = new CodexSession(this.agentId, transport, this.deps);
    if (probed.warning !== undefined) session.notices.push(probed.warning);
    try {
      await session.start(options);
    } catch (error) {
      await session.close();
      if (error instanceof AmaError) throw error;
      throw new AmaError(
        "agent_start_failed",
        `${this.agentId}: app-server failed to start (${(error as Error).message})${stderrHint(transport) !== "" ? `: ${stderrHint(transport)}` : ""}`,
        { cause: error },
      );
    }
    return session;
  }
}

class CodexSession implements DriverSession {
  readonly notices: string[] = [];
  private readonly peer: JsonRpcPeer;
  private threadId = "";
  private turnId: string | undefined;
  private turn: TurnCollector | undefined;
  private hooks: DriverPromptHooks | undefined;
  private finishTurn: ((turn: Json) => void) | undefined;
  private running: Promise<DriverTurnResult> | undefined;
  private readonly permissions = new Set<AbortController>();
  /** fileChange 条目的路径（审批请求只带 itemId）。 */
  private readonly itemPaths = new Map<string, string[]>();
  private readonly messages = new Map<string, string>();
  private tokensTotal: CodexTokens | undefined;
  private tokensAtStart: CodexTokens | undefined;
  private contextWindow: number | undefined;
  /** 最近一次请求的总量（`tokenUsage.last.totalTokens`）= 线程当前的上下文占用。 */
  private contextTokens: number | undefined;
  private closed = false;
  private interruptRequested = false;

  constructor(
    private readonly agentId: string,
    private readonly transport: AgentTransport,
    private readonly deps: DriverDeps,
  ) {
    this.peer = new JsonRpcPeer({
      input: transport.stdout,
      output: transport.stdin,
      jsonrpcField: false,
      onRequest: (method, params) => this.onServerRequest(method, (params ?? {}) as Json),
      onNotification: (method, params) => this.onNotification(method, (params ?? {}) as Json),
      onClose: () => {
        for (const c of this.permissions) c.abort();
      },
    });
  }

  get sessionId(): string {
    return this.threadId;
  }

  async start(options: DriverOpenOptions): Promise<void> {
    const signal = options.signal;
    await this.peer.request(
      "initialize",
      {
        clientInfo: { name: "ama", title: "ama", version: AMA_VERSION },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
      signal,
    );
    await this.peer.notify("initialized");
    const policy = codexPolicy(options.mode, options.unattended === true);
    const common = {
      cwd: options.cwd,
      ...policy,
      ...(options.model !== undefined ? { model: options.model } : {}),
    };
    if (options.resume !== undefined) {
      try {
        const resumed = await this.peer.request<{ thread?: { id?: string } }>(
          "thread/resume",
          { threadId: options.resume, excludeTurns: true, ...common },
          signal,
        );
        this.threadId = resumed.thread?.id ?? options.resume;
        return;
      } catch (error) {
        if (signal.aborted || !(error instanceof RpcError)) throw error;
        this.notices.push(msg().drivers.agent.resumeNotFound(this.agentId, options.resume));
      }
    }
    const started = await this.peer.request<{ thread?: { id?: string } }>(
      "thread/start",
      common,
      signal,
    );
    const id = started.thread?.id;
    if (typeof id !== "string" || id === "") throw new Error("thread/start returned no thread.id");
    this.threadId = id;
  }

  async prompt(content: ContentBlock[], hooks: DriverPromptHooks): Promise<DriverTurnResult> {
    if (this.closed || !this.peer.isOpen)
      throw new AmaError("agent_closed", `${this.agentId} session is closed`);
    if (this.running !== undefined)
      throw new AmaError("busy", `${this.agentId} is already running`);
    const turn = new TurnCollector((e) => hooks.onEvent(e));
    for (const text of this.notices.splice(0)) turn.push({ type: "notice", level: "info", text });
    if (content.some((b) => b.type === "image"))
      turn.push({
        type: "notice",
        level: "warn",
        text: msg().drivers.agent.noImagesDriver(this.agentId),
      });
    this.turn = turn;
    this.hooks = hooks;
    this.messages.clear();
    this.tokensAtStart = this.tokensTotal;
    this.interruptRequested = false;
    const completed = new Promise<Json>((resolve) => (this.finishTurn = resolve));
    const closed = this.peer.closed.then(() => {
      throw new AmaError(
        "agent_exited",
        `${this.agentId} process exited${stderrHint(this.transport) !== "" ? `: ${stderrHint(this.transport)}` : ""}`,
      );
    });
    void closed.catch(() => undefined);
    this.running = (async () => {
      const response = await Promise.race([
        this.peer.request<{ turn?: { id?: string } }>("turn/start", {
          threadId: this.threadId,
          input: textInput(content),
        }),
        closed,
      ]);
      if (typeof response.turn?.id === "string") this.setTurnId(response.turn.id);
      const done = await Promise.race([completed, closed]);
      return this.complete(done, turn);
    })();
    try {
      return await this.running;
    } finally {
      this.running = undefined;
      this.turn = undefined;
      this.hooks = undefined;
      this.turnId = undefined;
      this.finishTurn = undefined;
    }
  }

  async steer(content: ContentBlock[]): Promise<void> {
    if (this.turnId === undefined)
      throw new AmaError("not_running", `${this.agentId} has no turn in progress`);
    await this.peer.request("turn/steer", {
      threadId: this.threadId,
      input: textInput(content),
      expectedTurnId: this.turnId,
    });
  }

  async cancel(): Promise<void> {
    const running = this.running;
    if (running === undefined || this.closed) return;
    for (const c of this.permissions) c.abort();
    this.interruptRequested = true;
    if (this.turnId !== undefined) this.sendInterrupt(this.turnId);
    armCancelWatchdog(
      this.transport,
      running.catch(() => undefined),
      this.deps,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.permissions) c.abort();
    this.peer.close();
    await this.transport.terminate();
  }

  /** turn id 可能先从通知 / 服务端请求里知道（早于 turn/start 的响应被处理）。 */
  private setTurnId(id: string): void {
    if (this.running === undefined || this.turnId !== undefined) return;
    this.turnId = id;
    if (this.interruptRequested) this.sendInterrupt(id);
  }

  private sendInterrupt(turnId: string): void {
    void this.peer
      .request("turn/interrupt", { threadId: this.threadId, turnId })
      .catch(() => undefined);
  }

  private complete(turnInfo: Json, turn: TurnCollector): DriverTurnResult {
    const start = this.tokensAtStart;
    const end = this.tokensTotal;
    if (end !== undefined) {
      turn.push({
        type: "usage",
        input: end.inputTokens - (start?.inputTokens ?? 0),
        output: end.outputTokens - (start?.outputTokens ?? 0),
        cacheRead: end.cachedInputTokens - (start?.cachedInputTokens ?? 0),
        ...(this.contextTokens !== undefined ? { contextTokens: this.contextTokens } : {}),
        ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}),
      });
    }
    const last = [...this.messages.values()].at(-1);
    if (last !== undefined) turn.setFinalText(last);
    const status = turnInfo["status"];
    if (status === "interrupted") return turn.result("cancelled");
    if (status === "failed") {
      const error = (turnInfo["error"] ?? {}) as Json;
      throw new AmaError(
        "agent_failed",
        `${this.agentId} turn failed: ${oneLine(String(error["message"] ?? "unknown"), 300)}`,
      );
    }
    return turn.result("end_turn");
  }

  private onNotification(method: string, params: Json): void {
    const turn = this.turn;
    switch (method) {
      case "thread/tokenUsage/updated": {
        const usage = (params["tokenUsage"] ?? {}) as Json;
        const total = readTokens(usage["total"]);
        if (total !== undefined) this.tokensTotal = total;
        const last = readTokens(usage["last"]);
        if (last !== undefined && last.totalTokens > 0) this.contextTokens = last.totalTokens;
        if (typeof usage["modelContextWindow"] === "number")
          this.contextWindow = usage["modelContextWindow"];
        return;
      }
      case "turn/started": {
        const id = ((params["turn"] ?? {}) as Json)["id"];
        if (typeof id === "string") this.setTurnId(id);
        return;
      }
      case "turn/completed": {
        const info = (params["turn"] ?? {}) as Json;
        if (this.turnId === undefined || info["id"] === this.turnId) this.finishTurn?.(info);
        return;
      }
      default:
        break;
    }
    if (turn === undefined) return;
    switch (method) {
      case "item/agentMessage/delta": {
        const delta = String(params["delta"] ?? "");
        const id = String(params["itemId"] ?? "");
        this.messages.set(id, (this.messages.get(id) ?? "") + delta);
        turn.push({ type: "message_delta", text: delta });
        return;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        turn.push({ type: "thought_delta", text: String(params["delta"] ?? "") });
        return;
      case "item/started":
      case "item/completed": {
        const item = (params["item"] ?? {}) as Json;
        if (item["type"] === "agentMessage" && method === "item/completed") {
          this.messages.set(String(item["id"]), String(item["text"] ?? ""));
          return;
        }
        const event = codexToolEvent(item, method === "item/started" ? "started" : "completed");
        if (event === undefined) return;
        if (event.locations !== undefined) this.itemPaths.set(event.id, event.locations);
        turn.push(event);
        return;
      }
      case "turn/plan/updated": {
        const plan = codexPlan(params);
        if (plan !== undefined) turn.push(plan);
        return;
      }
      case "error": {
        const error = (params["error"] ?? {}) as Json;
        turn.push({
          type: "notice",
          level: "warn",
          text: msg().drivers.agent.error(
            this.agentId,
            oneLine(String(error["message"] ?? "error"), 200),
            params["willRetry"] === true,
          ),
        });
        return;
      }
      default:
        return;
    }
  }

  private async ask(request: DriverPermissionRequest): Promise<string | undefined> {
    const hooks = this.hooks;
    if (hooks === undefined || this.closed) return undefined;
    const controller = new AbortController();
    this.permissions.add(controller);
    try {
      const outcome = await hooks.onPermission(request, controller.signal);
      return outcome.outcome === "selected" && !controller.signal.aborted
        ? outcome.optionId
        : undefined;
    } finally {
      this.permissions.delete(controller);
    }
  }

  private async onServerRequest(method: string, params: Json): Promise<unknown> {
    if (typeof params["turnId"] === "string") this.setTurnId(params["turnId"]);
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const command = String(params["command"] ?? "");
        const reason = typeof params["reason"] === "string" ? ` — ${params["reason"]}` : "";
        const cwd = typeof params["cwd"] === "string" ? [params["cwd"]] : undefined;
        const answer = await this.ask({
          toolCall: {
            title: `$ ${oneLine(command, 100)}`,
            kind: "execute",
            ...(cwd !== undefined ? { locations: cwd } : {}),
            inputSummary: oneLine(`${command}${reason}`, 300),
          },
          options: DECISION_OPTIONS,
        });
        return { decision: codexDecision(answer) };
      }
      case "item/fileChange/requestApproval": {
        const paths = this.itemPaths.get(String(params["itemId"] ?? "")) ?? [];
        const reason = typeof params["reason"] === "string" ? params["reason"] : "";
        const answer = await this.ask({
          toolCall: {
            title: paths.length > 0 ? `edit ${paths.join(", ")}` : "edit files",
            kind: "edit",
            ...(paths.length > 0 ? { locations: paths } : {}),
            ...(reason !== "" ? { inputSummary: oneLine(reason, 300) } : {}),
          },
          options: DECISION_OPTIONS,
        });
        return { decision: codexDecision(answer) };
      }
      case "item/permissions/requestApproval": {
        const reason = typeof params["reason"] === "string" ? params["reason"] : "";
        const answer = await this.ask({
          toolCall: {
            title: "request additional permissions",
            kind: "other",
            inputSummary: oneLine(`${JSON.stringify(params["permissions"] ?? {})} ${reason}`, 300),
          },
          options: [
            { optionId: "turn", kind: "allow_once" },
            { optionId: "session", kind: "allow_always" },
            { optionId: "deny", kind: "reject_once" },
          ],
        });
        if (answer === "turn" || answer === "session")
          return { permissions: grantedProfile(params["permissions"]), scope: answer };
        return { permissions: {}, scope: "turn" };
      }
      case "item/tool/requestUserInput":
        this.turn?.push({
          type: "notice",
          level: "warn",
          text: msg().drivers.agent.askedQuestionCodex(this.agentId),
        });
        throw new RpcError(-32601, "The coordinator cannot relay interactive questions");
      case "mcpServer/elicitation/request":
        this.turn?.push({
          type: "notice",
          level: "warn",
          text: msg().drivers.agent.mcpElicitation(this.agentId),
        });
        return { action: "cancel", content: null, _meta: null };
      default:
        throw new RpcError(-32601, `ama does not handle ${method}`);
    }
  }
}
