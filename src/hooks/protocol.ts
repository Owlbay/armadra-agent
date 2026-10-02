/**
 * Hook 输入 / 输出的构造、校验与决策合并（设计 §6.1）。[B5]
 *
 * 退出码语义：0 放行并解析 stdout；2 阻止（stderr 作为 reason）；其它非零 = Hook 自身错误，
 * 非阻塞、记 warning、按「无决策」继续；超时同非阻塞错误，但 PreToolUse 超时按 deny。
 * 合并：决策最严 `deny > block > ask > allow`；`updatedInput` / `updatedPrompt` 只接受唯一
 * 一个返回者（多个则全部忽略并 warning）；`additionalContext` / `customInstructions` 按配置顺序拼接。
 */

import type {
  HookDecision,
  HookEvent,
  HookInput,
  HookOutcome,
  HookOutput,
  HookRunResult,
} from "./types.js";

export const DECISION_SEVERITY: Readonly<Record<HookDecision, number>> = {
  deny: 4,
  block: 3,
  ask: 2,
  allow: 1,
};

/** 各事件接受的决策（其它决策忽略并 warning；deny / block 在两类事件间互换）。 */
const ACCEPTED: Readonly<Record<HookEvent, readonly HookDecision[]>> = {
  PreToolUse: ["allow", "deny", "ask"],
  PostToolUse: ["block"],
  UserPromptSubmit: ["block"],
  Stop: ["block"],
  SubagentStop: ["block"],
  PreCompact: ["block"],
  SessionStart: ["block"],
  Notification: [],
  SessionEnd: [],
  PostRewind: [],
  PostCompact: [],
};

/** 退出码 2 映射的阻止决策；undefined = 该事件忽略退出码 2。 */
export function blockingDecision(event: HookEvent): HookDecision | undefined {
  if (event === "PreToolUse") return "deny";
  if (
    event === "Notification" ||
    event === "SessionEnd" ||
    event === "PostRewind" ||
    event === "PostCompact"
  )
    return undefined;
  return "block";
}

export interface ParsedOutput {
  output?: HookOutput;
  warnings: string[];
}

/** 解析 stdout：空 / 非 JSON / 非对象 → 无输出；字段类型不对的丢弃并 warning。 */
export function parseHookOutput(stdout: string): ParsedOutput {
  const text = stdout.trim();
  if (text === "" || (text[0] !== "{" && text[0] !== "[")) return { warnings: [] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { warnings: [] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { warnings: [] };
  const raw = value as Record<string, unknown>;
  const output: HookOutput = {};
  const warnings: string[] = [];
  const decision = raw["decision"];
  if (decision !== undefined) {
    if (decision === "allow" || decision === "deny" || decision === "ask" || decision === "block") {
      output.decision = decision;
    } else {
      warnings.push(`未知 decision：${JSON.stringify(decision)}`);
    }
  }
  for (const key of [
    "reason",
    "updatedPrompt",
    "additionalContext",
    "customInstructions",
  ] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v === "string") output[key] = v;
    else warnings.push(`${key} 应为字符串`);
  }
  if ("updatedInput" in raw) output.updatedInput = raw["updatedInput"];
  if (raw["continue"] === false) output.continue = false;
  if (raw["suppressOutput"] === true) output.suppressOutput = true;
  return { output, warnings };
}

/** 单条结果的有效决策与 reason（已按事件与退出码解释）。 */
export interface Interpreted {
  decision?: HookDecision;
  reason?: string;
  warning?: string;
  /** 是否采用 stdout 的其它字段（只有退出码 0）。 */
  useOutput: boolean;
}

function describe(result: HookRunResult): string {
  return `Hook ${result.event}「${result.command}」`;
}

/** [W6-C0] 回给模型的阻止理由固定英文（警告仍给人看）。 */
function describeForModel(result: HookRunResult): string {
  return `Hook ${result.event} "${result.command}"`;
}

function normalizeDecision(event: HookEvent, decision: HookDecision): HookDecision | undefined {
  const accepted = ACCEPTED[event];
  if (accepted.includes(decision)) return decision;
  if (decision === "deny" && accepted.includes("block")) return "block";
  if (decision === "block" && accepted.includes("deny")) return "deny";
  return undefined;
}

export function interpretResult(result: HookRunResult): Interpreted {
  const event = result.event;
  if (result.timedOut) {
    const message = `${describe(result)} 超时（${result.durationMs} ms）`;
    if (event === "PreToolUse")
      return {
        decision: "deny",
        reason: `${describeForModel(result)} timed out (${result.durationMs} ms)`,
        warning: message,
        useOutput: false,
      };
    return { warning: message, useOutput: false };
  }
  if (result.exitCode === 2) {
    const decision = blockingDecision(event);
    const reason = result.stderr.trim() || `${describeForModel(result)} blocked with exit code 2`;
    if (decision === undefined) return { useOutput: false };
    return { decision, reason, useOutput: false };
  }
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-3).join(" | ");
    const code = result.exitCode === null ? "被信号终止" : `退出码 ${result.exitCode}`;
    return {
      warning: `${describe(result)} 失败（${code}）${tail === "" ? "" : `：${tail}`}`,
      useOutput: false,
    };
  }
  const output = result.output;
  if (output?.decision === undefined) return { useOutput: true };
  const decision = normalizeDecision(event, output.decision);
  if (decision === undefined) {
    return {
      useOutput: true,
      warning: `${describe(result)} 的 decision "${output.decision}" 对 ${event} 无效，已忽略`,
    };
  }
  const interpreted: Interpreted = { decision, useOutput: true };
  if (output.reason !== undefined) interpreted.reason = output.reason;
  return interpreted;
}

function joinTexts(values: readonly string[]): string | undefined {
  const parts = values.map((v) => v.trim()).filter((v) => v !== "");
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** 合并同一事件下全部结果（`results` 已按配置顺序排列）。 */
export function mergeResults(
  results: readonly HookRunResult[],
  extraWarnings: readonly string[] = [],
): HookOutcome {
  const warnings = [...extraWarnings];
  let decision: HookDecision | undefined;
  let reason: string | undefined;
  const inputs: unknown[] = [];
  const prompts: string[] = [];
  const contexts: string[] = [];
  const instructions: string[] = [];
  let stop = false;
  let suppressOutput = false;

  for (const result of results) {
    const interpreted = interpretResult(result);
    if (interpreted.warning !== undefined) warnings.push(interpreted.warning);
    if (interpreted.decision !== undefined) {
      if (
        decision === undefined ||
        DECISION_SEVERITY[interpreted.decision] > DECISION_SEVERITY[decision]
      ) {
        decision = interpreted.decision;
        reason = interpreted.reason;
      } else if (interpreted.decision === decision && reason === undefined) {
        reason = interpreted.reason;
      }
    }
    if (!interpreted.useOutput || result.output === undefined) continue;
    const output = result.output;
    if ("updatedInput" in output) inputs.push(output.updatedInput);
    if (output.updatedPrompt !== undefined) prompts.push(output.updatedPrompt);
    if (output.additionalContext !== undefined) contexts.push(output.additionalContext);
    if (output.customInstructions !== undefined) instructions.push(output.customInstructions);
    if (output.continue === false) {
      stop = true;
      if (reason === undefined && output.reason !== undefined) reason = output.reason;
    }
    if (output.suppressOutput === true) suppressOutput = true;
  }

  const outcome: HookOutcome = {
    hasUpdatedInput: false,
    stop,
    suppressOutput,
    results: [...results],
    warnings,
  };
  if (decision !== undefined) outcome.decision = decision;
  if (reason !== undefined) outcome.reason = reason;
  if (inputs.length === 1) {
    outcome.updatedInput = inputs[0];
    outcome.hasUpdatedInput = true;
  } else if (inputs.length > 1) {
    warnings.push(`${inputs.length} 个 Hook 同时返回 updatedInput，全部忽略`);
  }
  if (prompts.length === 1 && prompts[0] !== undefined) outcome.updatedPrompt = prompts[0];
  else if (prompts.length > 1)
    warnings.push(`${prompts.length} 个 Hook 同时返回 updatedPrompt，全部忽略`);
  const additionalContext = joinTexts(contexts);
  if (additionalContext !== undefined) outcome.additionalContext = additionalContext;
  const customInstructions = joinTexts(instructions);
  if (customInstructions !== undefined) outcome.customInstructions = customInstructions;
  return outcome;
}

/** 无任何 Hook 时的空结论。 */
export function emptyOutcome(): HookOutcome {
  return { hasUpdatedInput: false, stop: false, suppressOutput: false, results: [], warnings: [] };
}

/** 给 shell 脚本的环境变量（§6.1）。 */
export function hookEnv(input: HookInput): Record<string, string> {
  const env: Record<string, string> = {
    AMA_HOOK_EVENT: input.hookEventName,
    AMA_SESSION_ID: input.sessionId,
    AMA_CWD: input.cwd,
  };
  if (input.toolName !== undefined) env["AMA_TOOL_NAME"] = input.toolName;
  const file = filePathOf(input);
  if (file !== undefined) env["AMA_FILE"] = file;
  return env;
}

function filePathOf(input: HookInput): string | undefined {
  if (input.toolName === undefined || !["write", "edit", "read"].includes(input.toolName)) {
    return undefined;
  }
  const toolInput = input.toolInput;
  if (typeof toolInput !== "object" || toolInput === null) return undefined;
  const record = toolInput as Record<string, unknown>;
  const path = record["path"] ?? record["file_path"];
  return typeof path === "string" ? path : undefined;
}
