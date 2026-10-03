/**
 * `ama config get | set | unset | list` (docs/wave6-plan.md §6.4, D24-D26). [W6-S]
 *
 * Thin layer over config/edit.ts (the `/config` panel uses the same core):
 * - `get <key> [--json]`: effective value, source layer and apply tier;
 * - `set <key> <value> [--project] [--json-value] [--yes]`: write one key to the user file (or the
 *   project file, tighten only); lists and objects need `--json-value`; `permission.mode full-auto`
 *   asks once on a TTY and needs `--yes` otherwise;
 * - `unset <key> [--project]`;
 * - `list [prefix] [--json] [--all]`: panel settings (or every settable key with `--all`).
 * Unknown keys, invalid values and refused project writes exit 3 (`ExitCode.Config`). `get` / `list`
 * never create the config directory. `--profile <file>` adds the host profile layer to the view.
 */

import { msg } from "../../i18n/index.js";
import {
  assertSettable,
  formatSettingValue,
  getConfigValue,
  parseValue,
  readSnapshot,
  setConfigValue,
  type ConfigLayerInput,
  type EditResult,
  type EditScope,
  type SettingValue,
} from "../../config/edit.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { initConfigDir } from "../../config/init.js";
import { CONFIG_FILE, resolveConfigDir } from "../../config/paths.js";
import { loadProfile } from "../../config/profile.js";
import { settableKeys, settingSpec, settingsRegistry } from "../../config/settings-registry.js";
import { confirmContinue } from "../choice-prompt.js";
import { parseSubArgs, UsageError } from "../args.js";
import type { CliIo } from "../deps.js";
import { ExitCode } from "../exit-codes.js";

export const CONFIG_EDIT_ACTIONS = ["get", "set", "unset", "list"] as const;
export type ConfigEditAction = (typeof CONFIG_EDIT_ACTIONS)[number];

export interface ConfigSetDeps {
  /** Ask before persisting Bypass (TTY only); default: the CLI y/N prompt. */
  confirm?(question: string): Promise<boolean>;
}

function layerInput(io: CliIo, profilePath: string | undefined): ConfigLayerInput {
  const input: ConfigLayerInput = {
    configDir: resolveConfigDir({ env: io.env }),
    cwd: io.cwd,
    env: io.env,
  };
  if (profilePath !== undefined) {
    const profile = loadProfile(profilePath, io.cwd);
    input.profile = { config: profile.config };
    input.hasProfile = true;
  }
  return input;
}

function applyText(key: string): string {
  const spec = settingSpec(key);
  const s = msg().settings;
  if (spec === undefined) return s.cli.applyNone;
  return spec.prefix === true ? `${s.apply[spec.apply]} · ${s.prefixTag}` : s.apply[spec.apply];
}

function jsonRow(value: SettingValue): Record<string, unknown> {
  const spec = settingSpec(value.key);
  return {
    key: value.key,
    value: value.value ?? null,
    source: value.source,
    ...(value.envName !== undefined ? { env: value.envName } : {}),
    apply: spec?.apply ?? null,
    prefix: spec?.prefix === true,
    project: spec?.project ?? null,
  };
}

function textRow(value: SettingValue): string {
  const source = value.envName !== undefined ? `env ${value.envName}` : value.source;
  return msg().settings.cli.getLine(
    value.key,
    formatSettingValue(value.value),
    source,
    applyText(value.key),
  );
}

function scopeLabel(scope: EditScope): string {
  return msg().settings.scope[scope];
}

/**
 * Receipt of a write. When a higher layer (env, project, cli, profile) still hides the key, the first line shows the
 * value just written and its layer, and the second line names the overriding source and the effective value.
 */
function report(io: CliIo, result: EditResult, written: unknown): void {
  const s = msg().settings;
  const effective = formatSettingValue(result.after.value);
  const scope = scopeLabel(result.scope);
  const by = result.after.envName ?? result.overriddenBy;
  if (written === undefined) io.stdout(`${s.unsetDone(result.key, effective, scope)}\n`);
  else if (by === undefined) io.stdout(`${s.setDone(result.key, effective, scope)}\n`);
  else io.stdout(`${s.writtenTo(result.key, formatSettingValue(written), scope)}\n`);
  if (by === undefined) return;
  io.stdout(
    `${written === undefined ? s.stillOverridden(result.key, by) : s.overriddenNow(by, effective)}\n`,
  );
}

/** Confirm persisting `permission.mode full-auto`: TTY asks, otherwise `--yes` is required. */
async function confirmBypass(io: CliIo, yes: boolean, deps: ConfigSetDeps): Promise<boolean> {
  const s = msg().settings.cli;
  if (yes) return true;
  if (!io.stdinIsTTY) {
    io.stderr(`ama: ${s.needYes}\n`);
    return false;
  }
  const ask = deps.confirm ?? ((question: string) => confirmContinue({ question, env: io.env }));
  if (await ask(s.confirmBypass)) return true;
  io.stderr(`${s.cancelled}\n`);
  return false;
}

export async function runConfigEdit(
  action: ConfigEditAction,
  argv: readonly string[],
  io: CliIo,
  deps: ConfigSetDeps = {},
): Promise<number> {
  const { positionals, values, flags } = parseSubArgs(
    argv,
    ["profile"],
    ["json", "project", "json-value", "yes", "all"],
  );
  const s = msg().settings;
  if (flags.has("help")) {
    io.stdout(s.cli.usage);
    return ExitCode.Ok;
  }
  const input = layerInput(io, values.get("profile"));
  const scope: EditScope = flags.has("project") ? "project" : "user";
  if (action === "list") {
    const snapshot = readSnapshot(input);
    const prefix = positionals[0] ?? "";
    const keys = (
      flags.has("all") ? settableKeys() : settingsRegistry().map((spec) => spec.key)
    ).filter((key) => key.startsWith(prefix));
    const rows = keys.map((key) => getConfigValue(snapshot, key));
    if (flags.has("json")) io.stdout(`${JSON.stringify(rows.map(jsonRow), null, 2)}\n`);
    else io.stdout(`${[s.cli.listHeader, ...rows.map((r) => `  ${textRow(r)}`)].join("\n")}\n`);
    return ExitCode.Ok;
  }
  const key = positionals[0];
  if (key === undefined) throw new UsageError(s.cli.missingKey);
  if (action === "get") {
    assertSettable(key);
    const value = getConfigValue(readSnapshot(input), key);
    io.stdout(
      flags.has("json") ? `${JSON.stringify(jsonRow(value), null, 2)}\n` : `${textRow(value)}\n`,
    );
    return ExitCode.Ok;
  }
  if (action === "unset") {
    report(io, setConfigValue({ ...input, scope, key, value: undefined }), undefined);
    return ExitCode.Ok;
  }
  const raw = positionals.slice(1).join(" ");
  if (positionals.length < 2) throw new UsageError(s.cli.missingValue);
  const value = parseValue(key, raw, flags.has("json-value"));
  if (key === "permission.mode" && value === "full-auto" && scope === "user") {
    if (!(await confirmBypass(io, flags.has("yes"), deps))) return ExitCode.Config;
  }
  // first write to a fresh config dir: lay out config.json + config.schema.json like `ama init`
  if (scope === "user" && !existsSync(join(input.configDir, CONFIG_FILE)))
    initConfigDir(input.configDir);
  report(io, setConfigValue({ ...input, scope, key, value }), value);
  return ExitCode.Ok;
}
