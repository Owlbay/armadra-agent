/**
 * 打断并立即发送的按键状态机（key-dispatch.ts `sendKeys`）：运行中 Enter 缺省排队、`Ctrl+X` 打断并发送；
 * `ui.enterWhileRunning: "interrupt"` 时互换；补全打开、审批（覆盖层）打开时不触发；空闲时 `Ctrl+X` 等同 Enter；
 * 斜杠命令照常执行；Esc 语义不变（中断 + 回填，不发送）。
 */

import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../agent/types.js";
import { Editor, Keybindings, plainTheme } from "../../tui.js";
import { createKeyDispatch } from "./key-dispatch.js";
import type { EnterMode } from "./run-indicator.js";
import type { StatusBar } from "./status-bar.js";
import type { ToolTracker } from "./tool-view.js";

const ENTER = "\r";
const CTRL_X = "\x18";
const ESC = "\x1b";

function fixture(options: { busy?: boolean; mode?: EnterMode } = {}) {
  const state = {
    busy: options.busy ?? true,
    mode: options.mode ?? ("queue" as EnterMode),
    overlay: false,
    completion: false,
  };
  const submitted: { text: string; via: string }[] = [];
  const interrupts: string[] = [];
  const aborted: string[] = [];
  const editor = new Editor({
    theme: plainTheme(),
    onSubmit: (text) => submitted.push({ text, via: "enter" }),
  });
  Object.defineProperty(editor, "isCompletionOpen", { get: () => state.completion });
  editor.render(80);
  const session = {
    clearQueue: () => ({ steering: ["queued steer"], followUp: [] }),
    abort: async () => void aborted.push("abort"),
  } as unknown as AgentSession;
  const dispatch = createKeyDispatch({
    keys: new Keybindings(),
    editor,
    tools: {} as ToolTracker,
    status: {} as StatusBar,
    session: () => session,
    inactive: () => state.overlay,
    busy: () => state.busy,
    now: () => 0,
    showHint: () => undefined,
    submit: (text, via) => void submitted.push({ text, via }),
    runCommand: () => undefined,
    exit: () => undefined,
    enterWhileRunning: () => state.mode,
    interruptSend: (text) => void interrupts.push(text),
  });
  const press = (data: string): boolean => {
    const handled = dispatch(data);
    if (!handled && !state.overlay) editor.handleInput(data);
    return handled;
  };
  const type = (text: string): void => editor.setText(text);
  return { state, editor, submitted, interrupts, aborted, press, type };
}

describe("运行中：缺省排队，Ctrl+X 打断并发送", () => {
  it("有字 Enter：照常提交（steer 排队），不打断", () => {
    const f = fixture();
    f.type("use pnpm");
    expect(f.press(ENTER)).toBe(false);
    expect(f.submitted).toEqual([{ text: "use pnpm", via: "enter" }]);
    expect(f.interrupts).toEqual([]);
  });

  it("有字 Ctrl+X：打断并发送输入框的文字，输入框清空并记进历史", () => {
    const f = fixture();
    f.type("stop, do X");
    expect(f.press(CTRL_X)).toBe(true);
    expect(f.interrupts).toEqual(["stop, do X"]);
    expect(f.submitted).toEqual([]);
    expect(f.editor.isEmpty()).toBe(true);
    expect(f.editor.getHistory()).toContain("stop, do X");
  });

  it("空输入 Ctrl+X：只把排队的插话立即送出（文字为空）", () => {
    const f = fixture();
    expect(f.press(CTRL_X)).toBe(true);
    expect(f.interrupts).toEqual([""]);
  });

  it("斜杠命令 + Ctrl+X：当命令执行，不打断", () => {
    const f = fixture();
    f.type("/tasks bg");
    expect(f.press(CTRL_X)).toBe(true);
    expect(f.submitted).toEqual([{ text: "/tasks bg", via: "enter" }]);
    expect(f.interrupts).toEqual([]);
  });

  it("补全打开：Ctrl+X 与 Enter 都交给编辑器", () => {
    const f = fixture();
    f.type("@sr");
    f.state.completion = true;
    expect(f.press(CTRL_X)).toBe(false);
    expect(f.interrupts).toEqual([]);
  });

  it("审批 / 选择器打开（覆盖层）：不触发", () => {
    const f = fixture();
    f.type("answer");
    f.state.overlay = true;
    expect(f.press(CTRL_X)).toBe(false);
    expect(f.interrupts).toEqual([]);
    expect(f.editor.getText()).toBe("answer");
  });

  it("Esc 语义不变：中断并回填排队消息，不发送", () => {
    const f = fixture();
    f.type("draft");
    expect(f.press(ESC)).toBe(true);
    expect(f.interrupts).toEqual([]);
    expect(f.aborted).toEqual(["abort"]);
    expect(f.editor.getText()).toBe("queued steer\ndraft");
  });
});

describe("空闲", () => {
  it("有字 Ctrl+X 等同 Enter；空输入落回编辑器", () => {
    const f = fixture({ busy: false });
    f.type("hello");
    expect(f.press(CTRL_X)).toBe(true);
    expect(f.submitted).toEqual([{ text: "hello", via: "enter" }]);
    expect(f.interrupts).toEqual([]);
    expect(f.press(CTRL_X)).toBe(false);
  });

  it("interrupt 模式下的 Enter 照常提交", () => {
    const f = fixture({ busy: false, mode: "interrupt" });
    f.type("hello");
    expect(f.press(ENTER)).toBe(false);
    expect(f.submitted).toEqual([{ text: "hello", via: "enter" }]);
  });
});

describe("ui.enterWhileRunning: interrupt（互换）", () => {
  it("运行中 Enter = 打断并发送，Ctrl+X = 排队", () => {
    const f = fixture({ mode: "interrupt" });
    f.type("now");
    expect(f.press(ENTER)).toBe(true);
    expect(f.interrupts).toEqual(["now"]);
    f.type("later");
    expect(f.press(CTRL_X)).toBe(true);
    expect(f.submitted).toEqual([{ text: "later", via: "enter" }]);
  });

  it("斜杠命令的 Enter 照常交给编辑器", () => {
    const f = fixture({ mode: "interrupt" });
    f.type("/tasks");
    expect(f.press(ENTER)).toBe(false);
    expect(f.submitted).toEqual([{ text: "/tasks", via: "enter" }]);
    expect(f.interrupts).toEqual([]);
  });

  it("配置在按键时读取：中途改模式立即生效", () => {
    const f = fixture();
    f.type("a");
    f.press(ENTER);
    f.state.mode = "interrupt";
    f.type("b");
    f.press(ENTER);
    expect(f.submitted.map((s) => s.text)).toEqual(["a"]);
    expect(f.interrupts).toEqual(["b"]);
  });
});
