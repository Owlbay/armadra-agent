/**
 * 启动序列的单步辅助（设计 §11.1）：错误映射、模式判定、profile 合并、会话请求、
 * 模型与思考级别解析、工具过滤、指令文件。[B5] 由 cli/bootstrap.ts 编排。
 */

import { describeLookupFailure } from "../ai/providers/suggest.js";
import { formatModelRef } from "../ai/providers/channels.js";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Model, ModelThinkingLevel, ProviderData, ProviderRegistryApi } from "../ai/types.js";
import type { AgentSession } from "../agent/types.js";
import type { ProfileOptions } from "../config/profile.js";
import { AmaError, StartupError, isAmaError } from "../errors.js";
import type { InstructionSource } from "../host/types.js";
import type { SessionEntry, SessionManagerApi } from "../session/types.js";
import { UsageError, type ParsedArgs } from "./args.js";
import { noModelGuidance, pickDefaultModel } from "./default-model.js";
import { hideFakeProvider } from "./fake-visibility.js";
import type { CliIo, RuntimeDeps, SessionAssembly, SessionRequest } from "./deps.js";
import { ExitCode } from "./exit-codes.js";
import type { Runtime, RuntimeMode } from "./runtime.js";

/** 把非 StartupError 包成指定退出码；StartupError / UsageError 原样透传。 */
export async function step<T>(
  exitCode: number,
  label: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toStartupError(error, exitCode, label);
  }
}

const CODE_EXIT: Readonly<Record<string, number>> = {
  session_not_found: ExitCode.Session,
  session_corrupt: ExitCode.Session,
  model_not_found: ExitCode.NoModel,
  provider_not_found: ExitCode.NoModel,
  no_api_key: ExitCode.NoModel,
  config_invalid: ExitCode.Config,
  profile_invalid: ExitCode.Config,
  tool_not_found: ExitCode.Usage,
  host_load_failed: ExitCode.HostOrHook,
  host_version_mismatch: ExitCode.HostVersion,
  hook_failed: ExitCode.HostOrHook,
};

export function toStartupError(error: unknown, exitCode: number, label: string): AmaError {
  if (error instanceof StartupError || error instanceof UsageError) return error;
  if (isAmaError(error)) {
    const mapped = error.exitCode ?? CODE_EXIT[error.code] ?? exitCode;
    return new StartupError(error.code, error.message, mapped, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new StartupError("startup_failed", `${label}：${message}`, exitCode, { cause: error });
}

/** 第 4 步。 */
export function decideMode(
  args: ParsedArgs,
  io: Pick<CliIo, "stdinIsTTY" | "stdoutIsTTY" | "env">,
): RuntimeMode {
  if (args.mode === "rpc") return "rpc";
  if (args.print) return "print";
  if (args.noTui || !io.stdinIsTTY || !io.stdoutIsTTY || io.env["TERM"] === "dumb") return "line";
  return "interactive";
}

/** 第 3 步：profile 字段等价于参数，命令行显式参数优先。 */
export function applyProfile(args: ParsedArgs, profile: ProfileOptions): ParsedArgs {
  const merged: ParsedArgs = { ...args };
  if (merged.host === undefined && profile.host !== undefined) merged.host = profile.host;
  if (merged.authFile === undefined && profile.authFile !== undefined)
    merged.authFile = profile.authFile;
  if (merged.sessionDir === undefined && profile.sessionDir !== undefined)
    merged.sessionDir = profile.sessionDir;
  if (merged.trust === undefined && profile.trustProject) merged.trust = true;
  merged.instructions = [...profile.instructions, ...args.instructions];
  merged.skillDirs = [...args.skillDirs, ...profile.skillDirs];
  return merged;
}

export function sessionRequestOf(args: ParsedArgs): SessionRequest | "pick" {
  if (args.noSession) return { kind: "memory" };
  if (args.continue) return { kind: "continue" };
  if (args.resume)
    return args.resumeId === undefined ? "pick" : { kind: "resume", id: args.resumeId };
  if (args.sessionId !== undefined) return { kind: "session-id", id: args.sessionId };
  if (args.fork !== undefined) return { kind: "fork", id: args.fork };
  return { kind: "new" };
}

export function sourceOf(
  request: SessionRequest,
  manager: SessionManagerApi,
): SessionAssembly["source"] {
  if (request.kind === "fork") return "fork";
  if (request.kind === "new" || request.kind === "memory") return "startup";
  return manager.entries().length > 0 ? "resume" : "startup";
}

export function lastEntry(
  manager: SessionManagerApi,
  predicate: (entry: SessionEntry) => boolean,
): SessionEntry | undefined {
  const branch = manager.branch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry !== undefined && predicate(entry)) return entry;
  }
  return undefined;
}

export interface ModelChoice {
  model: Model;
  provider: ProviderData;
}

/** 第 11 步：解析模型与 key。 */
export async function resolveModel(
  args: ParsedArgs,
  registry: ProviderRegistryApi,
  manager: SessionManagerApi,
  defaultModel: string | undefined,
  deps: RuntimeDeps,
  interactive: boolean,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<ModelChoice> {
  if (args.provider !== undefined && args.model === undefined) {
    throw new UsageError(
      `--provider ${args.provider} 需要同时给出 --model（不回退到该供应商的缺省模型）`,
    );
  }
  const lookup = (ref: string, label: string): ModelChoice => {
    const found = registry.findModel(ref);
    if (found.ok) return { model: found.model, provider: found.provider };
    const code = found.reason === "provider_not_found" ? "provider_not_found" : "model_not_found";
    throw new StartupError(code, `${label}${describeLookupFailure(ref, found)}`, ExitCode.NoModel);
  };
  let choice: ModelChoice | undefined;
  if (args.model !== undefined) {
    const ref =
      args.provider !== undefined && !args.model.includes("/")
        ? `${args.provider}/${args.model}`
        : args.model;
    choice = lookup(ref, "");
  } else {
    const change = lastEntry(manager, (e) => e.type === "model_change");
    if (change?.type === "model_change") {
      const found = registry.findModel(
        formatModelRef({
          provider: change.provider,
          id: change.modelId,
          ...(change.channel !== undefined ? { channel: change.channel } : {}),
        }),
      );
      if (found.ok) choice = { model: found.model, provider: found.provider };
    }
    if (choice === undefined && defaultModel !== undefined)
      choice = lookup(defaultModel, "config.defaultModel ");
    if (choice === undefined) {
      const picked = await pickDefaultModel(registry);
      if (picked !== undefined) choice = { model: picked.model, provider: picked.provider };
    }
  }
  const pick = async (reason: string): Promise<ModelChoice> => {
    // 选择器不列测试供应商 fake（AMA_SHOW_FAKE=1 或 AMA_FAKE_SCRIPT 时照列）
    const picked = interactive
      ? await deps.ui?.pickModel?.(hideFakeProvider(registry, env), reason)
      : undefined;
    if (picked === undefined) throw new StartupError("no_api_key", reason, ExitCode.NoModel);
    return lookup(picked, "");
  };
  if (choice === undefined) {
    return pick(noModelGuidance(registry));
  }
  if (choice.provider.requiresApiKey) {
    const key = await registry.resolveApiKey(choice.provider.id);
    if (key.apiKey === undefined) {
      const envs =
        choice.provider.envKeys.length > 0
          ? `，或设置环境变量 ${choice.provider.envKeys.join(" / ")}`
          : "";
      return pick(
        `供应商 ${choice.provider.id} 没有 API key：运行 \`ama auth set ${choice.provider.id}\`${envs}`,
      );
    }
  }
  return choice;
}

export function thinkingOf(
  args: ParsedArgs,
  manager: SessionManagerApi,
  fallback: ModelThinkingLevel | undefined,
): ModelThinkingLevel {
  if (args.thinking !== undefined) return args.thinking;
  const change = lastEntry(manager, (e) => e.type === "thinking_level_change");
  if (change?.type === "thinking_level_change") return change.thinkingLevel;
  return fallback ?? "medium";
}

/** 第 12 步之后：`--tools` / `--exclude-tools`（宿主工具注册后再校验，宿主工具名也可用）。 */
export function applyToolFilters(args: ParsedArgs, runtimeTools: Runtime["tools"]): void {
  const unknown = [...(args.tools ?? []), ...(args.excludeTools ?? [])].filter(
    (n) => runtimeTools.get(n) === undefined,
  );
  if (unknown.length > 0) {
    throw new UsageError(
      `未知工具：${unknown.join(", ")}（可用：${runtimeTools.list().join(", ")}）`,
    );
  }
  if (args.tools !== undefined) runtimeTools.setActive(args.tools);
  for (const name of args.excludeTools ?? []) runtimeTools.disable(name);
}

export function instructionSources(paths: readonly string[], cwd: string): InstructionSource[] {
  return paths.map((p) => {
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    let ok = false;
    try {
      ok = statSync(abs).isFile();
    } catch {
      ok = false;
    }
    if (!ok)
      throw new StartupError(
        "config_invalid",
        `--instructions 文件不存在：${abs}`,
        ExitCode.Config,
      );
    return { kind: "file", path: abs };
  });
}

/** 宿主 `messages.sendUser` 的缺省实现：运行中 steer，空闲时 prompt；origin 原样落盘到 user 消息。 */
export async function defaultSendUser(
  session: AgentSession,
  text: string,
  origin?: string,
): Promise<"started" | "queued"> {
  const tagged = origin !== undefined ? { origin } : {};
  if (session.state.isStreaming) {
    await session.steer(text, tagged);
    return "queued";
  }
  void session.prompt(text, { streamingBehavior: "steer", ...tagged }).catch(() => undefined);
  return "started";
}
