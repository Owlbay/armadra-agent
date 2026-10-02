/**
 * `/config` settings panel component (docs/wave6-plan.md §6.3, D24-D26). [W6-S]
 *
 * Bottom overlay with the card bar: title + write target (`Tab` switches user / project), a search line,
 * the grouped `SettingsList`, a rule, the selected key's description (key-docs, dim, wrapped), one notice
 * line and the key hints. What a key press *does* to a setting is the controller's job (config-ui.ts):
 * the panel calls `activate(key)` for Enter / Space, `unset(key)` for a confirmed Backspace / Delete,
 * `commit(key, text)` for the inline number / text editor, `switchScope()` for Tab and `close()` for Esc.
 *
 * Keys: ↑↓ (and Ctrl+P / Ctrl+N) move; `/` starts a search (typing filters, Esc clears it first, a
 * second Esc closes); Backspace / Delete asks once, then unsets; inside the editor Enter saves (an
 * invalid value stays in the box with the error in red), Esc cancels.
 */

import {
  Card,
  SettingsList,
  defaultKeybindings,
  isPasteData,
  isPrintableText,
  matchesKey,
  truncateToWidth,
  unwrapPaste,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type Keybindings,
  type SemanticColor,
  type SettingsRow,
  type Theme,
} from "../../tui.js";
import { msg } from "../../i18n/index.js";
import {
  formatSettingValue,
  getConfigValue,
  overriddenFor,
  type ConfigSnapshot,
  type EditScope,
  type SettingValue,
} from "../../config/edit.js";
import {
  SETTING_HINTS,
  settingDoc,
  settingDynamicDefault,
  settingsRegistry,
  type SettingSpec,
} from "../../config/settings-registry.js";

export interface ConfigPanelDeps {
  theme: Theme;
  keybindings?: Keybindings;
  /** Terminal rows (the panel fits in `rows - 1`). */
  rows?(): number;
  /** Write target paths for the title (already shortened with ~). */
  paths: Readonly<Record<EditScope, string>>;
  /** Embedded host (profile): the title says changes go to the user config. */
  embedded?: boolean;
  activate(key: string, scope: EditScope): void | Promise<void>;
  unset(key: string, scope: EditScope): void | Promise<void>;
  /** Inline editor: returns an error message to keep the box open. */
  commit(key: string, text: string, scope: EditScope): Promise<string | undefined>;
  close(): void;
  requestRender(): void;
}

const ELSEWHERE = "elsewhere:";

/** Display text of a setting value (unset ASCII shows the detected value). */
export function settingValueText(spec: SettingSpec, value: SettingValue, theme: Theme): string {
  if (value.value === undefined && spec.key === "ui.ascii")
    return msg().settings.auto(String(theme.glyphs.ascii));
  return formatSettingValue(value.value);
}

function lockReason(value: SettingValue): string {
  const reasons = msg().settings.lockReason;
  if (value.source === "env") return reasons.env(value.envName ?? "");
  if (value.source === "cli") return reasons.cli;
  if (value.source === "profile") return reasons.profile;
  return reasons.project;
}

/** Why the row cannot be changed in `scope` (undefined: editable). */
export function blockedReason(
  spec: SettingSpec,
  value: SettingValue,
  scope: EditScope,
): string | undefined {
  const s = msg().settings;
  if (overriddenFor(value, scope) !== undefined)
    return s.errors.locked(
      s.labels[spec.key as keyof typeof s.labels] ?? spec.key,
      lockReason(value),
    );
  if (scope === "project" && spec.project === "deny") return s.errors.projectDenied(spec.key);
  return undefined;
}

/** Panel rows for a snapshot (pure; frame tests use it directly). */
export function settingRows(
  snapshot: ConfigSnapshot,
  scope: EditScope,
  theme: Theme,
): SettingsRow[] {
  const s = msg().settings;
  const labels = s.labels as Readonly<Record<string, string>>;
  const rows: SettingsRow[] = settingsRegistry().map((spec) => {
    const value = getConfigValue(snapshot, spec.key);
    const locked = overriddenFor(value, scope) !== undefined;
    const tag =
      spec.prefix === true ? `${s.apply[spec.apply]} · ${s.prefixTag}` : s.apply[spec.apply];
    let note: string | undefined;
    let noteColor: SemanticColor | undefined;
    if (locked) {
      note = s.locked(value.envName ?? value.source);
      noteColor = "warning";
    } else if (scope === "project" && spec.project !== "any") note = s.projectNote[spec.project];
    else if (value.source !== "default") note = s.source(value.source);
    const row: SettingsRow = {
      id: spec.key,
      group: s.groups[spec.group],
      label: labels[spec.key] ?? spec.key,
      value: settingValueText(spec, value, theme),
      tag,
      search: [...(spec.options ?? []), settingDoc(spec.key) ?? ""].join(" "),
    };
    if (value.value === undefined) row.valueColor = "dim";
    if (note !== undefined) row.note = note;
    if (noteColor !== undefined) row.noteColor = noteColor;
    if (scope === "project" && spec.project === "deny") row.dim = true;
    return row;
  });
  for (const hint of SETTING_HINTS) {
    rows.push({
      id: `${ELSEWHERE}${hint.key}`,
      group: s.groups.elsewhere,
      label: hint.key,
      value: s.hints[hint.hint],
      dim: true,
    });
  }
  return rows;
}

/** Hint text for an "edited elsewhere" row id (undefined for settings). */
export function hintOf(id: string): string | undefined {
  if (!id.startsWith(ELSEWHERE)) return undefined;
  const key = id.slice(ELSEWHERE.length);
  const hint = SETTING_HINTS.find((h) => h.key === key);
  return hint === undefined ? undefined : msg().settings.hints[hint.hint];
}

class Lines implements Component {
  constructor(private readonly build: (width: number) => string[]) {}
  render(width: number): string[] {
    return this.build(width);
  }
  invalidate(): void {}
}

/** Fixed lines besides the list: title (+ embedded), search, rule, description (≤ 3), notice, footer. */
const CHROME = 8;

export class ConfigPanel implements Component, Focusable {
  focused = false;
  scope: EditScope = "user";
  private readonly list: SettingsList;
  private searching = false;
  private edit: { key: string; text: string; error?: string } | undefined;
  private pendingUnset: string | undefined;
  private notice: { text: string; color: SemanticColor } | undefined;
  private busy = false;

  constructor(
    private snapshot: ConfigSnapshot,
    private readonly deps: ConfigPanelDeps,
  ) {
    this.list = new SettingsList({ theme: deps.theme, emptyText: msg().settings.noMatches });
    this.refresh(snapshot);
  }

  /** Selected row id (tests). */
  get selectedKey(): string | undefined {
    return this.list.selectedRow?.id;
  }

  get editing(): boolean {
    return this.edit !== undefined;
  }

  refresh(snapshot: ConfigSnapshot = this.snapshot): void {
    this.snapshot = snapshot;
    this.list.setRows(settingRows(snapshot, this.scope, this.deps.theme));
  }

  select(key: string): void {
    this.list.selectId(key);
  }

  setNotice(text: string | undefined, color: SemanticColor = "dim"): void {
    this.notice = text === undefined ? undefined : { text, color };
  }

  /** Open the inline editor for a number / text key. */
  startEdit(key: string, initial: string): void {
    this.edit = { key, text: initial };
  }

  handleInput(data: string): void {
    if (this.busy) return;
    const keys = this.deps.keybindings ?? defaultKeybindings;
    if (this.edit !== undefined) return this.editInput(data);
    const row = this.list.selectedRow;
    const unsetKey = matchesKey(data, "backspace") || matchesKey(data, "delete");
    if (!unsetKey || this.searching) this.pendingUnset = undefined;
    if (keys.matches(data, "tui.select.up")) return this.move(-1);
    if (keys.matches(data, "tui.select.down")) return this.move(1);
    if (matchesKey(data, "escape") || keys.matches(data, "app.clear")) {
      if (this.searching || this.list.query !== "") {
        this.searching = false;
        this.list.setQuery("");
        return;
      }
      return this.deps.close();
    }
    if (matchesKey(data, "tab")) {
      this.scope = this.scope === "user" ? "project" : "user";
      this.notice = undefined;
      this.refresh();
      return;
    }
    if (this.searching) {
      if (matchesKey(data, "enter") && row !== undefined)
        return this.run(this.deps.activate(row.id, this.scope));
      if (matchesKey(data, "backspace"))
        return this.list.setQuery([...this.list.query].slice(0, -1).join(""));
      const text = isPasteData(data) ? unwrapPaste(data) : isPrintableText(data) ? data : "";
      if (text !== "") this.list.setQuery(this.list.query + text.replace(/\s+/g, " "));
      return;
    }
    if (data === "/") {
      this.searching = true;
      return;
    }
    if (row === undefined) return;
    if (matchesKey(data, "enter") || matchesKey(data, "space")) {
      this.notice = undefined;
      const hint = hintOf(row.id);
      if (hint !== undefined) return this.setNotice(hint);
      return this.run(this.deps.activate(row.id, this.scope));
    }
    if (unsetKey && hintOf(row.id) === undefined) {
      if (this.pendingUnset === row.id) {
        this.pendingUnset = undefined;
        return this.run(this.deps.unset(row.id, this.scope));
      }
      this.pendingUnset = row.id;
      this.setNotice(msg().settings.confirmUnset(row.id), "warning");
    }
  }

  private move(delta: number): void {
    this.list.move(delta);
    this.pendingUnset = undefined;
    if (!this.searching) this.notice = undefined;
  }

  /** Run a controller action; input is ignored until it settles. */
  private run(result: void | Promise<void>): void {
    if (!(result instanceof Promise)) return;
    this.busy = true;
    void result.finally(() => {
      this.busy = false;
      this.deps.requestRender();
    });
  }

  private editInput(data: string): void {
    const edit = this.edit!;
    if (
      matchesKey(data, "escape") ||
      (this.deps.keybindings ?? defaultKeybindings).matches(data, "app.clear")
    ) {
      this.edit = undefined;
      return;
    }
    if (matchesKey(data, "enter")) {
      this.busy = true;
      void this.deps
        .commit(edit.key, edit.text, this.scope)
        .then((error) => {
          if (error === undefined) this.edit = undefined;
          else edit.error = error;
        })
        .finally(() => {
          this.busy = false;
          this.deps.requestRender();
        });
      return;
    }
    if (matchesKey(data, "backspace")) edit.text = [...edit.text].slice(0, -1).join("");
    else if (isPasteData(data)) edit.text += unwrapPaste(data).replace(/\s+/g, " ");
    else if (isPrintableText(data)) edit.text += data;
    else return;
    delete edit.error;
  }

  render(width: number): string[] {
    const { theme } = this.deps;
    const s = msg().settings;
    const rows = this.deps.rows?.();
    const embedded = this.deps.embedded === true ? 1 : 0;
    if (rows !== undefined) this.list.maxVisible = rows - 1 - CHROME - embedded;
    const subtitle = `${s.writeTo(s.scope[this.scope], this.deps.paths[this.scope])}  ${s.tabSwitch}`;
    const card = new Card(new Lines((w) => this.body(w)), { theme, title: s.title, subtitle });
    return card.render(width);
  }

  private body(width: number): string[] {
    const { theme } = this.deps;
    const s = msg().settings;
    const out: string[] = [];
    if (this.deps.embedded === true) out.push(theme.fg("warning", s.embedded));
    const query = this.list.query;
    out.push(
      this.searching || query !== ""
        ? `${s.searchPrompt(query)}${this.searching && this.edit === undefined ? theme.fg("accent", "_") : ""}`
        : theme.fg("dim", s.searchPlaceholder),
    );
    out.push(...this.list.render(width));
    out.push(theme.fg("border", theme.glyphs.rule.repeat(Math.max(1, width))));
    out.push(...this.description(width));
    if (this.edit !== undefined) {
      const label = (s.labels as Readonly<Record<string, string>>)[this.edit.key] ?? this.edit.key;
      const box = `${s.editPrompt(label)}${this.edit.text}${theme.fg("accent", "_")}`;
      out.push(truncateToWidth(box, width));
      if (this.edit.error !== undefined)
        out.push(theme.fg("error", truncateToWidth(this.edit.error, width)));
    } else if (this.notice !== undefined) {
      out.push(
        ...wrapTextWithAnsi(theme.fg(this.notice.color, this.notice.text), width).slice(0, 2),
      );
    }
    const footer =
      this.edit !== undefined
        ? s.footerEdit
        : this.searching
          ? s.footerSearch
          : width < 72
            ? s.footerCompact
            : s.footer;
    out.push(theme.fg("dim", truncateToWidth(footer, width)));
    return out;
  }

  private description(width: number): string[] {
    const { theme } = this.deps;
    const row = this.list.selectedRow;
    if (row === undefined || hintOf(row.id) !== undefined) return [];
    const doc = settingDoc(row.id) ?? "";
    const value = getConfigValue(this.snapshot, row.id);
    const dynamic = value.value === undefined ? settingDynamicDefault(row.id) : undefined;
    const text = dynamic === undefined ? doc : `${doc} · ${dynamic}`;
    const spec = settingsRegistry().find((x) => x.key === row.id);
    const blocked = spec === undefined ? undefined : blockedReason(spec, value, this.scope);
    const lines =
      blocked === undefined ? [] : [theme.fg("warning", truncateToWidth(blocked, width))];
    if (text !== "") lines.push(...wrapTextWithAnsi(theme.fg("dim", text), width));
    return lines.slice(0, 3);
  }

  invalidate(): void {}
}
