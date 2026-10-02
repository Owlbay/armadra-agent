/**
 * 消息区面板（终端界面视觉设计 v1 §3.13）：`/session`、`/cache`、`/permissions` 用左竖条卡片 + 键值表
 * 渲染，而不是把纯文本拍进通知。line 模式与 RPC 仍用 session-report 的文本版。
 *
 * - `/session`：标题 `会话 <id 前 8 位> · <文件>`；模型 / 消息 / 用量 / 上下文（余量表，阈值着色），
 *   空一行后「缓存」段（与 `/cache` 共用 `cacheRows`）；
 * - `/permissions`：权限模式、判定顺序（折行对齐值列）、规则（allow success、deny error、来源 dim）、
 *   最近的 auto 判定。
 */

import type { AgentSession } from "../../agent/types.js";
import type { Runtime } from "../../cli/runtime.js";
import { AUTO_LAYER_TEXT, permissionModeLabel } from "../../permissions/modes.js";
import {
  Card,
  KeyValue,
  Meter,
  type Component,
  type KeyValueRow,
  type SemanticColor,
  type Theme,
} from "../../tui.js";
import { cacheRows, formatTokenCount, formatUsd } from "../session-report.js";
import { tildePath } from "../../cli/startup-screen.js";

/** 多段内容按顺序拼起来（段之间不加空行，由调用方放空串）。 */
class Stack implements Component {
  constructor(private readonly parts: readonly (Component | string)[]) {}

  render(width: number): string[] {
    return this.parts.flatMap((part) => (typeof part === "string" ? [part] : part.render(width)));
  }

  invalidate(): void {
    for (const part of this.parts) if (typeof part !== "string") part.invalidate();
  }
}

/** 缩进若干列的子组件。 */
class Indent implements Component {
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

function keyValue(rows: readonly KeyValueRow[], theme: Theme, wrap = false): KeyValue {
  return new KeyValue(rows, { theme, maxKeyRatio: 0.3, ...(wrap ? { wrap: true } : {}) });
}

function cacheSection(session: AgentSession, theme: Theme, now: number): (Component | string)[] {
  return [theme.bold("缓存"), new Indent(keyValue(cacheRows(session, now), theme), 2)];
}

export function sessionPanel(
  session: AgentSession,
  theme: Theme,
  options: { now?: number; home?: string } = {},
): Component {
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
      key: "模型",
      value:
        theme.fg("accent", model) +
        sep +
        `思考 ${state.thinkingLevel}` +
        sep +
        `权限 ${permissionModeLabel(state.permissionMode)}`,
    },
    {
      key: "消息",
      value: [
        `用户 ${stats.userMessages}`,
        `助手 ${stats.assistantMessages}`,
        `工具调用 ${stats.toolCalls}`,
      ].join(sep),
    },
    {
      key: "用量",
      value: [
        `输入 ${formatTokenCount(t.input)}`,
        `输出 ${formatTokenCount(t.output)}`,
        `缓存读 ${formatTokenCount(t.cacheRead)}`,
        `缓存写 ${formatTokenCount(t.cacheWrite)}`,
        formatUsd(stats.cost),
      ].join(sep),
    },
    { key: "上下文", value: meter + window },
  ];
  const file =
    state.sessionFile === undefined ? "未落盘" : tildePath(state.sessionFile, options.home);
  return new Card(new Stack([keyValue(rows, theme), "", ...cacheSection(session, theme, now)]), {
    theme,
    title: `会话 ${state.sessionId.slice(0, 8)}`,
    subtitle: file,
  });
}

export function cachePanel(session: AgentSession, theme: Theme, now = Date.now()): Component {
  return new Card(keyValue(cacheRows(session, now), theme), { theme, title: "缓存" });
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
  const rules = runtime.permission.rules;
  const mode = session.state.permissionMode;
  const order =
    mode === "auto"
      ? "deny 规则 → Hook deny → 危险命令确认 → 规则层（受保护路径、项目外写入、网络、删除类）→ Hook ask → allow 规则 / Hook allow / 本会话记忆 → 静态判定（只读、项目内写入、安全名单）→ 模型分类器 → 询问"
      : mode === "allowlist"
        ? "deny 规则 → Hook deny → 危险命令（拒绝）→ 只读工具 / allow 规则 / Hook allow 放行 → 其余拒绝（从不询问）"
        : "deny 规则 → Hook deny → 危险命令确认 → 权限模式 → allow 规则 / Hook allow / 本会话记忆 → 询问";
  const effect = (decision: string): string =>
    theme.fg(DECISION_COLOR[decision] ?? "text", decision.padEnd(5));
  const parts: (Component | string)[] = [
    keyValue(
      [
        { key: "权限模式", value: `${permissionModeLabel(mode)}${theme.fg("dim", `（${mode}）`)}` },
        { key: "判定顺序", value: order },
      ],
      theme,
      true,
    ),
    theme.bold(rules.length === 0 ? "规则（无）" : `规则（${rules.length}）`),
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
    parts.push(theme.bold(`最近的 auto 判定（${recent.length}）`));
    parts.push(
      new Indent(
        keyValue(
          recent.map((d) => ({
            key: AUTO_LAYER_TEXT[d.layer],
            value:
              `${effect(d.decision)}  ${d.toolName} ${d.summary} — ${d.reason}` +
              (d.cached === true ? theme.fg("dim", "（缓存）") : ""),
          })),
          theme,
        ),
        2,
      ),
    );
  }
  return new Card(new Stack(parts), { theme });
}
