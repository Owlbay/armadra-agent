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
import { HELP_TEXT, parseArgs, UsageError, type ParsedArgs } from "./args.js";
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

/** §11.1 第 3–14 步。 */
export async function bootstrap(
  argsIn: ParsedArgs,
  deps: RuntimeDeps,
  io: CliIo,
): Promise<Runtime> {
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
  const paths = await step(ExitCode.Config, "目录", () => {
    const resolved = resolvePaths({ env: io.env, cwd: io.cwd, sessionDirFlag: args.sessionDir });
    ensurePaths(resolved);
    return resolved;
  });
  // 6. 用户级 + profile.config
  const base = await step(ExitCode.Config, "配置", () => {
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
      throw new UsageError("--resume 在非交互模式下需要会话 id");
    }
    const items = await step(
      ExitCode.Session,
      "会话列表",
      () => deps.sessions.list?.({ sessionDir: paths.sessionDir, cwd: paths.cwd }) ?? [],
    );
    const id = await deps.ui.pickSession(items);
    if (id === undefined)
      throw new StartupError("session_not_found", "未选择会话", ExitCode.Session);
    request = { kind: "resume", id };
  }
  const sessionRequest = request;
  const sessionManager = await step(ExitCode.Session, "会话", () =>
    deps.sessions.open(sessionRequest, { sessionDir: paths.sessionDir, cwd: paths.cwd }),
  );
  let sessionCwd = sessionManager.cwd;
  if (!existsSync(sessionCwd)) {
    const replacement = interactive ? await deps.ui?.askCwd?.(sessionCwd) : undefined;
    if (replacement === undefined) {
      throw new StartupError(
        "session_corrupt",
        `会话的工作目录不存在：${sessionCwd}`,
        ExitCode.Session,
      );
    }
    sessionCwd = resolve(replacement);
  }
  const runtimePaths = { ...paths, cwd: sessionCwd };
  // 8. 信任（以会话 cwd 为准）
  const trust = await step(ExitCode.Config, "信任", () =>
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
  const merged = await step(ExitCode.Config, "项目配置", () => {
    const project = loadConfigFile("config", projectFile(sessionCwd, CONFIG_FILE));
    if (project !== undefined) warnings.push(...project.warnings);
    return mergeProjectAndCli(base, project?.value, {
      thinkingLevel: args.thinking,
      permissionMode: args.permissionMode,
      allow: args.allow,
      deny: args.deny,
      quietStartup: args.quietStartup,
      tuiMode: args.tuiMode,
    });
  });
  warnings.push(...merged.warnings);
  const config = merged.config;
  // 10. 资源发现
  const context = findContextFiles({ cwd: sessionCwd, configDir: paths.configDir });
  warnings.push(...context.warnings);
  const discovered =
    deps.resources === undefined
      ? { skills: [], prompts: [], warnings: [] }
      : await step(
          ExitCode.Config,
          "Skill 发现",
          () =>
            deps.resources?.discover({
              cwd: sessionCwd,
              configDir: paths.configDir,
              trusted: trust.trusted,
              extraSkillDirs: [...args.skillDirs, ...(config.skills?.dirs ?? [])],
              promptDirs: profile?.promptDirs ?? [],
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
  const providers = await step(ExitCode.Config, "供应商", () =>
    deps.providers.create({
      config,
      cwd: sessionCwd,
      authFile:
        args.authFile !== undefined
          ? resolve(io.cwd, args.authFile)
          : defaultAuthFilePath(paths.configDir),
      authEnv: profile?.authEnv ?? true,
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
  const { model, provider } = await step(ExitCode.NoModel, "模型", () =>
    resolveModel(args, providers, sessionManager, config.defaultModel, deps, interactive),
  );
  const thinkingLevel = thinkingOf(args, sessionManager, config.thinkingLevel);
  // 12. 工具注册表
  const tools = await step(ExitCode.RuntimeError, "工具", () =>
    deps.tools.create({ config, cwd: sessionCwd, mode }),
  );
  for (const name of config.tools?.disabled ?? []) {
    if (tools.get(name) === undefined) warn(`config tools.disabled：未知工具 ${name}，已忽略`);
    else tools.disable(name);
  }
  // 13. 宿主适配器
  let session: AgentSession | undefined;
  const events = new AgentEventBus((level, message, detail) => {
    if (level === "warn" || level === "error")
      warn(`${message}${detail instanceof Error ? `：${detail.message}` : ""}`);
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
      if (session === undefined) return Promise.reject(new AmaError("busy", "会话尚未就绪"));
      return (deps.sendUser ?? defaultSendUser)(session, text, origin);
    },
    stderr: io.stderr,
  });
  let uiBroker: ApprovalBroker | undefined;
  const hostSpec = args.host;
  let host: HostAdapterHandle | undefined;
  if (hostSpec !== undefined) {
    host = await step(ExitCode.HostOrHook, "宿主适配器", () =>
      activateHost({ module: hostSpec, binding, cwd: io.cwd }),
    );
  }
  let shutdown: ((reason: "exit" | "new" | "switch") => Promise<void>) | undefined;
  try {
    applyToolFilters(args, tools);
    // 14. 组装 AgentSession、session_start、SessionStart Hook
    const unattended = mode === "print";
    const permission = await step(ExitCode.Config, "权限", () =>
      deps.permissions.create({
        mode: config.permission?.mode ?? "default",
        rules: merged.ruleSpecs,
        unattended,
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
      host: { handle: host, broker: binding.broker, instructions: binding.instructions },
      uiBroker: () => uiBroker,
      sessionStartContext: () => sessionStartContext,
      unattended,
      warn,
    };
    session = await step(ExitCode.RuntimeError, "会话组装", () => deps.session.create(assembly));
    const active = session;
    let disposed: Promise<void> | undefined;
    shutdown = (reason) => {
      disposed ??= (async () => {
        await events.emit("session_shutdown", {});
        await hooks.run("SessionEnd", { reason }).catch(() => undefined);
        await disposeHost(host, (e) => warn(`宿主适配器 dispose 失败：${String(e)}`));
        await active.dispose();
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
        `SessionStart Hook 阻止启动：${outcome.reason ?? "（无原因）"}`,
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
    throw toStartupError(error, ExitCode.RuntimeError, "启动");
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
    if (parsed.kind !== "run") throw new UsageError("子命令应由 main 分派");
    args = parsed.args;
  } catch (error) {
    return reportError(error, io);
  }
  if (args.help) {
    io.stdout(HELP_TEXT);
    return ExitCode.Ok;
  }
  if (deps === undefined) {
    io.stderr("ama: 运行时尚未装配（集成批次通过 registerRuntimeDeps 注入实现）\n");
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
  try {
    if (runtime.mode !== "interactive")
      for (const w of runtime.warnings) io.stderr(`ama: 警告：${w}\n`);
    const context = { args, prompt: args.prompt, io };
    const runner = deps.modes[runtime.mode];
    if (runner === undefined)
      throw new AmaError("not_implemented", `模式 ${runtime.mode} 尚未装配`, { exitCode: 1 });
    try {
      return await runner(runtime, context);
    } catch (error) {
      const line = deps.modes.line;
      if (runtime.mode !== "interactive" || !isTerminalInitError(error) || line === undefined)
        throw error;
      io.stderr(`ama: 警告：终端初始化失败，降级为行式界面（${(error as Error).message}）\n`);
      return await line(runtime, context);
    }
  } catch (error) {
    return reportError(error, io, ExitCode.RuntimeError);
  } finally {
    await runtime.dispose("exit").catch(() => undefined);
    restore();
  }
}

export function reportError(
  error: unknown,
  io: Pick<CliIo, "stderr">,
  fallback: number = ExitCode.RuntimeError,
): number {
  if (error instanceof UsageError) {
    io.stderr(`ama: ${error.message}\n（ama --help 查看用法）\n`);
    return ExitCode.Usage;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.stderr(`ama: ${message}\n`);
  if (isAmaError(error) && error.exitCode !== undefined) return error.exitCode;
  return fallback;
}
