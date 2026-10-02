/**
 * 启动序列编排（设计 §11.1 第 3–16 步、§11.2）。[B5]
 *
 * `bootstrap(args, deps, io)` 跑第 3–14 步并返回 Runtime（SDK `createRuntime()` 复用）；
 * `runCli(argv, deps, io)` 在其前后加上第 2 步（参数）与第 15–16 步（模式分派），返回退出码。
 * 每步失败抛 `StartupError{exitCode}`；具体实现经 RuntimeDeps 注入（见 cli/deps.ts）。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentSession } from "../agent/types.js";
import { defaultAuthFilePath } from "../config/auth-file.js";
import { findContextFiles } from "../config/context-files.js";
import { loadConfigFile } from "../config/load.js";
import { mergeBaseLayers, mergeProjectAndCli } from "../config/merge.js";
import { CONFIG_FILE, ensurePaths, projectFile, resolvePaths, userFile } from "../config/paths.js";
import { loadProfile, type ProfileOptions } from "../config/profile.js";
import { decideTrust } from "../config/trust.js";
import { AmaError, StartupError, isAmaError } from "../errors.js";
import { loadHookConfigs } from "../hooks/config.js";
import { HookDispatcher } from "../hooks/dispatcher.js";
import { AgentEventBus, createHostApi } from "../host/api-impl.js";
import { activateHost, disposeHost } from "../host/loader.js";
import type { ApprovalBroker, HostAdapterHandle } from "../host/types.js";
import { helpText, parseArgs, UsageError, type ParsedArgs } from "./args.js";
import { applyFromOption } from "./from-prompt.js";
import type { CliIo, RuntimeDeps, SessionAssembly } from "./deps.js";
import { ExitCode } from "./exit-codes.js";
import {
  applyProfile,
  applyToolFilters,
  decideMode,
  defaultSendUser,
  instructionSources,
  resolveModel,
  sessionRequestOf,
  sourceOf,
  step,
  thinkingOf,
  toStartupError,
} from "./startup-steps.js";
import type { LoadedResources, Runtime } from "./runtime.js";
import { resolveSystemPromptArg } from "./system-prompt-arg.js";
import { msg, resolveLocale, setLocale } from "../i18n/index.js";

/** §11.1 第 3–14 步。 */
export async function bootstrap(
  argsIn: ParsedArgs,
  deps: RuntimeDeps,
  io: CliIo,
): Promise<Runtime> {
  // 文案按调用时的语言取（第 9 步可能按 profile / 项目级 ui.language 补定语言）
  const m = (): ReturnType<typeof msg>["cli"]["bootstrap"] => msg().cli.bootstrap;
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
  };
  // 3. profile
  let args = argsIn;
  let profile: ProfileOptions | undefined;
  if (args.profile !== undefined) {
    const profilePath = args.profile;
    profile = await step(ExitCode.Config, "profile", () => loadProfile(profilePath, io.cwd));
    warnings.push(...profile.warnings);
    args = applyProfile(args, profile);
  }
  // 4. 模式
  const mode = decideMode(args, io);
  const interactive = mode === "interactive" || mode === "line";
  // 5. 目录
  const paths = await step(ExitCode.Config, m().steps.dirs, () => {
    const resolved = resolvePaths({ env: io.env, cwd: io.cwd, sessionDirFlag: args.sessionDir });
    ensurePaths(resolved);
    return resolved;
  });
  // 6. 用户级 + profile.config
  const base = await step(ExitCode.Config, m().steps.config, () => {
    const user = loadConfigFile("config", userFile(paths, CONFIG_FILE));
    if (user !== undefined) warnings.push(...user.warnings);
    return mergeBaseLayers({
      user: user?.value,
      profile: profile?.config,
      hasProfile: profile !== undefined,
    });
  });
  // 7. 会话
  let request = sessionRequestOf(args);
  if (request === "pick") {
    if (!interactive || deps.ui?.pickSession === undefined || deps.sessions.list === undefined) {
      throw new UsageError(m().resumeNeedsId);
    }
    const items = await step(
      ExitCode.Session,
      m().steps.sessionList,
      () => deps.sessions.list?.({ sessionDir: paths.sessionDir, cwd: paths.cwd }) ?? [],
    );
    const id = await deps.ui.pickSession(items);
    if (id === undefined)
      throw new StartupError("session_not_found", m().noSessionPicked, ExitCode.Session);
    request = { kind: "resume", id };
  }
  const sessionRequest = request;
  const sessionManager = await step(ExitCode.Session, m().steps.session, () =>
    deps.sessions.open(sessionRequest, { sessionDir: paths.sessionDir, cwd: paths.cwd }),
  );
  let sessionCwd = sessionManager.cwd;
  if (!existsSync(sessionCwd)) {
    const replacement = interactive ? await deps.ui?.askCwd?.(sessionCwd) : undefined;
    if (replacement === undefined) {
      throw new StartupError(
        "session_corrupt",
        m().sessionCwdMissing(sessionCwd),
        ExitCode.Session,
      );
    }
    sessionCwd = resolve(replacement);
  }
  const runtimePaths = { ...paths, cwd: sessionCwd };
  // 8. 信任（以会话 cwd 为准）
  const trust = await step(ExitCode.Config, m().steps.trust, () =>
    decideTrust({
      cwd: sessionCwd,
      configDir: paths.configDir,
      flag: args.trust,
      profileTrust: profile?.trustProject,
      interactive,
      prompt: deps.ui?.promptTrust,
    }),
  );
  // 9. 项目级配置（只能收紧）+ 命令行
  const merged = await step(ExitCode.Config, m().steps.projectConfig, () => {
    const project = loadConfigFile("config", projectFile(sessionCwd, CONFIG_FILE));
    if (project !== undefined) warnings.push(...project.warnings);
    return mergeProjectAndCli(base, project?.value, {
      thinkingLevel: args.thinking,
      permissionMode: args.permissionMode,
      allow: args.allow,
      deny: args.deny,
      quietStartup: args.quietStartup,
      tuiMode: args.tuiMode,
      toolsPreset: args.toolsPreset,
      codemode: args.codemode,
      memory: args.memory,
    });
  });
  warnings.push(...merged.warnings);
  const config = merged.config;
  // [W6-C0] main.ts 只看了用户级；profile 的 language 与合并后的 ui.language 在这里补定（AMA_LANG / --lang 仍优先）
  const language = profile?.language ?? config.ui?.language;
  if (language === "zh" || language === "en")
    setLocale(resolveLocale(io.env, { language }, args.lang));
  // 10. 资源发现
  const context = findContextFiles({ cwd: sessionCwd, configDir: paths.configDir });
  warnings.push(...context.warnings);
  const discovered =
    deps.resources === undefined
      ? { skills: [], prompts: [], warnings: [] }
      : await step(
          ExitCode.Config,
          m().steps.skillDiscovery,
          () =>
            deps.resources?.discover({
              cwd: sessionCwd,
              configDir: paths.configDir,
              trusted: trust.trusted,
              extraSkillDirs: [...args.skillDirs, ...(config.skills?.dirs ?? [])],
              promptDirs: profile?.promptDirs ?? [],
              dataDir: paths.dataDir,
            }) ?? { skills: [], prompts: [], warnings: [] },
        );
  warnings.push(...discovered.warnings);
  const hookConfig = await step(ExitCode.Config, "hooks.json", () =>
    loadHookConfigs({
      configDir: paths.configDir,
      cwd: sessionCwd,
      profileHooksFile: profile?.hooksFile,
      trusted: trust.trusted,
      defaultTimeoutMs: config.hooks?.timeoutMs,
    }),
  );
  warnings.push(...hookConfig.warnings);
  const instructions = instructionSources(args.instructions, io.cwd);
  const resources: LoadedResources = {
    contextFiles: context.files.map((f) => ({ path: f.path, content: f.content })),
    skills: discovered.skills,
    prompts: discovered.prompts,
    instructions,
  };
  // 11. 供应商与模型
  const providers = await step(ExitCode.Config, m().steps.providers, () =>
    deps.providers.create({
      config,
      cwd: sessionCwd,
      authFile:
        args.authFile !== undefined
          ? resolve(io.cwd, args.authFile)
          : defaultAuthFilePath(paths.configDir),
      authEnv: profile?.authEnv ?? true,
      dataDir: paths.dataDir,
      ...(args.apiKey !== undefined && args.model !== undefined
        ? {
            cliApiKey: {
              apiKey: args.apiKey,
              modelRef: args.model,
              ...(args.provider !== undefined ? { provider: args.provider } : {}),
            },
          }
        : {}),
    }),
  );
  const { model, provider } = await step(ExitCode.NoModel, m().steps.model, () =>
    resolveModel(args, providers, sessionManager, config.defaultModel, deps, interactive, io.env),
  );
  const thinkingLevel = thinkingOf(args, sessionManager, config.thinkingLevel);
  // 12. 工具注册表
  const tools = await step(ExitCode.RuntimeError, m().steps.tools, () =>
    deps.tools.create({
      config,
      cwd: sessionCwd,
      mode,
      paths: { configDir: paths.configDir, dataDir: paths.dataDir },
    }),
  );
  for (const name of config.tools?.disabled ?? []) {
    if (tools.get(name) === undefined) warn(m().unknownDisabledTool(name));
    else tools.disable(name);
  }
  // 13. 宿主适配器
  let session: AgentSession | undefined;
  const events = new AgentEventBus((level, message, detail) => {
    if (level === "warn" || level === "error")
      warn(m().eventWarning(message, detail instanceof Error ? detail.message : undefined));
  });
  const binding = createHostApi({
    mode,
    env: io.env as NodeJS.ProcessEnv,
    session: {
      id: () => session?.state.sessionId ?? sessionManager.id,
      file: () => (session !== undefined ? session.state.sessionFile : sessionManager.file()),
      cwd: () => session?.state.cwd ?? sessionCwd,
      model: () => session?.state.model ?? { provider: model.provider, id: model.id },
    },
    tools,
    bus: events,
    sendUser: (text, origin) => {
      if (session === undefined) return Promise.reject(new AmaError("busy", m().sessionNotReady));
      return (deps.sendUser ?? defaultSendUser)(session, text, origin);
    },
    stderr: io.stderr,
  });
  let uiBroker: ApprovalBroker | undefined;
  const hostSpec = args.host;
  let host: HostAdapterHandle | undefined;
  if (hostSpec !== undefined) {
    host = await step(ExitCode.HostOrHook, m().steps.host, () =>
      activateHost({ module: hostSpec, binding, cwd: io.cwd }),
    );
  }
  let shutdown: ((reason: "exit" | "new" | "switch") => Promise<void>) | undefined;
  try {
    applyToolFilters(args, tools);
    // 14. 组装 AgentSession、session_start、SessionStart Hook
    const unattended = mode === "print";
    const builtinDeny = config.permission?.builtinDeny;
    const autoSafeCommands = config.permission?.autoSafeCommands;
    const permission = await step(ExitCode.Config, m().steps.permission, () =>
      deps.permissions.create({
        mode: config.permission?.mode ?? "default",
        rules: merged.ruleSpecs,
        unattended,
        cwd: sessionCwd,
        ...(builtinDeny !== undefined ? { builtinDeny } : {}),
        ...(autoSafeCommands !== undefined ? { autoSafeCommands } : {}),
      }),
    );
    const hooks = new HookDispatcher({
      hooks: hookConfig.hooks,
      context: () => ({
        sessionId: session?.state.sessionId ?? sessionManager.id,
        ...((session?.state.sessionFile ?? sessionManager.file()) !== undefined
          ? { sessionFile: (session?.state.sessionFile ?? sessionManager.file()) as string }
          : {}),
        cwd: session?.state.cwd ?? sessionCwd,
        model: session?.state.model ?? { provider: model.provider, id: model.id },
        permissionMode: session?.state.permissionMode ?? permission.mode,
        depth: 0,
        ...(host !== undefined ? { host: host.adapter.id } : {}),
      }),
      onExecuted: (r) =>
        void events.emit("hook_executed", {
          event: r.event,
          command: r.command,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
        }),
      onWarning: warn,
    });
    let sessionStartContext: string | undefined;
    const source = sourceOf(sessionRequest, sessionManager);
    const assembly: SessionAssembly = {
      mode,
      paths: runtimePaths,
      config,
      trust,
      resources,
      providers,
      model,
      provider,
      thinkingLevel,
      sessionManager,
      source,
      hooks,
      permission,
      tools,
      events,
      host: {
        handle: host,
        broker: binding.broker,
        instructions: binding.instructions,
        warmingDecider: binding.warmingDecider,
      },
      uiBroker: () => uiBroker,
      onSessionReplaced: (next) => {
        session = next;
      },
      sessionStartContext: () => sessionStartContext,
      unattended,
      warn,
    };
    const overrides: NonNullable<SessionAssembly["overrides"]> = {};
    if (args.maxTurns !== undefined) overrides.maxTurns = args.maxTurns;
    // [W5-H2] --max-cost 由 limits 扩展执行（agent/limits.ts）
    if (args.maxCostUsd !== undefined) overrides.maxCostUsd = args.maxCostUsd;
    if (args.agentDirs !== undefined) overrides.agentDirs = [...args.agentDirs];
    if (args.noSession) overrides.noSession = true;
    const systemPrompt = await step(ExitCode.Config, "--system-prompt", () =>
      resolveSystemPromptArg(args.systemPrompt, args.systemPromptMode, io.cwd),
    );
    if (systemPrompt !== undefined) overrides.systemPrompt = systemPrompt;
    if (Object.keys(overrides).length > 0) assembly.overrides = overrides;
    session = await step(ExitCode.RuntimeError, m().steps.assembly, () =>
      deps.session.create(assembly),
    );
    const active = session;
    let disposed: Promise<void> | undefined;
    shutdown = (reason) => {
      disposed ??= (async () => {
        await events.emit("session_shutdown", {});
        await hooks.run("SessionEnd", { reason }).catch(() => undefined);
        await disposeHost(host, (e) => warn(m().hostDisposeFailed(String(e))));
        // 会话被替换过时 dispose 当前那个（旧会话由替换方负责）
        await (session ?? active).dispose();
      })();
      return disposed;
    };
    await events.emit("session_start", {
      sessionId: active.state.sessionId,
      ...(active.state.sessionFile !== undefined ? { sessionFile: active.state.sessionFile } : {}),
      cwd: active.state.cwd,
      reason: source,
    });
    const outcome = await hooks.run("SessionStart", { source });
    if (outcome.decision === "block") {
      throw new StartupError(
        "hook_failed",
        m().sessionStartBlocked(outcome.reason),
        ExitCode.HostOrHook,
      );
    }
    sessionStartContext = outcome.additionalContext;
    const finalShutdown = shutdown;
    return {
      mode,
      paths: runtimePaths,
      config,
      trust,
      resources,
      providers,
      model,
      thinkingLevel,
      sessionManager,
      session: active,
      hooks,
      host,
      permission,
      tools,
      approvals: {
        setUiBroker: (broker) => {
          uiBroker = broker;
        },
      },
      notifier: { set: (fn) => binding.setNotify(fn) },
      warnings,
      dispose: (reason = "exit") => finalShutdown(reason),
    };
  } catch (error) {
    if (shutdown !== undefined) await shutdown("exit").catch(() => undefined);
    else await disposeHost(host);
    throw toStartupError(error, ExitCode.RuntimeError, m().steps.startup);
  }
}

/** 非交互模式接管 stdout：console.log / info / debug 改写到 stderr；返回还原函数。 */
export function takeOverStdout(): () => void {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  console.log = console.info = console.debug = (...items: unknown[]) => console.error(...items);
  return () => {
    console.log = saved.log;
    console.info = saved.info;
    console.debug = saved.debug;
  };
}

export function isTerminalInitError(error: unknown): boolean {
  return isAmaError(error) && error.code === "terminal_init_failed";
}

/** 第 2–16 步：参数 → bootstrap → 模式；返回退出码（不含子命令）。 */
export async function runCli(
  argv: readonly string[],
  deps: RuntimeDeps | undefined,
  io: CliIo,
): Promise<number> {
  let args: ParsedArgs;
  try {
    const parsed = parseArgs(argv);
    if (parsed.kind !== "run") throw new UsageError(msg().cli.bootstrap.subcommandNotDispatched);
    args = parsed.args;
  } catch (error) {
    return reportError(error, io);
  }
  if (args.help) {
    io.stdout(helpText());
    return ExitCode.Ok;
  }
  // [W5-E] --mode acp：装配同 rpc（宿主看到的 mode 也是 rpc），分派到 ACP 服务端
  const acp = args.mode === "acp";
  if (acp) args = { ...args, mode: "rpc" };
  if (deps === undefined) {
    io.stderr(msg().cli.bootstrap.runtimeNotAssembled);
    return ExitCode.RuntimeError;
  }
  let runtime: Runtime;
  try {
    runtime = await bootstrap(args, deps, io);
  } catch (error) {
    return reportError(error, io);
  }
  const restore =
    runtime.mode === "print" || runtime.mode === "rpc" ? takeOverStdout() : () => undefined;
  let cleanupFrom = (): void => undefined;
  try {
    if (runtime.mode !== "interactive")
      for (const w of runtime.warnings) io.stderr(msg().cli.bootstrap.warning(w));
    // [W4-D] --from：旧会话的一条用户消息作提示（-p 时连图片，临时文件在 finally 删除）。
    const from = applyFromOption(args, runtime, io);
    cleanupFrom = from.cleanup;
    const context = from.context;
    const runner = acp
      ? (await import("../modes/acp/acp-mode.js")).runAcpMode
      : deps.modes[runtime.mode];
    if (runner === undefined)
      throw new AmaError("not_implemented", msg().cli.bootstrap.modeNotAssembled(runtime.mode), {
        exitCode: 1,
      });
    try {
      return await runner(runtime, context);
    } catch (error) {
      const line = deps.modes.line;
      if (runtime.mode !== "interactive" || !isTerminalInitError(error) || line === undefined)
        throw error;
      io.stderr(msg().cli.bootstrap.terminalFallback((error as Error).message));
      return await line(runtime, context);
    }
  } catch (error) {
    return reportError(error, io, ExitCode.RuntimeError);
  } finally {
    await runtime.dispose("exit").catch(() => undefined);
    cleanupFrom();
    restore();
  }
}

export function reportError(
  error: unknown,
  io: Pick<CliIo, "stderr">,
  fallback: number = ExitCode.RuntimeError,
): number {
  if (error instanceof UsageError) {
    io.stderr(msg().cli.bootstrap.usageError(error.message));
    return ExitCode.Usage;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.stderr(`ama: ${message}\n`);
  if (isAmaError(error) && error.exitCode !== undefined) return error.exitCode;
  return fallback;
}
