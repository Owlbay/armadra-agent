/**
 * Agent 栏进栏键的分派（docs/agents-concurrency-plan.md §1.4，W7-A）：`↓` 是唯一缺省进栏键；落空给提示
 * （有字每段草稿一次、栏关闭、没有任务）；浏览历史时不抢 `↓`；`Ctrl+B` 不再进栏、落回编辑器。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../agent/types.js";
import { setLocale } from "../../i18n/index.js";
import { Editor, Keybindings, plainTheme } from "../../tui.js";
import { createKeyDispatch, FOCUS_HINT_MS, type AgentFocusResult } from "./key-dispatch.js";
import type { StatusBar } from "./status-bar.js";
import type { ToolTracker } from "./tool-view.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const CTRL_B = "\x02";

afterEach(() => setLocale("zh"));

function fixture(answer: (editorEmpty: boolean) => AgentFocusResult) {
  const editor = new Editor({ theme: plainTheme() });
  editor.render(80);
  const hints: { text: string; ms: number | undefined }[] = [];
  const focusCalls: string[] = [];
  const dispatch = createKeyDispatch({
    keys: new Keybindings(),
    editor,
    tools: {} as ToolTracker,
    status: {} as StatusBar,
    session: () => ({}) as AgentSession,
    inactive: () => false,
    busy: () => false,
    now: () => 0,
    showHint: (text, ms) => void hints.push({ text, ms }),
    submit: () => undefined,
    runCommand: () => undefined,
    exit: () => undefined,
    agents: () => ({
      handleKey: () => false,
      focus: (data) => {
        focusCalls.push(data);
        return answer(editor.isEmpty());
      },
    }),
  });
  /** 像 TUI 一样：监听器不处理就交给编辑器。 */
  const press = (data: string): boolean => {
    const handled = dispatch(data);
    if (!handled) editor.handleInput(data);
    editor.render(80);
    return handled;
  };
  return { editor, hints, focusCalls, press };
}

/** 有任务、栏开着时 agent-ui 的回答。 */
const withTasks = (empty: boolean): AgentFocusResult => (empty ? true : "busy-input");

describe("进栏键 ↓", () => {
  it("空输入：进栏并消费按键", () => {
    const f = fixture(withTasks);
    expect(f.press(DOWN)).toBe(true);
    expect(f.focusCalls).toEqual([DOWN]);
    expect(f.hints).toEqual([]);
  });

  it("有字：交给编辑器，每段草稿只提示一次；清空后的新草稿再提示", () => {
    const f = fixture(withTasks);
    f.editor.setText("ab");
    expect(f.press(DOWN)).toBe(false);
    expect(f.hints).toEqual([{ text: "输入框有字；清空后再按 ↓ 进 Agent 栏", ms: FOCUS_HINT_MS }]);
    f.press(DOWN);
    f.press("c");
    f.press(DOWN);
    expect(f.hints).toHaveLength(1);
    expect(f.editor.getText()).toBe("abc");
    f.editor.clear();
    f.press("x");
    f.press(DOWN);
    expect(f.hints).toHaveLength(2);
    // 清空后进栏：撤掉落空提示
    f.editor.clear();
    expect(f.press(DOWN)).toBe(true);
    expect(f.hints.at(-1)?.text).toBe("");
  });

  it("多行草稿光标不在末行：↓ 是下移，不提示", () => {
    const f = fixture(withTasks);
    f.editor.setText("one\ntwo");
    f.editor.handleInput(UP);
    expect(f.editor.cursor.line).toBe(0);
    f.press(DOWN);
    expect(f.hints).toEqual([]);
    expect(f.editor.cursor.line).toBe(1);
  });

  it("浏览输入历史时不抢 ↓（历史下一条）", () => {
    const f = fixture(withTasks);
    f.editor.addToHistory("first");
    f.editor.addToHistory("second");
    f.press(UP);
    f.press(UP);
    expect(f.editor.getText()).toBe("first");
    expect(f.press(DOWN)).toBe(false);
    expect(f.editor.getText()).toBe("second");
    expect(f.focusCalls).toEqual([]);
    expect(f.hints).toEqual([]);
  });

  it("栏关闭 / 没有任务：提示原因，按键仍交给编辑器；false 不提示", () => {
    const off = fixture(() => "disabled");
    expect(off.press(DOWN)).toBe(false);
    expect(off.hints.at(-1)?.text).toBe("Agent 栏已关闭（ui.agentBar），用 /tasks");
    const none = fixture(() => "empty");
    none.press(DOWN);
    expect(none.hints.at(-1)).toEqual({ text: "还没有子 Agent 任务", ms: FOCUS_HINT_MS });
    const quiet = fixture(() => false);
    quiet.press(DOWN);
    expect(quiet.hints).toEqual([]);
  });

  it("en 提示", () => {
    setLocale("en");
    const f = fixture(withTasks);
    f.editor.setText("ab");
    f.press(DOWN);
    expect(f.hints[0]?.text).toBe("Input is not empty; clear it and press ↓ for the Agent bar");
  });
});

describe("Ctrl+B 不再进栏", () => {
  it("空输入与有字都落回编辑器（光标左移），不问 Agent 栏", () => {
    const f = fixture(withTasks);
    expect(f.press(CTRL_B)).toBe(false);
    f.editor.setText("ab");
    f.press(CTRL_B);
    f.press("X");
    expect(f.editor.getText()).toBe("aXb");
    expect(f.focusCalls).toEqual([]);
  });

  it("缺省键位：app.agents.focus 只有 down，app.tasks.background 为 ctrl+b（与光标左移共用）", () => {
    const keys = new Keybindings();
    expect(keys.keys("app.agents.focus")).toEqual(["down"]);
    expect(keys.keys("app.tasks.background")).toEqual(["ctrl+b"]);
    expect(keys.actionsFor(CTRL_B)).toEqual(["tui.editor.cursorLeft", "app.tasks.background"]);
  });
});
