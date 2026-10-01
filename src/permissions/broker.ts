/**
 * ApprovalBroker 链（设计 §6.3 第 4 步、§7.1）。[B3]
 *
 * - 回答者顺序：宿主 broker（`HostApi.approvals.setBroker`）→ UI broker（TUI 对话框 / RPC 客户端 /
 *   SDK 回调）→ 无人值守 deny。回答者返回 undefined 表示交给下一个；抛错按 deny（fail-safe）。
 * - 超时（缺省 10 min）→ deny；父 signal abort → deny。
 * - 审批**串行化**：同一时刻只有一个请求在等回答（task 子 Agent 的审批排到父对话框之后）。
 * - `allow_session` → 调 `pipeline.rememberForSession()` 后放行。
 * - `authorize()`：管线判定 + 需要时走 broker，给 tool-runner（B2）一个单入口。
 */

import { randomUUID } from "node:crypto";
import type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalReason,
  ApprovalRequest,
  PermissionCheckInput,
  PermissionPipelineApi,
  PermissionVerdict,
} from "./types.js";

export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export interface BrokerChainOptions {
  timeoutMs?: number;
  onRequested?(request: ApprovalRequest): void;
  onResolved?(request: ApprovalRequest, decision: ApprovalDecision, by: AnsweredBy): void;
  log?(level: "debug" | "info" | "warn", message: string): void;
}

export type AnsweredBy = "host" | "ui" | "timeout" | "aborted" | "unattended" | "error";

export class ApprovalBrokerChain {
  private host: ApprovalBroker | undefined;
  private ui: ApprovalBroker | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: BrokerChainOptions = {}) {}

  setHostBroker(broker: ApprovalBroker | undefined): void {
    this.host = broker;
  }

  setUiBroker(broker: ApprovalBroker | undefined): void {
    this.ui = broker;
  }

  /** 有没有可能回答的人；没有则调用方应按无人值守处理。 */
  hasResponder(): boolean {
    return this.host !== undefined || this.ui !== undefined;
  }

  /** 串行排队后询问；总会给出决定。 */
  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const run = this.queue.then(() => this.askNow(request, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async askNow(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    this.options.onRequested?.(request);
    const finish = (decision: ApprovalDecision, by: AnsweredBy) => {
      this.options.onResolved?.(request, decision, by);
      return decision;
    };
    if (signal.aborted) return finish("deny", "aborted");
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(),
      this.options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    );
    const combined = AbortSignal.any([signal, timeout.signal]);
    const stopped = new Promise<"stopped">((resolve) => {
      if (combined.aborted) resolve("stopped");
      combined.addEventListener("abort", () => resolve("stopped"), { once: true });
    });
    try {
      const responders: [AnsweredBy, ApprovalBroker | undefined][] = [
        ["host", this.host],
        ["ui", this.ui],
      ];
      for (const [by, broker] of responders) {
        if (!broker) continue;
        let answer: ApprovalDecision | undefined | "stopped";
        try {
          answer = await Promise.race([broker.ask(request, combined), stopped]);
        } catch (err) {
          this.options.log?.("warn", `approval broker (${by}) failed: ${(err as Error).message}`);
          return finish("deny", "error");
        }
        if (answer === "stopped") return finish("deny", signal.aborted ? "aborted" : "timeout");
        if (answer === "allow" || answer === "deny" || answer === "allow_session") {
          return finish(answer, by);
        }
      }
      return finish("deny", "unattended");
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface AuthorizeResult {
  allowed: boolean;
  verdict: PermissionVerdict;
  /** 走了 broker 时的回答。 */
  decision?: ApprovalDecision;
  /** 拒绝时给 tool_result 的说明。 */
  message?: string;
}

export interface AuthorizeOptions {
  signal: AbortSignal;
  requestId?: string;
}

/** 管线 + broker 的单入口。`input.unattended` 由调用方按「是否有回答者」等决定。 */
export async function authorize(
  pipeline: PermissionPipelineApi,
  chain: ApprovalBrokerChain,
  input: PermissionCheckInput,
  options: AuthorizeOptions,
): Promise<AuthorizeResult> {
  const verdict = pipeline.check(input);
  if (verdict.decision === "allow") return { allowed: true, verdict };
  if (verdict.decision === "deny") {
    return { allowed: false, verdict, message: verdict.message ?? "Permission denied" };
  }
  const reason: ApprovalReason = verdict.approvalReason ?? "mode";
  const request: ApprovalRequest = {
    requestId: options.requestId ?? randomUUID(),
    toolName: input.toolName,
    input: input.input,
    reason,
  };
  const hookReason = reason === "hook" ? (input.hookReason ?? verdict.message) : undefined;
  if (hookReason !== undefined) request.hookReason = hookReason;
  const decision = await chain.ask(request, options.signal);
  if (decision === "allow_session") pipeline.rememberForSession(input.toolName, input.input);
  if (decision === "deny") {
    return { allowed: false, verdict, decision, message: "The tool call was not approved." };
  }
  return { allowed: true, verdict, decision };
}
