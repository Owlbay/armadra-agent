/**
 * `ama sessions export <id>`：导出会话（只读，不加锁；正在运行的会话也能导）。[W4-D]
 *
 * - `--format md|json|jsonl`（缺省 md）；`--branch leaf|all`（缺省 leaf = 当前分支）；
 * - `--output <文件>`：写文件（0600，已存在则覆盖），否则写 stdout；
 * - 导出内容先脱敏（session/redact.ts），格式说明见 docs/sessions.md「导出」。
 */

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expandHome, resolveDataDir } from "../../config/paths.js";
import { renderExport, type ExportBranch, type ExportFormat } from "../../session/export.js";
import { findSessionFileReadOnly, readSessionReadOnly } from "../../session/scan.js";
import { parseSubArgs, UsageError } from "../args.js";
import type { CliIo } from "../deps.js";
import { ExitCode } from "../exit-codes.js";
import { msg } from "../../i18n/index.js";

export function sessionsExportUsage(): string {
  return msg().subcommands.sessionsExport.usage;
}

const FORMATS: readonly ExportFormat[] = ["md", "json", "jsonl"];
const BRANCHES: readonly ExportBranch[] = ["leaf", "all"];

export async function runSessionsExport(argv: readonly string[], io: CliIo): Promise<number> {
  const { positionals, values, flags } = parseSubArgs(argv, [
    "format",
    "output",
    "branch",
    "session-dir",
  ]);
  if (flags.has("help")) {
    io.stdout(sessionsExportUsage());
    return ExitCode.Ok;
  }
  const [id, extra] = positionals;
  if (id === undefined)
    throw new UsageError(msg().subcommands.common.needsArg("ama sessions export", "<id>"));
  if (extra !== undefined) throw new UsageError(msg().subcommands.common.extraArgs(extra));
  const format = (values.get("format") ?? "md") as ExportFormat;
  if (!FORMATS.includes(format)) {
    throw new UsageError(msg().subcommands.common.invalidChoice("--format", FORMATS, format));
  }
  const branch = (values.get("branch") ?? "leaf") as ExportBranch;
  if (!BRANCHES.includes(branch)) {
    throw new UsageError(msg().subcommands.common.invalidChoice("--branch", BRANCHES, branch));
  }
  const dirFlag = values.get("session-dir");
  const root =
    dirFlag !== undefined
      ? resolve(io.cwd, expandHome(dirFlag, { env: io.env }))
      : join(resolveDataDir({ env: io.env }), "sessions");
  const session = readSessionReadOnly(findSessionFileReadOnly(root, id, io.cwd));
  const text = renderExport(session, format, branch);
  const output = values.get("output");
  if (output === undefined) {
    io.stdout(text);
    return ExitCode.Ok;
  }
  const target = resolve(io.cwd, expandHome(output, { env: io.env }));
  writeFileSync(target, text, { mode: 0o600 });
  io.stderr(msg().subcommands.sessionsExport.exported(target));
  return ExitCode.Ok;
}
