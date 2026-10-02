/**
 * 轨迹扁平化与格式化（docs/wave6-plan.md §2.4）：行模型、分页、条形、line 模式文本黄金。[W6-T1]
 * 更新黄金：`AMA_UPDATE_GOLDEN=1 pnpm vitest run src/trace/format.test.ts`。
 */

import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n/index.js";
import { stripAnsi, visibleWidth } from "../tui/ansi.js";
import { createTheme, plainTheme } from "../tui/theme.js";
import { buildTrace, type TraceInput } from "./build.js";
import { describeNode, detailLines, entryLookup } from "./detail.js";
import {
  countNodes,
  flattenNode,
  flattenTrace,
  rowIndex,
  tailStart,
  type TraceRow,
} from "./flatten.js";
import { barText, formatRow, formatTraceText, NARROW_WIDTH } from "./format.js";
import { findSubagent } from "./build.js";
import { TRACE_FIXTURES, fixtureChild, loadFixture, traceGolden } from "./test-support.js";
import type { Trace } from "./types.js";

afterEach(() => setLocale("zh"));

function lookupFor(input: TraceInput) {
  const child = fixtureChild("subagent-child");
  return entryLookup([...input.entries, ...(child?.entries ?? [])], input.header.cwd);
}

function textOf(name: string): string {
  const input = loadFixture(name);
  const trace = buildTrace(input, { loadChild: fixtureChild });
  const lookup = lookupFor(input);
  return formatTraceText(trace, { theme: plainTheme(), describe: (n) => describeNode(n, lookup) });
}

describe("line 模式文本黄金", () => {
  for (const name of TRACE_FIXTURES) it(name, () => traceGolden(`${name}.trace.txt`, textOf(name)));

  it("en", () => {
    setLocale("en");
    traceGolden("subagent.trace.en.txt", textOf("subagent"));
    traceGolden("legacy-approx.trace.en.txt", textOf("legacy-approx"));
  });
});

describe("扁平化", () => {
  const trace = buildTrace(loadFixture("subagent"), { loadChild: fixtureChild });

  it("缺省：回合与请求展开，工具与子 Agent 折叠；key 是稳定路径", () => {
    const rows = flattenTrace(trace);
    expect(rows.map((r) => [r.key, r.depth, r.expanded])).toEqual([
      ["t:su004", 0, true],
      ["t:su004/s:su005", 1, true],
      ["t:su004/s:su005/x:c_task1", 2, false],
      ["t:su004/s:su005/x:c_task2", 2, false],
      ["t:su004/s:su012", 1, false],
    ]);
  });

  it("展开工具与子 Agent：子轨迹的回合挂在子 Agent 下，按子轨迹编号", () => {
    const expanded = new Map([
      ["t:su004/s:su005/x:c_task1", true],
      ["t:su004/s:su005/x:c_task1/a:t1", true],
    ]);
    const rows = flattenTrace(trace, { expanded });
    const sub = rows.find((r) => r.key.endsWith("/a:t1/t:ch003"));
    expect(sub).toMatchObject({ depth: 4, turn: 1, expanded: true });
    expect(sub?.span?.start).toBeGreaterThan(0);
  });

  it("懒加载：没有子轨迹时子 Agent 仍可展开（needsChild）", () => {
    const lazy = buildTrace(loadFixture("subagent"));
    const expanded = new Map([["t:su004/s:su005/x:c_task1", true]]);
    const row = flattenTrace(lazy, { expanded }).find((r) => r.key.endsWith("/a:t1"));
    expect(row).toMatchObject({ expandable: true, expanded: false });
  });

  it("分页：尾部优先，之前的回合折成一行；辅助请求收成一组", () => {
    const big = buildTrace(loadFixture("overflow"));
    const rows = flattenTrace(big, { fromTurn: 1 });
    expect(rows[0]).toMatchObject({ key: "more", node: { kind: "more", hidden: 1 } });
    expect(rows.at(-1)).toMatchObject({ key: "aux", expanded: false });
    expect(tailStart(big, 50)).toBe(0);
    const open = flattenTrace(big, { expanded: new Map([["aux", true]]) });
    expect(open.slice(-2).map((r) => r.key)).toEqual(["aux/u:ov012", "aux/u:ov014"]);
    expect(rowIndex(open, "aux")).toBe(open.length - 3);
  });

  it("以子 Agent 为根（/trace t2）", () => {
    const sub = findSubagent(buildTrace(loadFixture("external")), "t1")!;
    const rows = flattenNode(sub, { expanded: new Map([["a:t1", true]]) });
    expect(rows.map((r) => r.key)).toEqual(["a:t1", "a:t1/e:t1#1"]);
  });

  it("节点计数", () => {
    expect(countNodes(trace)).toBe(11);
  });
});

describe("行格式", () => {
  const trace = buildTrace(loadFixture("parallel"));
  const rows = flattenTrace(trace, { expanded: new Map() });
  const lookup = lookupFor(loadFixture("parallel"));
  const ctx = (theme = plainTheme()) => ({
    theme,
    describe: (n: TraceRow["node"]) => describeNode(n, lookup),
  });

  it("每行可见宽恰为 width（120 / 80 / 60 / 59 / 40）", () => {
    for (const width of [120, 80, 60, 59, 40])
      for (const row of rows) expect(visibleWidth(formatRow(row, width, ctx()))).toBe(width);
  });

  it("宽 < 60 去掉条形与 token 列", () => {
    const narrow = formatRow(rows[0]!, NARROW_WIDTH - 1, ctx());
    expect(narrow).not.toContain("[");
    expect(narrow).not.toContain("↑");
    expect(formatRow(rows[0]!, NARROW_WIDTH, ctx())).toContain("↑");
  });

  it("条形：Unicode（有色）与 ASCII / 无色降级；同一回合共用时间轴", () => {
    const color = createTheme("dark", { caps: { colors: 256 }, ascii: false });
    const step = rows[1]!;
    expect(stripAnsi(barText(step, 14, color))).toMatch(/^▕[▒█░ ]{12}▏$/);
    expect(barText(step, 14, plainTheme())).toMatch(/^\[[.=\- ]{12}\]$/);
    expect(barText(step, 14, plainTheme())).toContain("=");
    // bash 工具 8 s，占回合 12 s 的大部分
    const bash = rows[2]!;
    expect((barText(bash, 26, plainTheme()).match(/-/g) ?? []).length).toBeGreaterThan(14);
  });

  it("进行中只画起点、耗时为 …", () => {
    const live = buildTrace(loadFixture("legacy-approx"), {
      live: {
        running: true,
        tools: [{ id: "l_edit", name: "edit", startedAt: 1_791_014_496_000 }],
      },
    });
    const all = flattenTrace(live, { expanded: new Map([["t:le014/s:le016", true]]) });
    const edit = all.find((r) => r.key.endsWith("x:l_edit"))!;
    const line = formatRow(edit, 80, ctx());
    expect(line).toContain("…");
    expect(barText(edit, 14, plainTheme()).replace(/[[\] ]/g, "")).toBe("|");
  });

  it("详情：概要、用量与缓存、参数与结果预览", () => {
    const bash = rows[2]!;
    const lines = detailLines(bash.node, lookup, 60, plainTheme(), trace.startedAt).join("\n");
    expect(lines).toContain("等待审批");
    expect(lines).toContain('"command": "pnpm test"');
    expect(lines).toContain("Tests  42 passed");
    const step = detailLines(rows[1]!.node, lookup, 60, plainTheme(), trace.startedAt).join("\n");
    expect(step).toContain("anthropic/claude-sonnet-4-5");
    expect(step).toContain("缓存命中");
  });

  it("预览截断：参数 500、结果 2000", () => {
    const input = loadFixture("basic");
    const long = "x".repeat(5000);
    const entries = input.entries.map((e) =>
      e.type === "message" && e.message.role === "toolResult"
        ? { ...e, message: { ...e.message, content: long } }
        : e,
    );
    const t: Trace = buildTrace({ ...input, entries });
    const tool = flattenTrace(t, { expanded: new Map() }).find((r) => r.node.kind === "tool")!;
    const text = detailLines(tool.node, entryLookup(entries), 4000, plainTheme(), 0).join("\n");
    expect(text).toContain("x".repeat(2000));
    expect(text).not.toContain("x".repeat(2001));
    expect(text).toContain("原长 5000 字符");
  });
});
