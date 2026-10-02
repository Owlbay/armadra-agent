/**
 * `ama init [--force]`（docs/providers.md「配置目录」）：建配置目录与缺省文件，逐个报告状态。
 */

import { INIT_NEXT_STEPS, describeInit, initConfigDir } from "../../config/init.js";
import { resolveConfigDir } from "../../config/paths.js";
import { parseSubArgs, UsageError } from "../args.js";
import type { CliIo } from "../deps.js";
import { ExitCode } from "../exit-codes.js";

export const INIT_USAGE = `用法：ama init [--force]   建配置目录（0700）与 config.json、config.schema.json
                          已有的 config.json 不覆盖（--force 先备份为 .bak 再重写）；不创建 auth.json
`;

export function runInit(argv: readonly string[], io: CliIo): number {
  const { positionals, flags } = parseSubArgs(argv, [], ["force"]);
  if (flags.has("help")) {
    io.stdout(INIT_USAGE);
    return ExitCode.Ok;
  }
  if (positionals.length > 0) throw new UsageError(`多余的参数：${positionals.join(" ")}`);
  const result = initConfigDir(resolveConfigDir({ env: io.env }), { force: flags.has("force") });
  io.stdout(describeInit(result));
  io.stdout(`\n${INIT_NEXT_STEPS.join("\n")}\n`);
  return ExitCode.Ok;
}
