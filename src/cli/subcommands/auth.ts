/**
 * `ama auth set|list|remove <provider>`（设计 §3.5、§16.2 B5 验收）。[B5]
 * `ama auth login|logout|status chatgpt`（docs/wave6-plan.md §4.2）。[W6-O] 实现在 auth/chatgpt/cli.ts。
 *
 * - set：key 从 stdin 读取（TTY 下不回显），不经命令行参数，避免进 shell 历史；写 auth.json 0600。
 * - list：只列供应商与 key 形态（字面量 / `!command` / `$ENV` 引用 / oauth 的 flavor 与计划），从不输出 key 或 token。
 * - `--auth-file <path>` 改变目标文件（缺省 `<configDir>/auth.json`）。
 */

import { resolve } from "node:path";
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

/** 取第一行并去掉首尾空白；stdin 为空返回 ""。 */
export function extractKey(raw: string): string {
  const line = raw.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return line.trim();
}

export async function runAuth(
  argv: readonly string[],
  io: CliIo,
  deps: AuthCliDeps = {},
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
      const provider = providerArg(positionals, "set");
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
