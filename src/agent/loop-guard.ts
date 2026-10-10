/**
 * 重复调用检测（docs/history/wave5-plan.md §8.3 H1，D29）。[W5-H2]
 *
 * - 指纹 = `sha256(工具名 + 规范化 JSON 参数)`（对象键排序，数组保持顺序）；同一 run 内**累计**计数。
 * - 第 `LOOP_REMIND_AT`（3）次起：照常执行，在该次 toolResult 末尾追加提醒（只改这条结果，缓存安全）。
 * - 第 `LOOP_STOP_AT`（5）次：不执行，给错误结果并结束本 run，`agent_settled{warning:"repeated_tool_call"}`。
 * - 豁免：`annotations.pollable` 的工具（`task_ctl`），以及后台 bash 的查询（`bash{job, action:"wait"|"output"}`）。
 *
 * 每个 run 一个实例：tool-runner 以 run 的 AbortSignal 为键取（`guardFor`），run 结束随之回收。
 */

import { createHash } from "node:crypto";
import type { ToolCallBlock } from "../ai/types.js";
import type { ToolDefinition } from "../tools/types.js";

export const LOOP_REMIND_AT = 3;
export const LOOP_STOP_AT = 5;
/** 结束 run 时 `agent_settled.warning` 的值。 */
export const REPEATED_TOOL_CALL = "repeated_tool_call";

export type LoopVerdict = "ok" | "remind" | "stop";

/** 规范化 JSON：对象键按字典序，`undefined` 字段省略。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${parts.join(",")}}`;
}

export function callFingerprint(call: Pick<ToolCallBlock, "name" | "arguments">): string {
  return createHash("sha256")
    .update(call.name)
    .update("\u0000")
    .update(canonicalJson(call.arguments))
    .digest("hex");
}

/** 轮询类调用：工具声明 `pollable`，或后台 bash 的 wait / output。 */
export function isPollableCall(call: ToolCallBlock, tool: ToolDefinition | undefined): boolean {
  if (tool?.annotations?.pollable === true) return true;
  if (call.name !== "bash") return false;
  const args = call.arguments as { job?: unknown; action?: unknown } | null;
  return (
    typeof args === "object" &&
    args !== null &&
    typeof args.job === "string" &&
    (args.action === "wait" || args.action === "output")
  );
}

export class LoopGuard {
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly remindAt = LOOP_REMIND_AT,
    private readonly stopAt = LOOP_STOP_AT,
  ) {}

  /** 记一次调用并给出判定（轮询类恒为 ok，不计数）。 */
  observe(call: ToolCallBlock, tool: ToolDefinition | undefined): LoopVerdict {
    if (isPollableCall(call, tool)) return "ok";
    const key = callFingerprint(call);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (count >= this.stopAt) return "stop";
    if (count >= this.remindAt) return "remind";
    return "ok";
  }

  /** 该调用到目前为止的次数。 */
  count(call: ToolCallBlock): number {
    return this.counts.get(callFingerprint(call)) ?? 0;
  }
}

/** 追加在第 3、4 次结果末尾的提醒（给模型看）。 */
export function loopReminderText(name: string, count: number): string {
  return (
    `<system-reminder>You have now called ${name} ${count} times in this run with exactly the ` +
    `same arguments. Repeating it will not change the result; use what you already have, try a ` +
    `different approach, or stop and report. A ${LOOP_STOP_AT}th identical call ends the run.` +
    `</system-reminder>`
  );
}

/** 第 5 次：不执行，给这条错误结果并结束 run。 */
export function loopStopText(name: string, count: number): string {
  return (
    `Not executed: ${name} was called ${count} times in this run with identical arguments. ` +
    `The run was stopped to avoid a loop.`
  );
}

const guards = new WeakMap<AbortSignal, LoopGuard>();

/** 本 run 的检测器（以 run 的 AbortSignal 为键，run 结束随 signal 回收）。 */
export function guardFor(signal: AbortSignal): LoopGuard {
  let guard = guards.get(signal);
  if (guard === undefined) {
    guard = new LoopGuard();
    guards.set(signal, guard);
  }
  return guard;
}
