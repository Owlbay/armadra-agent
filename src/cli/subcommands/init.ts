/**
 * `ama init [--force]`（docs/providers.md「配置目录」）：建配置目录与缺省文件，逐个报告状态。
 */

import { INIT_NEXT_STEPS, describeInit, initConfigDir } from "../../config/init.js";
import { resolveConfigDir } from "../../config/paths.js";
import { parseSubArgs, UsageError } from "../args.js";
import type { CliIo } from "../deps.js";
import { ExitCode } from "../exit-codes.js";
import { msg } from "../../i18n/index.js";

export function initUsage(): string {
  return msg().subcommands.init.usage;
}

export function runInit(argv: readonly string[], io: CliIo): number {
  const { positionals, flags } = parseSubArgs(argv, [], ["force"]);
  if (flags.has("help")) {
    io.stdout(initUsage());
    return ExitCode.Ok;
  }
  if (positionals.length > 0)
    throw new UsageError(msg().subcommands.common.extraArgs(positionals.join(" ")));
  const result = initConfigDir(resolveConfigDir({ env: io.env }), { force: flags.has("force") });
  io.stdout(describeInit(result));
  io.stdout(`\n${INIT_NEXT_STEPS.join("\n")}\n`);
  return ExitCode.Ok;
}
