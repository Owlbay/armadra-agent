import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "../../agent/types.js";
import { Container, MemoryTerminal, TUI, plainTheme } from "../../tui.js";
import { RECENT_TOOLS, SubagentTracker, backgroundEndText } from "./subagent-view.js";
import { subagentBackgroundText } from "./event-notices.js";
import { golden, usage } from "./test-support.js";
import { ToolTracker } from "./tool-view.js";

let now = 0;
const theme = plainTheme();

function start(taskId: string, call: string, extra: Partial<SessionEvent> = {}): SessionEvent {
  return {
    type: "subagent_start",
    taskId,
    parentToolCallId: call,
    agent: "explore",
    runner: "ama",
    description: "找出测试缺口",
    background: false,
    cwd: "/w",
    ...extra,
  } as SessionEvent;
}

function tool(taskId: string, name: string, turn: number): SessionEvent {
  return { type: "subagent_update", taskId, kind: "tool", toolName: name, turn };
}

let tui: TUI | undefined;
afterEach(() => {
  tui?.stop();
  tui = undefined;
});

function frame(container: Container, columns: number, label: string): string {
  const terminal = new MemoryTerminal({ columns, rows: 14 });
  tui = new TUI(terminal);
  tui.addChild(container);
  tui.start();
  tui.renderNow();
  const out = [`# ${label} · viewport ${columns}x14`, ...terminal.viewport().map((l) => `|${l}`)];
  tui.stop();
  tui = undefined;
  return out.join("\n") + "\n";
}

describe("子 Agent 折叠视图", () => {
  it("tracker：轮数、最近 3 个工具、用量与终态", () => {
    const tracker = new SubagentTracker(() => now);
    now = 1000;
    tracker.onEvent(start("t1", "c1"));
    for (const [i, name] of ["read", "grep", "glob", "bash"].entries())
      tracker.onEvent(tool("t1", name, i + 1));
    tracker.onEvent({
      type: "subagent_update",
      taskId: "t1",
      kind: "turn",
      turn: 5,
      usage: usage({ input: 1000, cacheRead: 11_000, output: 3400 }),
    });
    const state = tracker.forToolCall("c1");
    expect(state?.tools).toHaveLength(RECENT_TOOLS);
    expect(state?.tools).toEqual(["grep", "glob", "bash"]);
    expect(state?.turns).toBe(5);
    now = 66_000;
    tracker.onEvent({ type: "subagent_end", taskId: "t1", status: "completed" });
    expect(tracker.get("t1")?.status).toBe("completed");
    expect(
      tracker.onEvent({ type: "subagent_end", taskId: "t9", status: "failed" }),
    ).toBeUndefined();
    expect(backgroundEndText(tracker.get("t1")!)).toBe(
      "后台任务 t1（explore）完成 · 5 轮 · /tasks 查看输出",
    );
  });

  for (const columns of [80, 40]) {
    it(`task 工具行：前台运行中 / 后台跟随状态 / 外部 runner 失败 ${columns} 列`, () => {
      now = 0;
      const tracker = new SubagentTracker(() => now);
      const tools = new ToolTracker({
        theme,
        cwd: "/w",
        now: () => now,
        subagent: (id) => tracker.forToolCall(id),
      });
      const container = new Container();
      const add = (id: string, args: unknown): void => {
        container.addChild(tools.start({ toolCallId: id, toolName: "task", args }).view);
      };
      // 前台运行中
      add("c1", { prompt: "x", description: "检查 src/tui 的测试覆盖缺口", agent: "explore" });
      tracker.onEvent(start("t1", "c1"));
      tracker.onEvent(tool("t1", "read", 1));
      tracker.onEvent(tool("t1", "grep", 2));
      tracker.onEvent({
        type: "subagent_update",
        taskId: "t1",
        kind: "turn",
        turn: 3,
        usage: usage({ input: 12_000, output: 3400 }),
      });
      // 后台：工具立即返回，跟随状态
      add("c2", { prompt: "y", description: "后台审查", agent: "explore", background: true });
      tracker.onEvent(start("t2", "c2", { background: true }));
      tools.end(
        "c2",
        { content: [{ type: "text", text: "Started background task t2 (agent explore)." }] },
        false,
      );
      tracker.onEvent(tool("t2", "read", 1));
      // 外部 runner 失败
      add("c3", { prompt: "z", description: "让 claude 改", agent: "claude" });
      tracker.onEvent(start("t3", "c3", { agent: "claude", runner: "claude" }));
      now = 65_000;
      tracker.onEvent({ type: "subagent_end", taskId: "t3", status: "failed" });
      tools.end(
        "c3",
        { content: [{ type: "text", text: "Sub-agent failed: boom" }], isError: true },
        true,
      );
      const shot = frame(container, columns, "subagent views");
      golden(`subagent-view-${columns}x14`, shot);
      if (columns === 80) {
        expect(shot).toContain("explore · 运行中 1m05s · 3 轮 · read grep · ↑12k ↓3.4k");
        expect(shot).toContain("↳ t2 explore · 运行中 1m05s · 1 轮 · read");
      }
    });
  }
});

describe("[W7-C] 转后台的呈现", () => {
  it("subagent_background：tracker 置后台；工具行 `已转后台 · 耗时` + 跟随行，说明文字折叠时不显示", () => {
    now = 0;
    const tracker = new SubagentTracker(() => now);
    const tools = new ToolTracker({
      theme,
      cwd: "/w",
      now: () => now,
      subagent: (id) => tracker.forToolCall(id),
    });
    const view = tools.start({
      toolCallId: "c1",
      toolName: "task",
      args: { prompt: "x", description: "扫描", agent: "explore" },
    }).view;
    tracker.onEvent(start("t1", "c1"));
    expect(
      tracker.onEvent({
        type: "subagent_background",
        taskId: "t9",
        parentToolCallId: "c9",
        reason: "user",
      }),
    ).toBeUndefined();
    now = 12_000;
    tracker.onEvent({
      type: "subagent_background",
      taskId: "t1",
      parentToolCallId: "c1",
      reason: "user",
    });
    expect(tracker.get("t1")?.background).toBe(true);
    const text =
      "[task t1] Moved to the background by the user; it was not interrupted. A <task-notification> arrives when it finishes.";
    tools.end("c1", { content: [{ type: "text", text }], details: { status: "running" } }, false);
    const lines = view.render(80).map((l) => l.trimEnd());
    expect(lines[1]).toBe("  ⎿ 已转后台 · 12s");
    expect(lines[2]).toMatch(/^ {4}↳ t1 explore · 运行中 12s$/);
    expect(lines).toHaveLength(3);
    // 直接后台启动
    const direct = tools.start({ toolCallId: "c2", toolName: "task", args: { prompt: "y" } }).view;
    tracker.onEvent(start("t2", "c2", { background: true }));
    tools.end(
      "c2",
      {
        content: [{ type: "text", text: "Started background task t2 (agent explore)." }],
        details: { status: "running" },
      },
      false,
    );
    expect(direct.render(80)[1]?.trimEnd()).toBe("  ⎿ 已在后台启动");
  });

  it("event-notices：超时 / 宿主转后台的一行提示（人按的不在这里）", () => {
    const event = (reason: "timeout" | "host") =>
      ({ type: "subagent_background", taskId: "t2", parentToolCallId: "c", reason }) as const;
    expect(subagentBackgroundText(event("timeout"), "explore")).toBe(
      "t2 explore 运行较久，已自动转后台（subagents.autoBackgroundAfterMs）",
    );
    expect(subagentBackgroundText(event("host"), "explore")).toBe("t2 explore 已由宿主转后台");
  });
});
