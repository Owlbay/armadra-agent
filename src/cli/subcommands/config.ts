/**
 * `ama config show [--json] [--profile <文件>] [--auth-file <文件>]`（设计 §10.0）：打印生效配置，
 * 每一项标出来自哪一层（default / user / profile / project），并给出将使用的模型与原因
 * （`config.defaultModel` 或零配置选择）。只读；config 里的字面量 apiKey 只显示种类。[B6]
 *
 * 缺省值来自 config/key-docs.ts 的 DISPLAY_DEFAULTS（含 DEFAULT_CONFIG 不写的 cache / codemode 等段），
 * `codemode.mode` 不写时显示跟随预设的结果与原因；`--tools-preset` / `--codemode` 作为 cli 层叠加；
 * 预设写的是旧名（codemode）时显示规范名并提示。
 *
 * [W3-B12] 「供应商」节：config 里出现的供应商与 baseUrl 来自环境变量（`OPENAI_BASE_URL` /
 * `ANTHROPIC_BASE_URL`）的内置供应商，列出协议、生效 baseUrl 与来源、config 里每个模型的协议
 * （模型级 `api` 生效后的值）。
 */

import { metadataOf, modelFlags, sourcesLine } from "./model-meta.js";
import { loadConfigFile } from "../../config/load.js";
import {
  PROFILE_DEFAULTS,
  cliOverridesToConfig,
  mergeConfig,
  mergeProjectAndCli,
  type CliConfigOverrides,
} from "../../config/merge.js";
import { DISPLAY_DEFAULTS } from "../../config/key-docs.js";
import {
  AUTH_FILE,
  CONFIG_FILE,
  HOOKS_FILE,
  projectFile,
  resolveConfigDir,
  resolveDataDir,
} from "../../config/paths.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { modelsDevCachePath } from "../../ai/providers/models-dev-cache.js";
import { initConfigDir } from "../../config/init.js";
import { CONFIG_SCHEMA_FILE } from "../../config/json-schema.js";
import {
  CODEMODE_MODES,
  TOOLS_PRESET_ALIASES,
  TOOLS_PRESET_INPUTS,
  canonicalPreset,
  type AmaConfig,
  type CodemodeMode,
  type ToolsPresetInput,
} from "../../config/types.js";
import { codemodeAvailability, detectSandboxCapability } from "../../codemode/capability.js";
import { baseUrlEnvOf } from "../../ai/providers/registry.js";
import type { Api, ProviderRegistryApi } from "../../ai/types.js";
import { classifyKeyValue } from "../../config/auth-file.js";
import { CODEMODE_TOOL, resolveCodemodeMode, resolvePreset } from "../../tools/presets.js";
import { builtinTools } from "../../tools/registry.js";
import { parseSubArgs, UsageError } from "../args.js";
import { noModelGuidance, pickDefaultModel } from "../default-model.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { ExitCode } from "../exit-codes.js";
import { buildRegistry, loadUserLevel, type UserLevel } from "./context.js";

export const CONFIG_USAGE = `用法：ama config show [--json] [--profile <文件>] [--auth-file <文件>]
                        [--tools-preset <名>] [--codemode off|on|only]
      ama config path    配置目录、数据目录与各文件路径
      ama config edit    用 $VISUAL / $EDITOR 打开 config.json（没有编辑器时打印路径）
`;

/** `ama config path`：目录与文件路径，标出是否存在。 */
function showPaths(io: CliIo): number {
  const configDir = resolveConfigDir({ env: io.env });
  const dataDir = resolveDataDir({ env: io.env });
  const mark = (path: string): string => `${path}${existsSync(path) ? "" : "  （不存在）"}`;
  const lines = [
    `配置目录  ${mark(configDir)}`,
    `  config.json         ${mark(join(configDir, CONFIG_FILE))}`,
    `  config.schema.json  ${mark(join(configDir, CONFIG_SCHEMA_FILE))}`,
    `  auth.json           ${mark(join(configDir, AUTH_FILE))}`,
    `  hooks.json          ${mark(join(configDir, HOOKS_FILE))}`,
    `数据目录  ${mark(dataDir)}`,
    `  sessions/           ${mark(join(dataDir, "sessions"))}`,
    `  models-dev.json     ${mark(modelsDevCachePath(dataDir))}`,
    `项目级    ${mark(projectFile(io.cwd, CONFIG_FILE))}`,
  ];
  io.stdout(`${lines.join("\n")}\n`);
  return ExitCode.Ok;
}

/** `ama config edit`：不存在先 init；`$VISUAL` / `$EDITOR`（可带参数）打开，没有就打印路径。 */
function editConfig(io: CliIo): number {
  const configDir = resolveConfigDir({ env: io.env });
  const path = join(configDir, CONFIG_FILE);
  if (!existsSync(path)) initConfigDir(configDir);
  const editor = (io.env["VISUAL"] ?? io.env["EDITOR"] ?? "").trim();
  if (editor === "") {
    io.stdout(`${path}\n（没有设置 $VISUAL / $EDITOR，请用编辑器打开上面的文件）\n`);
    return ExitCode.Ok;
  }
  const quoted = process.platform === "win32" ? `"${path}"` : `'${path.replace(/'/g, `'\\''`)}'`;
  const result = spawnSync(`${editor} ${quoted}`, { stdio: "inherit", shell: true });
  if (result.error !== undefined || result.status !== 0) {
    io.stderr(`ama: 编辑器退出异常（${editor}）；文件在 ${path}\n`);
    return ExitCode.RuntimeError;
  }
  return ExitCode.Ok;
}

type Layer = {
  name: "default" | "user" | "profile" | "project" | "cli";
  label: string;
  value: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 叶子路径 → 值（数组与标量是叶子）。 */
export function flatten(
  value: unknown,
  prefix = "",
  out = new Map<string, unknown>(),
): Map<string, unknown> {
  if (!isObject(value)) {
    if (prefix !== "") out.set(prefix, value);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema" || (prefix === "" && key === "version")) continue;
    flatten(child, prefix === "" ? key : `${prefix}.${key}`, out);
  }
  return out;
}

const ACCUMULATING = new Set([
  "permission.allow",
  "permission.deny",
  "tools.disabled",
  "skills.dirs",
]);

function display(path: string, value: unknown): string {
  if (path.endsWith(".apiKey") && typeof value === "string") {
    const kind = classifyKeyValue(value);
    return kind === "literal" ? "<literal key>" : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

export interface ModelDescription {
  ref: string | undefined;
  reason: string;
}

/** 将使用的模型：`defaultModel` → 零配置（第一个有 key / 本地可达的供应商）→ 无。 */
export async function describeModel(
  config: AmaConfig,
  registry: ProviderRegistryApi | undefined,
): Promise<ModelDescription> {
  if (config.defaultModel !== undefined)
    return { ref: config.defaultModel, reason: "config.defaultModel" };
  if (registry === undefined) return { ref: undefined, reason: "注册表未装配" };
  const picked = await pickDefaultModel(registry);
  if (picked === undefined) return { ref: undefined, reason: noModelGuidance(registry) };
  const ref = `${picked.provider.id}/${picked.model.id}`;
  if (picked.via === "local") return { ref, reason: `零配置：本地 ${picked.provider.id} 可达` };
  const key = await registry.resolveApiKey(picked.provider.id);
  const origin = key.origin !== undefined ? ` ${key.origin}` : "";
  return { ref, reason: `零配置：${picked.provider.id} 有 key（${key.source}${origin}）` };
}

export interface ProviderDescription {
  id: string;
  api: Api;
  baseUrl: string;
  /** baseUrl 来自的环境变量。 */
  baseUrlEnv?: string;
  /** 渠道（多渠道供应商）。 */
  channels?: { name: string; api: Api; baseUrl: string }[];
  /** config 里列出的模型及其生效协议、渠道与元数据来源。 */
  models: {
    id: string;
    api: Api;
    channels?: string[];
    flags: string;
    sources?: string;
  }[];
}

/** config 里出现的供应商 + baseUrl 来自环境变量的内置供应商。 */
export function describeProviders(
  config: AmaConfig,
  registry: ProviderRegistryApi | undefined,
): ProviderDescription[] {
  if (registry === undefined) return [];
  const out: ProviderDescription[] = [];
  for (const provider of registry.list()) {
    const configured = config.providers?.[provider.id];
    const env = baseUrlEnvOf(registry, provider.id);
    if (configured === undefined && env === undefined) continue;
    const ids = new Set((configured?.models ?? []).map((m) => m.id));
    out.push({
      id: provider.id,
      api: provider.api,
      baseUrl: provider.baseUrl,
      ...(env !== undefined ? { baseUrlEnv: env } : {}),
      ...(provider.channels !== undefined
        ? {
            channels: provider.channels.map((c) => ({
              name: c.name,
              api: c.api,
              baseUrl: c.baseUrl,
            })),
          }
        : {}),
      models: provider.models
        .filter((m) => ids.has(m.id))
        .map((m) => {
          const sources = sourcesLine(metadataOf(registry, provider.id, m.id));
          return {
            id: m.id,
            api: m.api,
            ...(m.channels !== undefined ? { channels: [...m.channels] } : {}),
            flags: modelFlags(m),
            ...(sources !== undefined ? { sources } : {}),
          };
        }),
    });
  }
  return out;
}

function providerLines(providers: readonly ProviderDescription[]): string[] {
  if (providers.length === 0) return [];
  const lines = ["", "供应商："];
  for (const p of providers) {
    const env = p.baseUrlEnv !== undefined ? `（baseUrl 来自环境变量 ${p.baseUrlEnv}）` : "";
    lines.push(`  ${p.id}  ${p.api}  ${p.baseUrl}${env}`);
    for (const c of p.channels ?? []) lines.push(`    @${c.name}  ${c.api}  ${c.baseUrl}`);
    for (const m of p.models) {
      lines.push(`    ${p.id}/${m.id}  ${m.api}  ${m.flags}`);
      if (m.sources !== undefined) lines.push(`      ${m.sources}`);
    }
  }
  return lines;
}

function layersOf(
  level: UserLevel,
  project: AmaConfig | undefined,
  effective: AmaConfig,
  cli: Partial<AmaConfig> | undefined,
): Layer[] {
  const layers: Layer[] = [{ name: "default", label: "内置缺省", value: DISPLAY_DEFAULTS }];
  const user = loadConfigFile("config", level.userConfigPath)?.value;
  if (user !== undefined) layers.push({ name: "user", label: level.userConfigPath, value: user });
  if (level.profile !== undefined) {
    layers.push({ name: "profile", label: level.profile.path, value: PROFILE_DEFAULTS });
    if (level.profile.config !== undefined)
      layers.push({
        name: "profile",
        label: level.profile.configFile ?? level.profile.path,
        value: level.profile.config,
      });
  }
  if (project !== undefined) {
    // 只记被接受的项：生效值与项目级相同的路径才算项目级来源。
    const flat = flatten(effective);
    const accepted: Record<string, unknown> = {};
    for (const [path, value] of flatten(project)) {
      if (JSON.stringify(flat.get(path)) === JSON.stringify(value) || ACCUMULATING.has(path))
        accepted[path] = value;
    }
    layers.push({ name: "project", label: ".ama/config.json", value: unflatten(accepted) });
  }
  if (cli !== undefined && Object.keys(cli).length > 0)
    layers.push({ name: "cli", label: "命令行", value: cli });
  return layers;
}

function unflatten(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const keys = path.split(".");
    let node = out;
    for (const key of keys.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>;
    node[keys.at(-1) as string] = value;
  }
  return out;
}

/** 每个生效叶子的来源：累加型列表列出所有贡献层，其余取最后设置它的层。 */
export function sourcesOf(effective: AmaConfig, layers: readonly Layer[]): Map<string, string> {
  const flats = layers.map((l) => ({ name: l.name, flat: flatten(l.value) }));
  const sources = new Map<string, string>();
  for (const path of flatten(effective).keys()) {
    const setBy = flats.filter((l) => l.flat.has(path)).map((l) => l.name);
    const names = ACCUMULATING.has(path)
      ? [...new Set(setBy.filter((n) => n !== "default"))]
      : setBy.slice(-1);
    sources.set(path, names.length > 0 ? names.join("+") : "default");
  }
  return sources;
}

export interface CodemodeDescription {
  mode: CodemodeMode;
  /** config：显式 codemode.mode；preset：跟随预设。 */
  source: "config" | "preset";
  /** 人读原因。 */
  reason: string;
  strict: boolean;
  /** 生效模式不是 off 但 codemode 工具不可用（requireStrict）时的说明。 */
  unavailable?: string;
}

/** codemode 生效模式与原因（跟随预设时写明预设与运行时 Node 是否隔离网络）。 */
export function describeCodemode(config: AmaConfig, nodeVersion?: string): CodemodeDescription {
  const capability = detectSandboxCapability(nodeVersion);
  const resolved = resolveCodemodeMode(config, capability.strict);
  const sandbox = capability.strict
    ? `Node ${capability.nodeMajor} 网络已隔离`
    : `Node ${capability.nodeMajor} < 25 网络未隔离`;
  const reason =
    resolved.source === "config"
      ? `codemode.mode 显式设置（${sandbox}）`
      : `跟随预设 ${resolved.preset}（${sandbox}）`;
  const out: CodemodeDescription = {
    mode: resolved.mode,
    source: resolved.source,
    reason,
    strict: capability.strict,
  };
  if (resolved.mode !== "off") {
    const availability = codemodeAvailability(config.codemode?.requireStrict, capability);
    if (!availability.available) out.unavailable = availability.warning;
  }
  return out;
}

/** 各层里把 tools.preset 写成旧名（别名）的：`user（写的是旧名 codemode）`。 */
function presetAliasNotes(layers: readonly Layer[]): string[] {
  const notes: string[] = [];
  for (const layer of layers) {
    const preset = (layer.value as AmaConfig | undefined)?.tools?.preset;
    if (preset !== undefined && Object.hasOwn(TOOLS_PRESET_ALIASES, preset))
      notes.push(
        `${layer.name}（${layer.label}）的 tools.preset 写的是旧名 ${preset}，规范名 ${canonicalPreset(preset)}`,
      );
  }
  return notes;
}

function choice<T extends string>(name: string, value: string | undefined, all: readonly T[]) {
  if (value === undefined) return undefined;
  if ((all as readonly string[]).includes(value)) return value as T;
  throw new UsageError(`--${name} 的取值应为 ${all.join(" | ")}（收到 ${value}）`);
}

export async function runConfig(
  argv: readonly string[],
  io: CliIo,
  deps: Pick<RuntimeDeps, "providers"> | undefined,
): Promise<number> {
  const { positionals, values, flags } = parseSubArgs(
    argv,
    ["profile", "auth-file", "tools-preset", "codemode"],
    ["json"],
  );
  const action = positionals[0] ?? "show";
  if (flags.has("help")) {
    io.stdout(CONFIG_USAGE);
    return ExitCode.Ok;
  }
  if (action === "path") return showPaths(io);
  if (action === "edit") return editConfig(io);
  if (action !== "show") throw new UsageError(`未知的 config 子命令：${action}`);
  const cli: CliConfigOverrides = {};
  const presetFlag = choice<ToolsPresetInput>(
    "tools-preset",
    values.get("tools-preset"),
    TOOLS_PRESET_INPUTS,
  );
  if (presetFlag !== undefined) cli.toolsPreset = presetFlag;
  const codemodeFlag = choice("codemode", values.get("codemode"), CODEMODE_MODES);
  if (codemodeFlag !== undefined) cli.codemode = codemodeFlag;
  const level = loadUserLevel(io, {
    profile: values.get("profile"),
    authFile: values.get("auth-file"),
  });
  const project = loadConfigFile("config", projectFile(io.cwd, CONFIG_FILE))?.value;
  const merged = mergeProjectAndCli(level.merged, project, cli);
  const config = merged.config;
  const layers = layersOf(level, project, config, cliOverridesToConfig(cli));
  // 展示：生效配置补上 DEFAULT_CONFIG 不写的缺省（cache、codemode.inlineBudget 等），来源 default
  const shown = mergeConfig(DISPLAY_DEFAULTS as AmaConfig, config);
  const sources = sourcesOf(shown, layers);
  const registry = deps === undefined ? undefined : await buildRegistry(level, io, deps);
  const model = await describeModel(config, registry);
  const providers = describeProviders(config, registry);
  const codemode = describeCodemode(config);
  const builtin = new Set(builtinTools().map((tool) => tool.name));
  if (codemode.mode !== "off" && codemode.unavailable === undefined) builtin.add(CODEMODE_TOOL);
  const preset = resolvePreset({
    config,
    available: (name) => builtin.has(name),
    strict: codemode.strict,
  });
  const notes = presetAliasNotes(layers);
  const warnings = [...level.warnings, ...merged.warnings];
  const rows = [...flatten(shown)].map(([path, value]) => ({
    path,
    value,
    source: sources.get(path) ?? "default",
  }));
  if (config.codemode?.mode === undefined)
    rows.push({
      path: "codemode.mode",
      value: codemode.mode,
      source: `default（${codemode.reason}）`,
    });
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (flags.has("json")) {
    const entries = rows.map(({ path, value, source }) => ({
      path,
      value: path.endsWith(".apiKey") ? display(path, value) : value,
      source,
    }));
    io.stdout(
      `${JSON.stringify({ model, providers, tools: preset.builtin, preset: preset.preset, codemode, entries, layers: layers.map((l) => ({ name: l.name, file: l.label })), notes, warnings }, null, 2)}\n`,
    );
    return ExitCode.Ok;
  }
  const lines = ["生效配置（来源：default 内置 ← user ← profile ← project 只能收紧 ← cli）"];
  for (const layer of layers.slice(1)) lines.push(`  ${layer.name}：${layer.label}`);
  lines.push("");
  const texts = rows.map((row) => [`${row.path} = ${display(row.path, row.value)}`, row.source]);
  const width = Math.min(60, Math.max(...texts.map(([text]) => (text ?? "").length)));
  for (const [text, source] of texts) lines.push(`  ${(text ?? "").padEnd(width)}  ${source}`);
  lines.push(...providerLines(providers));
  lines.push("");
  lines.push(`模型：${model.ref ?? "（无）"}  ${model.reason}`);
  lines.push(
    `工具：${preset.builtin.join(", ")}（预设 ${preset.preset}，codemode ${preset.codemode}）`,
  );
  lines.push(`codemode：${codemode.mode}  ${codemode.reason}`);
  if (codemode.unavailable !== undefined) lines.push(`  ${codemode.unavailable}`);
  for (const note of notes) lines.push(`提示：${note}`);
  for (const warning of [...warnings, ...preset.warnings]) lines.push(`警告：${warning}`);
  io.stdout(`${lines.join("\n")}\n`);
  return ExitCode.Ok;
}
