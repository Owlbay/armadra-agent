/**
 * 转后台的按键状态机（docs/history/agents-concurrency-plan.md §2.4、§4 C 项，W7-C）：`Ctrl+B` 有阻塞中的前台任务时
 * 转后台并提示（不看输入框）、没有时落回编辑器（有字 / 无字）；Esc 中断提示写明后台任务不受影响；栏内 `x`
 * 双击确认；按键标签。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../agent/types.js";
import { setLocale } from "../../i18n/index.js";
import { Editor, Keybindings, plainTheme } from "../../tui.js";
import { createKeyDispatch, FOCUS_HINT_MS } from "./key-dispatch.js";
import type { StatusBar } from "./status-bar.js";
import { backgroundedText, keyLabel, StopArm, STOP_CONFIRM_MS } from "./task-background.js";
import type { ToolTracker } from "./tool-view.js";

const CTRL_B = "\x02";
const ESC = "\x1b";

afterEach(() => setLocale("zh"));

function fixture(options: { blocking: string[]; busy?: boolean; background?: string[] }) {
  const editor = new Editor({ theme: plainTheme() });
  editor.render(80);
  const hints: { text: string; ms: number | undefined }[] = [];
  const calls: string[] = [];
  let aborted = 0;
  const session = {
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => void aborted++,
  } as unknown as AgentSession;
  const dispatch = createKeyDispatch({
    keys: new Keybindings(),
    editor,
    tools: {} as ToolTracker,
    status: {} as StatusBar,
    session: () => session,
    inactive: () => false,
    busy: () => options.busy ?? false,
    now: () => 0,
    showHint: (text, ms) => void hints.push({ text, ms }),
    submit: () => undefined,
    runCommand: () => undefined,
    exit: () => undefined,
    backgroundTasks: () => {
      calls.push("background");
      const moved = options.blocking;
      options.blocking = [];
      return moved;
    },
    runningBackground: () => options.background ?? [],
  });
  const press = (data: string): boolean => {
    const handled = dispatch(data);
    if (!handled) editor.handleInput(data);
    editor.render(80);
    return handled;
  };
  return { editor, hints, calls, press, aborted: () => aborted };
}

describe("Ctrl+B 转后台", () => {
  it("有前台任务：转后台、消费按键、提示「已转后台」；输入框有字也一样", () => {
    const f = fixture({ blocking: ["t2"] });
    f.editor.setText("ab");
    expect(f.press(CTRL_B)).toBe(true);
    expect(f.editor.getText()).toBe("ab");
    expect(f.calls).toEqual(["background"]);
    expect(f.hints).toEqual([{ text: "已转后台：t2，完成后会通知", ms: FOCUS_HINT_MS }]);
  });

  it("没有前台任务：落回编辑器（光标左移），不提示", () => {
    const f = fixture({ blocking: [] });
    f.editor.setText("ab");
    expect(f.press(CTRL_B)).toBe(false);
    f.press("X");
    expect(f.editor.getText()).toBe("aXb");
    expect(f.hints).toEqual([]);
  });

  it("没有前台任务、空输入：同样落回编辑器", () => {
    const f = fixture({ blocking: [] });
    expect(f.press(CTRL_B)).toBe(false);
    expect(f.editor.getText()).toBe("");
    expect(f.hints).toEqual([]);
  });

  it("转完再按：没有可转的，落回编辑器", () => {
    const f = fixture({ blocking: ["t1", "t3"] });
    expect(f.press(CTRL_B)).toBe(true);
    expect(f.hints[0]?.text).toBe("已转后台：t1, t3，完成后会通知");
    expect(f.press(CTRL_B)).toBe(false);
    expect(f.calls).toEqual(["background", "background"]);
  });

  it("en 文案", () => {
    setLocale("en");
    const f = fixture({ blocking: ["t2"] });
    f.press(CTRL_B);
    expect(f.hints[0]?.text).toBe(
      "Moved to the background: t2; you'll be notified when it finishes",
    );
  });
});

describe("Esc 只中断前台", () => {
  it("运行中 Esc：中断主回合，提示写明后台任务仍在运行", () => {
    const f = fixture({ blocking: [], busy: true, background: ["t2"] });
    expect(f.press(ESC)).toBe(true);
    expect(f.aborted()).toBe(1);
    expect(f.hints.at(-1)?.text).toBe("已中断（后台任务 t2 仍在运行，Esc 不影响）");
  });

  it("没有后台任务：原来的中断提示", () => {
    const f = fixture({ blocking: [], busy: true });
    f.press(ESC);
    expect(f.hints.at(-1)?.text).not.toContain("后台任务");
  });
});

describe("栏内 x 双击确认（StopArm）", () => {
  it("第一次 arm，间隔内对同一任务再按 stop；超时或换任务重新 arm", () => {
    const arm = new StopArm();
    expect(arm.press("t1", 0)).toBe("arm");
    expect(arm.press("t1", STOP_CONFIRM_MS - 1)).toBe("stop");
    expect(arm.press("t1", 5000)).toBe("arm");
    expect(arm.press("t1", 5000 + STOP_CONFIRM_MS)).toBe("arm");
    expect(arm.press("t2", 5000 + STOP_CONFIRM_MS + 1)).toBe("arm");
    arm.reset();
    expect(arm.press("t2", 5000 + STOP_CONFIRM_MS + 2)).toBe("arm");
  });
});

describe("文案与按键标签", () => {
  it("backgroundedText：有 / 没有", () => {
    expect(backgroundedText(["t2"])).toBe("已转后台：t2，完成后会通知");
    expect(backgroundedText([])).toBe("没有可转后台的前台任务");
  });

  it("keyLabel：缺省 Ctrl+B；覆盖为 alt+b；不绑定为 undefined", () => {
    expect(keyLabel(new Keybindings(), "app.tasks.background")).toBe("Ctrl+B");
    expect(
      keyLabel(new Keybindings({ "app.tasks.background": ["alt+b"] }), "app.tasks.background"),
    ).toBe("Alt+B");
    expect(
      keyLabel(new Keybindings({ "app.tasks.background": [] }), "app.tasks.background"),
    ).toBeUndefined();
  });
});
