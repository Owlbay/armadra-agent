/**
 * 双击 Esc 状态机与键位分派的优先级（RW-C）：空输入回滚、有字清空、超时、覆盖层优先、运行中中断即撤回。
 */

import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../agent/types.js";
import { Keybindings, type Editor } from "../../tui.js";
import { DOUBLE_ESC_HINT_MS, DOUBLE_ESC_MS, DoubleEscape } from "./double-esc.js";
import { createKeyDispatch } from "./key-dispatch.js";
import type { StatusBar } from "./status-bar.js";
import type { ToolTracker } from "./tool-view.js";

describe("DoubleEscape", () => {
  it("空输入：第一次预备、间隔内第二次回滚；超时重新预备", () => {
    const esc = new DoubleEscape();
    expect(esc.press(0, true)).toBe("arm-rewind");
    expect(esc.press(DOUBLE_ESC_MS, true)).toBe("rewind");
    expect(esc.isArmed).toBe(false);
    expect(esc.press(1000, true)).toBe("arm-rewind");
    expect(esc.press(1000 + DOUBLE_ESC_MS + 1, true)).toBe("arm-rewind");
  });

  it("有字：预备清空 → 清空；两次之间输入框状态变了或 reset 都重新计", () => {
    const esc = new DoubleEscape();
    expect(esc.press(0, false)).toBe("arm-clear");
    expect(esc.press(10, false)).toBe("clear");
    expect(esc.press(20, false)).toBe("arm-clear");
    expect(esc.press(30, true)).toBe("arm-rewind");
    esc.reset();
    expect(esc.press(40, true)).toBe("arm-rewind");
  });
});

interface Fixture {
  dispatch: (data: string) => boolean;
  text: { value: string };
  history: string[];
  hints: { text: string; ms: number | undefined }[];
  commands: string[];
  interrupted: boolean[];
  aborted: number;
  setNow(n: number): void;
  setBusy(b: boolean): void;
  setInactive(b: boolean): void;
  setCompletion(b: boolean): void;
}

function fixture(): Fixture {
  let now = 0;
  let busy = false;
  let inactive = false;
  let completion = false;
  const text = { value: "" };
  const history: string[] = [];
  const editor = {
    isEmpty: () => text.value === "",
    getText: () => text.value,
    getExpandedText: () => text.value,
    setText: (t: string) => void (text.value = t),
    clear: () => void (text.value = ""),
    addToHistory: (t: string) => void history.push(t),
    takeSubmission: () => null,
    get isCompletionOpen() {
      return completion;
    },
  } as unknown as Editor;
  const f: Fixture = {
    dispatch: () => false,
    text,
    history,
    hints: [],
    commands: [],
    interrupted: [],
    aborted: 0,
    setNow: (n) => (now = n),
    setBusy: (b) => (busy = b),
    setInactive: (b) => (inactive = b),
    setCompletion: (b) => (completion = b),
  };
  const session = {
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => {
      f.aborted++;
    },
  } as unknown as AgentSession;
  f.dispatch = createKeyDispatch({
    keys: new Keybindings(),
    editor,
    tools: {} as ToolTracker,
    status: {} as StatusBar,
    session: () => session,
    inactive: () => inactive,
    busy: () => busy,
    now: () => now,
    showHint: (t, ms) => void f.hints.push({ text: t, ms }),
    submit: () => undefined,
    runCommand: (line) => void f.commands.push(line),
    exit: () => undefined,
    onInterrupted: (empty) => void f.interrupted.push(empty),
  });
  return f;
}

describe("键位分派：Esc", () => {
  it("空闲且输入框为空：第一次提示 1 s，第二次打开 /rewind", () => {
    const f = fixture();
    expect(f.dispatch("\x1b")).toBe(true);
    expect(f.hints.at(-1)).toEqual({ text: "再按 Esc 回滚", ms: DOUBLE_ESC_HINT_MS });
    f.setNow(500);
    expect(f.dispatch("\x1b")).toBe(true);
    expect(f.commands).toEqual(["/rewind"]);
  });

  it("超过 800 ms：第二次只是重新提示", () => {
    const f = fixture();
    f.dispatch("\x1b");
    f.setNow(DOUBLE_ESC_MS + 1);
    f.dispatch("\x1b");
    expect(f.commands).toEqual([]);
    expect(f.hints.map((h) => h.text)).toEqual(["再按 Esc 回滚", "再按 Esc 回滚"]);
  });

  it("输入框有字：双击清空并记进输入历史", () => {
    const f = fixture();
    f.text.value = "草稿";
    f.dispatch("\x1b");
    expect(f.hints.at(-1)?.text).toBe("再按 Esc 清空");
    expect(f.text.value).toBe("草稿");
    f.dispatch("\x1b");
    expect(f.text.value).toBe("");
    expect(f.history).toEqual(["草稿"]);
    expect(f.commands).toEqual([]);
  });

  it("两次 Esc 之间按了别的键：重新计", () => {
    const f = fixture();
    f.dispatch("\x1b");
    expect(f.dispatch("a")).toBe(false);
    f.dispatch("\x1b");
    expect(f.commands).toEqual([]);
  });

  it("审批对话框 / 选择器打开（inactive）时 Esc 不归分派；补全打开时交给编辑器", () => {
    const f = fixture();
    f.setInactive(true);
    expect(f.dispatch("\x1b")).toBe(false);
    expect(f.dispatch("\x1b")).toBe(false);
    expect(f.hints).toEqual([]);
    f.setInactive(false);
    f.setCompletion(true);
    expect(f.dispatch("\x1b")).toBe(false);
    expect(f.dispatch("\x1b")).toBe(false);
    expect(f.commands).toEqual([]);
  });

  it("运行中：Esc 仍为中断，并把「输入框是否为空」交给中断即撤回", () => {
    const f = fixture();
    f.setBusy(true);
    expect(f.dispatch("\x1b")).toBe(true);
    expect(f.aborted).toBe(1);
    expect(f.interrupted).toEqual([true]);
    expect(f.hints.at(-1)?.text).toBe("已中断");
    f.text.value = "正在写";
    f.dispatch("\x1b");
    expect(f.interrupted).toEqual([true, false]);
    expect(f.commands).toEqual([]);
  });

  it("app.rewind 可在 keybindings.json 里换键", () => {
    const keys = new Keybindings({ "app.rewind": ["ctrl+g"] });
    expect(keys.matches("\x07", "app.rewind")).toBe(true);
    expect(keys.matches("\x1b", "app.rewind")).toBe(false);
  });
});
