/**
 * Codex app-server（0.160.x，`[experimental]`）↔ ama 的映射（docs/wave5-plan.md §5.1 normalize，
 * R2 §1.3）。[W5-E]
 *
 * 只依赖 `test/fixtures/drivers/codex-schema/shapes.json` 锁住的方法与字段（12 个方法 + 5 类审批
 * 请求）；线上不写 `"jsonrpc"` 字段。
 */

import type { PermissionMode } from "../../permissions/types.js";
import { oneLine } from "../turn.js";
import type { AcpToolKind, DriverEvent } from "../types.js";

export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

/**
 * ama 模式 → Codex `approvalPolicy` + `sandbox`。从不给 `danger-full-access`；
 * 无人值守一律 `never`（不发审批请求，越权的操作由沙箱拒绝后交回模型）。
 */
export function codexPolicy(
  mode: PermissionMode,
  unattended: boolean,
): { approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandbox } {
  const base = ((): { approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandbox } => {
    switch (mode) {
      case "plan":
      case "allowlist":
        return { approvalPolicy: "never", sandbox: "read-only" };
      case "default":
        // 写文件 / 越过只读沙箱都要先问人（≈ ama default 的「写与执行要问」）
        return { approvalPolicy: "on-request", sandbox: "read-only" };
      case "auto-edit":
        return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
      case "auto":
        return { approvalPolicy: "on-request", sandbox: "workspace-write" };
      case "full-auto":
        return { approvalPolicy: "never", sandbox: "workspace-write" };
    }
  })();
  return unattended ? { ...base, approvalPolicy: "never" } : base;
}

type Json = Record<string, unknown>;

/** ThreadItem → tool_call（非工具类条目返回 undefined）。 */
export function codexToolEvent(
  item: Json,
  phase: "started" | "completed",
): Extract<DriverEvent, { type: "tool_call" }> | undefined {
  const id = String(item["id"] ?? "");
  const type = item["type"];
  let kind: AcpToolKind;
  let title: string;
  let locations: string[] | undefined;
  switch (type) {
    case "commandExecution":
      kind = "execute";
      title = `$ ${oneLine(String(item["command"] ?? ""), 100)}`;
      break;
    case "fileChange": {
      kind = "edit";
      const changes = Array.isArray(item["changes"]) ? (item["changes"] as Json[]) : [];
      locations = changes.map((c) => String(c["path"] ?? "")).filter((p) => p !== "");
      title = locations.length > 0 ? `edit ${locations.join(", ")}` : "edit";
      break;
    }
    case "mcpToolCall":
      kind = "other";
      title = `${String(item["server"] ?? "mcp")}.${String(item["tool"] ?? "tool")}`;
      break;
    case "dynamicToolCall":
      kind = "other";
      title = String(item["tool"] ?? "tool");
      break;
    case "webSearch":
      kind = "fetch";
      title = `search ${oneLine(String(item["query"] ?? ""), 80)}`;
      break;
    default:
      return undefined;
  }
  const status = String(item["status"] ?? "");
  const failed = status === "failed" || status === "declined";
  return {
    type: "tool_call",
    id,
    title,
    kind,
    status: phase === "started" ? "in_progress" : failed ? "failed" : "completed",
    ...(locations !== undefined && locations.length > 0 ? { locations } : {}),
  };
}

/** turn/plan/updated → plan。 */
export function codexPlan(params: Json): DriverEvent | undefined {
  const plan = params["plan"];
  if (!Array.isArray(plan)) return undefined;
  return {
    type: "plan",
    entries: (plan as Json[]).map((s) => ({
      content: String(s["step"] ?? ""),
      status: String(s["status"] ?? "pending"),
    })),
  };
}

export interface CodexTokens {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function readTokens(value: unknown): CodexTokens | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const num = (k: string): number => (typeof v[k] === "number" ? (v[k] as number) : 0);
  return {
    totalTokens: num("totalTokens"),
    inputTokens: num("inputTokens"),
    cachedInputTokens: num("cachedInputTokens"),
    outputTokens: num("outputTokens"),
  };
}

/** 审批决定（ACP 词汇 → Codex）；execpolicy 修订是持久配置变更，不提供。 */
export function codexDecision(
  optionId: string | undefined,
): "accept" | "acceptForSession" | "decline" | "cancel" {
  switch (optionId) {
    case "accept":
      return "accept";
    case "acceptForSession":
      return "acceptForSession";
    case "decline":
      return "decline";
    default:
      return "cancel";
  }
}

/** 去掉 null 字段（`RequestPermissionProfile` → `GrantedPermissionProfile`）。 */
export function grantedProfile(permissions: unknown): Json {
  if (permissions === null || typeof permissions !== "object") return {};
  const out: Json = {};
  for (const [k, v] of Object.entries(permissions as Json))
    if (v !== null && v !== undefined) out[k] = v;
  return out;
}
