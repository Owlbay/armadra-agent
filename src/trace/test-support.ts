/**
 * 轨迹测试的夹具读取（build / format / trace-view 测试共用）。[W6-T1]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { strictEqual } from "node:assert";
import { basename, join } from "node:path";
import { readSessionReadOnly } from "../session/scan.js";
import type { SessionEntry, SessionHeader } from "../session/types.js";
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

const SYNTHETIC_T0 = Date.UTC(2026, 9, 3, 8, 0, 0);

/** [W6-T2] `n` 个回合的合成会话（user → assistant，各 1 秒）。 */
export function synthetic(n: number): TraceInput {
  const header: SessionHeader = {
    type: "session",
    version: 1,
    id: "sess-syn",
    timestamp: new Date(SYNTHETIC_T0).toISOString(),
    cwd: "/work/syn",
    agent: { name: "ama", version: "0.6.0" },
  };
  const entries: SessionEntry[] = [];
  let parent: string | null = null;
  const push = (entry: Record<string, unknown>, at: number): void => {
    const id = `sy${String(entries.length).padStart(4, "0")}`;
    entries.push({
      ...entry,
      id,
      parentId: parent,
      timestamp: new Date(at).toISOString(),
    } as SessionEntry);
    parent = id;
  };
  for (let i = 0; i < n; i++) {
    const at = SYNTHETIC_T0 + i * 10_000;
    push({ type: "message", message: { role: "user", content: `q${i}`, timestamp: at } }, at);
    push(
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `a${i}` }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
          stopReason: "stop",
          timestamp: at + 100,
        },
      },
      at + 1000,
    );
  }
  return { header, entries };
}
