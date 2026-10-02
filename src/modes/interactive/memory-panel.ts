/**
 * `/memory`（docs/wave6-plan.md §3.5）。[W6-M]
 *
 * | 输入                         | 交互界面                                   | 行式界面                       |
 * | ---------------------------- | ------------------------------------------ | ------------------------------ |
 * | `/memory`                    | 消息区面板：各作用域条目（> 90 天标灰）     | 文本列表                       |
 * | `/memory show <名字>`        | 面板显示正文                               | 打印正文                       |
 * | `/memory edit [名字\|作用域]`| `$EDITOR` 编辑副本，存回时检查凭据与上限   | 提示用 `ama memory edit`       |
 * | `/memory rm <名字>`          | 确认框后删除                               | 需 `--yes`                     |
 * | `/memory on\|off`            | 本会话允许 / 禁止写                        | 同左                           |
 * | `/memory reload`             | 重渲染 memory 节（提示断一次缓存）         | 同左                           |
 *
 * 会话未开启记忆时一律提示如何开启。写入后的索引在下次会话（或 reload）才进系统提示。
 */

import { formatBytes } from "../../checkpoints/gc.js";
import { memoryOf, reloadMemorySection } from "../../cli/compose-memory.js";
import { msg } from "../../i18n/index.js";
import { editMemory, type EditText } from "../../memory/edit.js";
import { logicalPath } from "../../memory/paths.js";
import {
  findOne,
  isStale,
  listText,
  memoryErrorText,
  runtimeNotes,
  scopeLabel,
  scopeSummaries,
} from "../../memory/report.js";
import type { MemoryRuntime } from "../../memory/runtime.js";
import { Card, wrapTextWithAnsi, type Component, type Theme } from "../../tui.js";
import type { CommandContext, CommandResult } from "../commands-core.js";
import type { CommandUi } from "./commands.js";
import { openChoice, type ChoiceHost } from "./confirm-dialog.js";
import { editExternally } from "./external-editor.js";

export type MemoryAction =
  | { kind: "list" }
  | { kind: "show"; name: string }
  | { kind: "edit"; target?: string }
  | { kind: "rm"; name: string; yes: boolean }
  | { kind: "writes"; on: boolean }
  | { kind: "reload" }
  | { kind: "usage" };

export function parseMemoryArgs(args: string): MemoryAction {
  const words = args
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  const [sub, ...rest] = words;
  const yes = rest.includes("--yes");
  const name = rest.filter((w) => w !== "--yes").join(" ");
  switch (sub) {
    case undefined:
    case "list":
      return { kind: "list" };
    case "show":
      return name === "" ? { kind: "usage" } : { kind: "show", name };
    case "edit":
      return name === "" ? { kind: "edit" } : { kind: "edit", target: name };
    case "rm":
      return name === "" ? { kind: "usage" } : { kind: "rm", name, yes };
    case "on":
    case "off":
      return rest.length === 0 ? { kind: "writes", on: sub === "on" } : { kind: "usage" };
    case "reload":
      return rest.length === 0 ? { kind: "reload" } : { kind: "usage" };
    default:
      return { kind: "usage" };
  }
}

/** 不需要界面能力的动作（两种界面共用）；需要编辑器 / 确认框的返回 undefined。 */
function simpleAction(
  runtime: MemoryRuntime,
  session: Parameters<typeof reloadMemorySection>[0],
  action: MemoryAction,
): string | undefined {
  const m = msg().memory.command;
  switch (action.kind) {
    case "usage":
      return m.usage;
    case "writes":
      runtime.writesEnabled = action.on;
      return action.on ? m.writesOn : m.writesOff;
    case "reload":
      return reloadMemorySection(session)?.changed === true ? m.reloaded : m.reloadUnchanged;
    case "show": {
      const found = findOne(runtime.store, action.name);
      if (!found.ok) return found.message;
      const text = runtime.store.readRaw(found.entry) ?? "";
      return `${logicalPath(found.entry.scope, found.entry.file)}\n${text.trimEnd()}`;
    }
    default:
      return undefined;
  }
}

/** 行式界面（`CommandContext.extra.memory`）。 */
export async function memoryLineCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const m = msg().memory;
  const session = ctx.session();
  const runtime = memoryOf(session);
  if (runtime === undefined) return { kind: "handled", message: m.panel.disabled };
  const action = parseMemoryArgs(args);
  const simple = simpleAction(runtime, session, action);
  if (simple !== undefined) return { kind: "handled", message: simple };
  if (action.kind === "list")
    return { kind: "handled", message: listText(runtime.store, { notes: runtimeNotes(runtime) }) };
  if (action.kind === "edit") return { kind: "handled", message: m.command.lineNoEditor };
  if (action.kind !== "rm") return { kind: "handled", message: m.command.usage };
  const found = findOne(runtime.store, action.name);
  if (!found.ok) return { kind: "handled", message: found.message };
  if (!action.yes) return { kind: "handled", message: m.command.lineNeedsYes(action.name) };
  try {
    return {
      kind: "handled",
      message: m.command.deleted((await runtime.store.remove(found.entry)).path),
    };
  } catch (error) {
    return { kind: "handled", message: memoryErrorText(error) };
  }
}

/** 按行折行的简单正文组件。 */
class Lines implements Component {
  constructor(private readonly lines: readonly string[]) {}
  render(width: number): string[] {
    return this.lines.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width)));
  }
  invalidate(): void {}
}

/** `/memory` 面板：每个作用域一段，条目一行（名字、说明、更新日期；> 90 天标灰）。 */
export function memoryListPanel(runtime: MemoryRuntime, theme: Theme, now: number): Component {
  const m = msg().memory.panel;
  const store = runtime.store;
  const lines: string[] = [];
  for (const s of scopeSummaries(store)) {
    if (lines.length > 0) lines.push("");
    lines.push(
      theme.bold(
        m.scopeLine(
          `${scopeLabel(s.scope)} ${logicalPath(s.scope)}/`,
          s.entries.length,
          formatBytes(s.indexBytes),
          formatBytes(store.limits.indexMaxBytes),
        ),
      ),
    );
    if (s.entries.length === 0) lines.push(theme.fg("dim", `  ${m.noEntries}`));
    for (const e of s.entries) {
      const description = e.description === "" ? "" : ` — ${e.description}`;
      const text = `  ${e.name}${description}  ${m.entryUpdated(e.updated)}`;
      lines.push(isStale(e, now) ? theme.fg("dim", text) : text);
    }
    if (s.omitted > 0) lines.push(theme.fg("warning", `  ${m.truncated(s.omitted)}`));
  }
  for (const note of runtimeNotes(runtime)) lines.push("", theme.fg("warning", note));
  return new Card(new Lines(lines), { theme, title: m.title, subtitle: m.hint });
}

export interface MemoryPanelDeps {
  ui(): CommandUi;
  /** 删除前的确认框。 */
  choice: ChoiceHost;
  /** 编辑器期间挂起 / 恢复界面。 */
  suspend(): void;
  resume(): void;
  env: Readonly<Record<string, string | undefined>>;
  /** 测试注入：代替真实编辑器。 */
  edit?: EditText;
}

/** 交互界面的 `CommandUi.memoryPanel`。 */
export function createMemoryPanel(deps: MemoryPanelDeps): (args: string) => Promise<void> {
  const edit: EditText =
    deps.edit ??
    ((text, name) =>
      editExternally(text, name, {
        env: deps.env,
        suspend: () => deps.suspend(),
        resume: () => deps.resume(),
      }));
  return async (args) => {
    const ui = deps.ui();
    const m = msg().memory;
    const session = ui.session();
    const runtime = memoryOf(session);
    if (runtime === undefined) return ui.notice("info", m.panel.disabled);
    const action = parseMemoryArgs(args);
    const theme = ui.theme?.();
    if (action.kind === "list") {
      if (ui.panel !== undefined && theme !== undefined)
        return ui.panel(memoryListPanel(runtime, theme, ui.now()));
      return ui.notice("info", listText(runtime.store, { notes: runtimeNotes(runtime) }));
    }
    if (action.kind === "show" && ui.panel !== undefined && theme !== undefined) {
      const found = findOne(runtime.store, action.name);
      if (!found.ok) return ui.notice("warn", found.message);
      const body = (runtime.store.readRaw(found.entry) ?? "").trimEnd().split("\n");
      const title = logicalPath(found.entry.scope, found.entry.file);
      return ui.panel(new Card(new Lines(body), { theme, title }));
    }
    const simple = simpleAction(runtime, session, action);
    if (simple !== undefined) return ui.notice("info", simple);
    try {
      if (action.kind === "edit") {
        const outcome = await editMemory(runtime.store, action.target, edit);
        if (outcome.status === "saved") return ui.notice("info", m.command.saved(outcome.path));
        if (outcome.status === "not_found") return ui.notice("warn", outcome.message);
        return ui.notice(
          "info",
          outcome.status === "cancelled" ? m.command.editCancelled : m.command.unchanged,
        );
      }
      if (action.kind !== "rm") return ui.notice("info", m.command.usage);
      const found = findOne(runtime.store, action.name);
      if (!found.ok) return ui.notice("warn", found.message);
      const path = logicalPath(found.entry.scope, found.entry.file);
      const choice = action.yes
        ? 0
        : await openChoice(deps.choice, {
            title: m.command.confirmTitle,
            body: [path],
            options: [
              { label: m.command.confirmDelete, keys: "y" },
              { label: m.command.confirmCancel, keys: "n Esc" },
            ],
            selected: 1,
            borderColor: "warning",
          });
      if (choice !== 0) return;
      await runtime.store.remove(found.entry);
      ui.notice("info", m.command.deleted(path));
    } catch (error) {
      ui.notice("error", memoryErrorText(error));
    }
  };
}

/** interactive-mode.ts 的一行装配（编辑器期间停掉 TUI，回来整屏重画）。 */
export function memoryPanelFor(
  ui: () => CommandUi,
  choice: ChoiceHost,
  tui: { stop(): void; start(): void; forceFullRedraw(): void },
  env: Readonly<Record<string, string | undefined>>,
): (args: string) => Promise<void> {
  return createMemoryPanel({
    ui,
    choice,
    env,
    suspend: () => tui.stop(),
    resume: () => {
      tui.start();
      tui.forceFullRedraw();
    },
  });
}
