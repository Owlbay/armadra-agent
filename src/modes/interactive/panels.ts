/**
 * 消息区面板（终端界面视觉设计 v1 §3.13）：`/session`、`/cache`、`/permissions` 用左竖条卡片 + 键值表
 * 渲染，而不是把纯文本拍进通知。line 模式与 RPC 仍用 session-report 的文本版。
 *
 * - `/session`：标题 `会话 <id 前 8 位> · <文件>`；模型 / 消息 / 用量 / 上下文（余量表，阈值着色），
 *   空一行后「缓存」段（与 `/cache` 共用 `cacheRows`）；
 * - [W5-U] `/session` 多「子 Agent」行（任务汇总）与「外部 Agent」段（按 Agent 的运行次数与用量，单位不换算）；
 * - `/permissions`：权限模式、判定顺序（折行对齐值列）、规则（allow success、deny error、来源 dim）、
 *   最近的 auto 判定。
 */

import type { AgentSession } from "../../agent/types.js";
import type { Runtime } from "../../cli/runtime.js";
import { msg } from "../../i18n/index.js";
import { autoLayerText, permissionModeLabel } from "../../permissions/modes.js";
import {
  Card,
  KeyValue,
  Meter,
  type Component,
  type KeyValueRow,
  type SemanticColor,
  type Theme,
} from "../../tui.js";
import {
  cacheRows,
  externalRows,
  formatTokenCount,
  formatUsd,
  taskStatsText,
} from "../session-report.js";
import { tildePath } from "../../cli/startup-screen.js";

/** 多段内容按顺序拼起来（段之间不加空行，由调用方放空串）。 */
export class Stack implements Component {
  constructor(private readonly parts: readonly (Component | string)[]) {}

  render(width: number): string[] {
    return this.parts.flatMap((part) => (typeof part === "string" ? [part] : part.render(width)));
  }

  invalidate(): void {
    for (const part of this.parts) if (typeof part !== "string") part.invalidate();
  }
}

/** 缩进若干列的子组件。 */
export class Indent implements Component {
  constructor(
    private readonly child: Component,
    private readonly columns: number,
  ) {}

  render(width: number): string[] {
    const pad = " ".repeat(this.columns);
    return this.child
      .render(Math.max(1, width - this.columns))
      .map((line) => (line === "" ? "" : pad + line));
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

export function keyValue(rows: readonly KeyValueRow[], theme: Theme, wrap = false): KeyValue {
  return new KeyValue(rows, { theme, maxKeyRatio: 0.3, ...(wrap ? { wrap: true } : {}) });
}

function cacheSection(session: AgentSession, theme: Theme, now: number): (Component | string)[] {
  return [
    theme.bold(msg().panels.cache.title),
    new Indent(keyValue(cacheRows(session, now), theme), 2),
  ];
}

export function sessionPanel(
  session: AgentSession,
  theme: Theme,
  options: { now?: number; home?: string } = {},
): Component {
  const m = msg().panels.session;
  const now = options.now ?? Date.now();
  const state = session.state;
  const stats = session.getStats();
  const t = stats.tokens;
  const sep = theme.fg("dim", " · ");
  const model = state.model === undefined ? "?" : `${state.model.provider}/${state.model.id}`;
  const ratio = stats.contextPercent === undefined ? undefined : stats.contextPercent / 100;
  const meter = new Meter(ratio, { theme }).render(40)[0] ?? "";
  const window =
    stats.contextTokens === undefined && stats.contextWindow === undefined
      ? ""
      : sep +
        `${stats.contextTokens === undefined ? "?" : formatTokenCount(stats.contextTokens)} / ` +
        `${stats.contextWindow === undefined ? "?" : formatTokenCount(stats.contextWindow)}`;
  const rows: KeyValueRow[] = [
    {
      key: m.model,
      value:
        theme.fg("accent", model) +
        sep +
        m.thinking(state.thinkingLevel) +
        sep +
        m.permission(permissionModeLabel(state.permissionMode)),
    },
    {
      key: m.messages,
      value: [
        m.user(stats.userMessages),
        m.assistant(stats.assistantMessages),
        m.toolCalls(stats.toolCalls),
      ].join(sep),
    },
    {
      key: m.usage,
      value: [
        m.input(formatTokenCount(t.input)),
        m.output(formatTokenCount(t.output)),
        m.cacheRead(formatTokenCount(t.cacheRead)),
        m.cacheWrite(formatTokenCount(t.cacheWrite)),
        formatUsd(stats.cost),
      ].join(sep),
    },
    { key: m.context, value: meter + window },
  ];
  const tasks = taskStatsText(session);
  if (tasks !== undefined) rows.push({ key: m.subagents, value: tasks });
  const external = externalRows(session);
  const externalSection: (Component | string)[] =
    external.length > 0
      ? ["", theme.bold(m.external), new Indent(keyValue(external, theme), 2)]
      : [];
  const file =
    state.sessionFile === undefined ? m.notSaved : tildePath(state.sessionFile, options.home);
  const parts = [
    keyValue(rows, theme),
    "",
    ...cacheSection(session, theme, now),
    ...externalSection,
  ];
  return new Card(new Stack(parts), {
    theme,
    title: m.title(state.sessionId.slice(0, 8)),
    subtitle: file,
  });
}

export function cachePanel(session: AgentSession, theme: Theme, now = Date.now()): Component {
  return new Card(keyValue(cacheRows(session, now), theme), {
    theme,
    title: msg().panels.cache.title,
  });
}

const DECISION_COLOR: Record<string, SemanticColor> = {
  allow: "success",
  deny: "error",
  ask: "warning",
};

export function permissionsPanel(
  runtime: Pick<Runtime, "permission">,
  session: AgentSession,
  theme: Theme,
): Component {
  const m = msg().panels.permissions;
  const rules = runtime.permission.rules;
  const mode = session.state.permissionMode;
  const order =
    mode === "auto" ? m.orderAuto : mode === "allowlist" ? m.orderAllowlist : m.orderDefault;
  const effect = (decision: string): string =>
    theme.fg(DECISION_COLOR[decision] ?? "text", decision.padEnd(5));
  const parts: (Component | string)[] = [
    keyValue(
      [
        {
          key: m.mode,
          value: m.modeValue(permissionModeLabel(mode), mode, (t) => theme.fg("dim", t)),
        },
        { key: m.order, value: order },
      ],
      theme,
      true,
    ),
    theme.bold(rules.length === 0 ? m.rulesNone : m.rules(rules.length)),
  ];
  if (rules.length > 0) {
    parts.push(
      new Indent(
        keyValue(
          rules.map((r) => ({
            key: effect(r.effect),
            value: `${r.raw}  ${theme.fg("dim", `[${r.source}]`)}`,
          })),
          theme,
        ),
        2,
      ),
    );
  }
  const recent = runtime.permission.autoDecisions?.() ?? [];
  if (recent.length > 0) {
    parts.push(theme.bold(m.recentAuto(recent.length)));
    parts.push(
      new Indent(
        keyValue(
          recent.map((d) => ({
            key: autoLayerText(d.layer),
            value:
              `${effect(d.decision)}  ${d.toolName} ${d.summary} — ${d.reason}` +
              (d.cached === true ? theme.fg("dim", m.cached) : ""),
          })),
          theme,
        ),
        2,
      ),
    );
  }
  return new Card(new Stack(parts), { theme });
}
