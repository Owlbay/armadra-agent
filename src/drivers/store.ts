/**
 * 外部 Agent 的会话引用与记账（docs/wave5-plan.md §5.4 记账 / 敏感数据，session-format 登记）。[W5-E]
 *
 * - `custom{ama.agent-session}`：`{ agent, runner, sessionId, cwd?, taskId? }`——外部 CLI 自己的
 *   会话 id，续聊（`taskId` / resume）用；不含原始事件与转录。
 * - `custom{ama.agent-usage}`：每个回合结束一条 `{ agent, sessionId, unit, amount, tokens? }`；
 *   无美元单位的按各自单位记，不换算。
 * - `SessionStats.external` 由 {@link createExternalStatsExtension} 从活动分支汇总（扩展点
 *   `contributeStats`，主会话才装）。
 */

import type { SessionExtension } from "../agent/session-extensions.js";
import type { ExternalAgentStats, ExternalUsageUnit } from "../agent/types-w5.js";
import type { SessionEntry } from "../session/types.js";

export const AGENT_SESSION_CUSTOM = "ama.agent-session";
export const AGENT_USAGE_CUSTOM = "ama.agent-usage";

export interface AgentSessionRecord {
  agent: string;
  /** 驱动种类（`claude-stream` / `codex-app-server` / `acp` …）或宿主 runner id。 */
  runner: string;
  sessionId: string;
  cwd?: string;
  taskId?: string;
}

export interface AgentUsageRecord {
  agent: string;
  sessionId: string;
  unit: ExternalUsageUnit;
  amount: number;
  tokens?: number;
}

/** 会话一侧的最小接口（`ToolContext.session` 或 SessionCore 都能提供）。 */
export interface AgentStoreBackend {
  appendCustom(customType: string, data: unknown): void;
  /** 活动分支上的条目（求会话级美元合计；不给则只算本进程记下的）。 */
  entries?(): readonly SessionEntry[];
}

export interface AgentStore {
  recordSession(record: AgentSessionRecord): void;
  recordUsage(record: AgentUsageRecord): void;
  /** 本会话外部 Agent 的美元合计（`agents.sessionBudgetUsd`）。 */
  totalUsd(): number;
  /** 最近一条该 Agent（可按 taskId 过滤）的会话引用。 */
  lastSession(agent: string, taskId?: string): AgentSessionRecord | undefined;
}

function customs<T>(entries: readonly SessionEntry[], type: string): T[] {
  const out: T[] = [];
  for (const entry of entries)
    if (entry.type === "custom" && entry.customType === type && typeof entry.data === "object")
      out.push(entry.data as T);
  return out;
}

export function createAgentStore(backend: AgentStoreBackend): AgentStore {
  const sessions: AgentSessionRecord[] = [];
  let usd = 0;
  const all = (): { sessions: AgentSessionRecord[]; usage: AgentUsageRecord[] } | undefined => {
    const entries = backend.entries?.();
    if (entries === undefined) return undefined;
    return {
      sessions: customs<AgentSessionRecord>(entries, AGENT_SESSION_CUSTOM),
      usage: customs<AgentUsageRecord>(entries, AGENT_USAGE_CUSTOM),
    };
  };
  return {
    recordSession(record) {
      sessions.push(record);
      backend.appendCustom(AGENT_SESSION_CUSTOM, record);
    },
    recordUsage(record) {
      if (record.unit === "usd") usd += record.amount;
      backend.appendCustom(AGENT_USAGE_CUSTOM, record);
    },
    totalUsd() {
      const persisted = all();
      if (persisted === undefined) return usd;
      return persisted.usage.reduce((sum, u) => (u.unit === "usd" ? sum + u.amount : sum), 0);
    },
    lastSession(agent, taskId) {
      const list = all()?.sessions ?? sessions;
      for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i]!;
        if (r.agent === agent && (taskId === undefined || r.taskId === taskId)) return r;
      }
      return undefined;
    },
  };
}

/** 活动分支上的 `ama.agent-usage` → `SessionStats.external`；没有外部运行时 undefined。 */
export function aggregateExternal(
  entries: readonly SessionEntry[],
): ExternalAgentStats | undefined {
  const usage = customs<AgentUsageRecord>(entries, AGENT_USAGE_CUSTOM);
  if (usage.length === 0) return undefined;
  const byAgent: ExternalAgentStats["byAgent"] = {};
  for (const u of usage) {
    if (typeof u.agent !== "string" || typeof u.amount !== "number") continue;
    const row = (byAgent[u.agent] ??= { runs: 0, unit: u.unit, amount: 0 });
    row.runs += 1;
    // 同一 Agent 换了单位（换了驱动）时以最新单位重新计
    if (row.unit !== u.unit) {
      row.unit = u.unit;
      row.amount = 0;
    }
    row.amount += u.amount;
    if (typeof u.tokens === "number") row.tokens = (row.tokens ?? 0) + u.tokens;
  }
  return { byAgent };
}

/** 会话扩展：`getStats()` 时补 `external`（只装在主会话）。 */
export function createExternalStatsExtension(
  entries: () => readonly SessionEntry[],
): SessionExtension {
  return {
    id: "external-agents",
    contributeStats(stats) {
      const external = aggregateExternal(entries());
      if (external !== undefined) stats.external = external;
    },
  };
}
