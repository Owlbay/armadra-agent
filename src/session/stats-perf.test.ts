/**
 * `ama stats` 大目录性能：1000 个合成会话（每个 12 个回合、每回合 2 次工具调用，工具结果 2 KB）。
 * 目标：冷扫描 < 2 s；有索引缓存时远低于冷扫描。CI 机器（尤其 Windows）慢，阈值放宽到 6 s，只防数量级退化。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { aggregateStats } from "./stats-aggregate.js";
import { collectSummaries } from "./stats-index.js";
import { sessionFilesInScope } from "./scan.js";
import { sessionDirForCwd, sessionFileName } from "./store.js";
import { assistantEntry, toolResultEntry, usageOf, userEntry } from "./test-support.js";

const SESSIONS = 1000;
const TURNS = 12;
const LIMIT_MS = process.env["CI"] !== undefined ? 6000 : 2000;

let home: TmpHome;
let root: string;
let totalBytes = 0;

beforeAll(() => {
  home = createTmpHome("ama-stats-perf-");
  root = join(home.dataDir, "sessions");
  const big = "x".repeat(2048);
  const base = Date.parse("2026-09-01T00:00:00Z");
  for (let s = 0; s < SESSIONS; s++) {
    const cwd = `/proj/p${s % 20}`;
    const dir = sessionDirForCwd(root, cwd);
    mkdirSync(dir, { recursive: true });
    const start = base + s * 60_000;
    const id = `00000000-0000-0000-0000-${String(s).padStart(12, "0")}`;
    const lines: string[] = [
      JSON.stringify({
        type: "session",
        version: 1,
        id,
        timestamp: new Date(start).toISOString(),
        cwd,
        agent: { name: "ama", version: "0.0.0" },
      }),
    ];
    let n = 0;
    let parent: string | null = null;
    const push = (entry: Record<string, unknown>): void => {
      const eid = `e${++n}`;
      lines.push(
        JSON.stringify({
          ...entry,
          id: eid,
          parentId: parent,
          timestamp: new Date(start + n * 1000).toISOString(),
        }),
      );
      parent = eid;
    };
    for (let t = 0; t < TURNS; t++) {
      push(userEntry(`turn ${t} please do something`));
      push(
        assistantEntry("", usageOf(200, 20, 3000, 0, 0.001), {
          tools: [{ name: "read" }, { name: "bash" }],
        }),
      );
      push(toolResultEntry("read", big));
      push(toolResultEntry("bash", big));
      push(assistantEntry("done", usageOf(100, 50, 7000, 0, 0.002)));
    }
    const text = lines.join("\n") + "\n";
    totalBytes += text.length;
    writeFileSync(join(dir, sessionFileName(new Date(start), id)), text);
  }
  // 只是生成 1000 个夹具文件（被测的扫描另有 LIMIT_MS）；CI Windows 写小文件慢，缺省 10 s 钩子超时不够
}, 60_000);

afterAll(() => home.cleanup());

describe("stats 性能（1000 个会话）", () => {
  it(`冷扫描与缓存命中都 < ${LIMIT_MS} ms，结果一致`, () => {
    const index = join(home.dataDir, "stats-index.json");
    const t0 = performance.now();
    const files = sessionFilesInScope(root);
    const cold = collectSummaries(files, { indexFile: index, prune: true });
    const coldReport = aggregateStats(cold.summaries, { by: "day" });
    const coldMs = performance.now() - t0;
    const t1 = performance.now();
    const warm = collectSummaries(sessionFilesInScope(root), { indexFile: index, prune: true });
    const warmReport = aggregateStats(warm.summaries, { by: "day" });
    const warmMs = performance.now() - t1;
    console.info(
      `stats perf: ${SESSIONS} 会话 ${(totalBytes / 1e6).toFixed(1)} MB，冷 ${coldMs.toFixed(0)} ms，缓存 ${warmMs.toFixed(0)} ms`,
    );
    expect(cold.scanned).toBe(SESSIONS);
    expect(warm.cached).toBe(SESSIONS);
    expect(coldReport.totals.requests).toBe(SESSIONS * TURNS * 2);
    expect(coldReport.totals.turns).toBe(SESSIONS * TURNS);
    expect(warmReport).toEqual(coldReport);
    expect(coldMs).toBeLessThan(LIMIT_MS);
    // 缓存命中与冷扫描的快慢在 Windows runner 上受文件系统缓存影响会颠倒（冷 291 ms、热 816 ms），只防数量级退化
    expect(warmMs).toBeLessThan(LIMIT_MS);
  });
});
