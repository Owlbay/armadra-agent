/**
 * 会话预算（docs/history/wave5-plan.md §8.3 H2，D29）：`--max-turns` / `--max-cost` / config `limits.*`。[W5-H2]
 *
 * 以 `SessionExtension` 实现（只装主会话；task 子会话有自己的 maxTurns）：
 * - **回合**：每个会话周期（`before_agent_start` 起）累计助手回复（error / aborted 不算）；第 N 次回复
 *   带工具调用时 `requestStop`——本轮工具照常执行，之后结束 run（与原 `--max-turns` 语义一致：
 *   「一次模型请求加其工具执行算一轮」；第 N 次回复不再调用工具时自然结束，不算到限）。
 * - **费用**：同样按会话周期累计助手回复的 `usage.cost.total` 与子 Agent `subagent_end` 的用量
 *   （模型无价格时为 0，不会到限）；某次回复后累计 ≥ 上限且还要调用工具 → 同样结束 run。本周期内
 *   之后的 turn 请求（重试、Stop Hook 续跑等）在发出前被拦下（`wrapStream`，返回 `limit_reached:`
 *   开头的错误回复，不重试、不计费）。两项都是「一次运行」（config 说明与 `--max-cost` 的口径）。
 * - 到限：发 `limit_reached{kind, value, limit}`（每周期每类一次），`agent_settled{warning:"limit_reached"}`，
 *   `-p` 以退出码 8 结束（print-mode.ts）。交互与 RPC 同样生效。
 * - `budgetOf(core)` 给提醒通道（reminders.ts）读当前用量（预算剩余 < 20% 提醒）。
 */

import { runEventStream } from "../ai/event-stream.js";
import type { AssistantMessage } from "../ai/types.js";
import type { StreamFn } from "./loop.js";
import { ZERO_USAGE } from "./loop.js";
import type { SessionCore } from "./session-core.js";
import type { SessionExtension } from "./session-extensions.js";
import { LIMIT_ERROR_PREFIX, noteSettleWarning } from "./session-run.js";
import type { LimitKind, SessionEvent, SessionLimits } from "./types.js";

export const LIMIT_REACHED = "limit_reached";
export { LIMIT_ERROR_PREFIX };

export interface BudgetState {
  /** 本周期的助手回复数。 */
  turns: number;
  maxTurns?: number;
  /** 本周期累计美元（模型无价格时为 0）。 */
  spentUsd: number;
  maxCostUsd?: number;
}

const budgets = new WeakMap<SessionCore, BudgetState>();

/** 当前会话的预算状态（未设上限 / 未装扩展时 undefined）。 */
export function budgetOf(core: SessionCore): Readonly<BudgetState> | undefined {
  return budgets.get(core);
}

/** 合并：`--max-turns` / `--max-cost` 覆盖 config `limits.*`；全空返回 undefined。 */
export function resolveLimits(
  config: SessionLimits | undefined,
  overrides: { maxTurns?: number | undefined; maxCostUsd?: number | undefined } = {},
): SessionLimits | undefined {
  const limits: SessionLimits = { ...config };
  if (overrides.maxTurns !== undefined) limits.maxTurns = overrides.maxTurns;
  if (overrides.maxCostUsd !== undefined) limits.maxCostUsd = overrides.maxCostUsd;
  if (limits.maxTurns === undefined) delete limits.maxTurns;
  if (limits.maxCostUsd === undefined) delete limits.maxCostUsd;
  return Object.keys(limits).length > 0 ? limits : undefined;
}

export function formatUsd(value: number): string {
  return `$${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;
}

function hasToolCalls(message: AssistantMessage): boolean {
  return message.content.some((block) => block.type === "toolCall");
}

function blockedReply(model: Parameters<StreamFn>[0], text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...ZERO_USAGE },
    stopReason: "error",
    errorMessage: text,
    timestamp: Date.now(),
  };
}

export function createLimitsExtension(
  core: SessionCore,
  limits: SessionLimits | undefined,
): SessionExtension | undefined {
  if (limits === undefined || (limits.maxTurns === undefined && limits.maxCostUsd === undefined))
    return undefined;
  const state: BudgetState = { turns: 0, spentUsd: 0 };
  if (limits.maxTurns !== undefined) state.maxTurns = limits.maxTurns;
  if (limits.maxCostUsd !== undefined) state.maxCostUsd = limits.maxCostUsd;
  budgets.set(core, state);
  /** 本周期已报过的类别（每周期每类只报一次）。 */
  const reported = new Set<LimitKind>();

  const reach = (kind: LimitKind, value: number, limit: number): void => {
    if (reported.has(kind)) return;
    reported.add(kind);
    core.emit({ type: "limit_reached", kind, value, limit });
    noteSettleWarning(core, LIMIT_REACHED);
  };

  const overCost = (): boolean =>
    state.maxCostUsd !== undefined && state.spentUsd >= state.maxCostUsd;

  const onAssistant = (message: AssistantMessage): void => {
    state.spentUsd += message.usage.cost?.total ?? 0;
    if (message.stopReason === "error" || message.stopReason === "aborted") return;
    state.turns++;
    if (!hasToolCalls(message)) return;
    if (state.maxTurns !== undefined && state.turns >= state.maxTurns) {
      reach("turns", state.turns, state.maxTurns);
      core.requestStop(undefined);
    }
    if (overCost()) {
      reach("cost", state.spentUsd, state.maxCostUsd as number);
      core.requestStop(undefined);
    }
  };

  return {
    id: "limits",
    onEvent(event: SessionEvent): void {
      if (event.type === "before_agent_start") {
        state.turns = 0;
        state.spentUsd = 0;
        reported.clear();
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        onAssistant(event.message);
      } else if (event.type === "subagent_end") {
        state.spentUsd += event.usage?.cost?.total ?? 0;
      }
    },
    wrapStream(stream: StreamFn): StreamFn {
      return (model, context, options) => {
        if ((options.purpose ?? "turn") !== "turn" || !overCost()) {
          return stream(model, context, options);
        }
        const limit = state.maxCostUsd as number;
        reach("cost", state.spentUsd, limit);
        const text =
          `${LIMIT_ERROR_PREFIX} session cost ${formatUsd(state.spentUsd)} has reached the ` +
          `${formatUsd(limit)} budget (limits.maxCostUsd / --max-cost); no request was sent`;
        const reply = blockedReply(model, text);
        return runEventStream(
          () => reply,
          async (out) => {
            out.push({ type: "error", reason: "error", message: reply });
          },
        );
      };
    },
    dispose(): void {
      budgets.delete(core);
    },
  };
}
