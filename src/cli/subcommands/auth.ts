/**
 * `ama auth set|list|remove <provider>`（设计 §3.5、§16.2 B5 验收）。[B5]
 *
 * - set：key 从 stdin 读取（TTY 下不回显），不经命令行参数，避免进 shell 历史；写 auth.json 0600。
 * - list：只列供应商与 key 形态（字面量 / `!command` / `$ENV` 引用），从不输出 key。
 * - `--auth-file <path>` 改变目标文件（缺省 `<configDir>/auth.json`）。
 */

import { resolve } from "node:path";
import {
  PROVIDER_ID_PATTERN,
  defaultAuthFilePath,
  describeAuthFile,
  readAuthFile,
  removeAuthKey,
  setAuthKey,
} from "../../config/auth-file.js";
import { resolveConfigDir } from "../../config/paths.js";
import { parseSubArgs, UsageError } from "../args.js";
import type { CliIo } from "../deps.js";
import { ExitCode } from "../exit-codes.js";

export const AUTH_USAGE = `用法：ama auth set <provider> [--auth-file <文件>]   从 stdin 读取 key
      ama auth list [--auth-file <文件>]
      ama auth remove <provider> [--auth-file <文件>]
`;

const KIND_TEXT = {
  literal: "key",
  command: "!命令",
  "env-ref": "环境变量引用",
  oauth: "oauth", // [W6-C0] W6-O 补登录状态
} as const;

function providerArg(positionals: string[], action: string): string {
  const provider = positionals[1];
  if (provider === undefined) throw new UsageError(`ama auth ${action} 需要 <provider>`);
  if (positionals.length > 2) throw new UsageError(`多余的参数：${positionals.slice(2).join(" ")}`);
  if (!PROVIDER_ID_PATTERN.test(provider)) throw new UsageError(`供应商 id 不合法：${provider}`);
  return provider;
}

/** 取第一行并去掉首尾空白；stdin 为空返回 ""。 */
export function extractKey(raw: string): string {
  const line = raw.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return line.trim();
}

export async function runAuth(argv: readonly string[], io: CliIo): Promise<number> {
  const { positionals, values, flags } = parseSubArgs(argv, ["auth-file"]);
  const action = positionals[0];
  if (flags.has("help") || action === undefined) {
    io.stdout(AUTH_USAGE);
    return flags.has("help") ? ExitCode.Ok : ExitCode.Usage;
  }
  const explicit = values.get("auth-file");
  const path =
    explicit !== undefined
      ? resolve(io.cwd, explicit)
      : defaultAuthFilePath(resolveConfigDir({ env: io.env }));
  switch (action) {
    case "set": {
      const provider = providerArg(positionals, "set");
      if (io.stdinIsTTY) io.stderr(`输入 ${provider} 的 API key（不回显），回车结束：`);
      const key = extractKey(await io.readStdin());
      if (io.stdinIsTTY) io.stderr("\n");
      if (key === "") throw new UsageError("没有从 stdin 读到 key");
      setAuthKey(path, provider, key);
      io.stdout(`已保存 ${provider} 的 key → ${path}（0600）\n`);
      return ExitCode.Ok;
    }
    case "list": {
      if (positionals.length > 1)
        throw new UsageError(`多余的参数：${positionals.slice(1).join(" ")}`);
      const result = readAuthFile(path);
      for (const warning of result.warnings) io.stderr(`ama: 警告：${warning}\n`);
      const entries = describeAuthFile(result.file);
      if (entries.length === 0) {
        io.stdout(`${path}：没有保存的 key\n`);
        return ExitCode.Ok;
      }
      io.stdout(`${path}\n`);
      for (const entry of entries) {
        const extra = [
          entry.hasBaseUrl ? "baseUrl" : undefined,
          entry.envNames.length > 0 ? `env ${entry.envNames.join(",")}` : undefined,
        ].filter((x) => x !== undefined);
        io.stdout(
          `  ${entry.provider.padEnd(20)} ${KIND_TEXT[entry.kind]}${extra.length > 0 ? ` · ${extra.join(" · ")}` : ""}\n`,
        );
      }
      return ExitCode.Ok;
    }
    case "remove": {
      const provider = providerArg(positionals, "remove");
      if (removeAuthKey(path, provider)) {
        io.stdout(`已删除 ${provider} 的 key（${path}）\n`);
        return ExitCode.Ok;
      }
      io.stderr(`ama: ${path} 中没有 ${provider}\n`);
      return ExitCode.RuntimeError;
    }
    default:
      throw new UsageError(`未知的 auth 子命令：${action}`);
  }
}
