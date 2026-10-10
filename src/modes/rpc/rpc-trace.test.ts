/**
 * [W6-T2] RPC `get_trace`（docs/history/wave6-plan.md §2.6）：黄金记录 trace.out.jsonl（两轮对话 → 全量 → 预览 →
 * 带 since 的增量 → before 翻页 → 错误码），以及 `entry_appended` 驱动的增量拼接 = 全量。
 */

import { describe, expect, it } from "vitest";
import { driveRpc, normalizeLine, rpcGolden, type Line } from "../../../test/helpers/rpc-driver.js";
import type { RpcW6Results } from "../../rpc.js";
import type { TraceTurnNode } from "../../trace/types.js";

type TraceData = RpcW6Results["get_trace"];

/** 轨迹里随机器与时序变化的数字。 */
const TIME_KEYS = new Set([
  "requestAt",
  "firstTokenAt",
  "doneAt",
  "startedAt",
  "endedAt",
  "tps",
  "ttftMs",
  "ttftP50",
  "ttftP90",
  "avgTps",
  "approvalMs",
]);

function normalize(line: Line, root: string): string {
  const scrubbed = JSON.parse(
    JSON.stringify(line, (key, value: unknown) => {
      // 有无取决于时序（例如解码 0 ms 时没有吞吐），整键去掉
      if (TIME_KEYS.has(key) && typeof value === "number") return undefined;
      if (key === "sessionFile" && typeof value === "string") return "<sessionFile>";
      // previews 的 key 是 `<kind>:<条目 id>`，id 随机
      if (key === "previews" && typeof value === "object" && value !== null)
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k.replace(/:[0-9a-f]{8}$/, ":<id>"), v]),
        );
      return value;
    }),
  ) as Line;
  return normalizeLine(scrubbed, root);
}

const settled = (l: Line) => l["type"] === "agent_settled";
const dataOf = (lines: Line[], id: string) =>
  lines.find((l) => l["id"] === id)?.["data"] as TraceData;

describe("RPC get_trace", () => {
  it("黄金记录：全量 / 预览 / since 增量 / before 翻页 / 错误码", async () => {
    let from = 0;
    const { lines, h } = await driveRpc(
      [
        {
          steps: [{ toolCall: { name: "read", arguments: { path: "missing.txt" } } }],
          usage: { input: 30, output: 6 },
        },
        { text: "no such file", usage: { input: 40, output: 4 } },
        { text: "second answer", usage: { input: 50, output: 5 } },
      ],
      async (d) => {
        d.send({ id: "p1", type: "prompt", message: "read missing.txt" });
        await d.waitFor((l) => settled(l) && d.lines.filter(settled).length === 1);
        from = d.lines.length;
        d.send({ id: "t1", type: "get_trace" });
        const first = (await d.waitFor((l) => l["id"] === "t1"))["data"] as TraceData;
        d.send({ id: "p2", type: "prompt", message: "again" });
        await d.waitFor((l) => settled(l) && d.lines.filter(settled).length === 2);
        d.send({ id: "t2", type: "get_trace", since: first.cursor.since });
        d.send({ id: "t3", type: "get_trace", content: "preview", turnLimit: 1 });
        const page = (await d.waitFor((l) => l["id"] === "t3"))["data"] as TraceData;
        d.send({ id: "t4", type: "get_trace", before: page.cursor.before });
        d.send({ id: "e1", type: "get_trace", taskId: "t9" });
        d.send({ id: "e2", type: "get_trace", turnLimit: 0 });
        await d.waitFor((l) => l["id"] === "e2");
      },
    );
    try {
      const t1 = dataOf(lines, "t1");
      const t2 = dataOf(lines, "t2");
      const t3 = dataOf(lines, "t3");
      const t4 = dataOf(lines, "t4");
      expect(t1.trace.turns).toHaveLength(1);
      expect(t1.trace.turns[0]?.steps).toHaveLength(2);
      expect(t1.previews).toBeUndefined();
      // since：从游标条目所在的回合（第一轮，重发）起到末尾
      expect(t2.trace.turns.map((t) => t.id)[0]).toBe(t1.trace.turns[0]?.id);
      expect(t2.trace.turns).toHaveLength(2);
      // 预览 + 尾部 1 个回合 → before 拿到第一轮
      expect(t3.hasMoreBefore).toBe(true);
      expect(Object.keys(t3.previews ?? {}).length).toBeGreaterThan(0);
      expect(t4.trace.turns.map((t) => t.id)).toEqual(t1.trace.turns.map((t) => t.id));
      expect(lines.find((l) => l["id"] === "e1")).toMatchObject({
        success: false,
        code: "task_not_found",
      });
      expect(lines.find((l) => l["id"] === "e2")).toMatchObject({
        success: false,
        code: "invalid_arguments",
      });
      rpcGolden(
        "trace.out.jsonl",
        lines
          .slice(from)
          .filter((l) => typeof l["id"] === "string" && /^[te]\d$/.test(l["id"]))
          .map((l) => normalize(l, h.home.root))
          .join("\n") + "\n",
      );
    } finally {
      h.cleanup();
    }
  });

  it("entry_appended 触发 get_trace{since}，增量拼接 = 全量", async () => {
    const snapshots: { turns: TraceTurnNode[]; full: TraceTurnNode[]; same: boolean }[] = [];
    const { h } = await driveRpc(
      [{ text: "one" }, { text: "two" }, { text: "three" }],
      async (d) => {
        let local: TraceTurnNode[] = [];
        let since: string | undefined;
        let seen = 0;
        let n = 0;
        const sync = async (): Promise<void> => {
          const id = `s${n++}`;
          d.send({ id, type: "get_trace", ...(since !== undefined ? { since } : {}) });
          const r = (await d.waitFor((l) => l["id"] === id))["data"] as TraceData;
          const first = r.trace.turns[0];
          const at = first === undefined ? -1 : local.findIndex((t) => t.id === first.id);
          local =
            first === undefined
              ? []
              : at < 0
                ? r.trace.turns
                : [...local.slice(0, at), ...r.trace.turns];
          since = r.cursor.since;
          const fid = `f${n++}`;
          d.send({ id: fid, type: "get_trace", turnLimit: 500 });
          const full = (await d.waitFor((l) => l["id"] === fid))["data"] as TraceData;
          // 两次请求之间可能又落了条目 / 运行状态变了：只比游标一致的快照
          const same = full.cursor.since === since && full.trace.partial === r.trace.partial;
          snapshots.push({ turns: local, full: full.trace.turns, same });
        };
        for (const message of ["a", "b", "c"]) {
          const target = d.lines.filter(settled).length;
          d.send({ type: "prompt", message });
          for (;;) {
            const appended = d.lines.filter((l) => l["type"] === "entry_appended").length;
            if (appended > seen) {
              seen = appended;
              await sync();
            }
            if (d.lines.filter(settled).length > target && appended === seen) break;
            await new Promise((r) => setTimeout(r, 5));
          }
          await sync();
        }
      },
    );
    try {
      const comparable = snapshots.filter((s) => s.same);
      expect(comparable.length).toBeGreaterThanOrEqual(3);
      for (const s of comparable) expect(s.turns).toEqual(s.full);
      expect(snapshots.at(-1)?.same).toBe(true);
      expect(snapshots.at(-1)?.full).toHaveLength(3);
    } finally {
      h.cleanup();
    }
  });
});
