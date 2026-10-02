/**
 * codemode 测试辅助：用 esbuild 把 src/codemode/sandbox-entry.ts 打成自包含的 .cjs（与
 * dist/bundle/ama-sandbox.cjs 同一构建方式），每个测试进程只打一次。[B10]
 *
 * 子进程在 `--permission` 下只能读入口文件本身，所以测试不能直接跑 .ts 源文件（类型剥离也要读
 * 同目录的其它文件时会被拒）；打成单文件后与发布形态一致。
 */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

let built: string | undefined;

export function sandboxEntryForTests(): string {
  if (built !== undefined) return built;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ama-sandbox-")));
  const outfile = join(dir, "ama-sandbox.cjs");
  buildSync({
    entryPoints: [fileURLToPath(new URL("../../src/codemode/sandbox-entry.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "warning",
  });
  built = outfile;
  return outfile;
}
