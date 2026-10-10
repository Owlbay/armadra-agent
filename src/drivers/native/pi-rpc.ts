/**
 * pi 原生驱动：`pi --mode rpc` 长驻进程（stdin 命令 / stdout 响应与事件，严格按 LF 分帧）。[#198]
 *
 * `pi --mode rpc --session-id <uuid> [--model <m>] -e <审批闸> [--tools read,grep,find,ls]`
 * （新会话与续聊都用 `--session-id`：pi 找到同 id 的项目会话就续上，否则新建）。
 *
 * - 回合：`prompt` → 响应 `disposition`（`handled` 时没有运行，直接结束）→ 事件流 → `agent_settled`
 *   结束（`aborted` 为真即中断）；运行中追加用 `steer`；中断 `abort`（15 s 看门狗）。
 * - 审批：pi 自己不问人，ama 以 `-e` 加载审批闸（{@link PI_GATE_SOURCE}），只读内置工具以外的调用
 *   经 `extension_ui_request{confirm, title: "ama-approval"}` 到这里：plan / allowlist 直接拒绝（并以
 *   `--tools` 只开只读工具），auto-edit / auto / full-auto 放行 `edit` / `write`，其余交给人（只交给人，
 *   不代答）。其它扩展的对话框（select / input / editor / 别的 confirm）一律取消并提示。
 * - 用量：assistant `message_end` 的 usage 累加（input 不含缓存命中，cost.total 是 pi 按价目表的估算）；
 *   回合结束后 `get_session_stats` 的 `contextUsage` 记上下文占用与窗口。
 */

import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import type { ContentBlock } from "../../ai/types.js";
import { AmaError } from "../../errors.js";
import { createLineReader } from "../../modes/rpc/jsonl.js";
import {
  armCancelWatchdog,
  isReadOnlyMode,
  probeCandidate,
  spawnOf,
  type DriverDeps,
} from "../base.js";
import type { CatalogCandidate } from "../catalog.js";
import { stderrHint, type AgentTransport } from "../process.js";
import { TurnCollector, oneLine } from "../turn.js";
import type {
  AcpToolKind,
  AgentDriver,
  DriverOpenOptions,
  DriverProbe,
  DriverPromptHooks,
  DriverSession,
  DriverTurnResult,
} from "../types.js";
import { PI_GATE_TITLE, PI_READ_ONLY_TOOLS, writePiGate } from "./pi-gate.js";
import { msg } from "../../i18n/index.js";

type Json = Record<string, unknown>;

const DIALOG_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);
/** auto-edit 及更宽的模式下不问人的文件编辑工具。 */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

export function piArgs(
  options: Pick<DriverOpenOptions, "mode" | "model">,
  sessionId: string,
  gatePath: string,
): string[] {
  const args = ["--session-id", sessionId];
  if (options.model !== undefined) args.push("--model", options.model);
  args.push("-e", gatePath);
  if (isReadOnlyMode(options.mode)) args.push("--tools", PI_READ_ONLY_TOOLS.join(","));
  return args;
}

export function piToolKind(tool: string): AcpToolKind {
  switch (tool) {
    case "bash":
    case "powershell":
      return "execute";
    case "edit":
    case "write":
      return "edit";
    case "read":
      return "read";
    case "grep":
    case "find":
    case "ls":
      return "search";
    default:
      return "other";
  }
}

function piToolTitle(tool: string, input: Json): string {
  if (typeof input["command"] === "string") return `$ ${oneLine(input["command"], 100)}`;
  if (typeof input["path"] === "string") return `${tool} ${input["path"]}`;
  if (typeof input["pattern"] === "string") return `${tool} ${oneLine(input["pattern"], 80)}`;
  return tool;
}

function textOf(message: Json): string {
  const content = message["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Json[])
    .map((b) => (b["type"] === "text" && typeof b["text"] === "string" ? b["text"] : ""))
    .join("");
}

export class PiRpcDriver implements AgentDriver {
  readonly kind = "pi-rpc" as const;

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
    const sessionId = options.resume ?? randomUUID();
    const gate = writePiGate();
    const transport = spawnOf(this.deps)({
      program: probed.path ?? this.candidate.program,
      args: [...this.candidate.args, ...piArgs(options, sessionId, gate.path)],
      cwd: options.cwd,
      env: options.env,
    });
    const session = new PiSession(this.agentId, sessionId, transport, options, this.deps, () =>
      gate.dispose(),
    );
    if (probed.warning !== undefined) session.notices.push(probed.warning);
    try {
      await session.start(options.signal);
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

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  costUsd: number;
  seen: boolean;
}

class PiSession implements DriverSession {
  readonly notices: string[] = [];
  private nextId = 1;
  private readonly pending = new Map<string, { resolve(r: Json): void; reject(e: Error): void }>();
  private readonly permissions = new Set<AbortController>();
  private turn: TurnCollector | undefined;
  private hooks: DriverPromptHooks | undefined;
  private settle: ((aborted: boolean) => void) | undefined;
  private running: Promise<DriverTurnResult> | undefined;
  private usage: Usage = { input: 0, output: 0, cacheRead: 0, costUsd: 0, seen: false };
  private lastAssistant: Json | undefined;
  private interrupted = false;
  private closed = false;
  private exited = false;
  private readonly exitWaiters = new Set<(error: Error) => void>();

  constructor(
    private readonly agentId: string,
    private id: string,
    private readonly transport: AgentTransport,
    private readonly options: DriverOpenOptions,
    private readonly deps: DriverDeps,
    private readonly dispose: () => void,
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

  /** 握手：`get_state` 确认进程起来了，并取 pi 实际使用的会话 id。 */
  async start(signal: AbortSignal): Promise<void> {
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    void aborted.catch(() => undefined);
    const state = await Promise.race([this.request({ type: "get_state" }), aborted]);
    const data = (state["data"] ?? {}) as Json;
    if (typeof data["sessionId"] === "string" && data["sessionId"] !== "")
      this.id = data["sessionId"];
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
    this.usage = { input: 0, output: 0, cacheRead: 0, costUsd: 0, seen: false };
    this.lastAssistant = undefined;
    this.running = this.run(content, turn);
    try {
      return await this.running;
    } finally {
      this.running = undefined;
      this.turn = undefined;
      this.hooks = undefined;
      this.settle = undefined;
      this.exitWaiters.clear();
    }
  }

  private async run(content: ContentBlock[], turn: TurnCollector): Promise<DriverTurnResult> {
    // 先让出一拍：`this.running` 赋值之后再写命令（同步回显的对端里事件可能立刻到达并触发 cancel）
    await Promise.resolve();
    const settled = new Promise<boolean>((resolve) => (this.settle = resolve));
    const response = await this.request({ type: "prompt", ...this.message(content) });
    if (response["success"] !== true)
      throw new AmaError(
        "agent_failed",
        `${this.agentId} rejected the prompt: ${oneLine(String(response["error"] ?? "unknown"), 300)}`,
      );
    const disposition = ((response["data"] ?? {}) as Json)["disposition"];
    if (disposition === "handled") return turn.result("end_turn");
    const aborted = await Promise.race([settled, this.exitPromise()]);
    await this.reportContext(turn);
    return this.complete(turn, aborted);
  }

  async steer(content: ContentBlock[]): Promise<void> {
    if (this.closed || this.exited)
      throw new AmaError("agent_closed", `${this.agentId} session is closed`);
    await this.request({ type: "steer", ...this.message(content) });
  }

  async cancel(): Promise<void> {
    const running = this.running;
    if (running === undefined || this.closed) return;
    this.interrupted = true;
    for (const c of this.permissions) c.abort();
    void this.request({ type: "abort" }).catch(() => undefined);
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
    if (this.running !== undefined) {
      this.interrupted = true;
      this.write({ type: "abort" });
    }
    try {
      await this.transport.terminate();
    } finally {
      this.dispose();
    }
  }

  private message(content: readonly ContentBlock[]): Json {
    const text = content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    const images = content.flatMap((b) =>
      b.type === "image" ? [{ type: "image", data: b.data, mimeType: b.mimeType }] : [],
    );
    return { message: text, ...(images.length > 0 ? { images } : {}) };
  }

  private complete(turn: TurnCollector, aborted: boolean): DriverTurnResult {
    const u = this.usage;
    if (u.seen)
      turn.push({
        type: "usage",
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        costUsd: u.costUsd,
      });
    const last = this.lastAssistant;
    if (last !== undefined) {
      const text = textOf(last);
      if (text !== "") turn.setFinalText(text);
    }
    if (aborted || this.interrupted) return turn.result("cancelled");
    switch (last?.["stopReason"]) {
      case "error":
        throw new AmaError(
          "agent_failed",
          `${this.agentId} failed: ${oneLine(String(last["errorMessage"] ?? "unknown error"), 300)}`,
        );
      case "aborted":
        return turn.result("cancelled");
      case "length":
        return turn.result("max_tokens");
      default:
        return turn.result("end_turn");
    }
  }

  /** `get_session_stats.contextUsage` → 上下文占用与窗口（拿不到就算了）。 */
  private async reportContext(turn: TurnCollector): Promise<void> {
    if (this.exited) return;
    try {
      const stats = await Promise.race([
        this.request({ type: "get_session_stats" }),
        new Promise<Json>((resolve) => setTimeout(() => resolve({}), 5_000).unref()),
      ]);
      const usage = (((stats["data"] ?? {}) as Json)["contextUsage"] ?? {}) as Json;
      const tokens = usage["tokens"];
      const window = usage["contextWindow"];
      if (typeof tokens === "number" || typeof window === "number")
        turn.push({
          type: "usage",
          ...(typeof tokens === "number" ? { contextTokens: tokens } : {}),
          ...(typeof window === "number" ? { contextWindow: window } : {}),
        });
    } catch {
      // 统计拿不到不影响回合
    }
  }

  private exitPromise(): Promise<never> {
    return new Promise<never>((_, reject) => {
      if (this.exited) reject(this.exitError());
      else this.exitWaiters.add(reject);
    });
  }

  private exitError(): AmaError {
    const hint = stderrHint(this.transport);
    return new AmaError(
      "agent_exited",
      `${this.agentId} process exited${hint !== "" ? `: ${hint}` : ""}`,
    );
  }

  private request(command: Json): Promise<Json> {
    if (this.exited) return Promise.reject(this.exitError());
    const id = `ama-${this.nextId++}`;
    return new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, ...command });
    });
  }

  private write(record: Json): void {
    if (this.exited) return;
    this.transport.stdin.write(`${JSON.stringify(record)}\n`);
  }

  private onExit(): void {
    this.exited = true;
    const error = this.exitError();
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    for (const reject of this.exitWaiters) reject(error);
    this.exitWaiters.clear();
    for (const c of this.permissions) c.abort();
  }

  private onLine(line: string): void {
    let record: Json;
    try {
      record = JSON.parse(line) as Json;
    } catch {
      this.deps.log?.("debug", msg().drivers.agent.nonJson(this.agentId));
      return;
    }
    switch (record["type"]) {
      case "response": {
        const id = record["id"];
        const pending = typeof id === "string" ? this.pending.get(id) : undefined;
        if (pending === undefined || typeof id !== "string") return;
        this.pending.delete(id);
        pending.resolve(record);
        return;
      }
      case "agent_settled":
        this.settle?.(record["aborted"] === true);
        return;
      case "extension_ui_request":
        void this.onDialog(record);
        return;
      default:
        this.onEvent(record);
    }
  }

  private onEvent(record: Json): void {
    const turn = this.turn;
    if (turn === undefined) return;
    switch (record["type"]) {
      case "message_update": {
        const event = (record["assistantMessageEvent"] ?? {}) as Json;
        const delta = event["delta"];
        if (typeof delta !== "string") return;
        if (event["type"] === "text_delta") turn.push({ type: "message_delta", text: delta });
        else if (event["type"] === "thinking_delta")
          turn.push({ type: "thought_delta", text: delta });
        return;
      }
      case "message_end": {
        const message = (record["message"] ?? {}) as Json;
        if (message["role"] !== "assistant") return;
        this.lastAssistant = message;
        const usage = (message["usage"] ?? {}) as Json;
        const num = (key: string): number =>
          typeof usage[key] === "number" ? (usage[key] as number) : 0;
        const cost = ((usage["cost"] ?? {}) as Json)["total"];
        this.usage = {
          input: this.usage.input + num("input"),
          output: this.usage.output + num("output"),
          cacheRead: this.usage.cacheRead + num("cacheRead"),
          costUsd: this.usage.costUsd + (typeof cost === "number" ? cost : 0),
          seen: true,
        };
        return;
      }
      case "tool_execution_start":
      case "tool_execution_end": {
        const tool = String(record["toolName"] ?? "tool");
        const known = turn.tool(String(record["toolCallId"] ?? ""));
        const input = (record["args"] ?? {}) as Json;
        const path = typeof input["path"] === "string" ? input["path"] : undefined;
        const locations =
          path !== undefined ? [resolvePath(this.options.cwd, path)] : known?.locations;
        turn.push({
          type: "tool_call",
          id: String(record["toolCallId"] ?? ""),
          title: known?.title ?? piToolTitle(tool, input),
          kind: piToolKind(tool),
          status:
            record["type"] === "tool_execution_start"
              ? "in_progress"
              : record["isError"] === true
                ? "failed"
                : "completed",
          ...(locations !== undefined && locations.length > 0 ? { locations } : {}),
        });
        return;
      }
      case "auto_retry_start":
        turn.push({
          type: "notice",
          level: "warn",
          text: msg().drivers.agent.error(
            this.agentId,
            oneLine(String(record["errorMessage"] ?? "error"), 200),
            true,
          ),
        });
        return;
      default:
        return;
    }
  }

  /** 扩展对话框：ama 的审批闸按模式决定或交给人；其它扩展的对话框取消（不代答）。 */
  private async onDialog(record: Json): Promise<void> {
    const id = String(record["id"] ?? "");
    const method = String(record["method"] ?? "");
    if (!DIALOG_METHODS.has(method)) {
      if (record["method"] === "notify" && record["notifyType"] !== "info")
        this.turn?.push({
          type: "notice",
          level: "warn",
          text: `${this.agentId}: ${oneLine(String(record["message"] ?? ""), 200)}`,
        });
      return;
    }
    if (method !== "confirm" || record["title"] !== PI_GATE_TITLE) {
      this.turn?.push({
        type: "notice",
        level: "warn",
        text: msg().drivers.agent.extensionDialog(
          this.agentId,
          oneLine(String(record["title"] ?? method), 80),
        ),
      });
      this.write({ type: "extension_ui_response", id, cancelled: true });
      return;
    }
    const confirmed = await this.decide(record);
    this.write({ type: "extension_ui_response", id, confirmed });
  }

  private async decide(record: Json): Promise<boolean> {
    let call: Json;
    try {
      call = JSON.parse(String(record["message"] ?? "{}")) as Json;
    } catch {
      return false;
    }
    const tool = String(call["tool"] ?? "tool");
    const input = (call["input"] ?? {}) as Json;
    const mode = this.options.mode;
    if (isReadOnlyMode(mode)) return false;
    if (mode !== "default" && EDIT_TOOLS.has(tool)) return true;
    const hooks = this.hooks;
    if (hooks === undefined || this.interrupted || this.closed) return false;
    const known = this.turn?.tool(String(call["id"] ?? ""));
    const path = typeof input["path"] === "string" ? input["path"] : undefined;
    const controller = new AbortController();
    this.permissions.add(controller);
    try {
      const outcome = await hooks.onPermission(
        {
          toolCall: {
            title: known?.title ?? piToolTitle(tool, input),
            kind: piToolKind(tool),
            ...(path !== undefined ? { locations: [resolvePath(this.options.cwd, path)] } : {}),
            inputSummary: oneLine(JSON.stringify(input), 300),
          },
          options: [
            { optionId: "allow", kind: "allow_once" },
            { optionId: "reject", kind: "reject_once" },
          ],
        },
        controller.signal,
      );
      return (
        !controller.signal.aborted && outcome.outcome === "selected" && outcome.optionId === "allow"
      );
    } finally {
      this.permissions.delete(controller);
    }
  }
}
