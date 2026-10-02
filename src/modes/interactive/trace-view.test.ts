/**
 * `/trace` 覆盖层（docs/wave6-plan.md §2.4、§2.7 T1）：帧黄金 120 / 60 / 40 列与 NO_COLOR、详情、子 Agent 钻入、
 * 任务视图、跟随与暂停、刷新、10k 节点只渲染可见行。
 * 更新黄金：`AMA_UPDATE_GOLDEN=1 pnpm vitest run src/modes/interactive/trace-view.test.ts`，逐个审阅 diff。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, SessionEvent } from "../../agent/types.js";
import { MemoryTerminal, TUI, Text, createTheme, plainTheme, type Theme } from "../../tui.js";
import type { SessionEntry } from "../../session/types.js";
import { buildTrace, type TraceInput } from "../../trace/build.js";
import { countNodes } from "../../trace/flatten.js";
import type { ChildLoader } from "../../trace/session.js";
import { fixtureChild, loadFixture } from "../../trace/test-support.js";
import { cleanupStarted, golden, start, type Started } from "./test-support.js";
import { TraceView, openTraceView, type TraceViewHost } from "./trace-view.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ESC = "\x1b";
const ENTER = "\r";

interface FakeSession {
  session: AgentSession;
  entries: SessionEntry[];
  emit(event: SessionEvent): void;
  streaming: boolean;
}

function fakeSession(input: TraceInput): FakeSession {
  const listeners = new Set<(event: SessionEvent) => void>();
  const fake: FakeSession = {
    entries: [...input.entries],
    streaming: false,
    emit: (event) => {
      for (const l of listeners) l(event);
    },
    session: undefined as unknown as AgentSession,
  };
  fake.session = {
    get entries() {
      return fake.entries;
    },
    get state() {
      return {
        sessionId: input.header.id,
        cwd: input.header.cwd,
        sessionFile: undefined,
        isStreaming: fake.streaming,
      };
    },
    subscribe(listener: (event: SessionEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as AgentSession;
  return fake;
}

function fixtureLoader(): ChildLoader {
  const seen = new Map<string, TraceInput | undefined>();
  const load = ((file: string) => {
    if (!seen.has(file)) seen.set(file, fixtureChild(file));
    return seen.get(file);
  }) as ChildLoader;
  load.inputs = () => [...seen.values()].flatMap((v) => (v === undefined ? [] : [v]));
  return load;
}

interface Screen {
  terminal: MemoryTerminal;
  host: TraceViewHost;
  fake: FakeSession;
  notices: string[];
  shot(label: string): string;
  key(...keys: string[]): void;
}

function screen(name: string, columns: number, rows: number, theme: Theme = plainTheme()): Screen {
  const terminal = new MemoryTerminal({ columns, rows });
  const tui = new TUI(terminal);
  tui.addChild(new Text("先前的对话"));
  tui.start();
  const fake = fakeSession(loadFixture(name));
  const notices: string[] = [];
  const host: TraceViewHost = {
    theme,
    showOverlay: (c, o) => tui.showOverlay(c, o),
    rows: () => rows,
    session: () => fake.session,
    now: () => 1_791_014_500_000,
    notice: (_level, text) => void notices.push(text),
    render: () => tui.requestRender(),
    loadChild: fixtureLoader(),
    refreshMs: 0,
  };
  return {
    terminal,
    host,
    fake,
    notices,
    shot(label) {
      tui.renderNow();
      const out = [`# ${label} · viewport ${columns}x${rows}`];
      out.push(...terminal.viewport().map((l) => `|${l.replace(/\s+$/, "")}`));
      return out.join("\n") + "\n";
    },
    key(...keys) {
      for (const k of keys) {
        terminal.sendInput(k);
        terminal.flushInput();
      }
    },
  };
}

const COLOR = (): Theme => createTheme("dark", { caps: { colors: 256 }, ascii: false });

describe("帧黄金", () => {
  for (const [columns, theme, label] of [
    [120, COLOR, "color"],
    [60, COLOR, "color"],
    [40, COLOR, "color"],
    [80, plainTheme, "nocolor"],
  ] as const) {
    it(`${columns} 列 ${label}：列表 → 上移 → 详情 → 返回 → 关闭`, async () => {
      const s = screen("parallel", columns, 14, theme());
      const closed = openTraceView(s.host);
      const frames = [s.shot("list · cursor at tail")];
      s.key(UP, UP, UP);
      frames.push(s.shot("after ↑↑↑ (bash)"));
      s.key(ENTER);
      frames.push(s.shot("detail"));
      s.key(ESC);
      frames.push(s.shot("detail closed"));
      s.key(ESC);
      await closed;
      frames.push(s.shot("view closed"));
      golden(`trace-parallel-${columns}x14-${label}`, frames.join("\n"));
    });
  }

  it("子 Agent 钻入：→ 展开工具 → → 展开子 Agent（懒加载子轨迹）→ ← 回父行；缺子会话的展开为空", async () => {
    const s = screen("subagent", 100, 20, COLOR());
    const closed = openTraceView(s.host);
    const frames = [s.shot("list")];
    s.key(UP, UP, RIGHT);
    frames.push(s.shot("task tool expanded"));
    s.key(DOWN, RIGHT);
    frames.push(s.shot("subagent expanded (child trace)"));
    s.key(DOWN, DOWN, DOWN, LEFT);
    frames.push(s.shot("← back to parent row"));
    s.key(DOWN, DOWN, DOWN, RIGHT, DOWN, RIGHT);
    frames.push(s.shot("background task: child missing"));
    s.key(ESC);
    await closed;
    golden("trace-subagent-100x20", frames.join("\n"));
  });

  it("/trace t1：外部 Agent 任务视图（骨架）；ASCII", async () => {
    const s = screen("external", 80, 10, plainTheme({ ascii: true }));
    const closed = openTraceView(s.host, "t1");
    const frames = [s.shot("task view")];
    s.key(ESC);
    await closed;
    golden("trace-task-external-80x10-ascii", frames.join("\n"));
  });

  it("/trace t9：没有这个任务时提示、不打开", async () => {
    const s = screen("external", 80, 10);
    await openTraceView(s.host, "t9");
    expect(s.notices).toEqual(["本会话没有任务 t9（见 /tasks）"]);
  });
});

describe("跟随与刷新", () => {
  it("运行中自动跟随；上移暂停；f 恢复；新条目到达时跟随贴底、暂停时光标不动", async () => {
    const s = screen("legacy-approx", 80, 12);
    s.fake.streaming = true;
    const view = new TraceView(s.host, undefined, () => undefined);
    // legacy 最后一个工具没有结果：运行中视为进行中 → partial
    expect(view.following).toBe(true);
    const tail = view.rowCount - 1;
    view.handleInput(UP);
    expect(view.following).toBe(false);
    const paused = view.selected?.key;
    view.refresh();
    expect(view.selected?.key).toBe(paused);
    view.handleInput("f");
    expect(view.following).toBe(true);
    expect(view.cursorIndex).toBe(view.rowCount - 1);
    expect(view.rowCount - 1).toBe(tail);
    // live：工具开始 → 刷新后仍贴底
    view.live.onEvent({
      type: "tool_execution_start",
      toolCallId: "l_edit",
      toolName: "edit",
      args: {},
    });
    view.refresh();
    expect(view.selected?.node.kind).toBe("tool");
    expect(view.render(80)).toHaveLength(11);
  });

  it("会话事件经 openTraceView 订阅刷新；关闭后退订", async () => {
    const s = screen("basic", 80, 12);
    const closed = openTraceView(s.host);
    const before = s.shot("before");
    const input = loadFixture("rewind-branch");
    // 追加另一个会话的一整回合（父指针接到最后一条），触发 entry_appended
    const last = s.fake.entries.at(-1)!;
    const turn = input.entries
      .slice(-3)
      .map((e, i) => ({ ...e, parentId: i === 0 ? last.id : e.parentId }));
    s.fake.entries.push(...turn);
    s.fake.emit({ type: "entry_appended", entry: turn.at(-1)! });
    const after = s.shot("after");
    expect(after).not.toBe(before);
    expect(after).toContain("#3 第二问（新分支）");
    s.key(ESC);
    await closed;
    s.fake.emit({ type: "entry_appended", entry: turn.at(-1)! });
  });
});

/** 合成 n 个回合、每回合 1 次请求 + 8 个工具。 */
function bigInput(turns: number): TraceInput {
  const base = loadFixture("basic");
  const entries: SessionEntry[] = [];
  let parent: string | null = null;
  let t = Date.parse(base.header.timestamp);
  const push = (e: object): string => {
    const id = `e${entries.length}`;
    entries.push({
      ...e,
      id,
      parentId: parent,
      timestamp: new Date(t).toISOString(),
    } as SessionEntry);
    parent = id;
    return id;
  };
  for (let i = 0; i < turns; i++) {
    t += 1000;
    push({ type: "message", message: { role: "user", content: `turn ${i}`, timestamp: t } });
    const calls = Array.from({ length: 8 }, (_, k) => ({
      type: "toolCall",
      id: `c${i}_${k}`,
      name: "read",
      arguments: { path: `src/f${k}.ts` },
    }));
    t += 500;
    const a = push({
      type: "message",
      message: {
        role: "assistant",
        content: calls,
        api: "x",
        provider: "p",
        model: "m",
        usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 0, totalTokens: 105 },
        stopReason: "toolUse",
        timestamp: t - 400,
      },
    });
    t += 300;
    for (const c of calls)
      push({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: c.id,
          toolName: "read",
          content: "x",
          isError: false,
          timestamp: t,
        },
      });
    push({
      type: "custom",
      customType: "ama.trace",
      data: {
        kind: "step",
        attempt: 1,
        assistantEntryId: a,
        requestAt: t - 1200,
        firstTokenAt: t - 900,
        doneAt: t - 300,
        tools: calls.map((c, k) => ({ id: c.id, startedAt: t - 290 + k, endedAt: t - 10 })),
      },
    });
  }
  return { header: base.header, entries, leaf: parent };
}

describe("性能", () => {
  it("10k 节点：构建 < 1 s；只格式化可见行；PgUp / Home / 加载更早回合", () => {
    const input = bigInput(1000);
    const started = performance.now();
    const trace = buildTrace(input);
    const buildMs = performance.now() - started;
    expect(countNodes(trace)).toBeGreaterThanOrEqual(10_000);
    expect(buildMs).toBeLessThan(1000);

    let formatted = 0;
    const base = plainTheme();
    const counting: Theme = {
      ...base,
      glyphs: base.glyphs,
      caps: base.caps,
      fg: (c, text) => base.fg(c, text),
      bg: (c, text) => base.bg(c, text),
      bold: (text) => base.bold(text),
      dim: (text) => {
        formatted++;
        return base.dim(text);
      },
      italic: (text) => base.italic(text),
      underline: (text) => base.underline(text),
    };
    const fake = fakeSession(input);
    const view = new TraceView(
      {
        theme: counting,
        showOverlay: () => ({ hide() {}, focus() {}, visible: true }),
        rows: () => 40,
        session: () => fake.session,
        now: () => 0,
        notice: () => undefined,
        loadChild: fixtureLoader(),
      },
      undefined,
      () => undefined,
    );
    // 尾部先加载 50 个回合（+ 一行「更早的回合」）
    expect(view.rowCount).toBe(1 + 50 * 10);
    const lines = view.render(120);
    expect(lines).toHaveLength(39);
    // 每个格式化的行调一次 dim（折叠符），加上提示行：与可见窗口同量级，而不是 10k
    expect(formatted).toBeLessThanOrEqual(40);
    view.handleInput("\x1b[H"); // Home
    expect(view.selected?.node.kind).toBe("more");
    view.handleInput(ENTER);
    expect(view.rowCount).toBe(1 + 100 * 10);
    // 光标停在新加载那页的最后一行（原先第一回合之前）
    expect(view.cursorIndex).toBe(1 + 50 * 10 - 1);
    view.handleInput("\x1b[5~"); // PgUp：一屏（rows − 3 行）
    expect(view.cursorIndex).toBe(1 + 50 * 10 - 1 - 37);
  });
});

describe("接线（交互）", () => {
  afterEach(cleanupStarted);

  it("/trace 打开覆盖层，Esc 关闭后消息区不变", async () => {
    const s = await start([{ text: "你好" }]);
    s.type("hi\r");
    await until(s, (x) => x.includes("你好"), "reply");
    const before = s.terminal.viewport().join("\n");
    s.type("/trace\r");
    await until(s, (x) => x.includes("轨迹 · 1 回合 · 1 请求"), "trace view");
    expect(s.terminal.viewport().join("\n")).toContain("#1 hi");
    s.type("\x1b");
    await until(s, (x) => !x.includes("轨迹 · 1 回合"), "closed");
    expect(s.terminal.viewport().join("\n")).toBe(before);
    s.handle.exit(0);
    await s.done;
  });
});

async function until(s: Started, check: (screen: string) => boolean, label: string): Promise<void> {
  const begun = Date.now();
  for (;;) {
    s.frame();
    const screen = s.terminal.viewport().join("\n");
    if (check(screen)) return;
    if (Date.now() - begun > 5000) throw new Error(`timeout: ${label}\n${screen}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
