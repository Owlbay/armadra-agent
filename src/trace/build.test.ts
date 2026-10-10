/**
 * 轨迹构建器（docs/history/wave6-plan.md §2.3、§2.7 T1）：9 类会话夹具的黄金、确定性、容忍与 live 叠加。
 * 夹具 `test/fixtures/trace/*.jsonl`；黄金 `*.trace.json`（整棵树；line 模式文本黄金见 format.test.ts）。
 * 更新：`AMA_UPDATE_GOLDEN=1 pnpm vitest run src/trace/build.test.ts`，逐个审阅 diff。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionImpl } from "../agent/session.js";
import { telemetryFactory } from "../agent/session-telemetry.js";
import { traceWriterFactory } from "../agent/session-trace-writer.js";
import { createScriptedApi } from "../agent/testing/scripted-api.js";
import { fakeModel, stubRegistry, stubTool } from "../agent/testing/stubs.js";
import { SessionManager } from "../session/manager.js";
import type { SessionEntry } from "../session/types.js";
import { buildTrace, findSubagent, loadSubagentTrace } from "./build.js";
import {
  FIXTURES,
  TRACE_FIXTURES,
  fixtureChild,
  loadFixture,
  traceGolden,
} from "./test-support.js";
import type { Trace, TraceStepNode, TraceToolNode } from "./types.js";

function build(name: string, extra: Parameters<typeof buildTrace>[1] = {}): Trace {
  return buildTrace(loadFixture(name), { loadChild: fixtureChild, ...extra });
}

function steps(trace: Trace, turn = 0): TraceStepNode[] {
  return (trace.turns[turn]?.steps ?? []).filter((s): s is TraceStepNode => s.kind === "step");
}

function tools(trace: Trace): TraceToolNode[] {
  return trace.turns.flatMap((t) => t.steps.flatMap((s) => (s.kind === "step" ? s.tools : [])));
}

describe("黄金夹具", () => {
  for (const name of TRACE_FIXTURES) {
    it(name, () => {
      const trace = build(name);
      traceGolden(`${name}.trace.json`, `${JSON.stringify(trace, null, 2)}\n`);
    });
  }
});

describe("语义", () => {
  it("普通：两回合，精确计时（无 approx），ttft / tps 来自 ama.trace", () => {
    const trace = build("basic");
    expect(trace.turns).toHaveLength(2);
    expect(JSON.stringify(trace)).not.toContain('"approx"');
    const [first] = steps(trace);
    expect(first).toMatchObject({ ttftMs: 1200, attempt: 1, status: "ok" });
    expect(first?.tools[0]).toMatchObject({
      name: "read",
      status: "ok",
      startedAt: expect.any(Number),
    });
    expect(trace.totals).toMatchObject({ requests: 3, toolCalls: 1, ttftP50: 750 });
    expect(trace.partial).toBe(false);
  });

  it("并行：两工具起止不同；审批等待；被拒；steer 不开新回合", () => {
    const trace = build("parallel");
    expect(trace.turns).toHaveLength(1);
    expect(trace.turns[0]?.entryIds).toHaveLength(2);
    const [bash, grep, write] = tools(trace);
    expect([bash?.startedAt, bash?.endedAt]).not.toEqual([grep?.startedAt, grep?.endedAt]);
    expect(bash).toMatchObject({ approvalMs: 3200, status: "ok" });
    expect(write).toMatchObject({ denied: true, status: "denied", isError: true });
  });

  it("codemode：内层调用挂在外层工具下，错误的标 error", () => {
    const [cm] = tools(build("codemode"));
    expect(cm?.children.map((c) => [c.kind, c.id, c.status])).toEqual([
      ["subcall", "cm1_n1", "ok"],
      ["subcall", "cm1_n2", "ok"],
      ["subcall", "cm1_n3", "error"],
    ]);
  });

  it("重试 + 回退：两次失败标 retried，等待节点，第三次带 fallbackFrom", () => {
    const trace = build("retry-fallback");
    const kinds = trace.turns[0]?.steps.map((s) =>
      s.kind === "step" ? `${s.status}#${s.attempt}` : s.kind,
    );
    expect(kinds).toEqual(["retried#1", "retry_wait", "retried#2", "ok#3"]);
    expect(steps(trace).at(-1)).toMatchObject({
      provider: "openai",
      fallbackFrom: "anthropic/claude-sonnet-4-5",
    });
    expect(trace.turns[0]?.status).toBe("ok");
  });

  it("溢出压缩：失败请求 retried，压缩节点带触发与精确起止；辅助请求进 aux（保温只有结束时间 → approx）", () => {
    const trace = build("overflow");
    const nodes = trace.turns[0]?.steps ?? [];
    expect(nodes.map((n) => n.kind)).toEqual(["step", "compaction", "step"]);
    expect(nodes[0]?.status).toBe("retried");
    expect(nodes[1]).toMatchObject({ trigger: "overflow", tokensBefore: 210000 });
    expect(nodes[1]?.approx).toBeUndefined();
    expect(trace.aux.map((a) => [a.purpose, a.approx === true])).toEqual([
      ["cache_warm", true],
      ["permission_classify", false],
    ]);
    // 压缩与辅助请求的用量计入合计（与 usageTotals 同一口径）
    expect(trace.totals.requests).toBe(5);
  });

  it("子 Agent：ama 子会话经 loadChild 递归一层；缺文件标 childMissing；后台任务不拉长回合", () => {
    const trace = build("subagent");
    const t1 = findSubagent(trace, "t1");
    expect(t1?.child?.sessionId).toBe("sess-child");
    expect(t1?.child?.turns).toHaveLength(1);
    expect(t1?.status).toBe("ok");
    const t2 = findSubagent(trace, "t2");
    expect(t2).toMatchObject({ childMissing: true, background: true, status: "error" });
    expect(trace.turns[0]?.endedAt).toBeLessThan(t2?.endedAt ?? 0);
  });

  it("子 Agent 懒加载：不给 loadChild 时只有 childRef，之后 loadSubagentTrace 补上；回调抛错 → childMissing", () => {
    const trace = buildTrace(loadFixture("subagent"));
    const t1 = findSubagent(trace, "t1")!;
    expect(t1.child).toBeUndefined();
    expect(t1.childRef?.sessionFile).toContain("subagent-child.jsonl");
    expect(loadSubagentTrace(t1, fixtureChild)?.turns).toHaveLength(1);
    const t2 = findSubagent(trace, "t2")!;
    expect(
      loadSubagentTrace(t2, () => {
        throw new Error("EACCES");
      }),
    ).toBeUndefined();
    expect(t2.childMissing).toBe(true);
  });

  it("外部 Agent：只有骨架（种类 / 状态 / 时间 / 计数）", () => {
    const sub = findSubagent(build("external"), "t1");
    expect(sub).toMatchObject({ runner: "codex", status: "ok" });
    expect(sub?.external?.[0]).toMatchObject({ turn: 1, toolCount: 3, filesTouched: 2 });
    expect(sub?.external?.[0]?.tools.map((t) => t.kind)).toEqual(["execute", "edit", "execute"]);
  });

  it("回滚分支：leaf 只含当前分支，all 按文件序含被离开的分支", () => {
    expect(build("rewind-branch").turns).toHaveLength(2);
    expect(build("rewind-branch", { branch: "all" }).turns).toHaveLength(3);
  });

  it("老会话：全部推算并标 approx；没有结果的工具 interrupted；ttft 分位不用推算值；文件不变", () => {
    const file = join(FIXTURES, "legacy-approx.jsonl");
    const before = readFileSync(file, "utf8");
    const trace = build("legacy-approx");
    expect(steps(trace).every((s) => s.approx === true)).toBe(true);
    expect(tools(trace).every((t) => t.approx === true)).toBe(true);
    expect(trace.totals.ttftP50).toBeUndefined();
    expect(steps(trace).map((s) => s.status)).toEqual(["ok", "retried", "ok"]);
    expect(trace.turns[1]?.status).toBe("interrupted");
    expect(tools(trace).at(-1)).toMatchObject({ name: "edit", status: "interrupted" });
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("性质", () => {
  it("确定性：两次构建逐字节相同；不读时钟", () => {
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock read");
    });
    try {
      for (const name of TRACE_FIXTURES)
        expect(JSON.stringify(build(name))).toBe(JSON.stringify(build(name)));
    } finally {
      now.mockRestore();
    }
  });

  it("容忍：损坏的 ama.trace / ama.task、未知条目、孤立 toolResult 不抛", () => {
    const input = loadFixture("basic");
    const at = input.entries.at(-1)!;
    const junk = (n: number, extra: object): SessionEntry =>
      ({ ...extra, id: `junk${n}`, parentId: null, timestamp: at.timestamp }) as SessionEntry;
    const entries = [
      ...input.entries,
      junk(1, { type: "custom", customType: "ama.trace", data: null }),
      junk(2, { type: "custom", customType: "ama.trace", data: { kind: "step", tools: "x" } }),
      junk(3, { type: "custom", customType: "ama.task", data: { taskId: 3, status: "running" } }),
      junk(4, { type: "custom", customType: "ama.trace", data: { kind: "retry_wait" } }),
      junk(5, { type: "future_kind", payload: 1 }),
      junk(6, {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "nope",
          toolName: "x",
          content: "",
          isError: false,
          timestamp: 0,
        },
      }),
    ];
    const trace = buildTrace({ ...input, entries, leaf: undefined }, { branch: "all" });
    expect(trace.turns).toHaveLength(2);
  });

  it("空会话：没有回合，startedAt 用会话头", () => {
    const input = loadFixture("basic");
    const trace = buildTrace({ header: input.header, entries: [], leaf: null });
    expect(trace).toMatchObject({
      turns: [],
      aux: [],
      partial: false,
      startedAt: Date.parse(input.header.timestamp),
    });
  });

  it("live 叠加：在途请求与执行中的工具标 running、只有起点；partial", () => {
    const input = loadFixture("legacy-approx");
    const trace = buildTrace(input, {
      live: {
        running: true,
        request: { requestAt: 1_791_014_499_000, firstTokenAt: 1_791_014_499_400 },
        tools: [
          { id: "l_edit", name: "edit", startedAt: 1_791_014_496_000 },
          { id: "l_edit_n1", name: "read", startedAt: 1_791_014_496_100, parentId: "l_edit" },
        ],
      },
    });
    expect(trace.partial).toBe(true);
    expect(trace.endedAt).toBeUndefined();
    const last = trace.turns.at(-1)!;
    expect(last.status).toBe("running");
    expect(last.endedAt).toBeUndefined();
    const edit = tools(trace).at(-1)!;
    expect(edit).toMatchObject({ status: "running", startedAt: 1_791_014_496_000 });
    expect(edit.endedAt).toBeUndefined();
    expect(edit.children[0]).toMatchObject({ kind: "subcall", status: "running" });
    const live = steps(trace, 1).at(-1)!;
    expect(live).toMatchObject({ status: "running", ttftMs: 400, model: "claude-sonnet-4-5" });
    expect(live.endedAt).toBeUndefined();
    // 在途请求不计：3 + 1 次请求 + 1 次压缩
    expect(trace.totals.requests).toBe(5);
  });
});

describe("与写入扩展联调", () => {
  it("真实会话（脚本化 API + 写入扩展）：重试、并行工具、回退都精确、无 approx", async () => {
    const primary = fakeModel();
    const backup = fakeModel({ id: "backup", name: "Backup" });
    const scripted = createScriptedApi((call) =>
      call.index === 0
        ? { kind: "error", message: "502 bad gateway" }
        : call.index === 1
          ? {
              toolCalls: [
                { id: "c_a", name: "fast", args: {} },
                { id: "c_b", name: "fast", args: {} },
              ],
            }
          : { text: "done" },
    );
    const session = new AgentSessionImpl({
      sessionManager: SessionManager.inMemory("/work"),
      providers: stubRegistry([primary, backup], [scripted.api]),
      model: primary,
      tools: [stubTool({ name: "fast", run: async () => ({ content: "ok" }) })],
      retry: { baseDelayMs: 1, maxDelayMs: 2, maxRetries: 2 },
      extensions: [telemetryFactory(), traceWriterFactory()],
    });
    await session.prompt("go");
    const header = {
      type: "session",
      version: 1,
      id: "s",
      timestamp: new Date(0).toISOString(),
      cwd: "/work",
      agent: { name: "ama", version: "0" },
    } as const;
    const trace = buildTrace({ header, entries: session.entries });
    expect(JSON.stringify(trace)).not.toContain('"approx"');
    const kinds = trace.turns[0]?.steps.map((s) =>
      s.kind === "step" ? `${s.status}#${s.attempt}` : s.kind,
    );
    expect(kinds).toEqual(["retried#1", "retry_wait", "ok#2", "ok#1"]);
    const parallel = steps(trace)[1]!;
    expect(parallel.tools.map((t) => [t.id, t.status])).toEqual([
      ["c_a", "ok"],
      ["c_b", "ok"],
    ]);
    for (const tool of parallel.tools) expect(tool.endedAt).toBeGreaterThanOrEqual(tool.startedAt!);
    expect(trace.totals.requests).toBe(3);
    await session.dispose();
  });
});
