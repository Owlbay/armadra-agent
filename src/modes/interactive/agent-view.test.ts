/**
 * Agent 栏键位与子 Agent 视图的交互集成（MemoryTerminal + fake 供应商）与外部 Agent 视图的帧黄金
 * （docs/wave6-plan.md §1.1–§1.4）。[W6-A]
 *
 * - 空输入 `Ctrl+B` 进栏、有字时仍是光标左移；空输入 `↓` 进栏（tmux 前缀吃掉 `Ctrl+B` 时）；栏里可打印
 *   字符回到输入框；Esc 返回不中断。
 * - `/tasks <id>` 直接进视图；视图帧黄金 80×24 / 40×16；Esc 返回后主区帧与回滚不变。
 * - 视图里发消息：已结束的任务 → 后台续聊（子会话 user 消息 origin direct）。
 * - 子 Agent 的审批在视图上弹出、带来源，标题显示「等待审批」。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../../test/helpers/tmp-home.js";
import type { SessionEvent } from "../../agent/types.js";
import { SessionManager } from "../../session/manager.js";
import type { TaskSource } from "./agent-bar.js";
import {
  fakeRegistry,
  info,
  start as startEvent,
} from "../../agent/testing/agent-view-fixtures.js";
import { registryOf } from "../../agent/subagent-registry.js";
import { sharedCacheReporting } from "../../ai/cache/reporting.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import type { ExternalDisplayEvent } from "../../agents/task-record.js";
import { setLocale } from "../../i18n/index.js";
import { Keybindings, MemoryTerminal, TUI, Text, plainTheme } from "../../tui.js";
import { AgentView } from "./agent-view.js";
import { SubagentTracker } from "./subagent-view.js";
import {
  assistant,
  cleanupStarted,
  golden,
  lines,
  snapshot,
  start,
  type Started,
} from "./test-support.js";

let home: TmpHome | undefined;
afterEach(cleanupStarted);
afterEach(() => {
  home?.cleanup();
  home = undefined;
});
afterEach(() => setLocale("zh"));
beforeEach(() => sharedCacheReporting.clear());

const CTRL_B = "\x02";
const DOWN = "\x1b[B";
const ESC = "\x1b";

async function waitFor(
  s: Started,
  check: (screen: string) => boolean,
  label: string,
): Promise<void> {
  const began = Date.now();
  for (;;) {
    s.frame();
    const screen = s.terminal.viewport().join("\n");
    if (check(screen)) return;
    if (Date.now() - began > 5000) throw new Error(`timeout: ${label}\n${screen}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const screenOf = (s: Started): string => s.terminal.viewport().join("\n");

/** 单独的 Esc 要冲刷输入缓冲（否则等 ESC 超时）。 */
function esc(s: Started): void {
  s.terminal.sendInput(ESC);
  s.terminal.flushInput();
  s.frame();
}

/** 帧黄金：用量与状态栏随 token 估算变，光标随渲染时机变，耗时随真实时钟变。 */
function shot(s: Started, label: string): string {
  // 视口位置取决于此前内容到过的最高行数（随异步时序变）：整屏重画后只看最后一屏
  s.handle.tui.forceFullRedraw();
  s.frame();
  return snapshot(s.terminal, label)
    .replace(/ cursor=\d+,\d+/, "")
    .replace(/↑[\d.]+k? ↓[\d.]+k?/g, "↑<n> ↓<n>")
    .replace(/^\|(Manual|Plan|Bypass permissions) .*$/m, "|<状态栏>")
    .replace(/完成 · \d+(\.\d)?s/g, "完成 · <t>");
}

const BACKGROUND_TASK: FakeResponse = {
  steps: [
    {
      toolCall: {
        name: "task",
        arguments: {
          prompt: "找出 src/tui 的测试缺口",
          description: "找测试缺口",
          agent: "explore",
          background: true,
        },
      },
    },
  ],
};

/** 后台 explore 跑完、父会话收到通知之后的界面。 */
async function finishedTask(columns = 80, rows = 24, extra: FakeResponse[] = []): Promise<Started> {
  const s = await start(
    [BACKGROUND_TASK, { text: "好的" }, { text: "好的" }, { text: "收到通知" }, ...extra],
    {
      columns,
      rows,
      argv: ["--tools", "read,task", "--permission-mode", "full-auto"],
    },
  );
  s.type("后台找一下测试缺口\r");
  await waitFor(s, (x) => x.includes("收到通知"), "notification");
  await s.handle.session().waitForIdle();
  s.frame();
  return s;
}

describe("Agent 栏键位", () => {
  it("空输入 Ctrl+B 进栏、有字时仍左移；↓ 进栏；可打印字符回到输入框；Esc 返回不回滚", async () => {
    const s = await finishedTask();
    expect(screenOf(s)).toContain("⏺ t1 explore · 完成");
    s.type("ab");
    s.type(CTRL_B);
    s.type("X");
    expect(s.handle.editor.getText()).toBe("aXb");
    s.handle.editor.clear();
    s.type(CTRL_B);
    expect(screenOf(s)).toContain("Enter 打开");
    esc(s);
    expect(screenOf(s)).not.toContain("Enter 打开");
    expect(screenOf(s)).not.toContain("再按 Esc 回滚");
    // tmux 的前缀吃掉 Ctrl+B：空输入 ↓
    s.type(DOWN);
    expect(screenOf(s)).toContain("Enter 打开");
    s.type("h");
    expect(s.handle.editor.getText()).toBe("h");
    expect(screenOf(s)).not.toContain("Enter 打开");
    // 有字时 ↓ 交给编辑器
    s.type(DOWN);
    expect(screenOf(s)).not.toContain("Enter 打开");
    s.handle.editor.clear();
    // ↑ 越过第一项回到输入框
    s.type(CTRL_B);
    s.type("\x1b[A");
    expect(screenOf(s)).not.toContain("Enter 打开");
    s.handle.exit(0);
    await s.done;
  });

  it("没有任务：Ctrl+B 照常交给编辑器，↓ 不进栏，/tasks 给一行提示", async () => {
    const s = await start([], {});
    s.type(CTRL_B);
    s.type(DOWN);
    expect(screenOf(s)).not.toContain("Enter 打开");
    s.type("/tasks\r");
    await waitFor(s, (x) => x.includes("还没有子 Agent 任务"), "empty");
    s.handle.exit(0);
    await s.done;
  });
});

describe("子 Agent 视图", () => {
  for (const [columns, rows] of [
    [80, 24],
    [40, 16],
  ] as const)
    it(`/tasks t1 直接进视图（${columns}×${rows}），Esc 返回后主区帧与回滚不变`, async () => {
      const s = await finishedTask(columns, rows);
      const before = [...s.terminal.viewport()];
      const scrollback = s.terminal.screen.scrollback().length;
      s.type("/tasks t1\r");
      await waitFor(s, (x) => x.includes("发给 t1"), "view");
      esc(s);
      // 进视图前栏里有 t1（结束、未查看）；查看过之后栏收起，其余不变（差分渲染，不整屏重画）
      const strip = (lines: readonly string[]): string[] =>
        lines.filter((l) => l.trim() !== "" && !l.startsWith("⏺ t1 explore"));
      expect(strip(s.terminal.viewport())).toEqual(strip(before));
      expect(s.terminal.screen.scrollback().length).toBe(scrollback);
      s.type("/tasks t1\r");
      await waitFor(s, (x) => x.includes("发给 t1"), "view again");
      golden(`agent-view-${columns}`, shot(s, "/tasks t1"));
      s.handle.exit(0);
      await s.done;
    });

  it("en 80×24", async () => {
    setLocale("en");
    const s = await finishedTask();
    s.type("/tasks t1\r");
    await waitFor(s, (x) => x.includes("Message t1"), "view");
    golden("en/agent-view-80", shot(s, "/tasks t1"));
    s.handle.exit(0);
    await s.done;
  });

  it("已结束的任务：视图里发消息 → 后台续聊（origin direct），Esc 清空输入、再 Esc 返回", async () => {
    const s = await finishedTask(80, 24, [{ text: "补充看了 tests" }, { text: "收到第二次通知" }]);
    s.type(CTRL_B);
    s.type("\r");
    await waitFor(s, (x) => x.includes("发给 t1"), "view");
    s.type("再看看 tests 目录\r");
    await waitFor(s, (x) => x.includes("补充看了 tests"), "continued");
    expect(screenOf(s)).toContain("› 再看看 tests 目录");
    const registry = registryOf(s.handle.session().state.sessionId)!;
    const entries = registry.live("t1")?.entries?.() ?? [];
    const direct = entries.flatMap((e) =>
      e.type === "message" && e.message.role === "user" ? [e.message] : [],
    );
    expect(direct.at(-1)).toMatchObject({ content: "再看看 tests 目录", origin: "direct" });
    s.type("draft");
    esc(s);
    expect(screenOf(s)).toContain("发给 t1");
    esc(s);
    expect(screenOf(s)).not.toContain("发给 t1");
    await waitFor(s, (x) => x.includes("收到第二次通知"), "parent notified");
    s.handle.exit(0);
    await s.done;
  });

  it("子 Agent 的审批在视图上弹出、带来源；标题显示等待审批", async () => {
    const script: FakeResponse[] = [
      {
        steps: [
          {
            toolCall: {
              name: "task",
              arguments: {
                prompt: "写 a.txt",
                description: "写文件",
                agent: "general",
                background: false,
              },
            },
          },
        ],
      },
      {
        delayMs: 300,
        steps: [{ toolCall: { name: "write", arguments: { path: "a.txt", content: "x" } } }],
      },
      { text: "没写成" },
      { text: "完成" },
    ];
    const s = await start(script, { argv: ["--tools", "read,write,task"] });
    s.type("写个文件\r");
    await waitFor(s, (x) => x.includes("需要确认"), "task approval");
    s.type("y");
    await waitFor(s, (x) => x.includes("t1 general · 运行中"), "bar running");
    s.type(CTRL_B);
    s.type("\r");
    await waitFor(s, (x) => x.includes("发给 t1"), "view");
    await waitFor(s, (x) => x.includes("[task:general]"), "child approval");
    expect(screenOf(s)).toContain("等待审批");
    golden("agent-view-approval-80", shot(s, "approval over view"));
    s.type("n");
    await waitFor(s, (x) => x.includes("没写成"), "child done");
    expect(screenOf(s)).not.toContain("等待审批");
    esc(s);
    await waitFor(s, (x) => x.includes("完成") && !x.includes("发给 t1"), "parent done");
    s.handle.exit(0);
    await s.done;
  });
});

describe("外部 Agent 视图（内存环形缓冲）", () => {
  const events: ExternalDisplayEvent[] = [
    { at: 1, kind: "text", text: "先看一下 diff。", turn: 0 },
    { at: 2, kind: "thought", text: "需要跑测试", turn: 0 },
    { at: 3, kind: "tool", toolName: "shell", status: "started", toolId: "c1", turn: 0 },
    { at: 4, kind: "tool", toolName: "shell", status: "completed", toolId: "c1", turn: 0 },
    { at: 5, kind: "tool", toolName: "apply_patch", status: "started", toolId: "c2", turn: 0 },
    { at: 6, kind: "tool", toolName: "apply_patch", status: "failed", toolId: "c2", turn: 0 },
    { at: 7, kind: "turn", turn: 1 },
    { at: 8, kind: "notice", text: "rate limited, retrying", level: "warn", turn: 1 },
    { at: 9, kind: "text", text: "测试过了。", turn: 1 },
  ];

  function render(columns: number, rows: number, taskId: string): string {
    const tracker = new SubagentTracker(() => 65_000);
    tracker.onEvent(startEvent("t2", "codex", "codex"));
    const registry = fakeRegistry(
      [
        info("t2", {
          agent: "codex",
          runner: "codex",
          sessionRef: { runner: "codex", sessionId: "019a" },
        }),
        info("t3", {
          agent: "codex",
          runner: "codex",
          status: "interrupted",
          endedAt: 5000,
          sessionRef: { runner: "codex", sessionId: "019b-resume" },
        }),
      ],
      { recent: new Map([["t2", events]]) },
    );
    const terminal = new MemoryTerminal({ columns, rows });
    const tui = new TUI(terminal);
    tui.addChild(new Text("主会话的消息"));
    const view = new AgentView(taskId, {
      theme: plainTheme(),
      keys: new Keybindings(),
      registry: () => registry,
      tracker,
      approvals: () => new Set(),
      now: () => 65_000,
      rows: () => rows,
      render: () => undefined,
      siblings: () => ["t2", "t3"],
      close: () => undefined,
      stop: async () => undefined,
    });
    tui.showOverlay(view, { anchor: "bottom" });
    tui.start();
    tui.renderNow();
    const out = [
      `# external ${taskId} · ${columns}x${rows}`,
      ...terminal.viewport().map((l) => `|${l}`),
    ];
    tui.stop();
    return out.join("\n") + "\n";
  }

  it("运行中：文本、思考、工具起止合成一行、回合与 notice（80 / 40 列）；重启后只剩说明", () => {
    golden(
      "agent-view-external",
      [render(80, 24, "t2"), render(40, 16, "t2"), render(80, 12, "t3")].join("\n"),
    );
  });
});

describe("ama 子会话视图（组件）", () => {
  function transcript(turns: number): SessionManager {
    const manager = SessionManager.inMemory("/w");
    for (let i = 1; i <= turns; i++) {
      manager.append({
        type: "message",
        message: { role: "user", content: `问题 ${i}`, timestamp: 0 },
      });
      manager.append({
        type: "message",
        message: assistant([{ type: "text", text: `回答 ${i}` }]),
      });
    }
    return manager;
  }

  function view(registry: TaskSource, taskId = "t1", rows = 12) {
    const closed: string[] = [];
    const v = new AgentView(taskId, {
      theme: plainTheme(),
      keys: new Keybindings(),
      registry: () => registry,
      tracker: new SubagentTracker(() => 0),
      approvals: () => new Set(),
      now: () => 0,
      rows: () => rows,
      render: () => undefined,
      siblings: () => ["t1", "t2"],
      close: () => closed.push("closed"),
      stop: async () => undefined,
    });
    v.focused = true;
    return { v, closed, text: () => lines(v, 60).join("\n") };
  }

  it("跟随尾部；↑ / PgUp 暂停跟随、End 回到尾部；←/→ 切兄弟任务；输入非空时 ← 交给输入框", () => {
    const manager = transcript(8);
    const other = transcript(1);
    const registry = fakeRegistry(
      [
        info("t1", { status: "completed", endedAt: 1 }),
        info("t2", { status: "completed", endedAt: 1 }),
      ],
      {
        extra: (id) => ({
          entries: () => (id === "t1" ? manager : other).branch(),
          observe: () => () => undefined,
        }),
      },
    );
    const { v, text } = view(registry);
    expect(text()).toContain("回答 8");
    expect(text()).not.toContain("问题 1");
    v.handleInput("\x1b[5~"); // PgUp
    expect(text()).toContain("已暂停跟随");
    expect(text()).not.toContain("回答 8");
    v.handleInput("\x1b[F"); // End
    expect(text()).toContain("回答 8");
    expect(text()).not.toContain("已暂停跟随");
    v.handleInput("\x1b[C"); // →
    expect(v.task).toBe("t2");
    expect(text()).toContain("回答 1");
    v.handleInput("x");
    v.handleInput("\x1b[D"); // ← 在输入框里移光标
    expect(v.task).toBe("t2");
  });

  it("句柄被释放：只读加载子会话文件；运行中跟随事件（origin direct 按普通用户消息显示）", () => {
    home = createTmpHome("ama-w6a-view-");
    const manager = SessionManager.create(home.dataDir, "/w");
    manager.append({
      type: "message",
      message: { role: "user", content: "最初的任务", timestamp: 0 },
    });
    manager.append({ type: "message", message: assistant([{ type: "text", text: "做完了" }]) });
    const file = manager.flush()!;
    const released = fakeRegistry([
      info("t1", {
        status: "completed",
        endedAt: 1,
        sessionRef: { runner: "ama", sessionId: "x", sessionFile: file },
      }),
    ]);
    expect(view(released).text()).toContain("做完了");

    const listeners: ((e: SessionEvent) => void)[] = [];
    const live = fakeRegistry([info("t1")], {
      extra: () => ({
        entries: () => [],
        observe: (listener) => {
          listeners.push(listener);
          return () => undefined;
        },
      }),
    });
    const { text } = view(live);
    listeners[0]?.({
      type: "message_start",
      message: { role: "user", content: "人直接发的", origin: "direct", timestamp: 0 },
    });
    expect(text()).toContain("› 人直接发的");

    const missing = fakeRegistry([
      info("t1", {
        status: "completed",
        endedAt: 1,
        sessionRef: { runner: "ama", sessionId: "x", sessionFile: `${file}.gone` },
      }),
    ]);
    expect(view(missing).text()).toContain("读取对话记录失败");
  });

  it("Esc：输入非空先清空，空时返回；/tasks stop 停止，其它命令提示", async () => {
    const stopped: string[] = [];
    const registry = fakeRegistry([info("t1")]);
    const closed: string[] = [];
    const v = new AgentView("t1", {
      theme: plainTheme(),
      keys: new Keybindings(),
      registry: () => registry,
      tracker: new SubagentTracker(() => 0),
      approvals: () => new Set(["t1"]),
      now: () => 0,
      rows: () => 10,
      render: () => undefined,
      siblings: () => ["t1"],
      close: () => closed.push("x"),
      stop: async (id) => void stopped.push(id),
    });
    v.focused = true;
    expect(lines(v, 80)[0]).toContain("等待审批");
    for (const ch of "/model") v.handleInput(ch);
    v.handleInput("\r");
    await new Promise((r) => setTimeout(r, 0));
    expect(lines(v, 80).join("\n")).toContain("这里只能用 /tasks stop");
    for (const ch of "/tasks stop") v.handleInput(ch);
    v.handleInput("\r");
    await new Promise((r) => setTimeout(r, 0));
    expect(stopped).toEqual(["t1"]);
    expect(lines(v, 80).join("\n")).toContain("已停止 t1");
    v.handleInput("a");
    v.handleInput("\x1b");
    expect(closed).toEqual([]);
    v.handleInput("\x1b");
    expect(closed).toEqual(["x"]);
  });
});
