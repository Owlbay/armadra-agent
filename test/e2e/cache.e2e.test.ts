/**
 * bundle 级缓存测试（第三波 §2.4）：与 `src/cli/cache-stability.test.ts` 同口径，但走
 * `dist/bundle/ama.cjs`——fake 供应商经 `AMA_FAKE_RECORD` 把每次请求的折叠 system 与工具表记成
 * 一行，20 回合（RPC 一个进程内连续 prompt）全部行逐字节相同。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";
import { hasBundle, spawnRpc } from "./spawn.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/scripts/${name}`, import.meta.url));

interface RecordLine {
  index: number;
  purpose: string;
  model: string;
  system: string;
  tools: { name: string }[];
  messagesCount: number;
}

function readRecord(file: string): RecordLine[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as RecordLine);
}

describe.skipIf(!hasBundle)("e2e：缓存前缀稳定（bundle 子进程）", () => {
  it("20 回合：每次请求的 system 与 tools 逐字节相同，消息数单调增长", async () => {
    home = createTmpHome();
    home.write("work/AGENTS.md", "project rules");
    home.write(
      "home/.config/ama/skills/review/SKILL.md",
      "---\nname: review\ndescription: Review code\n---\nbody\n",
    );
    const record = home.path("record.jsonl");
    const rpc = spawnRpc(home, ["--model", "fake/echo"], {
      AMA_FAKE_SCRIPT: fixture("cache-stability-20.json"),
      AMA_FAKE_RECORD: record,
    });
    for (let i = 0; i < 20; i++) {
      const from = rpc.lines.length;
      rpc.send({ id: `p${i}`, type: "prompt", message: `question ${i}` });
      await rpc.waitFor((l) => l["type"] === "agent_settled", from);
    }
    rpc.send({ id: "stats", type: "get_session_stats" });
    const stats = await rpc.waitFor((l) => l["id"] === "stats");
    expect(await rpc.close()).toBe(0);

    const lines = readRecord(record);
    // 20 个文本回合 + 7 次工具调用回合。
    expect(lines).toHaveLength(27);
    expect(lines.every((l) => l.purpose === "turn" && l.model === "fake/echo")).toBe(true);
    const [first] = lines;
    expect(first?.system).toContain("project rules");
    expect(first?.system).toContain("review");
    expect(first?.tools.map((t) => t.name)).toContain("read");
    for (const line of lines) {
      expect(line.system).toBe(first?.system);
      expect(JSON.stringify(line.tools)).toBe(JSON.stringify(first?.tools));
    }
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]!.messagesCount).toBeGreaterThan(lines[i - 1]!.messagesCount);
    }
    const data = stats["data"] as { cacheHitRate?: number; tokens: { cacheRead: number } };
    expect(data.tokens.cacheRead).toBe(900 * 19);
    expect(data.cacheHitRate).toBeGreaterThan(0);
  });
});
