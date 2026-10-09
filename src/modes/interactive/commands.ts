/**
 * 交互模式的斜杠命令：把 commands-core 的 `CommandResult` 变成界面动作。[B7]
 *
 * - `handled` → 消息区显示文本；`prompt` → 发提示；`exit` → 退出；
 * - `pick` → 打开对应选择器：模型（setModel；不列测试供应商 fake，`AMA_SHOW_FAKE=1` 或 `AMA_FAKE_SCRIPT` 时照列）、会话（resume）、树（/fork 无参数：从选中的用户消息
 *   之前分叉，消息文本回填编辑器）、权限模式、思考级别；
 * - 交互模式自有命令：`/tree`（同一文件内换叶子到选中消息之前，文本回填编辑器，可改后重发形成新分支）、
 *   `/permissions`（当前模式、判定顺序与已加载规则）；`/help` 追加这两条与按键说明。
 * - `/session`、`/cache`（无参数）与 `/permissions` 在消息区画左竖条面板（panels.ts），不再拍成文本；
 *   `/context` 同样画面板（context-report.ts，`PANEL_COMMANDS`），没有面板时回落文本。
 * - `/rewind`（无参数）打开回滚列表与确认面板（rewind-flow.ts）；带参数走 commands-core，对话变了时
 *   重画消息区并回填原消息。
 * - 不是命令（含模板与 `/skill:`）返回 false，调用方把整行当提示发出。
 * - [W6-C0] 面板钩子：`/config`（W6-S）、`/trace`（W6-T1）、`/memory`（W6-M）按 `PANEL_COMMANDS` 表分派到
 *   `CommandUi` 的可选钩子；`/tasks` 无参在有 `agentBar` 时聚焦 Agent 栏、`/tasks <id>` 在有 `agentView` 时
 *   直接进子 Agent 视图（W6-A）。钩子没装时回落 commands-core（line 模式同一套文本）。
 */

import { msg } from "../../i18n/index.js";
import { formatModelRef } from "../../ai/providers/channels.js";
import { AgentSessionImpl } from "../../agent/session.js";
import type { AgentSession, RewindDraftText } from "../../agent/types.js";
import { THINKING_LEVELS } from "../../ai/thinking.js";
import type { ModelThinkingLevel, ProviderRegistryApi } from "../../ai/types.js";
import type { SwitchRequest } from "../../cli/compose-session.js";
import { listSessions } from "../../cli/compose-store.js";
import { hideFakeProvider } from "../../cli/fake-visibility.js";
import type { Runtime } from "../../cli/runtime.js";
import { autoLayerText, permissionModeLabel } from "../../permissions/modes.js";
import type { PermissionMode } from "../../permissions/types.js";
import type { SessionEntry } from "../../session/types.js";
import type { Component, SelectItem, Theme } from "../../tui.js";
import {
  BUILTIN_COMMANDS,
  parseSlash,
  runSlashCommand,
  type CommandInfo,
  type CommandResult,
} from "../commands-core.js";
import { contextPanel } from "../context-report.js";
import { contentText, type NoticeLevel } from "./message-view.js";
import { cachePanel, permissionsPanel, sessionPanel } from "./panels.js";
import {
  modelItems,
  permissionPickerSpec,
  sessionItems,
  thinkingItems,
  treeItems,
  type PickerSpec,
} from "./pickers.js";

/** 说明随界面语言（取用时求值）。 */
function command(name: string, key: "treeDescription" | "permissionsDescription"): CommandInfo {
  return {
    name,
    get description() {
      return msg().interactive.commands[key];
    },
  };
}

export const INTERACTIVE_COMMANDS: readonly CommandInfo[] = [
  command("tree", "treeDescription"),
  command("permissions", "permissionsDescription"),
];

/** 补全与 /help 用的完整命令表。 */
export const ALL_COMMANDS: readonly CommandInfo[] = [...BUILTIN_COMMANDS, ...INTERACTIVE_COMMANDS];

/** `/help` 末尾的按键说明（多行）。 */
export function keyHints(): string {
  return msg().interactive.commands.keyHints;
}

export interface CommandUi {
  readonly runtime: Runtime;
  session(): AgentSession;
  /** 切换会话（调用方负责重新订阅、重画消息区、announceStart）。 */
  switchSession(request: SwitchRequest): Promise<AgentSession>;
  pick(spec: PickerSpec): Promise<SelectItem | undefined>;
  notice(level: NoticeLevel, text: string): void;
  /** 消息区面板（/session、/cache、/permissions）；缺省回落为文本通知。 */
  panel?(component: Component): void;
  setEditorText(text: string): void;
  /** 发一条提示（不等运行结束）。 */
  prompt(text: string): void;
  /** /tree 换叶子后重画消息区。 */
  reload(): void;
  /** 回滚列表与确认面板（`/rewind` 无参数）；没有时回落为文字列表。 */
  rewind?(): Promise<void>;
  /** 回填原消息（文本 + 图片）；缺省只回填文本。 */
  setDraft?(draft: RewindDraftText): void;
  exit(code: number): void;
  now(): number;
  /** 面板用的主题（与 panel 一起提供）。 */
  theme?(): Theme;
  /** 家目录（面板里路径缩写为 ~）。 */
  home?: string;
  /** 进程环境：给出时 /model 选择器按 fake-visibility 规则藏起测试供应商 fake。 */
  env?: Readonly<Record<string, string | undefined>>;
  /** 切换权限模式前的确认（进入 Bypass 前弹确认框）；返回 false 保持原模式。 */
  confirmMode?(mode: PermissionMode): boolean | Promise<boolean>;
  /** [W5-U] 界面自己处理的第五波命令（agent-ui.ts）；处理了返回 true。 */
  extra?(name: string, args: string): Promise<boolean>;
  /** [W6-C0] 聚焦 Agent 栏（W6-A；`/tasks` 无参）。 */
  agentBar?(): void | Promise<void>;
  /** [W6-C0] 打开某任务的子 Agent 视图（W6-A；`/tasks <id>`）。 */
  agentView?(taskId: string): void | Promise<void>;
  /** [W6-C0] 轨迹覆盖层（W6-T1；`/trace [任务 id]`）。 */
  traceView?(taskId?: string): void | Promise<void>;
  /** [W6-C0] 记忆面板 / 子命令（W6-M；`/memory …`）。 */
  memoryPanel?(args: string): void | Promise<void>;
  /** [W6-C0] 设置面板（W6-S；`/config`，`/config key=value` 直接设一项）。 */
  configPanel?(args: string): void | Promise<void>;
  /** `/model` 选择器（model-picker.ts：Tab 视图、Space 清单）；没有时回落为 `pick` + `modelItems`。 */
  pickModel?(
    providers: ProviderRegistryApi,
    current: string | undefined,
  ): Promise<string | undefined>;
}

/**
 * [W6-C0] 面板类命令 → `CommandUi` 钩子。钩子存在就调用并返回 true；不存在返回 false（回落 commands-core）。
 */
export const PANEL_COMMANDS: Readonly<
  Record<string, (ui: CommandUi, args: string) => Promise<boolean>>
> = {
  config: async (ui, args) => {
    if (ui.configPanel === undefined) return false;
    await ui.configPanel(args);
    return true;
  },
  trace: async (ui, args) => {
    if (ui.traceView === undefined) return false;
    await ui.traceView(args === "" ? undefined : args);
    return true;
  },
  context: async (ui) => {
    const theme = ui.theme?.();
    if (ui.panel === undefined || theme === undefined) return false;
    ui.panel(contextPanel(ui.session(), theme));
    return true;
  },
  memory: async (ui, args) => {
    if (ui.memoryPanel === undefined) return false;
    await ui.memoryPanel(args);
    return true;
  },
  tasks: async (ui, args) => {
    const parts = args.split(/\s+/).filter((s) => s !== "");
    if (parts.length === 0 && ui.agentBar !== undefined) {
      await ui.agentBar();
      return true;
    }
    if (
      parts.length === 1 &&
      parts[0] !== "stop" &&
      parts[0] !== "bg" &&
      ui.agentView !== undefined
    ) {
      await ui.agentView(parts[0] as string);
      return true;
    }
    return false;
  },
};

function homeOf(ui: CommandUi): { home?: string } {
  return ui.home !== undefined ? { home: ui.home } : {};
}

function userEntryText(entry: SessionEntry | undefined): string | undefined {
  if (entry?.type !== "message" || entry.message.role !== "user") return undefined;
  return contentText(entry.message.content);
}

/** 当前分支上的条目 id（树选择器标 ●）。 */
export function activeBranchIds(session: AgentSession): Set<string> {
  if (session instanceof AgentSessionImpl)
    return new Set(session.manager.branch().map((e) => e.id));
  return new Set(session.entries.map((e) => e.id));
}

export function permissionsText(runtime: Runtime, session: AgentSession): string {
  const m = msg().interactive.commands;
  const p = msg().panels.permissions;
  const rules = runtime.permission.rules;
  const mode = session.state.permissionMode;
  const order =
    mode === "auto" ? p.orderAuto : mode === "allowlist" ? p.orderAllowlist : p.orderDefault;
  const lines = [
    m.permissionsMode(permissionModeLabel(mode), mode),
    m.permissionsOrder(order),
    rules.length === 0 ? m.rulesNone : m.rules(rules.length),
    ...rules.map((r) => `  ${r.effect === "deny" ? "deny " : "allow"}  ${r.raw}  [${r.source}]`),
  ];
  const recent = runtime.permission.autoDecisions?.() ?? [];
  if (recent.length > 0) {
    lines.push(m.recentAuto(recent.length));
    for (const d of recent) {
      const cached = d.cached === true ? p.cached : "";
      lines.push(
        `  ${autoLayerText(d.layer)}  ${d.decision}  ${d.toolName} ${d.summary} — ${d.reason}${cached}`,
      );
    }
  }
  return lines.join("\n");
}

async function pickTree(ui: CommandUi, title: string): Promise<SessionEntry | undefined> {
  const session = ui.session();
  const items = treeItems(session.entries, activeBranchIds(session), ui.now());
  if (items.length === 0) {
    ui.notice("info", msg().interactive.commands.noUserMessages);
    return undefined;
  }
  const active = [...items].reverse().find((i) => i.label.includes("● "));
  const picked = await ui.pick({
    title,
    items,
    filterable: true,
    ...(active !== undefined ? { selected: active.value } : {}),
  });
  return picked === undefined ? undefined : session.entries.find((e) => e.id === picked.value);
}

/** /tree：换叶子到选中用户消息之前，文本回填编辑器。 */
async function treeCommand(ui: CommandUi): Promise<void> {
  const session = ui.session();
  if (!(session instanceof AgentSessionImpl)) {
    ui.notice("warn", msg().interactive.commands.treeUnsupported);
    return;
  }
  if (session.state.isStreaming) {
    ui.notice("warn", msg().interactive.commands.treeBusy);
    return;
  }
  const entry = await pickTree(ui, msg().interactive.commands.treeTitle);
  if (entry === undefined) return;
  await session.navigate(entry.parentId);
  ui.reload();
  ui.setEditorText(userEntryText(entry) ?? "");
}

async function handlePick(
  what: Extract<CommandResult, { kind: "pick" }>["what"],
  ui: CommandUi,
): Promise<void> {
  const session = ui.session();
  const m = msg().interactive.commands;
  switch (what) {
    case "model": {
      const current = session.state.model;
      const ref = current === undefined ? undefined : `${current.provider}/${current.id}`;
      const providers =
        ui.env === undefined
          ? ui.runtime.providers
          : hideFakeProvider(ui.runtime.providers, ui.env);
      const picked =
        ui.pickModel !== undefined
          ? await ui.pickModel(providers, ref)
          : (
              await ui.pick({
                title: m.modelTitle,
                items: await modelItems(providers, {
                  current: ref,
                  enabled: ui.runtime.config.models?.enabled,
                  hints: false,
                }),
                filterable: true,
                showCount: true,
                ...(ref !== undefined ? { selected: ref, currentValue: ref } : {}),
              })
            )?.value;
      if (picked === undefined) return;
      await session.setModel(picked);
      ui.notice("info", m.modelSet(picked));
      return;
    }
    case "session": {
      const items = listSessions({
        sessionDir: ui.runtime.paths.sessionDir,
        cwd: session.state.cwd,
      });
      const others = items.filter((i) => i.id !== session.state.sessionId);
      if (others.length === 0) {
        ui.notice("info", m.noOtherSessions);
        return;
      }
      const picked = await ui.pick({
        title: m.resumeTitle,
        items: sessionItems(others, ui.now()),
        filterable: true,
      });
      if (picked === undefined) return;
      const next = await ui.switchSession({ kind: "resume", id: picked.value });
      ui.notice("info", m.resumed(next.state.sessionId.slice(0, 8)));
      return;
    }
    case "tree": {
      const entry = await pickTree(ui, m.forkTitle);
      if (entry === undefined) return;
      const next = await ui.switchSession(
        entry.parentId === null ? { kind: "new" } : { kind: "fork", entryId: entry.parentId },
      );
      ui.notice("info", m.forked(next.state.sessionId.slice(0, 8)));
      ui.setEditorText(userEntryText(entry) ?? "");
      return;
    }
    case "permission": {
      const picked = await ui.pick(
        permissionPickerSpec(
          session.state.permissionMode,
          ui.runtime.config.permission?.mode ?? "default",
        ),
      );
      if (picked === undefined) return;
      const mode = picked.value as PermissionMode;
      const current = session.state.permissionMode;
      if (mode !== current && ui.confirmMode !== undefined && !(await ui.confirmMode(mode))) {
        ui.notice("info", m.modeCancelled(permissionModeLabel(current)));
        return;
      }
      session.setPermissionMode(mode);
      ui.notice("info", m.modeSet(permissionModeLabel(mode)));
      return;
    }
    case "thinking": {
      const model = session.state.model;
      const found =
        model === undefined ? undefined : ui.runtime.providers.findModel(formatModelRef(model));
      const reasoning = found?.ok === true ? found.model.reasoning : true;
      const picked = await ui.pick({
        title: m.thinkingTitle,
        items: thinkingItems(reasoning),
        selected: session.state.thinkingLevel,
        currentValue: session.state.thinkingLevel,
        filterable: false,
        numberKeys: true,
        footer: m.numberFooter("↑↓", THINKING_LEVELS.length),
      });
      if (picked !== undefined) session.setThinkingLevel(picked.value as ModelThinkingLevel);
      return;
    }
  }
}

/** 返回 false：不是命令，调用方当作提示发出。 */
export async function runInteractiveCommand(line: string, ui: CommandUi): Promise<boolean> {
  const parsed = parseSlash(line);
  if (parsed === undefined) return false;
  try {
    if (ui.extra !== undefined && (await ui.extra(parsed.name, parsed.args))) return true;
    const panel = PANEL_COMMANDS[parsed.name];
    if (panel !== undefined && (await panel(ui, parsed.args))) return true;
    if (parsed.name === "tree") {
      await treeCommand(ui);
      return true;
    }
    if (parsed.name === "rewind" && parsed.args === "" && ui.rewind !== undefined) {
      await ui.rewind();
      return true;
    }
    const theme = ui.theme?.();
    if (parsed.name === "permissions") {
      if (ui.panel !== undefined && theme !== undefined) {
        ui.panel(permissionsPanel(ui.runtime, ui.session(), theme));
      } else ui.notice("info", permissionsText(ui.runtime, ui.session()));
      return true;
    }
    if (
      (parsed.name === "session" || parsed.name === "cache") &&
      parsed.args.trim() === "" &&
      ui.panel !== undefined &&
      theme !== undefined
    ) {
      const session = ui.session();
      ui.panel(
        parsed.name === "session"
          ? sessionPanel(session, theme, { now: ui.now(), ...homeOf(ui) })
          : cachePanel(session, theme, ui.now()),
      );
      return true;
    }
    const result = await runSlashCommand(line, {
      runtime: ui.runtime,
      session: () => ui.session(),
      switchSession: (request) => ui.switchSession(request),
      ...(ui.confirmMode !== undefined ? { confirmPermissionMode: ui.confirmMode } : {}),
    });
    if (result === undefined) return false;
    switch (result.kind) {
      case "exit":
        ui.exit(0);
        break;
      case "prompt":
        ui.prompt(result.text);
        break;
      case "pick":
        await handlePick(result.what, ui);
        break;
      case "handled":
        if (result.reload === true) ui.reload();
        if (parsed.name === "help") {
          const extra = INTERACTIVE_COMMANDS.map((c) => `/${c.name}  ${c.description}`);
          ui.notice("info", [result.message ?? "", ...extra, "", keyHints()].join("\n"));
        } else if (result.message !== undefined) ui.notice("info", result.message);
        if (result.draft !== undefined) {
          if (ui.setDraft !== undefined) ui.setDraft(result.draft);
          else ui.setEditorText(result.draft.text);
        }
        break;
    }
  } catch (error) {
    ui.notice("error", error instanceof Error ? error.message : String(error));
  }
  return true;
}
