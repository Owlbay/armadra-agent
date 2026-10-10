/**
 * Claude Code stream-json → DriverEvent 的映射表（docs/wave5-plan.md §5.1 normalize，R2 §3.2）。[W5-E]
 *
 * 线上形状按 Claude Code 2.1.x 的 `--output-format stream-json`（Agent SDK 所用的同一协议；
 * 官方称其不是公开的 CLI 接口，R3），只读用到的字段，其余忽略。
 */

import type { PermissionMode } from "../../permissions/types.js";
import { oneLine } from "../turn.js";
import type { AcpToolKind } from "../types.js";

const KINDS: Record<string, AcpToolKind> = {
  Read: "read",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "execute",
  BashOutput: "execute",
  KillShell: "execute",
  Grep: "search",
  Glob: "search",
  LS: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
  TodoWrite: "think",
  ExitPlanMode: "switch_mode",
};

export function claudeToolKind(name: string): AcpToolKind {
  return KINDS[name] ?? "other";
}

function field(input: unknown, ...keys: string[]): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  for (const key of keys) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

export function claudeToolTitle(name: string, input: unknown): string {
  const detail =
    field(input, "command") ??
    field(input, "file_path", "notebook_path", "path") ??
    field(input, "pattern", "url", "query", "description");
  return detail === undefined ? name : `${name}: ${oneLine(detail, 100)}`;
}

export function claudeToolLocations(input: unknown): string[] | undefined {
  const path = field(input, "file_path", "notebook_path", "path");
  return path === undefined ? undefined : [path];
}

/** TodoWrite 的 todos → plan 条目。 */
export function claudeTodos(input: unknown): { content: string; status: string }[] | undefined {
  const todos = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return undefined;
  return todos.flatMap((t) =>
    t !== null && typeof t === "object" && typeof (t as { content?: unknown }).content === "string"
      ? [
          {
            content: (t as { content: string }).content,
            status: String((t as { status?: unknown }).status ?? "pending"),
          },
        ]
      : [],
  );
}

/**
 * ama 模式 → Claude `--permission-mode`。full-auto 不映射成 bypassPermissions：协调者永远不替
 * 外部 Agent 打开「跳过全部检查」，最宽给到 auto（Claude 自己的分类器 + 需要时问人）。
 * `manual` 是 2.1.x 新名字，旧版本叫 `default`（探测 `--help` 决定）。
 */
export function claudePermissionMode(
  mode: PermissionMode,
  manualName: "manual" | "default",
): string {
  switch (mode) {
    // allowlist 也按 plan：Claude 的 dontAsk 会放行它自己配置里的 allow 规则（可能含写操作）
    case "plan":
    case "allowlist":
      return "plan";
    case "default":
      return manualName;
    case "auto-edit":
      return "acceptEdits";
    case "auto":
    case "full-auto":
      return "auto";
  }
}

/** 只能由人回答的提问类工具（ama 不代答）。 */
export const CLAUDE_QUESTION_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion"]);

export interface ClaudeResult {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  permission_denials?: { tool_name?: string }[];
  errors?: string[];
  /** 进程内累计，按模型分；`contextWindow` 是该模型的上下文窗口（2.1.x 起）。 */
  modelUsage?: Record<string, { contextWindow?: number }>;
}

/** 一条主线 assistant 消息的用量 = 这次请求后的上下文占用（输入 + 缓存读写 + 输出）。 */
export function claudeContextTokens(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  let total = 0;
  for (const key of [
    "input_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
  ])
    if (typeof u[key] === "number") total += u[key];
  return total > 0 ? total : undefined;
}

/** result.modelUsage 里某模型（缺省取最大）的上下文窗口。 */
export function claudeContextWindow(
  result: ClaudeResult,
  model: string | undefined,
): number | undefined {
  const entries = result.modelUsage ?? {};
  const hit = model !== undefined ? entries[model]?.contextWindow : undefined;
  if (typeof hit === "number" && hit > 0) return hit;
  const windows = Object.values(entries)
    .map((e) => e.contextWindow)
    .filter((w): w is number => typeof w === "number" && w > 0);
  return windows.length > 0 ? Math.max(...windows) : undefined;
}

/** result.subtype → 回合结束原因；`undefined` 表示执行出错（调用方按错误处理）。 */
export function claudeStopReason(
  result: ClaudeResult,
  interrupted: boolean,
): "end_turn" | "max_turn_requests" | "cancelled" | undefined {
  if (interrupted) return "cancelled";
  switch (result.subtype) {
    case "success":
      return result.is_error === true ? undefined : "end_turn";
    case "error_max_turns":
      return "max_turn_requests";
    case "error_max_budget_usd":
      return "cancelled";
    default:
      return undefined;
  }
}

/** 只保留会话范围的权限建议（`localSettings` 等会改用户 / 项目配置文件，不能替人写）。 */
export function sessionScopedSuggestions(suggestions: unknown): unknown[] {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.filter(
    (s) =>
      s !== null &&
      typeof s === "object" &&
      (s as { destination?: unknown }).destination === "session",
  );
}
