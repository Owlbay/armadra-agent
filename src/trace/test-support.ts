/**
 * 轨迹测试的夹具读取（build / format / trace-view 测试共用）。[W6-T1]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { strictEqual } from "node:assert";
import { basename, join } from "node:path";
import { readSessionReadOnly } from "../session/scan.js";
import type { TraceInput } from "./build.js";

export const FIXTURES = join(process.cwd(), "test", "fixtures", "trace");

export const TRACE_FIXTURES = [
  "basic",
  "parallel",
  "codemode",
  "retry-fallback",
  "overflow",
  "subagent",
  "external",
  "rewind-branch",
  "legacy-approx",
] as const;

export function loadFixture(name: string): TraceInput {
  const read = readSessionReadOnly(join(FIXTURES, `${name}.jsonl`));
  return { header: read.header, entries: read.entries, leaf: read.leaf };
}

/** 子会话按文件名回夹具目录找；找不到返回 undefined（→ childMissing）。 */
export function fixtureChild(file: string): TraceInput | undefined {
  const name = basename(file, ".jsonl");
  return existsSync(join(FIXTURES, `${name}.jsonl`)) ? loadFixture(name) : undefined;
}

/** 黄金文件（`test/fixtures/trace/<file>`）：缺失（非 CI）或 `AMA_UPDATE_GOLDEN=1` 时写入。 */
export function traceGolden(file: string, actual: string): void {
  const path = join(FIXTURES, file);
  if (process.env["AMA_UPDATE_GOLDEN"] === "1" || (!existsSync(path) && !process.env["CI"]))
    writeFileSync(path, actual);
  strictEqual(actual, readFileSync(path, "utf8"));
}
