/**
 * `ama auth set|list|remove <provider>`（设计 §3.5、§16.2 B5 验收）。[B5]
 * `ama auth login|logout|status chatgpt`（docs/history/wave6-plan.md §4.2）。[W6-O] 实现在 auth/chatgpt/cli.ts。
 *
 * - set：key 从 stdin 读取（TTY 下不回显），不经命令行参数，避免进 shell 历史；写 auth.json 0600。
 *   [ACP-A] 不给 provider 且 stdin 是 TTY 时先用方向键选内置的需 key 供应商（ACP 终端登录方法
 *   `ama auth set` 就这样跑）；非 TTY 仍是用法错误。
 * - list：只列供应商与 key 形态（字面量 / `!command` / `$ENV` 引用 / oauth 的 flavor 与计划），从不输出 key 或 token。
 * - `--auth-file <path>` 改变目标文件（缺省 `<configDir>/auth.json`）。
 */

import { resolve } from "node:path";
import { BUILTIN_PROVIDERS } from "../../ai/providers/builtin.js";
import { runLogin, runLogout, runStatus, type AuthCliDeps } from "../../auth/chatgpt/cli.js";
import {
  PROVIDER_ID_PATTERN,
  defaultAuthFilePath,
  describeAuthFile,
  readAuthFile,
  removeAuthKey,
  setAuthKey,
  type AuthEntrySummary,
} from "../../config/auth-file.js";
import { resolveConfigDir } from "../../config/paths.js";
import { msg } from "../../i18n/index.js";
import { parseSubArgs, UsageError } from "../args.js";
import { canPromptChoice, promptChoice, type ChoiceOption } from "../choice-prompt.js";
import type { CliIo } from "../deps.js";
import { ExitCode } from "../exit-codes.js";

/** 用法文本（按当前语言）。 */
export function authUsage(): string {
  return msg().auth.usage;
}

function kindText(entry: AuthEntrySummary): string {
  const kind = msg().auth.kind;
  switch (entry.kind) {
    case "literal":
      return kind.literal;
    case "command":
      return kind.command;
    case "env-ref":
      return kind.envRef;
    case "oauth":
      return entry.flavor === undefined
        ? kind.oauth
        : `${kind.oauth} · ${msg().auth.oauthSummary(entry.flavor, entry.plan, entry.needsLogin === true)}`;
  }
}

function providerArg(positionals: string[], action: string): string {
  const m = msg().auth;
  const provider = positionals[1];
  if (provider === undefined) throw new UsageError(m.needProvider(action));
  if (positionals.length > 2) throw new UsageError(m.extraArgs(positionals.slice(2).join(" ")));
  if (!PROVIDER_ID_PATTERN.test(provider)) throw new UsageError(m.badProvider(provider));
  return provider;
}

/** `auth set` 选择器列的供应商：内置、需要 API key、有 key 环境变量（不含 OAuth 的 chatgpt）。 */
export function keyProviders(): { id: string; name: string }[] {
  return BUILTIN_PROVIDERS.filter((p) => p.requiresApiKey && (p.envKeys ?? []).length > 0).map(
    (p) => ({ id: p.id, name: p.name }),
  );
}

export interface AuthDeps extends AuthCliDeps {
  /** `auth set` 不给 provider 时的选择器（测试注入）；返回下标，取消返回 undefined。缺省方向键选择。 */
  chooseProvider?(question: string, options: readonly ChoiceOption[]): Promise<number | undefined>;
}

/** `auth set` 的 provider：给了就校验；没给且 stdin 是 TTY → 选择器（取消返回 undefined）。 */
async function setProvider(
  positionals: string[],
  io: CliIo,
  deps: AuthDeps,
): Promise<string | undefined> {
  if (positionals.length > 1) return providerArg(positionals, "set");
  const m = msg().auth;
  const choose =
    deps.chooseProvider ??
    (canPromptChoice()
      ? (question: string, options: readonly ChoiceOption[]) =>
          promptChoice({ question, options, env: io.env })
      : undefined);
  if (!io.stdinIsTTY || choose === undefined) throw new UsageError(m.needProvider("set"));
  const providers = keyProviders();
  const index = await choose(
    m.pickProvider,
    providers.map((p) => ({ label: `${p.name} (${p.id})` })),
  );
  return index === undefined ? undefined : providers[index]?.id;
}

/** 取第一行并去掉首尾空白；stdin 为空返回 ""。 */
export function extractKey(raw: string): string {
  const line = raw.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return line.trim();
}

export async function runAuth(
  argv: readonly string[],
  io: CliIo,
  deps: AuthDeps = {},
): Promise<number> {
  const m = msg().auth;
  const { positionals, values, flags } = parseSubArgs(
    argv,
    ["auth-file", "flavor", "port"],
    ["paste", "device", "no-browser", "yes"],
  );
  const action = positionals[0];
  if (flags.has("help") || action === undefined) {
    io.stdout(authUsage());
    return flags.has("help") ? ExitCode.Ok : ExitCode.Usage;
  }
  const explicit = values.get("auth-file");
  const path =
    explicit !== undefined
      ? resolve(io.cwd, explicit)
      : defaultAuthFilePath(resolveConfigDir({ env: io.env }));
  const loginOnly = ["flavor", "port"].filter((name) => values.has(name));
  const loginFlags = ["paste", "device", "no-browser", "yes"].filter((name) => flags.has(name));
  if (action !== "login" && [...loginOnly, ...loginFlags].length > 0)
    throw new UsageError(m.extraArgs([...loginOnly, ...loginFlags].map((n) => `--${n}`).join(" ")));
  const cli = { positionals, values, flags, path };
  switch (action) {
    case "login":
      return runLogin(cli, io, deps);
    case "logout":
      return runLogout(cli, io, deps);
    case "status":
      return runStatus(cli, io, deps);
    case "set": {
      const provider = await setProvider(positionals, io, deps);
      if (provider === undefined) {
        io.stderr(msg().subcommands.common.cancelled);
        return ExitCode.Ok;
      }
      if (io.stdinIsTTY) io.stderr(m.setPrompt(provider));
      const key = extractKey(await io.readStdin());
      if (io.stdinIsTTY) io.stderr("\n");
      if (key === "") throw new UsageError(m.noKeyFromStdin);
      setAuthKey(path, provider, key);
      io.stdout(`${m.saved(provider, path)}\n`);
      return ExitCode.Ok;
    }
    case "list": {
      if (positionals.length > 1) throw new UsageError(m.extraArgs(positionals.slice(1).join(" ")));
      const result = readAuthFile(path);
      for (const warning of result.warnings) io.stderr(`${m.warning(warning)}\n`);
      const entries = describeAuthFile(result.file);
      if (entries.length === 0) {
        io.stdout(`${m.listEmpty(path)}\n`);
        return ExitCode.Ok;
      }
      io.stdout(`${path}\n`);
      for (const entry of entries) {
        const extra = [
          entry.hasBaseUrl ? "baseUrl" : undefined,
          entry.envNames.length > 0 ? `env ${entry.envNames.join(",")}` : undefined,
        ].filter((x) => x !== undefined);
        io.stdout(
          `  ${entry.provider.padEnd(20)} ${kindText(entry)}${extra.length > 0 ? ` · ${extra.join(" · ")}` : ""}\n`,
        );
      }
      return ExitCode.Ok;
    }
    case "remove": {
      const provider = providerArg(positionals, "remove");
      if (removeAuthKey(path, provider)) {
        io.stdout(`${m.removed(provider, path)}\n`);
        return ExitCode.Ok;
      }
      io.stderr(`${m.notFound(path, provider)}\n`);
      return ExitCode.RuntimeError;
    }
    default:
      throw new UsageError(m.unknownAction(action));
  }
}
