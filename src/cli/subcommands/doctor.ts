/**
 * `ama doctor`（设计 §1.2、§6.1、R4、R8）。[B5]
 *
 * 输出：目录、配置层级（每层文件存在 / 有效 / 警告）、信任状态与需信任的资源、AGENTS.md、
 * key 来源（只给来源不给值）、将执行的 Hook 命令（含因未信任被跳过的项目级）、终端能力。
 * 只读：不询问信任、不写任何文件；配置错误照常列出并以退出码 3 结束。
 * [W3-B12] baseUrl 来自 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` 时在 key 行后标出变量与地址。
 */

import { existsSync } from "node:fs";
import { blobUsage, fileHistoryDir } from "../../checkpoints/blobs.js";
import { shadowUsage } from "../../checkpoints/shadow-git.js";
import { formatBytes } from "../../checkpoints/gc.js";
import { baseUrlEnvOf } from "../../ai/providers/registry.js";
import { classifyKeyValue, isModeTooOpen, fileMode, readAuthFile } from "../../config/auth-file.js";
import { findContextFiles } from "../../config/context-files.js";
import { loadConfigFile, probeConfigFile } from "../../config/load.js";
import { mergeProjectAndCli } from "../../config/merge.js";
import { CONFIG_FILE, HOOKS_FILE, projectFile, userFile } from "../../config/paths.js";
import { findTrustEntry, readTrustFile, trustGatedResources } from "../../config/trust.js";
import { loadHookConfigs } from "../../hooks/config.js";
import { osSandboxStatus } from "../../sandbox/detect.js";
import { resolveBashSandbox } from "../../sandbox/bash.js";
import { AMA_VERSION } from "../../version.js";
import { parseSubArgs } from "../args.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { ExitCode } from "../exit-codes.js";
import { describeProxy, inspectProxy } from "../proxy.js";
import { describeCodemode, describeModel } from "./config.js";
import { buildRegistry, loadUserLevel, type UserLevel } from "./context.js";
import { apiKeyEntry } from "../../config/types-w6.js";
import { oauthDoctorLines } from "../../auth/chatgpt/doctor.js";
import { readOAuthEntry } from "../../auth/oauth/token-store.js";
import { getLocale, msg, resolveLocaleWithSource } from "../../i18n/index.js";

/** 用法（随界面语言）。 */
export function doctorUsage(): string {
  return msg().report.doctor.usage;
}

class Report {
  private readonly lines: string[] = [];
  problems = 0;

  section(title: string): void {
    if (this.lines.length > 0) this.lines.push("");
    this.lines.push(title);
  }

  item(text: string): void {
    this.lines.push(`  ${text}`);
  }

  problem(text: string): void {
    this.problems++;
    this.lines.push(`  ✗ ${text}`);
  }

  text(): string {
    return `${this.lines.join("\n")}\n`;
  }
}

function probeLine(report: Report, label: string, kind: "config" | "hooks", path: string): void {
  const probe = probeConfigFile(kind, path);
  if (!probe.exists) {
    report.item(msg().report.doctor.missing(label, path));
    return;
  }
  if (!probe.ok) {
    report.problem(msg().report.doctor.labeled(label, probe.messages.join("; ")));
    return;
  }
  report.item(msg().report.doctor.labeled(label, path));
  for (const message of probe.messages) report.item(`  ${msg().report.doctor.warning(message)}`);
}

function trustSection(
  report: Report,
  io: CliIo,
  level: UserLevel,
  flag: boolean | undefined,
): boolean {
  const m = msg().report.doctor;
  report.section(m.trustTitle);
  let trusted = false;
  let from: string;
  if (flag !== undefined) {
    trusted = flag;
    from = m.fromCli;
  } else if (level.profile?.trustProject === true) {
    trusted = true;
    from = "profile.trustProject";
  } else {
    try {
      const entry = findTrustEntry(readTrustFile(level.configDir).entries, io.cwd);
      trusted = entry?.trusted ?? false;
      from = entry === undefined ? m.noRecord : `trust.json ${entry.path}`;
    } catch (error) {
      report.problem((error as Error).message);
      from = m.trustInvalid;
    }
  }
  report.item(m.trust(io.cwd, trusted, from));
  const gated = trustGatedResources(io.cwd);
  if (gated.length > 0) {
    report.item(m.gated(trusted));
    for (const path of gated) report.item(`  ${path}`);
  }
  return trusted;
}

async function keySection(
  report: Report,
  io: CliIo,
  level: UserLevel,
  deps: RuntimeDeps | undefined,
): Promise<void> {
  const m = msg().report.doctor;
  report.section(m.keysTitle);
  try {
    const auth = readAuthFile(level.authFile);
    const mode = fileMode(level.authFile);
    if (!auth.exists) report.item(m.missing("auth.json", level.authFile));
    else if (isModeTooOpen(mode))
      report.problem(m.authMode(mode?.toString(8) ?? "?", level.authFile));
    else report.item(m.labeled("auth.json", level.authFile));
  } catch (error) {
    report.problem((error as Error).message);
  }
  if (deps !== undefined) {
    try {
      const registry = await buildRegistry(level, io, deps);
      for (const provider of registry.list()) {
        // [W6-O] OAuth 条目：只读文件，不刷新 token
        const oauth = readOAuthEntry(level.authFile, provider.id);
        if (oauth !== undefined) {
          const lines = await oauthDoctorLines(provider.id, oauth, {
            env: io.env,
            config: level.merged.config.auth?.chatgpt,
          });
          report.item(`${provider.id.padEnd(20)} ${lines.line}`);
          if (lines.quota !== undefined) report.item(`${"".padEnd(20)} ${lines.quota}`);
          if (lines.problem !== undefined) report.problem(lines.problem);
          continue;
        }
        const key = await registry.resolveApiKey(provider.id);
        const text =
          key.apiKey !== undefined
            ? m.keySource(key.source, key.origin)
            : provider.requiresApiKey
              ? m.none
              : m.notNeeded;
        report.item(`${provider.id.padEnd(20)} ${text}`);
        const env = baseUrlEnvOf(registry, provider.id);
        if (env !== undefined)
          report.item(`${"".padEnd(20)} ${m.baseUrlEnv(env, provider.baseUrl)}`);
      }
      const model = await describeModel(level.merged.config, registry);
      report.item(m.model(model.ref, model.reason));
      return;
    } catch (error) {
      report.problem(m.registry((error as Error).message));
    }
  }
  // 未装配注册表：按文件与环境变量名列出能看到的来源。
  try {
    for (const [id, entry] of Object.entries(readAuthFile(level.authFile).file.providers)) {
      const key = apiKeyEntry(entry)?.apiKey;
      report.item(
        `${id.padEnd(20)} ${m.keySource("auth-file", key === undefined ? "oauth" : classifyKeyValue(key))}`,
      );
    }
  } catch {
    // 上面已报告
  }
  for (const [id, provider] of Object.entries(level.merged.config.providers ?? {})) {
    if (provider.apiKey !== undefined) {
      report.item(`${id.padEnd(20)} ${m.keySource("config", classifyKeyValue(provider.apiKey))}`);
    }
  }
  const envNames = Object.keys(io.env)
    .filter((n) => /_API_KEY$/.test(n) || n.startsWith("AMA_API_KEY_"))
    .filter((n) => (io.env[n] ?? "") !== "")
    .sort();
  report.item(m.envVars(envNames));
}

function hookSection(report: Report, io: CliIo, level: UserLevel, trusted: boolean): void {
  const m = msg().report.doctor;
  report.section("Hook");
  try {
    const hooks = loadHookConfigs({
      configDir: level.configDir,
      cwd: io.cwd,
      profileHooksFile: level.profile?.hooksFile,
      trusted,
      defaultTimeoutMs: level.merged.config.hooks?.timeoutMs,
    });
    if (hooks.hooks.length === 0) report.item(m.empty);
    for (const hook of hooks.hooks) {
      const matcher = hook.matcher !== undefined ? ` [${hook.matcher}]` : "";
      report.item(
        `${hook.source.padEnd(7)} ${hook.event}${matcher} → ${m.hookCommand(hook.command, hook.timeoutMs)}`,
      );
    }
    if (hooks.skippedProject !== undefined) {
      report.item(m.hookSkipped(hooks.skippedProject));
    }
  } catch (error) {
    report.problem((error as Error).message);
  }
}

function terminalSection(report: Report, io: CliIo): void {
  const m = msg().report.doctor;
  report.section(m.terminalTitle);
  const env = io.env;
  report.item(m.tty(io.stdinIsTTY, io.stdoutIsTTY));
  report.item(m.term(env["TERM"], env["COLORTERM"]));
  if (env["NO_COLOR"] !== undefined) report.item(m.noColor);
  if (env["TMUX"] !== undefined) report.item(m.tmux);
  const columns = process.stdout.columns;
  if (io.stdoutIsTTY && columns !== undefined) report.item(m.size(columns, process.stdout.rows));
  const tui = io.stdinIsTTY && io.stdoutIsTTY && env["TERM"] !== "dumb";
  report.item(m.defaultUi(tui));
}

/** [W6-I3] 「界面语言：zh（来源 LANG=zh_CN.UTF-8）」；按环境与配置重算，与实际语言不同时说明来自 --lang。 */
function languageLine(report: Report, io: CliIo, level: UserLevel): void {
  const m = msg().report.doctor;
  const language = level.profile?.language ?? level.merged.config.ui?.language;
  const found = resolveLocaleWithSource(io.env, { language });
  const locale = getLocale();
  const source = found.locale === locale ? found.source : { kind: "cli" as const };
  const name = source.kind === "env" || source.kind === "locale" ? source.name : undefined;
  const value = source.kind === "env" || source.kind === "locale" ? source.value : undefined;
  report.item(m.language(locale, m.languageSource(source.kind, name, value)));
}

function proxySection(report: Report, io: CliIo): void {
  report.section(msg().report.doctor.proxyTitle);
  for (const line of describeProxy(inspectProxy(io.env))) report.item(line);
}

/** 检查点备份占用（docs/history/rewind-plan.md §1.4）。 */
async function fileHistoryLine(report: Report, dataDir: string): Promise<void> {
  try {
    const usage = await blobUsage(dataDir);
    const shadow = await shadowUsage(dataDir);
    const m = msg().report.doctor;
    const shadowText =
      shadow.repos === 0 ? undefined : m.shadowRepos(shadow.repos, formatBytes(shadow.bytes));
    report.item(
      m.fileHistory(usage.blobs, formatBytes(usage.bytes), shadowText, fileHistoryDir(dataDir)),
    );
  } catch (error) {
    report.item(msg().report.doctor.fileHistoryFailed((error as Error).message));
  }
}

export async function runDoctor(
  argv: readonly string[],
  io: CliIo,
  deps: RuntimeDeps | undefined,
): Promise<number> {
  const { values, flags } = parseSubArgs(argv, ["profile", "auth-file"], ["trust", "no-trust"]);
  if (flags.has("help")) {
    io.stdout(doctorUsage());
    return ExitCode.Ok;
  }
  const report = new Report();
  report.section(
    `ama ${AMA_VERSION} · Node ${process.version} · ${process.platform}-${process.arch}`,
  );
  let level: UserLevel;
  try {
    level = loadUserLevel(io, {
      profile: values.get("profile"),
      authFile: values.get("auth-file"),
    });
  } catch (error) {
    report.problem((error as Error).message);
    io.stdout(report.text());
    return ExitCode.Config;
  }
  const m = msg().report.doctor;
  report.section(m.dirsTitle);
  report.item(m.configDir(level.configDir));
  report.item(m.dataDir(level.dataDir, existsSync(level.dataDir)));
  await fileHistoryLine(report, level.dataDir);
  report.section(m.layersTitle);
  report.item(m.builtinDefaults);
  probeLine(report, m.userLevel, "config", level.userConfigPath);
  if (level.profile !== undefined) {
    report.item(m.labeled("profile", level.profile.path));
    if (level.profile.configFile !== undefined)
      probeLine(report, "profile.config", "config", level.profile.configFile);
  }
  const projectPath = projectFile(io.cwd, CONFIG_FILE);
  probeLine(report, m.projectLevel, "config", projectPath);
  try {
    const project = loadConfigFile("config", projectPath);
    const merged = mergeProjectAndCli(level.merged, project?.value, undefined);
    for (const warning of merged.warnings) report.item(m.tightened(warning));
    report.item(m.permissionMode(merged.config.permission?.mode ?? "default"));
    const codemode = describeCodemode(merged.config);
    report.item(m.codemode(codemode.mode, codemode.reason));
    if (codemode.unavailable !== undefined) report.item(`  ${codemode.unavailable}`);
    const os = osSandboxStatus(merged.config.sandbox?.enabled ?? "auto");
    report.item(m.osSandbox(os.kind, os.detail, os.kind !== "none" && !os.restrictsWrites));
    report.item(m.bashSandbox(resolveBashSandbox(merged.config.sandbox, { status: os }).detail));
  } catch {
    // probeLine 已报告
  }
  for (const warning of level.warnings) report.item(m.warning(warning));
  const flag = flags.has("trust") ? true : flags.has("no-trust") ? false : undefined;
  const trusted = trustSection(report, io, level, flag);
  report.section(m.contextTitle);
  const context = findContextFiles({ cwd: io.cwd, configDir: level.configDir });
  if (context.files.length === 0) report.item(m.empty);
  for (const file of context.files)
    report.item(`${file.scope === "user" ? m.contextUser : m.contextProject}  ${file.path}`);
  await keySection(report, io, level, deps);
  hookSection(report, io, level, trusted);
  report.item(m.userHooks(userFile(level, HOOKS_FILE)));
  proxySection(report, io);
  terminalSection(report, io);
  languageLine(report, io, level);
  io.stdout(report.text());
  return report.problems > 0 ? ExitCode.Config : ExitCode.Ok;
}
