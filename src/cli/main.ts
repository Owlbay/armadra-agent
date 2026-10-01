#!/usr/bin/env node
/**
 * bin 入口——B0 最小占位，B5 将替换。
 *
 * 现在只支持 `--version` / `-v` 与 `--help` / `-h`；其它参数输出「尚未实现」并以退出码 2 退出。
 * B5 替换时保留导出签名 `main(argv): Promise<number>` 与下方「直接执行才自动运行」的判定，
 * 因为 src/bundle.ts 会显式调用 `main()`。
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AMA_VERSION } from "../version.js";
import { ExitCode } from "./exit-codes.js";

declare const __AMA_BUNDLED__: boolean | undefined;

const USAGE = `用法：ama [选项] [提示]

  -v, --version   输出版本
  -h, --help      输出本帮助

（其余命令与选项尚未实现）
`;

export async function main(argv: readonly string[]): Promise<number> {
  const [first] = argv;
  if (argv.length === 1 && (first === "--version" || first === "-v")) {
    process.stdout.write(`${AMA_VERSION}\n`);
    return ExitCode.Ok;
  }
  if (argv.length === 1 && (first === "--help" || first === "-h")) {
    process.stdout.write(USAGE);
    return ExitCode.Ok;
  }
  process.stderr.write(`ama: 尚未实现：${argv.join(" ") || "(无参数)"}\n`);
  return ExitCode.Usage;
}

function isDirectRun(): boolean {
  if (typeof __AMA_BUNDLED__ !== "undefined" && __AMA_BUNDLED__) return false;
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`ama: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = ExitCode.RuntimeError;
    },
  );
}
