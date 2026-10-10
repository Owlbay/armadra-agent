/**
 * `scripts/lib/bench-memory-fixtures.mjs` 的 `parseJsonLine`（#173）：被测进程中途退出时的截断行、
 * 混入的非 JSON 输出都返回 `undefined`（由基准脚本计为坏行），完整行返回对象；`samplePeaks`（#172 探针
 * 细分）给出 heapTotal / other 峰值。
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

interface FixturesModule {
  parseJsonLine(line: string): Record<string, unknown> | undefined;
  samplePeaks(samples: Record<string, unknown>[]): Record<string, number>;
}

const SCRIPT = fileURLToPath(new URL("../scripts/lib/bench-memory-fixtures.mjs", import.meta.url));
const load = (): Promise<FixturesModule> =>
  import(pathToFileURL(SCRIPT).href) as Promise<FixturesModule>;

describe("bench-memory parseJsonLine", () => {
  it("完整行 → 对象", async () => {
    const { parseJsonLine } = await load();
    expect(parseJsonLine('{"type":"agent_settled","n":1}')).toEqual({
      type: "agent_settled",
      n: 1,
    });
    expect(parseJsonLine('  {"jsonrpc":"2.0","id":3,"result":{}}\r')).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {},
    });
  });

  it("截断行 → undefined", async () => {
    const { parseJsonLine } = await load();
    const full = JSON.stringify({ type: "message_update", text: "x".repeat(1000) });
    for (const cut of [1, 10, 500, full.length - 1]) {
      expect(parseJsonLine(full.slice(0, cut))).toBeUndefined();
    }
  });

  it("空行、非 JSON、非对象 → undefined", async () => {
    const { parseJsonLine } = await load();
    for (const line of [
      "",
      "   ",
      "[12345:0x1]    42 ms: Scavenge 8.1 (9.0) -> 7.9 (10.0) MB",
      "<--- Last few GCs --->",
      "null",
      "42",
      '"text"',
      "[1,2]",
    ]) {
      expect(parseJsonLine(line)).toBeUndefined();
    }
  });

  it("samplePeaks：rss 取 maxRss，other 缺省按 rss − heapTotal − external 现算", async () => {
    const { samplePeaks } = await load();
    const peaks = samplePeaks([
      { ev: "start", rss: 100, heapUsed: 10, heapTotal: 20, external: 5, other: 75 },
      { ev: "tick", rss: 300, heapUsed: 50, heapTotal: 90, external: 30 },
      { ev: "exit", rss: 200, heapUsed: 40, heapTotal: 60, external: 10, other: 130, maxRss: 400 },
    ]);
    expect(peaks).toEqual({ rss: 400, heapUsed: 50, heapTotal: 90, external: 30, other: 180 });
    expect(samplePeaks([])).toEqual({ rss: 0, heapUsed: 0, heapTotal: 0, external: 0, other: 0 });
  });
});
