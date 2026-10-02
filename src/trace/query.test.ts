/**
 * 轨迹查询（RPC `get_trace` / SDK `session.trace()` / `--json` 共用，docs/wave6-plan.md §2.6）：尾部分页、
 * `before` 向前翻页拼回全量、`since` 增量拼接 = 全量（逐条追加条目模拟 `entry_appended`）、`taskId`、
 * 参数校验、预览与脱敏。[W6-T2]
 */

import { describe, expect, it } from "vitest";
import type { AmaError } from "../errors.js";
import type { SessionEntry } from "../session/types.js";
import type { TraceInput } from "./build.js";
import { queryTrace, TURN_LIMIT_DEFAULT, type TraceQuery } from "./query.js";
import { TRACE_FIXTURES, fixtureChild, loadFixture, synthetic } from "./test-support.js";
import type { TraceTurnNode } from "./types.js";

function prefix(input: TraceInput, k: number): TraceInput {
  return { header: input.header, entries: input.entries.slice(0, k) };
}

/** 客户端合并规则：从返回的第一个回合 id 起替换尾部；找不到就整体替换；空 = 没有回合。 */
function merge(local: TraceTurnNode[], incoming: TraceTurnNode[]): TraceTurnNode[] {
  const first = incoming[0];
  if (first === undefined) return [];
  const at = local.findIndex((t) => t.id === first.id);
  return at < 0 ? incoming : [...local.slice(0, at), ...incoming];
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as AmaError).code;
  }
  return undefined;
}

describe("分页", () => {
  const input = synthetic(120);

  it("缺省尾部 50 个回合；cursor.before = 窗口第一个回合；since = 最后条目", () => {
    const r = queryTrace(input);
    expect(r.trace.turns).toHaveLength(TURN_LIMIT_DEFAULT);
    expect(r.hasMoreBefore).toBe(true);
    expect(r.cursor.before).toBe(r.trace.turns[0]?.id);
    expect(r.cursor.since).toBe(input.entries.at(-1)?.id);
    expect(r.leafId).toBe(input.entries.at(-1)?.id);
    // totals / aux 是整条分支的
    expect(r.trace.totals.requests).toBe(120);
  });

  it("before 向前翻页拼回全量", () => {
    const full = queryTrace(input, { turnLimit: 500 }).trace.turns;
    let page = queryTrace(input, { turnLimit: 17 });
    const turns = [...page.trace.turns];
    while (page.hasMoreBefore) {
      page = queryTrace(input, { turnLimit: 17, before: page.cursor.before as string });
      turns.unshift(...page.trace.turns);
    }
    expect(page.cursor.before).toBeUndefined();
    expect(turns).toEqual(full);
  });

  it("参数校验：invalid_arguments", () => {
    const bad: TraceQuery[] = [
      { turnLimit: 0 },
      { turnLimit: 501 },
      { turnLimit: 1.5 },
      { branch: "x" as "leaf" },
      { content: "full" as "none" },
      { before: "nope" },
      { before: "sy0000", since: "sy0001" },
      { since: "" },
    ];
    for (const q of bad) expect(codeOf(() => queryTrace(input, q))).toBe("invalid_arguments");
  });
});

/** subagent 夹具：后台任务 t2 的结束条目挪到新的第二个回合之后（晚到的条目改到旧回合）。 */
function lateTask(): TraceInput {
  const input = loadFixture("subagent");
  const head = input.entries.slice(0, -1);
  const done = input.entries.at(-1) as SessionEntry;
  const last = head.at(-1) as SessionEntry;
  const at = Date.parse(last.timestamp) + 5000;
  const user = {
    type: "message",
    message: { role: "user", content: "next", timestamp: at },
    id: "late01",
    parentId: last.id,
    timestamp: new Date(at).toISOString(),
  } as SessionEntry;
  const reply = {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: "stop",
      timestamp: at + 10,
    },
    id: "late02",
    parentId: "late01",
    timestamp: new Date(at + 500).toISOString(),
  } as SessionEntry;
  return { header: input.header, entries: [...head, user, reply, { ...done, parentId: "late02" }] };
}

describe("since 增量拼接 = 全量", () => {
  const cases: [string, TraceInput][] = [
    ["synthetic", synthetic(8)],
    ["late-task", lateTask()],
    ...TRACE_FIXTURES.map((name) => [name, loadFixture(name)] as [string, TraceInput]),
  ];
  for (const [name, input] of cases)
    it(name, () => {
      const deps = { loadChild: fixtureChild };
      let local: TraceTurnNode[] = [];
      let since: string | undefined;
      for (let k = 1; k <= input.entries.length; k++) {
        const step = prefix(input, k);
        const r = queryTrace(step, since === undefined ? {} : { since }, deps);
        local = merge(local, r.trace.turns);
        since = r.cursor.since;
        expect(local).toEqual(queryTrace(step, { turnLimit: 500 }, deps).trace.turns);
      }
    });

  it("since 不在分支上（未知 id）：从第一个回合全量返回", () => {
    const input = synthetic(3);
    expect(queryTrace(input, { since: "gone" }).trace.turns).toHaveLength(3);
  });

  it("后台任务晚到的条目改到旧回合：旧回合也重发", () => {
    const input = lateTask();
    const turns = queryTrace(input).trace.turns;
    expect(turns).toHaveLength(2);
    const r = queryTrace(input, { since: "late02" });
    expect(r.trace.turns.map((t) => t.id)).toEqual(turns.map((t) => t.id));
    expect(
      queryTrace(prefix(input, input.entries.length - 1), { since: "late01" }).trace.turns,
    ).toHaveLength(1);
  });
});

describe("taskId", () => {
  it("ama 子会话：返回子轨迹，task 是节点本身（不含 child）", () => {
    const r = queryTrace(loadFixture("subagent"), { taskId: "t1" }, { loadChild: fixtureChild });
    expect(r.trace.sessionId).toBe("sess-child");
    expect(r.trace.turns.length).toBeGreaterThan(0);
    expect(r.task?.taskId).toBe("t1");
    expect(r.task && "child" in r.task).toBe(false);
    expect(r.cursor.since).not.toBe("");
  });

  it("子会话缺失：标 childMissing，空回合", () => {
    const r = queryTrace(loadFixture("subagent"), { taskId: "t1" });
    expect(r.task?.childMissing).toBe(true);
    expect(r.trace.turns).toEqual([]);
  });

  it("外部 Agent：骨架在 task.external，回合为空", () => {
    const input = loadFixture("external");
    const all = queryTrace(input, { turnLimit: 500 });
    const ext = JSON.stringify(all.trace).match(/"taskId":"([^"]+)"/)?.[1] as string;
    const r = queryTrace(input, { taskId: ext });
    expect(r.trace.turns).toEqual([]);
    expect(r.task?.external?.length ?? 0).toBeGreaterThan(0);
  });

  it("不存在：task_not_found", () => {
    expect(codeOf(() => queryTrace(loadFixture("basic"), { taskId: "t9" }))).toBe("task_not_found");
  });
});

describe("内容", () => {
  it("缺省 none：没有 previews；preview：按 <kind>:<id> 给窗口内节点，已脱敏", () => {
    const input = loadFixture("basic");
    expect(queryTrace(input).previews).toBeUndefined();
    const secret = "sk-proj-QUERYSECRETMARKER1234567890";
    const poisoned: TraceInput = {
      ...input,
      entries: input.entries.map((e) =>
        e.type === "message" && e.message.role === "toolResult"
          ? { ...e, message: { ...e.message, content: `key ${secret}` } }
          : e,
      ),
    };
    const r = queryTrace(poisoned, { content: "preview" });
    expect(r.previews?.["turn:ba004"]?.input).toContain("README");
    expect(r.previews?.["tool:call_read"]?.args).toContain("README.md");
    expect(r.previews?.["tool:call_read"]?.result).toBe("key [REDACTED]");
    expect(JSON.stringify(r)).not.toContain("QUERYSECRETMARKER");
  });

  it("确定性：同输入同输出", () => {
    const input = loadFixture("parallel");
    expect(JSON.stringify(queryTrace(input, { content: "preview" }))).toBe(
      JSON.stringify(queryTrace(input, { content: "preview" })),
    );
  });
});
