/**
 * Agent 栏（docs/wave6-plan.md §1.1–§1.2、D4）：各状态、最多 3 行 +「另 N 个」、聚焦与滚动、保留规则
 * （查看过或 10 分钟）、`ui.agentBar: "off"`；帧黄金 80 / 40 列、ASCII、en。[W6-A]
 */

import { afterEach, describe, expect, it } from "vitest";
import { fakeRegistry, info, start } from "../../agent/testing/agent-view-fixtures.js";
import { setLocale } from "../../i18n/index.js";
import type { TaskInfo } from "../../tools/types.js";
import { plainTheme, type Theme } from "../../tui.js";
import { AgentBar, BAR_RETAIN_MS } from "./agent-bar.js";
import { SubagentTracker } from "./subagent-view.js";
import { golden, lines, usage } from "./test-support.js";

afterEach(() => setLocale("zh"));

interface Scene {
  bar: AgentBar;
  tracker: SubagentTracker;
  infos: TaskInfo[];
  clock: { now: number };
  approvals: Set<string>;
  enabled: { value: boolean };
}

/** 五个任务：运行中（工具）、等审批（外部）、排队、完成、失败。 */
function scene(theme: Theme = plainTheme()): Scene {
  const clock = { now: 0 };
  const tracker = new SubagentTracker(() => clock.now);
  const infos = [
    info("t1", { description: "找出 src/tui 的测试缺口" }),
    info("t2", { agent: "codex", runner: "codex", description: "review the diff" }),
    info("t3", { description: "排队中的任务" }),
    info("t4", { agent: "general", status: "completed", endedAt: 12_000, turns: 2 }),
    info("t5", { status: "failed", endedAt: 3000 }),
  ];
  tracker.onEvent(start("t1"));
  for (const [i, name] of ["read", "grep"].entries())
    tracker.onEvent({
      type: "subagent_update",
      taskId: "t1",
      kind: "tool",
      toolName: name,
      turn: i + 2,
    });
  tracker.onEvent({
    type: "subagent_update",
    taskId: "t1",
    kind: "turn",
    turn: 3,
    usage: usage({ input: 1000, output: 3400, cacheRead: 11_000 }),
  });
  tracker.onEvent(start("t2", "codex", "codex"));
  tracker.onEvent(start("t4", "general"));
  tracker.onEvent(start("t5"));
  clock.now = 12_000;
  tracker.onEvent({ type: "subagent_end", taskId: "t4", status: "completed" });
  tracker.onEvent({ type: "subagent_update", taskId: "t4", kind: "turn", turn: 2 });
  clock.now = 3000;
  tracker.onEvent({ type: "subagent_end", taskId: "t5", status: "failed" });
  clock.now = 65_000;
  const approvals = new Set(["t2"]);
  const enabled = { value: true };
  const registry = fakeRegistry(infos, { queued: new Set(["t3"]) });
  const bar = new AgentBar({
    theme,
    registry: () => registry,
    tracker,
    now: () => clock.now,
    approvals: () => approvals,
    enabled: () => enabled.value,
  });
  return { bar, tracker, infos, clock, approvals, enabled };
}

function frames(theme: Theme, width: number): string {
  const s = scene(theme);
  const out: string[] = [`# agent bar · ${width} 列`];
  const section = (label: string): void => {
    out.push(`## ${label}`);
    out.push(...lines(s.bar, width).map((l) => `|${l}`));
  };
  section("未聚焦：最多 3 行 + 另 N 个");
  s.bar.focus();
  section("聚焦：第 1 项");
  s.bar.move(3);
  section("聚焦：第 4 项（窗口滚动）");
  s.bar.blur();
  s.bar.markViewed("t4");
  s.approvals.clear();
  section("t4 查看过、t2 审批完");
  return out.join("\n") + "\n";
}

describe("Agent 栏：帧黄金", () => {
  for (const width of [80, 40])
    it(`zh ${width} 列`, () => golden(`agent-bar-${width}`, frames(plainTheme(), width)));

  it("ASCII 80 列", () => golden("agent-bar-ascii-80", frames(plainTheme({ ascii: true }), 80)));

  for (const width of [80, 40])
    it(`en ${width} 列`, () => {
      setLocale("en");
      golden(`en/agent-bar-${width}`, frames(plainTheme(), width));
    });
});

describe("Agent 栏：显示规则", () => {
  it("结束后未查看的保留 10 分钟；活动的一直在", () => {
    const s = scene();
    expect(s.bar.visibleRows().map((r) => r.taskId)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    s.clock.now += BAR_RETAIN_MS;
    expect(s.bar.visibleRows().map((r) => r.taskId)).toEqual(["t1", "t2", "t3"]);
  });

  it("续聊重新开跑：查看与保留重新计", () => {
    const s = scene();
    s.bar.markViewed("t4");
    expect(s.bar.visibleRows().map((r) => r.taskId)).not.toContain("t4");
    const t4 = s.infos[3]!;
    t4.status = "running";
    delete t4.endedAt;
    s.tracker.onEvent(start("t4", "general"));
    expect(s.bar.visibleRows().map((r) => r.taskId)).toContain("t4");
    t4.status = "completed";
    expect(s.bar.visibleRows().map((r) => r.taskId)).toContain("t4");
  });

  it("本进程没看着跑的任务（resume 重建）不进未聚焦的栏，聚焦时列出", () => {
    const s = scene();
    s.infos.push(info("t6", { status: "interrupted", endedAt: 1 }));
    expect(s.bar.visibleRows().map((r) => r.taskId)).not.toContain("t6");
    s.bar.focus();
    expect(s.bar.all().map((r) => r.taskId)).toContain("t6");
  });

  it("ui.agentBar off：不显示、不能聚焦", () => {
    const s = scene();
    s.enabled.value = false;
    expect(s.bar.render(80)).toEqual([]);
    expect(s.bar.focus()).toBe(false);
    expect(s.bar.visible).toBe(false);
  });

  it("选择：↑ 越过第一项返回 false；↓ 停在最后一项；select 定位", () => {
    const s = scene();
    s.bar.focus();
    expect(s.bar.move(-1)).toBe(false);
    s.bar.move(10);
    expect(s.bar.selected()).toBe("t5");
    s.bar.select("t2");
    expect(s.bar.selected()).toBe("t2");
  });

  it("没有任务：未聚焦不占行，focus 返回 false", () => {
    const bar = new AgentBar({
      theme: plainTheme(),
      registry: () => fakeRegistry([]),
      tracker: new SubagentTracker(() => 0),
      now: () => 0,
      approvals: () => new Set(),
      enabled: () => true,
    });
    expect(bar.render(80)).toEqual([]);
    expect(bar.focus()).toBe(false);
  });
});
