import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../i18n/index.js";
import type { ApprovalDecision, ApprovalRequest } from "../../permissions/types.js";
import { Editor, MemoryTerminal, TUI, Text, plainTheme } from "../../tui.js";
import {
  ApprovalDialogBroker,
  approvalOutcomeText,
  approvalTitle,
  sourceLabel,
} from "./approval-dialog.js";
import { FirstRunMerge, mergingBroker } from "./approval-merge.js";
import { approvalQuestion } from "./line/line-render.js";
import { golden } from "./test-support.js";

const theme = plainTheme();
const taskAgent = (taskId: string): string | undefined =>
  taskId === "t3" ? "reviewer" : taskId === "t4" ? "claude" : undefined;
const runnerOf = (agent: string): string | undefined =>
  agent === "claude" ? "claude" : agent === "reviewer" ? "ama" : undefined;

const ORIGIN: ApprovalRequest = {
  requestId: "r1",
  toolName: "agent:claude",
  input: { title: "Write note.txt", kind: "edit" },
  reason: "mode",
  context: {
    depth: 1,
    taskId: "t4",
    origin: {
      agent: "claude",
      sessionId: "abc12345-6789-4def",
      toolCall: {
        title: "Write note.txt",
        kind: "edit",
        locations: ["/w/note.txt"],
        inputSummary: "content: hi",
      },
      options: [
        { optionId: "a", kind: "allow_once" },
        { optionId: "b", kind: "allow_always" },
        { optionId: "c", kind: "reject_once" },
        { optionId: "d", kind: "reject_always" },
      ],
    },
  },
};

const SUBTASK: ApprovalRequest = {
  requestId: "r2",
  toolName: "bash",
  input: { command: "pnpm test" },
  reason: "mode",
  context: { depth: 1, taskId: "t3" },
};

const FIRST_RUN: ApprovalRequest = {
  requestId: "r3",
  toolName: "task",
  input: {
    agent: "claude",
    mode: "default",
    note: "Runs Claude Code with your existing login in that CLI (mode default).",
  },
  reason: "mode",
  context: { depth: 0, taskId: "t4" },
};

const TASK_CALL: ApprovalRequest = {
  requestId: "r4",
  toolName: "task",
  input: { agent: "claude", prompt: "review the diff", description: "审查改动" },
  reason: "mode",
};

let tui: TUI | undefined;
afterEach(() => tui?.stop());

function setup(columns = 80) {
  const terminal = new MemoryTerminal({ columns, rows: 24 });
  tui = new TUI(terminal);
  const editor = new Editor({ theme });
  tui.addChild(new Text("› 让 claude 审查改动"));
  tui.addChild(editor);
  tui.start();
  tui.setFocus(editor);
  const t = tui;
  const events: string[] = [];
  const broker = new ApprovalDialogBroker({
    theme,
    cwd: "/w",
    permissionMode: () => "default",
    taskAgent,
    externalRunner: (agent) => {
      const runner = runnerOf(agent);
      return runner === "ama" ? undefined : runner;
    },
    showOverlay: (c) => t.showOverlay(c, { anchor: "bottom" }),
    report: (r, outcome) => events.push(approvalOutcomeText(r, outcome, taskAgent)),
  });
  const shot = (label: string): string => {
    t.renderNow();
    const { row, col } = terminal.screen.cursor;
    return (
      [
        `# ${label} · viewport ${columns}x24 cursor=${row},${col}`,
        ...terminal.viewport().map((l) => `|${l}`),
      ].join("\n") + "\n"
    );
  };
  const key = (data: string): void => {
    terminal.sendInput(data);
    t.renderNow();
  };
  return { broker, shot, key, events };
}

describe("审批来源标注", () => {
  it("标注文字：外部 Agent / task:<agent> / task / 主会话", () => {
    expect(sourceLabel(ORIGIN, taskAgent)).toBe("[claude · 会话 abc12345]");
    expect(sourceLabel(SUBTASK, taskAgent)).toBe("[task:reviewer]");
    expect(sourceLabel({ ...SUBTASK, context: { depth: 1 } }, taskAgent)).toBe("[task]");
    expect(sourceLabel(TASK_CALL, taskAgent)).toBeUndefined();
    expect(approvalTitle(FIRST_RUN)).toBe("首次运行外部 Agent");
    expect(approvalTitle(SUBTASK, taskAgent)).toBe("[task:reviewer] 需要确认");
    expect(approvalOutcomeText(ORIGIN, "deny", taskAgent)).toBe(
      "已拒绝 [claude · 会话 abc12345] Write note.txt",
    );
  });

  for (const columns of [80, 40]) {
    it(`外部 Agent 的请求 ${columns}x24：标题 / 种类 / 路径来自 origin.toolCall，三项选项`, async () => {
      const s = setup(columns);
      const answer = s.broker.ask(ORIGIN, new AbortController().signal);
      const frame = s.shot("approval origin");
      golden(`approval-origin-${columns}x24`, frame);
      expect(frame).toContain("[claude · 会话 abc12345]");
      expect(frame).toContain("3. 拒绝");
      expect(frame).not.toContain("4.");
      s.key("a");
      expect(await answer).toBe<ApprovalDecision>("allow_session");
    });
  }

  it("task 子 Agent 的请求标 [task:<agent>]", async () => {
    const s = setup();
    const answer = s.broker.ask(SUBTASK, new AbortController().signal);
    const frame = s.shot("approval task agent");
    golden("approval-task-agent-80x24", frame);
    expect(frame).toContain("╭─ [task:reviewer] 需要确认");
    s.key("n");
    expect(await answer).toBe("deny");
    expect(s.events).toEqual(["已拒绝 [task:reviewer] bash"]);
  });

  it("外部 Agent 首次运行确认：说明与模式", async () => {
    const s = setup();
    const answer = s.broker.ask(FIRST_RUN, new AbortController().signal);
    const frame = s.shot("approval first run");
    golden("approval-first-run-80x24", frame);
    expect(frame).toContain("首次运行外部 Agent");
    expect(frame).toContain("Runs Claude Code with your existing login");
    expect(frame).toContain("模式 Manual");
    s.key("y");
    expect(await answer).toBe("allow");
  });

  it("外部 Agent 的 task 调用：正文写明一并确认首次运行", async () => {
    const s = setup();
    const answer = s.broker.ask(TASK_CALL, new AbortController().signal);
    const frame = s.shot("approval task call external");
    golden("approval-task-external-80x24", frame);
    expect(frame).toContain(
      "外部 Agent claude：以你在 claude CLI 的登录运行（含本会话首次运行确认）",
    );
    s.key("y");
    expect(await answer).toBe("allow");
  });

  it("line 模式问句带来源", () => {
    expect(approvalQuestion(ORIGIN, taskAgent)).toBe(
      "[claude · 会话 abc12345] 允许 Write note.txt /w/note.txt？[y 允许 / a 本会话都允许 / N 拒绝] ",
    );
    expect(approvalQuestion(SUBTASK, taskAgent)).toContain("[task:reviewer] 允许 bash pnpm test");
    expect(approvalQuestion(FIRST_RUN)).toContain("Runs Claude Code");
  });
});

describe("首次运行合并确认", () => {
  function harness(options: { startedAt?: number; agent?: string } = {}) {
    let now = 1000;
    const merge = new FirstRunMerge({
      sessionId: () => "s1",
      now: () => now,
      runnerOf,
      taskOf: (taskId) =>
        taskId === "t4"
          ? { agent: options.agent ?? "claude", startedAt: options.startedAt ?? 1500 }
          : undefined,
    });
    const asked: string[] = [];
    const merged: string[] = [];
    let reply: ApprovalDecision = "allow";
    const broker = mergingBroker(
      {
        ask: async (request) => {
          asked.push(request.requestId);
          return reply;
        },
      },
      merge,
      (request) => merged.push(request.requestId),
    );
    const ask = (r: ApprovalRequest) => broker.ask(r, new AbortController().signal);
    return {
      ask,
      asked,
      merged,
      tick: (ms: number) => (now += ms),
      setReply: (d: ApprovalDecision) => (reply = d),
    };
  }

  it("允许 task(agent=claude) 后紧接着的首次运行确认自动允许，只问一次", async () => {
    const h = harness();
    expect(await h.ask(TASK_CALL)).toBe("allow");
    h.tick(800);
    expect(await h.ask(FIRST_RUN)).toBe("allow");
    expect(h.asked).toEqual(["r4"]);
    expect(h.merged).toEqual(["r3"]);
    // 记录只用一次
    expect(await h.ask(FIRST_RUN)).toBe("allow");
    expect(h.asked).toEqual(["r4", "r3"]);
  });

  it("拒绝 task 调用、中间夹了别的请求、超时、任务不是这次调用建立的：照常询问", async () => {
    const denied = harness();
    denied.setReply("deny");
    await denied.ask(TASK_CALL);
    denied.setReply("allow");
    await denied.ask(FIRST_RUN);
    expect(denied.asked).toEqual(["r4", "r3"]);

    const between = harness();
    await between.ask(TASK_CALL);
    await between.ask(SUBTASK);
    await between.ask(FIRST_RUN);
    expect(between.asked).toEqual(["r4", "r2", "r3"]);

    const late = harness({ startedAt: 70_000 });
    await late.ask(TASK_CALL);
    late.tick(61_000);
    await late.ask(FIRST_RUN);
    expect(late.asked).toEqual(["r4", "r3"]);

    const older = harness({ startedAt: 500 });
    await older.ask(TASK_CALL);
    await older.ask(FIRST_RUN);
    expect(older.asked).toEqual(["r4", "r3"]);

    const other = harness({ agent: "codex" });
    await other.ask(TASK_CALL);
    await other.ask(FIRST_RUN);
    expect(other.asked).toEqual(["r4", "r3"]);
  });

  it("ama 类型的 task 调用不记录", async () => {
    const h = harness();
    await h.ask({ ...TASK_CALL, input: { agent: "reviewer", prompt: "x" } });
    await h.ask(FIRST_RUN);
    expect(h.asked).toEqual(["r4", "r3"]);
  });
});

describe("审批来源标注（en）", () => {
  afterEach(() => setLocale("zh"));

  it("外部 Agent 的请求 80x24", async () => {
    setLocale("en");
    const s = setup(80);
    const answer = s.broker.ask(ORIGIN, new AbortController().signal);
    golden("en/approval-origin-80x24", s.shot("approval origin"));
    s.key("a");
    expect(await answer).toBe<ApprovalDecision>("allow_session");
  });
});
