/**
 * `/config` controller (docs/wave6-plan.md §6.3, D24-D26). [W6-S]
 *
 * - `open("")` shows the panel (config-panel.ts); `open("key=value")` / `open("key value")` sets one key
 *   in the user config without the panel (same path as `ama config set`).
 * - Every change is written at once (config/edit.ts) and then applied: keys of the "now" tier go to the
 *   running session / view (`applySetting`), and `runtime.replaceConfig()` hands the re-merged config to
 *   `/new`. `defaultModel`, `thinkingLevel` and `permission.mode` also switch the current session.
 * - `permission.mode: full-auto` in the user config always asks the Bypass confirmation first.
 * - The first change of a cache-prefix key in a conversation that already has replies shows a notice once
 *   per panel; closing the panel posts one summary (`from → to (scope)`, plus restart / new-session lists).
 * - `configCommand()` is the line mode `/config` (`CommandContext.extra.config`).
 */

import { AgentSessionImpl } from "../../agent/session.js";
import type { AgentSession } from "../../agent/types.js";
import type { WarmingMode } from "../../ai/cache/types.js";
import type { ModelThinkingLevel } from "../../ai/types.js";
import { currentSession } from "../../cli/compose-session.js";
import type { ModeContext } from "../../cli/deps.js";
import { hideFakeProvider } from "../../cli/fake-visibility.js";
import type { Runtime } from "../../cli/runtime.js";
import { tildePath } from "../../cli/startup-screen.js";
import {
  ConfigEditError,
  formatSettingValue,
  getConfigValue,
  parseValue,
  readSnapshot,
  setConfigValue,
  type ConfigLayerInput,
  type EditResult,
  type EditScope,
} from "../../config/edit.js";
import type { CliConfigOverrides } from "../../config/merge.js";
import { loadProfile } from "../../config/profile.js";
import { settingSpec, settingsRegistry, type SettingSpec } from "../../config/settings-registry.js";
import type { StatusLineMode } from "../../config/types.js";
import { msg } from "../../i18n/index.js";
import type { PermissionMode } from "../../permissions/types.js";
import type { OverlayHandle, SelectItem } from "../../tui.js";
import type { CommandContext, CommandResult } from "../commands-core.js";
import { ConfigPanel, blockedReason } from "./config-panel.js";
import { bypassChoiceSpec, openChoice } from "./confirm-dialog.js";
import type { NoticeLevel, ThinkingDisplay } from "./message-view.js";
import {
  modelItems,
  openPicker,
  permissionItems,
  thinkingItems,
  type PickerHost,
} from "./pickers.js";

/** Where "now" settings land in the running UI (every target optional). */
export interface ConfigApplyTargets {
  session(): AgentSession;
  view?: {
    setOptions(options: {
      showThinking?: ThinkingDisplay;
      markdown?: boolean;
      compact?: boolean;
    }): void;
  };
  loader?: { setAnimation(on: boolean): void };
  area?: { setLayout(mode: StatusLineMode): void };
  redraw?(): void;
}

/** Apply one "now" key to the running session / view; returns false when nothing applies. */
export async function applySetting(
  key: string,
  value: unknown,
  targets: ConfigApplyTargets,
): Promise<boolean> {
  const session = targets.session();
  const impl = session instanceof AgentSessionImpl ? session : undefined;
  switch (key) {
    case "ui.markdown":
      targets.view?.setOptions({ markdown: value !== false });
      break;
    case "ui.showThinking":
      targets.view?.setOptions({ showThinking: (value ?? "collapsed") as ThinkingDisplay });
      break;
    case "ui.compact":
      targets.view?.setOptions({ compact: value === true });
      break;
    case "ui.animation":
      targets.loader?.setAnimation(value !== false);
      break;
    case "ui.statusLine":
      targets.area?.setLayout((value ?? "full") as StatusLineMode);
      break;
    case "thinkingLevel":
      session.setThinkingLevel((value ?? "medium") as ModelThinkingLevel);
      return true;
    case "permission.mode":
      session.setPermissionMode((value ?? "default") as PermissionMode);
      return true;
    case "defaultModel":
      if (typeof value !== "string") return false;
      await session.setModel(value);
      return true;
    case "compaction.enabled":
      impl?.setAutoCompaction(value !== false);
      return impl !== undefined;
    case "retry.enabled":
      impl?.setAutoRetry(value !== false);
      return impl !== undefined;
    case "cache.warming":
      if (typeof value === "string") impl?.cache.setWarming(value as WarmingMode);
      return impl !== undefined;
    default:
      return false;
  }
  targets.redraw?.();
  return true;
}

/** Layer inputs of this process: user / project files, the profile and the command line flags. */
export function layerInputFor(runtime: Runtime, context: ModeContext): ConfigLayerInput {
  const { args, io } = context;
  const cli: CliConfigOverrides = {};
  if (args.thinking !== undefined) cli.thinkingLevel = args.thinking;
  if (args.permissionMode !== undefined) cli.permissionMode = args.permissionMode;
  if (args.allow.length > 0) cli.allow = args.allow;
  if (args.deny.length > 0) cli.deny = args.deny;
  if (args.quietStartup !== undefined) cli.quietStartup = args.quietStartup;
  if (args.tuiMode !== undefined) cli.tuiMode = args.tuiMode;
  if (args.toolsPreset !== undefined) cli.toolsPreset = args.toolsPreset;
  if (args.codemode !== undefined) cli.codemode = args.codemode;
  if (args.memory !== undefined) cli.memory = args.memory;
  const input: ConfigLayerInput = {
    configDir: runtime.paths.configDir,
    cwd: runtime.paths.cwd,
    env: io.env,
    cli,
  };
  if (args.profile !== undefined) {
    input.profile = { config: loadProfile(args.profile, io.cwd).config };
    input.hasProfile = true;
  }
  return input;
}

/** `key=value` / `key value` → [key, raw]. */
export function splitAssignment(args: string): [string, string] | undefined {
  const text = args.trim();
  const eq = text.indexOf("=");
  const space = text.search(/\s/);
  const at = eq !== -1 && (space === -1 || eq < space) ? eq : space;
  if (at <= 0) return undefined;
  return [text.slice(0, at).trim(), text.slice(at + 1).trim()];
}

const PROJECT_FILE = ".ama/config.json";

const labelOf = (key: string): string =>
  (msg().settings.labels as Readonly<Record<string, string>>)[key] ?? key;

const hasReplies = (session: AgentSession): boolean =>
  session.messages.some((m) => m.role === "assistant");

interface Change {
  key: string;
  from: string;
  to: string;
  scope: EditScope;
  spec: SettingSpec | undefined;
}

export interface ConfigUiDeps extends PickerHost, ConfigApplyTargets {
  runtime: Runtime;
  context: ModeContext;
  rows(): number;
  notice(level: NoticeLevel, text: string): void;
  render(): void;
  /** Home directory for ~ in paths. */
  home?: string;
}

export class ConfigUi {
  private panel: ConfigPanel | undefined;
  private handle: OverlayHandle | undefined;
  private changes = new Map<string, Change>();
  private prefixNoticeShown = false;

  constructor(private readonly deps: ConfigUiDeps) {}

  private input(): ConfigLayerInput {
    return layerInputFor(this.deps.runtime, this.deps.context);
  }

  /** `/config [key=value]`. */
  async open(args: string): Promise<void> {
    if (args.trim() !== "") return this.direct(args);
    if (this.panel !== undefined) return;
    const snapshot = readSnapshot(this.input());
    const home = this.deps.home;
    this.changes = new Map();
    this.prefixNoticeShown = false;
    const panel = new ConfigPanel(snapshot, {
      theme: this.deps.theme,
      ...(this.deps.keybindings !== undefined ? { keybindings: this.deps.keybindings } : {}),
      rows: () => this.deps.rows(),
      // project file is always <cwd>/.ama/config.json; forward slashes on every platform
      paths: {
        user: tildePath(snapshot.userPath, home).replace(/\\/g, "/"),
        project: PROJECT_FILE,
      },
      embedded: this.input().hasProfile === true,
      activate: (key, scope) => this.activate(key, scope),
      unset: (key, scope) => this.write(key, undefined, scope).then(() => undefined),
      commit: (key, text, scope) => this.commitText(key, text, scope),
      close: () => this.close(),
      requestRender: () => this.deps.render(),
    });
    this.panel = panel;
    this.handle = this.deps.showOverlay(panel, { anchor: "bottom" });
    this.deps.render();
  }

  private close(): void {
    this.handle?.hide();
    this.handle = undefined;
    this.panel = undefined;
    const summary = this.summary();
    if (summary !== undefined) this.deps.notice("info", summary);
    this.deps.render();
  }

  /** Closing summary (undefined when nothing changed). */
  summary(): string | undefined {
    const s = msg().settings;
    const changed = [...this.changes.values()].filter((c) => c.from !== c.to);
    if (changed.length === 0) return undefined;
    const lines = [s.summaryTitle];
    for (const c of changed)
      lines.push(`  ${s.summaryLine(labelOf(c.key), c.from, c.to, s.scope[c.scope])}`);
    const tier = (apply: string): string =>
      changed
        .filter((c) => c.spec?.apply === apply)
        .map((c) => labelOf(c.key))
        .join(", ");
    if (tier("restart") !== "") lines.push(s.summaryRestart(tier("restart")));
    if (tier("nextSession") !== "") lines.push(s.summaryNextSession(tier("nextSession")));
    return lines.join("\n");
  }

  private async activate(key: string, scope: EditScope): Promise<void> {
    const panel = this.panel;
    const spec = settingSpec(key);
    if (panel === undefined || spec === undefined) return;
    const current = getConfigValue(readSnapshot(this.input()), key);
    const blocked = blockedReason(spec, current, scope);
    if (blocked !== undefined) return panel.setNotice(blocked, "warning");
    const value = current.value;
    switch (spec.kind) {
      case "bool":
        await this.write(key, value !== true, scope);
        return;
      case "enum": {
        const options = spec.options ?? [];
        if (options.length <= 4) {
          const next = options[(options.indexOf(String(value)) + 1) % options.length];
          await this.write(key, next, scope);
          return;
        }
        const picked = await this.pick(spec, value);
        if (picked !== undefined) await this.write(key, picked === "" ? undefined : picked, scope);
        return;
      }
      case "model": {
        const picked = await this.pick(spec, value);
        if (picked !== undefined) await this.write(key, picked === "" ? undefined : picked, scope);
        return;
      }
      default:
        panel.startEdit(key, value === undefined ? "" : formatSettingValue(value));
    }
  }

  private async pick(spec: SettingSpec, value: unknown): Promise<string | undefined> {
    const s = msg().settings;
    const current = typeof value === "string" ? value : undefined;
    let items: SelectItem[];
    if (spec.key === "permission.mode")
      items = permissionItems((current ?? "default") as PermissionMode);
    else if (spec.key.endsWith("thinkingLevel")) items = thinkingItems(true);
    else if (spec.kind === "model")
      items = [
        ...(await modelItems(
          hideFakeProvider(this.deps.runtime.providers, this.deps.context.io.env),
          { current, enabled: this.deps.runtime.config.models?.enabled, hints: false },
        )),
        { value: "", label: s.defaultChoice },
      ];
    else items = (spec.options ?? []).map((o) => ({ value: o, label: o }));
    const picked = await openPicker(this.deps, {
      title: s.pickTitle(labelOf(spec.key)),
      items,
      filterable: spec.kind === "model",
      ...(current !== undefined ? { selected: current, currentValue: current } : {}),
      ...(spec.key === "permission.mode" ? { stacked: true } : {}),
    });
    return picked?.value;
  }

  private async commitText(
    key: string,
    text: string,
    scope: EditScope,
  ): Promise<string | undefined> {
    try {
      await this.write(key, parseValue(key, text), scope, true);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Write one key and apply it. Errors become panel notices (or are rethrown with `rethrow`, for the
   * inline editor). Returns the edit result, undefined when refused / cancelled.
   */
  private async write(
    key: string,
    value: unknown,
    scope: EditScope,
    rethrow = false,
  ): Promise<EditResult | undefined> {
    const s = msg().settings;
    if (key === "permission.mode" && value === "full-auto" && scope === "user") {
      const spec = bypassChoiceSpec(this.deps.theme);
      const body = [...spec.body, this.deps.theme.fg("warning", s.bypassPersist)];
      if ((await openChoice(this.deps, { ...spec, body })) !== 0) return undefined;
    }
    let result: EditResult;
    try {
      result = setConfigValue({ ...this.input(), scope, key, value });
    } catch (error) {
      if (rethrow) throw error;
      const text = error instanceof Error ? error.message : String(error);
      if (this.panel !== undefined) this.panel.setNotice(text, "error");
      else this.deps.notice("error", text);
      return undefined;
    }
    await this.afterWrite(result);
    return result;
  }

  private async afterWrite(result: EditResult): Promise<void> {
    const s = msg().settings;
    const spec = settingSpec(result.key);
    const from = formatSettingValue(result.before.value);
    const to = formatSettingValue(result.after.value);
    const previous = this.changes.get(result.key);
    this.changes.set(result.key, {
      key: result.key,
      from: previous?.from ?? from,
      to,
      scope: result.scope,
      spec,
    });
    this.deps.runtime.replaceConfig?.(result.snapshot.config);
    let warning: string | undefined;
    if (result.apply === "now" && result.before.value !== result.after.value)
      await applySetting(result.key, result.after.value, this.deps).catch((error: unknown) => {
        warning = error instanceof Error ? error.message : String(error);
      });
    if (result.overriddenBy !== undefined)
      warning ??= s.stillOverridden(result.key, result.after.envName ?? result.overriddenBy);
    if (result.prefixChanged && !this.prefixNoticeShown && hasReplies(this.deps.session())) {
      this.prefixNoticeShown = true;
      warning ??= s.prefixNotice;
    }
    if (this.panel !== undefined) {
      this.panel.refresh(result.snapshot);
      this.panel.setNotice(warning, "warning");
    } else {
      const line = s.setDone(result.key, to, s.scope[result.scope]);
      this.deps.notice(
        warning === undefined ? "info" : "warn",
        warning === undefined ? line : `${line}\n${warning}`,
      );
    }
    this.deps.render();
  }

  /** `/config key=value`: user scope, no panel. */
  private async direct(args: string): Promise<void> {
    const s = msg().settings;
    const parts = splitAssignment(args);
    if (parts === undefined || parts[1] === "") return this.deps.notice("warn", s.slashUsage);
    try {
      const value = parseValue(parts[0], parts[1]);
      await this.write(parts[0], value, "user", true);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.deps.notice(error instanceof ConfigEditError ? "warn" : "error", text);
    }
  }
}

/** Line mode `/config`: no args lists the settings, `key=value` sets one (user scope). */
export function configCommand(
  runtime: Runtime,
  context: ModeContext,
): (args: string, ctx: CommandContext) => Promise<CommandResult> {
  return async (args, ctx) => {
    const s = msg().settings;
    const input = layerInputFor(runtime, context);
    if (args.trim() === "") {
      const snapshot = readSnapshot(input);
      const lines = settingsRegistry().map((spec) => {
        const value = getConfigValue(snapshot, spec.key);
        return `  ${spec.key} = ${formatSettingValue(value.value)}  ${value.envName ?? value.source}`;
      });
      return { kind: "handled", message: [s.cli.listHeader, ...lines].join("\n") };
    }
    const parts = splitAssignment(args);
    if (parts === undefined || parts[1] === "") return { kind: "handled", message: s.slashUsage };
    try {
      const value = parseValue(parts[0], parts[1]);
      if (parts[0] === "permission.mode" && value === "full-auto") {
        const confirmed =
          ctx.confirmPermissionMode === undefined
            ? false
            : await ctx.confirmPermissionMode("full-auto");
        if (!confirmed) return { kind: "handled", message: s.cli.needYes };
      }
      const result = setConfigValue({ ...input, scope: "user", key: parts[0], value });
      runtime.replaceConfig?.(result.snapshot.config);
      if (result.apply === "now" && result.before.value !== result.after.value)
        await applySetting(result.key, result.after.value, { session: () => ctx.session() });
      const lines = [s.setDone(result.key, formatSettingValue(result.after.value), s.scope.user)];
      if (result.overriddenBy !== undefined)
        lines.push(s.stillOverridden(result.key, result.after.envName ?? result.overriddenBy));
      return { kind: "handled", message: lines.join("\n") };
    } catch (error) {
      if (error instanceof ConfigEditError) return { kind: "handled", message: error.message };
      throw error;
    }
  };
}

/** Wiring for interactive-mode.ts (one line there): the session follows `/new` `/resume` `/fork`. */
export function configUiFor(
  host: PickerHost & { rows(): number },
  parts: {
    runtime: Runtime;
    context: ModeContext;
    view: NonNullable<ConfigApplyTargets["view"]>;
    loader: NonNullable<ConfigApplyTargets["loader"]>;
    area: NonNullable<ConfigApplyTargets["area"]>;
    tui: { forceFullRedraw(): void; requestRender(): void };
    notice(level: NoticeLevel, text: string): void;
  },
): ConfigUi {
  const { runtime, context, tui } = parts;
  const env = context.io.env;
  const home = env["HOME"] ?? env["USERPROFILE"];
  return new ConfigUi({
    ...host,
    runtime,
    context,
    view: parts.view,
    loader: parts.loader,
    area: parts.area,
    session: () => currentSession(runtime),
    notice: parts.notice,
    render: () => tui.requestRender(),
    redraw: () => tui.forceFullRedraw(),
    ...(home !== undefined ? { home } : {}),
  });
}
