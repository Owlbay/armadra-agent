/**
 * Claude Code 原生驱动：stream-json 长驻进程（docs/wave5-plan.md §5.1，R2 §1.2）。[W5-E]
 *
 * `claude -p --input-format stream-json --output-format stream-json --verbose
 *  --include-partial-messages --permission-prompt-tool stdio --permission-mode <m> --session-id <uuid>`
 * （续聊 `--resume <id>`；预算 `--max-budget-usd`；无人值守改 `--permission-prompts none`）。
 *
 * - 多轮复用同一进程：每回合写一行 `{"type":"user",…}`，以 `result` 结束；运行中再写即 steer。
 * - 权限：`control_request{can_use_tool}` → hooks.onPermission（只交给人）→ `control_response`
 *   allow（必须带 `updatedInput`，原样回传）/ deny；`control_cancel_request` 让挂起的请求回
 *   cancelled。「本会话允许」只在 Claude 给了 `destination: "session"` 的建议时提供，并只回传这些
 *   （会写配置文件的建议不替人接受）。`AskUserQuestion` 不代答：拒绝并提示写进最终回复。
 * - 中断：`control_request{interrupt}`；15 s 无 `result` → 关 stdin → 杀进程树（#98713 / #94741）。
 * - `--bare` 永不使用（它只认 API key，会把订阅切到 API 计费）。
 * - 成本：`result.total_cost_usd` 是 Claude 自己的估算（同一进程内累计，按差值记本回合）。
 */

import { randomUUID } from "node:crypto";
import type { ContentBlock } from "../../ai/types.js";
import { AmaError } from "../../errors.js";
import { createLineReader } from "../../modes/rpc/jsonl.js";
import { armCancelWatchdog, probeCandidate, spawnOf, type DriverDeps } from "../base.js";
import type { CatalogCandidate } from "../catalog.js";
import { stderrHint, type AgentTransport } from "../process.js";
import { TurnCollector, oneLine } from "../turn.js";
import type {
  AgentDriver,
  DriverOpenOptions,
  DriverProbe,
  DriverPromptHooks,
  DriverSession,
  DriverTurnResult,
} from "../types.js";
import {
  CLAUDE_QUESTION_TOOLS,
  claudePermissionMode,
  claudeStopReason,
  claudeTodos,
  claudeToolKind,
  claudeToolLocations,
  claudeToolTitle,
  sessionScopedSuggestions,
  type ClaudeResult,
} from "./claude-normalize.js";
import { msg as messages } from "../../i18n/index.js";

type Json = Record<string, unknown>;

export function claudeArgs(
  options: Pick<DriverOpenOptions, "mode" | "model" | "resume" | "budgetUsd" | "unattended">,
  sessionId: string,
  manualName: "manual" | "default" = "manual",
): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    claudePermissionMode(options.mode, manualName),
  ];
  if (options.unattended === true) args.push("--permission-prompts", "none");
  else args.push("--permission-prompt-tool", "stdio");
  if (options.resume !== undefined) args.push("--resume", options.resume);
  else args.push("--session-id", sessionId);
  if (options.model !== undefined) args.push("--model", options.model);
  if (options.budgetUsd !== undefined) args.push("--max-budget-usd", String(options.budgetUsd));
  return args;
}

function userLine(content: readonly ContentBlock[]): string {
  const blocks = content.map((b) =>
    b.type === "text"
      ? { type: "text", text: b.text }
      : { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } },
  );
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: blocks },
    parent_tool_use_id: null,
  })}\n`;
}

export class ClaudeStreamDriver implements AgentDriver {
  readonly kind = "claude-stream" as const;

  constructor(
    readonly agentId: string,
    private readonly candidate: CatalogCandidate,
    private readonly deps: DriverDeps = {},
  ) {}

  probe(): Promise<DriverProbe> {
    return probeCandidate(this.candidate, this.deps);
  }

  async open(options: DriverOpenOptions): Promise<DriverSession> {
    let manual: "manual" | "default" = "manual";
    const probed = await probeCandidate(this.candidate, this.deps);
    if (probed.path !== undefined && this.deps.probe !== undefined) {
      const help = await this.deps.probe.capture(probed.path, ["--help"]);
      if (help !== undefined && !help.includes('"manual"')) manual = "default";
    }
    const sessionId = options.resume ?? randomUUID();
    const transport = spawnOf(this.deps)({
      program: probed.path ?? this.candidate.program,
      args: [...this.candidate.args, ...claudeArgs(options, sessionId, manual)],
      cwd: options.cwd,
      env: options.env,
    });
    const session = new ClaudeStreamSession(this.agentId, sessionId, transport, this.deps);
    if (probed.warning !== undefined) session.notices.push(probed.warning);
    try {
      await session.initialize(options.signal);
    } catch (error) {
      await session.close();
      throw new AmaError(
        "agent_start_failed",
        `${this.agentId}: failed to start (${(error as Error).message})${stderrHint(transport) !== "" ? `: ${stderrHint(transport)}` : ""}`,
        { cause: error },
      );
    }
    return session;
  }
}

interface PendingControl {
  resolve(response: Json): void;
  reject(error: Error): void;
}

class ClaudeStreamSession implements DriverSession {
  readonly notices: string[] = [];
  private nextRequest = 1;
  private readonly controls = new Map<string, PendingControl>();
  private readonly permissions = new Map<string, AbortController>();
  private turn: TurnCollector | undefined;
  private hooks: DriverPromptHooks | undefined;
  private finishTurn: ((result: ClaudeResult) => void) | undefined;
  private failTurn: ((error: Error) => void) | undefined;
  private running: Promise<DriverTurnResult> | undefined;
  private interrupted = false;
  private sawPartialText = false;
  private lastTotalCost = 0;
  private closed = false;
  private exited = false;

  constructor(
    private readonly agentId: string,
    private id: string,
    private readonly transport: AgentTransport,
    private readonly deps: DriverDeps,
  ) {
    createLineReader(
      transport.stdout,
      (line) => this.onLine(line),
      () => this.onExit(),
    );
    transport.stdin.on?.("error", () => undefined);
  }

  get sessionId(): string {
    return this.id;
  }

  /** SDK 握手；旧版本不认 initialize 时忽略错误继续。 */
  async initialize(signal: AbortSignal): Promise<void> {
    const response = this.control({ subtype: "initialize", hooks: null });
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref());
    try {
      await Promise.race([response, aborted, timeout]);
    } catch (error) {
      if (this.exited || signal.aborted) throw error;
      this.deps.log?.(
        "debug",
        messages().drivers.agent.initializeRejected(this.agentId, (error as Error).message),
      );
    }
  }

  async prompt(content: ContentBlock[], hooks: DriverPromptHooks): Promise<DriverTurnResult> {
    if (this.closed || this.exited)
      throw new AmaError("agent_closed", `${this.agentId} session is closed`);
    if (this.running !== undefined)
      throw new AmaError("busy", `${this.agentId} is already running`);
    const turn = new TurnCollector((e) => hooks.onEvent(e));
    for (const text of this.notices.splice(0)) turn.push({ type: "notice", level: "warn", text });
    this.turn = turn;
    this.hooks = hooks;
    this.interrupted = false;
    this.sawPartialText = false;
    const done = new Promise<ClaudeResult>((resolve, reject) => {
      this.finishTurn = resolve;
      this.failTurn = reject;
    });
    this.running = done.then((result) => this.complete(result, turn));
    this.write(userLine(content));
    try {
      return await this.running;
    } finally {
      this.running = undefined;
      this.turn = undefined;
      this.hooks = undefined;
      this.finishTurn = undefined;
      this.failTurn = undefined;
    }
  }

  async steer(content: ContentBlock[]): Promise<void> {
    if (this.closed || this.exited)
      throw new AmaError("agent_closed", `${this.agentId} session is closed`);
    this.write(userLine(content));
  }

  async cancel(): Promise<void> {
    const running = this.running;
    if (running === undefined || this.closed) return;
    this.interrupted = true;
    for (const controller of this.permissions.values()) controller.abort();
    void this.control({ subtype: "interrupt" }).catch(() => undefined);
    armCancelWatchdog(
      this.transport,
      running.catch(() => undefined),
      this.deps,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.permissions.values()) controller.abort();
    if (this.running !== undefined) {
      this.interrupted = true;
      void this.control({ subtype: "interrupt" }).catch(() => undefined);
    }
    await this.transport.terminate();
  }

  private complete(result: ClaudeResult, turn: TurnCollector): DriverTurnResult {
    if (typeof result.session_id === "string" && result.session_id !== "")
      this.id = result.session_id;
    const u = result.usage ?? {};
    const total = typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined;
    const cost = total === undefined ? undefined : Math.max(0, total - this.lastTotalCost);
    if (total !== undefined) this.lastTotalCost = total;
    turn.push({
      type: "usage",
      ...(u.input_tokens !== undefined ? { input: u.input_tokens } : {}),
      ...(u.output_tokens !== undefined ? { output: u.output_tokens } : {}),
      ...(u.cache_read_input_tokens !== undefined ? { cacheRead: u.cache_read_input_tokens } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
    });
    if (typeof result.result === "string" && result.result !== "") turn.setFinalText(result.result);
    const denials = result.permission_denials?.length ?? 0;
    if (denials > 0)
      turn.push({
        type: "notice",
        level: "info",
        text: messages().drivers.agent.denials(this.agentId, denials),
      });
    if (result.subtype === "error_max_budget_usd")
      turn.push({
        type: "notice",
        level: "warn",
        text: messages().drivers.agent.budgetStop(this.agentId),
      });
    const stop = claudeStopReason(result, this.interrupted);
    if (stop === undefined) {
      const detail = result.errors?.join("; ") ?? result.result ?? result.subtype ?? "unknown";
      throw new AmaError("agent_failed", `${this.agentId} turn failed: ${oneLine(detail, 300)}`);
    }
    return turn.result(stop);
  }

  private write(line: string): void {
    if (this.exited) return;
    this.transport.stdin.write(line);
  }

  private control(request: Json): Promise<Json> {
    const requestId = `ama-${this.nextRequest++}`;
    return new Promise((resolve, reject) => {
      this.controls.set(requestId, { resolve, reject });
      this.write(
        `${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`,
      );
    });
  }

  private respond(requestId: string, response: Json): void {
    this.write(
      `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } })}\n`,
    );
  }

  private respondError(requestId: string, error: string): void {
    this.write(
      `${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: requestId, error } })}\n`,
    );
  }

  private onExit(): void {
    this.exited = true;
    for (const controller of this.permissions.values()) controller.abort();
    const error = new AmaError(
      "agent_exited",
      `${this.agentId} process exited${stderrHint(this.transport) !== "" ? `: ${stderrHint(this.transport)}` : ""}`,
    );
    for (const pending of this.controls.values()) pending.reject(error);
    this.controls.clear();
    this.failTurn?.(error);
  }

  private onLine(line: string): void {
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      this.deps.log?.("debug", messages().drivers.agent.nonJson(this.agentId));
      return;
    }
    switch (msg["type"]) {
      case "control_response":
        return this.onControlResponse(msg["response"] as Json | undefined);
      case "control_request":
        void this.onControlRequest(String(msg["request_id"]), (msg["request"] ?? {}) as Json);
        return;
      case "control_cancel_request":
        this.permissions.get(String(msg["request_id"]))?.abort();
        return;
      case "system":
        if (msg["subtype"] === "init" && typeof msg["session_id"] === "string")
          this.id = msg["session_id"];
        return;
      case "stream_event":
        // 子 Agent（Task）内部的流式文本不进最终文本
        if (typeof msg["parent_tool_use_id"] === "string") return;
        return this.onStreamEvent((msg["event"] ?? {}) as Json);
      case "assistant":
        return this.onAssistant((msg["message"] ?? {}) as Json, msg["parent_tool_use_id"]);
      case "user":
        return this.onToolResults((msg["message"] ?? {}) as Json);
      case "result":
        this.finishTurn?.(msg as ClaudeResult);
        return;
      default:
        return;
    }
  }

  private onControlResponse(response: Json | undefined): void {
    if (response === undefined) return;
    const id = String(response["request_id"]);
    const pending = this.controls.get(id);
    if (pending === undefined) return;
    this.controls.delete(id);
    if (response["subtype"] === "error")
      pending.reject(new Error(String(response["error"] ?? "error")));
    else pending.resolve((response["response"] ?? {}) as Json);
  }

  private onStreamEvent(event: Json): void {
    if (event["type"] !== "content_block_delta" || this.turn === undefined) return;
    const delta = (event["delta"] ?? {}) as Json;
    if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
      this.sawPartialText = true;
      this.turn.push({ type: "message_delta", text: delta["text"] });
    } else if (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
      this.turn.push({ type: "thought_delta", text: delta["thinking"] });
    }
  }

  private onAssistant(message: Json, parent: unknown): void {
    const turn = this.turn;
    if (turn === undefined || !Array.isArray(message["content"])) return;
    // 子 Agent（Task）内部的消息不进最终文本
    const nested = typeof parent === "string" && parent !== "";
    for (const block of message["content"] as Json[]) {
      if (
        block["type"] === "text" &&
        !nested &&
        !this.sawPartialText &&
        typeof block["text"] === "string"
      )
        turn.push({ type: "message_delta", text: block["text"] });
      else if (block["type"] === "tool_use") {
        const name = String(block["name"] ?? "tool");
        const input = block["input"];
        const locations = claudeToolLocations(input);
        turn.push({
          type: "tool_call",
          id: String(block["id"]),
          title: claudeToolTitle(name, input),
          kind: claudeToolKind(name),
          status: "pending",
          ...(locations !== undefined ? { locations } : {}),
        });
        const todos = name === "TodoWrite" ? claudeTodos(input) : undefined;
        if (todos !== undefined) turn.push({ type: "plan", entries: todos });
      }
    }
    // 下一条助手消息的流式文本重新计
    if (!nested) this.sawPartialText = false;
  }

  private onToolResults(message: Json): void {
    const turn = this.turn;
    if (turn === undefined || !Array.isArray(message["content"])) return;
    for (const block of message["content"] as Json[]) {
      if (block["type"] !== "tool_result") continue;
      const id = String(block["tool_use_id"]);
      const known = turn.tool(id);
      if (known === undefined) continue;
      turn.push({
        type: "tool_call",
        id,
        title: known.title,
        kind: known.kind,
        status: block["is_error"] === true ? "failed" : "completed",
        ...(known.locations.length > 0 ? { locations: [...known.locations] } : {}),
      });
    }
  }

  private async onControlRequest(requestId: string, request: Json): Promise<void> {
    if (request["subtype"] !== "can_use_tool") {
      this.respondError(requestId, `ama does not handle ${String(request["subtype"])}`);
      return;
    }
    const name = String(request["tool_name"] ?? "tool");
    const input = request["input"] ?? {};
    const hooks = this.hooks;
    if (CLAUDE_QUESTION_TOOLS.has(name)) {
      this.turn?.push({
        type: "notice",
        level: "warn",
        text: messages().drivers.agent.askedQuestion(this.agentId, name),
      });
      this.respond(requestId, {
        behavior: "deny",
        message:
          "The coordinator cannot relay interactive questions. Put your questions in your final reply and stop.",
      });
      return;
    }
    if (hooks === undefined || this.interrupted) {
      this.respond(requestId, { behavior: "deny", message: "Cancelled", interrupt: true });
      return;
    }
    const suggestions = sessionScopedSuggestions(request["permission_suggestions"]);
    const controller = new AbortController();
    this.permissions.set(requestId, controller);
    const locations = claudeToolLocations(input);
    try {
      const outcome = await hooks.onPermission(
        {
          toolCall: {
            title: claudeToolTitle(name, input),
            kind: claudeToolKind(name),
            ...(locations !== undefined ? { locations } : {}),
            inputSummary: oneLine(JSON.stringify(input), 300),
          },
          options: [
            { optionId: "allow", kind: "allow_once" },
            ...(suggestions.length > 0
              ? [{ optionId: "allow_session", kind: "allow_always" as const }]
              : []),
            { optionId: "deny", kind: "reject_once" },
          ],
        },
        controller.signal,
      );
      // Claude 自己取消了这个请求：不再回应
      if (controller.signal.aborted && !this.interrupted && !this.closed) return;
      if (outcome.outcome === "cancelled" || controller.signal.aborted) {
        this.respond(requestId, {
          behavior: "deny",
          message: "Cancelled by the user",
          interrupt: true,
        });
      } else if (outcome.optionId === "allow" || outcome.optionId === "allow_session") {
        this.respond(requestId, {
          behavior: "allow",
          updatedInput: input,
          ...(outcome.optionId === "allow_session" ? { updatedPermissions: suggestions } : {}),
        });
      } else {
        this.respond(requestId, { behavior: "deny", message: "The user denied this action" });
      }
    } finally {
      this.permissions.delete(requestId);
    }
  }
}
