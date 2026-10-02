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
import { formatBytes } from "../../checkpoints/gc.js";
import { baseUrlEnvOf } from "../../ai/providers/registry.js";
import { classifyKeyValue, isModeTooOpen, fileMode, readAuthFile } from "../../config/auth-file.js";
import { findContextFiles } from "../../config/context-files.js";
import { loadConfigFile, probeConfigFile } from "../../config/load.js";
import { mergeProjectAndCli } from "../../config/merge.js";
import { CONFIG_FILE, HOOKS_FILE, projectFile, userFile } from "../../config/paths.js";
import { findTrustEntry, readTrustFile, trustGatedResources } from "../../config/trust.js";
import { loadHookConfigs } from "../../hooks/config.js";
import { AMA_VERSION } from "../../version.js";
import { parseSubArgs } from "../args.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { ExitCode } from "../exit-codes.js";
import { describeProxy, inspectProxy } from "../proxy.js";
import { describeCodemode, describeModel } from "./config.js";
import { buildRegistry, loadUserLevel, type UserLevel } from "./context.js";

export const DOCTOR_USAGE = `用法：ama doctor [--profile <文件>] [--auth-file <文件>] [--trust | --no-trust]
`;

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
    report.item(`${label}：${path}（不存在）`);
    return;
  }
  if (!probe.ok) {
    report.problem(`${label}：${probe.messages.join("; ")}`);
    return;
  }
  report.item(`${label}：${path}`);
  for (const message of probe.messages) report.item(`  警告：${message}`);
}

function trustSection(
  report: Report,
  io: CliIo,
  level: UserLevel,
  flag: boolean | undefined,
): boolean {
  report.section("信任");
  let trusted = false;
  let from: string;
  if (flag !== undefined) {
    trusted = flag;
    from = "命令行";
  } else if (level.profile?.trustProject === true) {
    trusted = true;
    from = "profile.trustProject";
  } else {
    try {
      const entry = findTrustEntry(readTrustFile(level.configDir).entries, io.cwd);
      trusted = entry?.trusted ?? false;
      from = entry === undefined ? "缺省：无记录，交互模式会询问" : `trust.json ${entry.path}`;
    } catch (error) {
      report.problem((error as Error).message);
      from = "trust.json 无效";
    }
  }
  report.item(`${io.cwd}：${trusted ? "已信任" : "未信任"}（${from}）`);
  const gated = trustGatedResources(io.cwd);
  if (gated.length > 0) {
    report.item(`需要信任的资源${trusted ? "" : "（当前不加载）"}：`);
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
  report.section("Key 来源（只显示来源，不显示值）");
  try {
    const auth = readAuthFile(level.authFile);
    const mode = fileMode(level.authFile);
    if (!auth.exists) report.item(`auth.json：${level.authFile}（不存在）`);
    else if (isModeTooOpen(mode))
      report.problem(`auth.json 权限 ${mode?.toString(8)}，应为 600：${level.authFile}`);
    else report.item(`auth.json：${level.authFile}`);
  } catch (error) {
    report.problem((error as Error).message);
  }
  if (deps !== undefined) {
    try {
      const registry = await buildRegistry(level, io, deps);
      for (const provider of registry.list()) {
        const key = await registry.resolveApiKey(provider.id);
        const text =
          key.apiKey !== undefined
            ? `${key.source}${key.origin !== undefined ? `（${key.origin}）` : ""}`
            : provider.requiresApiKey
              ? "无"
              : "无需";
        report.item(`${provider.id.padEnd(20)} ${text}`);
        const env = baseUrlEnvOf(registry, provider.id);
        if (env !== undefined)
          report.item(
            `${"".padEnd(20)} baseUrl 来自环境变量 ${env}：${provider.baseUrl}（compat 按保守缺省）`,
          );
      }
      const model = await describeModel(level.merged.config, registry);
      report.item(`将使用的模型：${model.ref ?? "（无）"}（${model.reason}）`);
      return;
    } catch (error) {
      report.problem(`供应商注册表：${(error as Error).message}`);
    }
  }
  // 未装配注册表：按文件与环境变量名列出能看到的来源。
  try {
    for (const [id, entry] of Object.entries(readAuthFile(level.authFile).file.providers)) {
      report.item(`${id.padEnd(20)} auth-file（${classifyKeyValue(entry.apiKey)}）`);
    }
  } catch {
    // 上面已报告
  }
  for (const [id, provider] of Object.entries(level.merged.config.providers ?? {})) {
    if (provider.apiKey !== undefined) {
      report.item(`${id.padEnd(20)} config（${classifyKeyValue(provider.apiKey)}）`);
    }
  }
  const envNames = Object.keys(io.env)
    .filter((n) => /_API_KEY$/.test(n) || n.startsWith("AMA_API_KEY_"))
    .filter((n) => (io.env[n] ?? "") !== "")
    .sort();
  report.item(`环境变量：${envNames.length > 0 ? envNames.join(", ") : "（无）"}`);
}

function hookSection(report: Report, io: CliIo, level: UserLevel, trusted: boolean): void {
  report.section("Hook");
  try {
    const hooks = loadHookConfigs({
      configDir: level.configDir,
      cwd: io.cwd,
      profileHooksFile: level.profile?.hooksFile,
      trusted,
      defaultTimeoutMs: level.merged.config.hooks?.timeoutMs,
    });
    if (hooks.hooks.length === 0) report.item("（无）");
    for (const hook of hooks.hooks) {
      const matcher = hook.matcher !== undefined ? ` [${hook.matcher}]` : "";
      report.item(
        `${hook.source.padEnd(7)} ${hook.event}${matcher} → ${hook.command}（${hook.timeoutMs} ms）`,
      );
    }
    if (hooks.skippedProject !== undefined) {
      report.item(`未信任，跳过：${hooks.skippedProject}`);
    }
  } catch (error) {
    report.problem((error as Error).message);
  }
}

function terminalSection(report: Report, io: CliIo): void {
  report.section("终端");
  const env = io.env;
  report.item(
    `stdin TTY：${io.stdinIsTTY ? "是" : "否"} · stdout TTY：${io.stdoutIsTTY ? "是" : "否"}`,
  );
  report.item(
    `TERM=${env["TERM"] ?? "（未设置）"} · COLORTERM=${env["COLORTERM"] ?? "（未设置）"}`,
  );
  if (env["NO_COLOR"] !== undefined) report.item("NO_COLOR 已设置：不输出颜色");
  if (env["TMUX"] !== undefined) report.item("在 tmux 中运行");
  const columns = process.stdout.columns;
  if (io.stdoutIsTTY && columns !== undefined)
    report.item(`尺寸：${columns}×${process.stdout.rows}`);
  const tui = io.stdinIsTTY && io.stdoutIsTTY && env["TERM"] !== "dumb";
  report.item(`缺省界面：${tui ? "终端界面" : "行式（--no-tui 等价）"}`);
}

function proxySection(report: Report, io: CliIo): void {
  report.section("代理");
  for (const line of describeProxy(inspectProxy(io.env))) report.item(line);
}

/** 检查点备份占用（docs/rewind-plan.md §1.4）。 */
async function fileHistoryLine(report: Report, dataDir: string): Promise<void> {
  try {
    const usage = await blobUsage(dataDir);
    report.item(
      `file-history：${usage.blobs} 个备份，${formatBytes(usage.bytes)}（${fileHistoryDir(dataDir)}；ama sessions prune 清理）`,
    );
  } catch (error) {
    report.item(`file-history：读取失败（${(error as Error).message}）`);
  }
}

export async function runDoctor(
  argv: readonly string[],
  io: CliIo,
  deps: RuntimeDeps | undefined,
): Promise<number> {
  const { values, flags } = parseSubArgs(argv, ["profile", "auth-file"], ["trust", "no-trust"]);
  if (flags.has("help")) {
    io.stdout(DOCTOR_USAGE);
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
  report.section("目录");
  report.item(`配置目录：${level.configDir}`);
  report.item(`数据目录：${level.dataDir}${existsSync(level.dataDir) ? "" : "（尚未创建）"}`);
  await fileHistoryLine(report, level.dataDir);
  report.section("配置层级（缺省 ← 用户级 ← profile ← 项目级（只能收紧）← 命令行）");
  report.item("缺省：内置");
  probeLine(report, "用户级", "config", level.userConfigPath);
  if (level.profile !== undefined) {
    report.item(`profile：${level.profile.path}`);
    if (level.profile.configFile !== undefined)
      probeLine(report, "profile.config", "config", level.profile.configFile);
  }
  const projectPath = projectFile(io.cwd, CONFIG_FILE);
  probeLine(report, "项目级", "config", projectPath);
  try {
    const project = loadConfigFile("config", projectPath);
    const merged = mergeProjectAndCli(level.merged, project?.value, undefined);
    for (const warning of merged.warnings) report.item(`  收紧：${warning}`);
    report.item(`有效权限模式：${merged.config.permission?.mode ?? "default"}`);
    const codemode = describeCodemode(merged.config);
    report.item(`codemode：${codemode.mode}（${codemode.reason}）`);
    if (codemode.unavailable !== undefined) report.item(`  ${codemode.unavailable}`);
  } catch {
    // probeLine 已报告
  }
  for (const warning of level.warnings) report.item(`警告：${warning}`);
  const flag = flags.has("trust") ? true : flags.has("no-trust") ? false : undefined;
  const trusted = trustSection(report, io, level, flag);
  report.section("上下文文件（AGENTS.md，外层在前）");
  const context = findContextFiles({ cwd: io.cwd, configDir: level.configDir });
  if (context.files.length === 0) report.item("（无）");
  for (const file of context.files)
    report.item(`${file.scope === "user" ? "用户级" : "项目"}  ${file.path}`);
  await keySection(report, io, level, deps);
  hookSection(report, io, level, trusted);
  report.item(`用户级 hooks.json：${userFile(level, HOOKS_FILE)}`);
  proxySection(report, io);
  terminalSection(report, io);
  io.stdout(report.text());
  return report.problems > 0 ? ExitCode.Config : ExitCode.Ok;
}
