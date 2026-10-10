/**
 * 一次性打印模式兜底（docs/history/wave5-plan.md §5.1 oneshot.ts）。[W5-E]
 *
 * `claude -p --output-format json`、`codex exec --json`、`gemini -p --output-format stream-json`：
 * **不能审批**（能力 `permissions: "none"`），所以只在只读任务下用——open 时模式不是
 * plan / allowlist 直接拒绝；子进程一律以只读方式启动（Claude `--permission-mode plan
 * --permission-prompts none`，Codex `sandbox_mode="read-only"` + `approval_policy="never"`，
 * Gemini `--approval-mode default`，无头时需要批准的工具不可用；未实测）。每回合起一个进程，提示从 stdin 给（Gemini 走 `-p` 参数）；
 * 续聊用各 CLI 自己的 resume。中断 = 结束进程树。
 */

import { randomUUID } from "node:crypto";
import type { ContentBlock } from "../../ai/types.js";
import { AmaError } from "../../errors.js";
import { createLineReader } from "../../modes/rpc/jsonl.js";
import { isReadOnlyMode, probeCandidate, spawnOf, type DriverDeps } from "../base.js";
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
import { claudeStopReason, type ClaudeResult } from "./claude-normalize.js";
import { msg as messages } from "../../i18n/index.js";

type Json = Record<string, unknown>;
type Dialect = NonNullable<CatalogCandidate["oneshot"]>;

export function oneshotArgs(
  dialect: Dialect,
  options: Pick<DriverOpenOptions, "model" | "budgetUsd">,
  session: { id: string; resume: boolean },
  prompt: string,
): string[] {
  switch (dialect) {
    case "claude": {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--permission-mode",
        "plan",
        "--permission-prompts",
        "none",
      ];
      args.push(session.resume ? "--resume" : "--session-id", session.id);
      if (options.model !== undefined) args.push("--model", options.model);
      if (options.budgetUsd !== undefined) args.push("--max-budget-usd", String(options.budgetUsd));
      return args;
    }
    case "codex": {
      // ama 只在自己已信任的目录里起外部 Agent：跳过 codex 自己的 git 仓库检查（非 git 目录否则直接失败）
      const common = [
        "--json",
        "--skip-git-repo-check",
        "-c",
        'sandbox_mode="read-only"',
        "-c",
        'approval_policy="never"',
      ];
      if (options.model !== undefined) common.push("-m", options.model);
      return session.resume
        ? ["exec", "resume", session.id, ...common, "-"]
        : ["exec", ...common, "-"];
    }
    case "gemini": {
      // default：无头模式下需要批准的工具直接不可用（Gemini 没有交互审批通道）
      const args = ["--output-format", "stream-json", "--approval-mode", "default"];
      if (options.model !== undefined) args.push("--model", options.model);
      return [...args, "-p", prompt];
    }
  }
}

export class OneshotDriver implements AgentDriver {
  readonly kind = "oneshot" as const;

  constructor(
    readonly agentId: string,
    private readonly candidate: CatalogCandidate,
    private readonly deps: DriverDeps = {},
  ) {}

  probe(): Promise<DriverProbe> {
    return probeCandidate(this.candidate, this.deps);
  }

  async open(options: DriverOpenOptions): Promise<DriverSession> {
    if (!isReadOnlyMode(options.mode))
      throw new AmaError(
        "agent_mode_unsupported",
        `${this.agentId} only has a one-shot print mode, which cannot ask for approval; use it for read-only (plan) tasks only`,
      );
    const probed = await probeCandidate(this.candidate, this.deps);
    const dialect = this.candidate.oneshot ?? "claude";
    return new OneshotSession(
      this.agentId,
      dialect,
      probed.path ?? this.candidate.program,
      options,
      this.deps,
    );
  }
}

class OneshotSession implements DriverSession {
  private id: string;
  private resumable: boolean;
  private transport: AgentTransport | undefined;
  private interrupted = false;
  private closed = false;

  constructor(
    private readonly agentId: string,
    private readonly dialect: Dialect,
    private readonly program: string,
    private readonly options: DriverOpenOptions,
    private readonly deps: DriverDeps,
  ) {
    this.id = options.resume ?? (dialect === "claude" ? randomUUID() : "");
    this.resumable = options.resume !== undefined;
  }

  get sessionId(): string {
    return this.id;
  }

  async prompt(content: ContentBlock[], hooks: DriverPromptHooks): Promise<DriverTurnResult> {
    if (this.closed) throw new AmaError("agent_closed", `${this.agentId} session is closed`);
    if (this.transport !== undefined)
      throw new AmaError("busy", `${this.agentId} is already running`);
    const turn = new TurnCollector((e) => hooks.onEvent(e));
    const text = content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    if (content.some((b) => b.type === "image"))
      turn.push({
        type: "notice",
        level: "warn",
        text: messages().drivers.agent.noImagesOneshot(this.agentId),
      });
    const resume = this.resumable && this.id !== "";
    const transport = spawnOf(this.deps)({
      program: this.program,
      args: oneshotArgs(this.dialect, this.options, { id: this.id, resume }, text),
      cwd: this.options.cwd,
      env: this.options.env,
    });
    this.transport = transport;
    this.interrupted = false;
    let claude: ClaudeResult | undefined;
    let failure: string | undefined;
    const done = new Promise<void>((resolve) =>
      createLineReader(
        transport.stdout,
        (line) => {
          let msg: Json;
          try {
            msg = JSON.parse(line) as Json;
          } catch {
            return;
          }
          if (this.dialect === "claude") {
            if (msg["type"] === "result") claude = msg as ClaudeResult;
          } else if (this.dialect === "codex") failure = this.onCodex(msg, turn) ?? failure;
          else failure = this.onGemini(msg, turn) ?? failure;
        },
        resolve,
      ),
    );
    if (this.dialect !== "gemini") transport.stdin.write(text);
    transport.stdin.end();
    try {
      await done;
      const code = await transport.exited;
      if (this.dialect === "claude") return this.claudeResult(claude, turn, code, transport);
      if (this.interrupted) return turn.result("cancelled");
      if (failure !== undefined || code !== 0)
        throw new AmaError(
          "agent_failed",
          `${this.agentId} failed: ${oneLine(failure ?? (stderrHint(transport) || `exit code ${String(code)}`), 300)}`,
        );
      this.resumable = this.dialect !== "gemini" && this.id !== "";
      return turn.result("end_turn");
    } finally {
      this.transport = undefined;
    }
  }

  async cancel(): Promise<void> {
    if (this.transport === undefined) return;
    this.interrupted = true;
    await this.transport.terminate(0);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.cancel();
  }

  private claudeResult(
    result: ClaudeResult | undefined,
    turn: TurnCollector,
    code: number | null,
    transport: AgentTransport,
  ): DriverTurnResult {
    if (result === undefined) {
      if (this.interrupted) return turn.result("cancelled");
      throw new AmaError(
        "agent_failed",
        `${this.agentId} produced no result (exit code ${String(code)}): ${stderrHint(transport)}`,
      );
    }
    if (typeof result.session_id === "string") this.id = result.session_id;
    this.resumable = true;
    const u = result.usage ?? {};
    turn.push({
      type: "usage",
      ...(u.input_tokens !== undefined ? { input: u.input_tokens } : {}),
      ...(u.output_tokens !== undefined ? { output: u.output_tokens } : {}),
      ...(u.cache_read_input_tokens !== undefined ? { cacheRead: u.cache_read_input_tokens } : {}),
      ...(typeof result.total_cost_usd === "number" ? { costUsd: result.total_cost_usd } : {}),
    });
    if (typeof result.result === "string") turn.setFinalText(result.result);
    const stop = claudeStopReason(result, this.interrupted);
    if (stop === undefined)
      throw new AmaError(
        "agent_failed",
        `${this.agentId} failed: ${oneLine(result.result ?? result.subtype ?? "", 300)}`,
      );
    return turn.result(stop);
  }

  /** codex exec --json 的一行；返回失败信息（turn.failed / error）。 */
  private onCodex(msg: Json, turn: TurnCollector): string | undefined {
    const item = (msg["item"] ?? {}) as Json;
    switch (msg["type"]) {
      case "thread.started":
        if (typeof msg["thread_id"] === "string") this.id = msg["thread_id"];
        return undefined;
      case "item.completed":
      case "item.started": {
        const started = msg["type"] === "item.started";
        const id = String(item["id"] ?? "");
        switch (item["type"]) {
          case "agent_message":
            if (!started && typeof item["text"] === "string") {
              turn.push({
                type: "message_delta",
                text: turn.finalText === "" ? item["text"] : `\n${item["text"]}`,
              });
            }
            return undefined;
          case "reasoning":
            if (!started && typeof item["text"] === "string")
              turn.push({ type: "thought_delta", text: item["text"] });
            return undefined;
          case "command_execution":
            turn.push({
              type: "tool_call",
              id,
              title: `$ ${oneLine(String(item["command"] ?? ""), 100)}`,
              kind: "execute",
              status: started
                ? "in_progress"
                : item["status"] === "failed"
                  ? "failed"
                  : "completed",
            });
            return undefined;
          case "web_search":
            turn.push({
              type: "tool_call",
              id,
              title: `search ${oneLine(String(item["query"] ?? ""), 80)}`,
              kind: "fetch",
              status: started ? "in_progress" : "completed",
            });
            return undefined;
          default:
            return undefined;
        }
      }
      case "turn.completed": {
        const u = (msg["usage"] ?? {}) as Record<string, number | undefined>;
        // input_tokens 含缓存命中部分；ama 的 input 不含
        const input = u["input_tokens"];
        turn.push({
          type: "usage",
          ...(input !== undefined ? { input: input - (u["cached_input_tokens"] ?? 0) } : {}),
          ...(u["output_tokens"] !== undefined ? { output: u["output_tokens"] } : {}),
          ...(u["cached_input_tokens"] !== undefined
            ? { cacheRead: u["cached_input_tokens"] }
            : {}),
        });
        return undefined;
      }
      case "turn.failed":
        return String(((msg["error"] ?? {}) as Json)["message"] ?? "turn failed");
      case "error":
        return String(msg["message"] ?? "error");
      default:
        return undefined;
    }
  }

  /** gemini -p --output-format stream-json 的一行。 */
  private onGemini(msg: Json, turn: TurnCollector): string | undefined {
    switch (msg["type"]) {
      case "init":
        if (typeof msg["session_id"] === "string") this.id = msg["session_id"];
        return undefined;
      case "message":
        if (msg["role"] === "assistant" && typeof msg["content"] === "string")
          turn.push({ type: "message_delta", text: msg["content"] });
        return undefined;
      case "tool_use":
        turn.push({
          type: "tool_call",
          id: String(msg["tool_id"] ?? ""),
          title: String(msg["tool_name"] ?? "tool"),
          kind: "other",
          status: "in_progress",
        });
        return undefined;
      case "tool_result": {
        const id = String(msg["tool_id"] ?? "");
        const known = turn.tool(id);
        turn.push({
          type: "tool_call",
          id,
          title: known?.title ?? "tool",
          kind: known?.kind ?? "other",
          status: msg["status"] === "error" ? "failed" : "completed",
        });
        return undefined;
      }
      case "result": {
        const stats = (msg["stats"] ?? {}) as Record<string, number | undefined>;
        turn.push({
          type: "usage",
          ...(stats["input_tokens"] !== undefined ? { input: stats["input_tokens"] } : {}),
          ...(stats["output_tokens"] !== undefined ? { output: stats["output_tokens"] } : {}),
        });
        return msg["status"] === "error"
          ? String(((msg["error"] ?? {}) as Json)["message"] ?? "error")
          : undefined;
      }
      case "error":
        return String(msg["message"] ?? "error");
      default:
        return undefined;
    }
  }
}
