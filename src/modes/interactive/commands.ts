/**
 * 交互模式的斜杠命令：把 commands-core 的 `CommandResult` 变成界面动作。[B7]
 *
 * - `handled` → 消息区显示文本；`prompt` → 发提示；`exit` → 退出；
 * - `pick` → 打开对应选择器：模型（setModel）、会话（resume）、树（/fork 无参数：从选中的用户消息
 *   之前分叉，消息文本回填编辑器）、权限模式、思考级别；
 * - 交互模式自有命令：`/tree`（同一文件内换叶子到选中消息之前，文本回填编辑器，可改后重发形成新分支）、
 *   `/permissions`（当前模式、判定顺序与已加载规则）；`/help` 追加这两条与按键说明。
 * - 不是命令（含模板与 `/skill:`）返回 false，调用方把整行当提示发出。
 */

import { formatModelRef } from "../../ai/providers/channels.js";
import { AgentSessionImpl } from "../../agent/session.js";
import type { AgentSession } from "../../agent/types.js";
import type { ModelThinkingLevel } from "../../ai/types.js";
import type { SwitchRequest } from "../../cli/compose-session.js";
import { listSessions } from "../../cli/compose-store.js";
import type { Runtime } from "../../cli/runtime.js";
import { AUTO_LAYER_TEXT, permissionModeLabel } from "../../permissions/modes.js";
import type { PermissionMode } from "../../permissions/types.js";
import type { SessionEntry } from "../../session/types.js";
import type { SelectItem } from "../../tui.js";
import {
  BUILTIN_COMMANDS,
  parseSlash,
  runSlashCommand,
  type CommandInfo,
  type CommandResult,
} from "../commands-core.js";
import { contentText, type NoticeLevel } from "./message-view.js";
import {
  modelItems,
  permissionPickerSpec,
  sessionItems,
  thinkingItems,
  treeItems,
  type PickerSpec,
} from "./pickers.js";

export const INTERACTIVE_COMMANDS: readonly CommandInfo[] = [
  { name: "tree", description: "浏览会话树，回到某条消息之前重写" },
  { name: "permissions", description: "权限模式、判定顺序与规则" },
];

/** 补全与 /help 用的完整命令表。 */
export const ALL_COMMANDS: readonly CommandInfo[] = [...BUILTIN_COMMANDS, ...INTERACTIVE_COMMANDS];

export const KEY_HINTS = [
  "Enter 发送（运行中 = steer）  Alt+Enter 排到本轮之后  Shift+Enter / Ctrl+J 换行",
  "Esc 中断（排队消息回填编辑器）  Alt+↑ 取回最后一条排队消息",
  "Shift+Tab 切换权限模式  Ctrl+L 模型  Ctrl+T 思考级别  Ctrl+O 展开工具输出",
  "Ctrl+C 清空输入（再按退出）  Ctrl+D 空输入时退出  Tab 补全  @ 引用文件",
].join("\n");

export interface CommandUi {
  readonly runtime: Runtime;
  session(): AgentSession;
  /** 切换会话（调用方负责重新订阅、重画消息区、announceStart）。 */
  switchSession(request: SwitchRequest): Promise<AgentSession>;
  pick(spec: PickerSpec): Promise<SelectItem | undefined>;
  notice(level: NoticeLevel, text: string): void;
  setEditorText(text: string): void;
  /** 发一条提示（不等运行结束）。 */
  prompt(text: string): void;
  /** /tree 换叶子后重画消息区。 */
  reload(): void;
  exit(code: number): void;
  now(): number;
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
  const rules = runtime.permission.rules;
  const mode = session.state.permissionMode;
  const order =
    mode === "auto"
      ? "deny 规则 → Hook deny → 危险命令确认 → 规则层（受保护路径、项目外写入、网络、删除类）→ Hook ask → allow 规则 / Hook allow / 本会话记忆 → 静态判定（只读、项目内写入、安全名单）→ 模型分类器 → 询问"
      : mode === "allowlist"
        ? "deny 规则 → Hook deny → 危险命令（拒绝）→ 只读工具 / allow 规则 / Hook allow 放行 → 其余拒绝（从不询问）"
        : "deny 规则 → Hook deny → 危险命令确认 → 权限模式 → allow 规则 / Hook allow / 本会话记忆 → 询问";
  const lines = [
    `权限模式：${permissionModeLabel(mode)}（${mode}）`,
    `判定顺序：${order}`,
    rules.length === 0 ? "规则：（无）" : `规则（${rules.length}）：`,
    ...rules.map((r) => `  ${r.effect === "deny" ? "deny " : "allow"}  ${r.raw}  [${r.source}]`),
  ];
  const recent = runtime.permission.autoDecisions?.() ?? [];
  if (recent.length > 0) {
    lines.push(`最近的 auto 判定（${recent.length}）：`);
    for (const d of recent) {
      const cached = d.cached === true ? "（缓存）" : "";
      lines.push(
        `  ${AUTO_LAYER_TEXT[d.layer]}  ${d.decision}  ${d.toolName} ${d.summary} — ${d.reason}${cached}`,
      );
    }
  }
  return lines.join("\n");
}

async function pickTree(ui: CommandUi, title: string): Promise<SessionEntry | undefined> {
  const session = ui.session();
  const items = treeItems(session.entries, activeBranchIds(session), ui.now());
  if (items.length === 0) {
    ui.notice("info", "还没有用户消息");
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
    ui.notice("warn", "当前会话不支持 /tree");
    return;
  }
  if (session.state.isStreaming) {
    ui.notice("warn", "运行中不能切换分支（先 Esc 中断）");
    return;
  }
  const entry = await pickTree(ui, "会话树");
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
  switch (what) {
    case "model": {
      const current = session.state.model;
      const picked = await ui.pick({
        title: "选择模型",
        items: await modelItems(ui.runtime.providers),
        filterable: true,
        ...(current !== undefined ? { selected: `${current.provider}/${current.id}` } : {}),
      });
      if (picked === undefined) return;
      await session.setModel(picked.value);
      ui.notice("info", `模型：${picked.value}`);
      return;
    }
    case "session": {
      const items = listSessions({
        sessionDir: ui.runtime.paths.sessionDir,
        cwd: session.state.cwd,
      });
      const others = items.filter((i) => i.id !== session.state.sessionId);
      if (others.length === 0) {
        ui.notice("info", "本目录没有其它会话");
        return;
      }
      const picked = await ui.pick({
        title: "恢复会话",
        items: sessionItems(others, ui.now()),
        filterable: true,
      });
      if (picked === undefined) return;
      const next = await ui.switchSession({ kind: "resume", id: picked.value });
      ui.notice("info", `已恢复会话 ${next.state.sessionId.slice(0, 8)}`);
      return;
    }
    case "tree": {
      const entry = await pickTree(ui, "从哪条消息之前分叉");
      if (entry === undefined) return;
      const next = await ui.switchSession(
        entry.parentId === null ? { kind: "new" } : { kind: "fork", entryId: entry.parentId },
      );
      ui.notice("info", `已分叉到新会话 ${next.state.sessionId.slice(0, 8)}`);
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
      session.setPermissionMode(mode);
      ui.notice("info", `权限模式：${permissionModeLabel(mode)}`);
      return;
    }
    case "thinking": {
      const model = session.state.model;
      const found =
        model === undefined ? undefined : ui.runtime.providers.findModel(formatModelRef(model));
      const reasoning = found?.ok === true ? found.model.reasoning : true;
      const picked = await ui.pick({
        title: "思考级别",
        items: thinkingItems(reasoning),
        selected: session.state.thinkingLevel,
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
    if (parsed.name === "tree") {
      await treeCommand(ui);
      return true;
    }
    if (parsed.name === "permissions") {
      ui.notice("info", permissionsText(ui.runtime, ui.session()));
      return true;
    }
    const result = await runSlashCommand(line, {
      runtime: ui.runtime,
      session: () => ui.session(),
      switchSession: (request) => ui.switchSession(request),
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
        if (parsed.name === "help") {
          const extra = INTERACTIVE_COMMANDS.map((c) => `/${c.name}  ${c.description}`);
          ui.notice("info", [result.message ?? "", ...extra, "", KEY_HINTS].join("\n"));
        } else if (result.message !== undefined) ui.notice("info", result.message);
        break;
    }
  } catch (error) {
    ui.notice("error", error instanceof Error ? error.message : String(error));
  }
  return true;
}
