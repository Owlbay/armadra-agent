/**
 * 子 Agent 视图的「打断并发送」：Ctrl+X → `registry.message(id, text, true)`，Enter 仍是普通发送；
 * `ui.enterWhileRunning: "interrupt"` 时互换；外部 Agent 不支持打断时提示已排队。
 */

import { describe, expect, it } from "vitest";
import { info, fakeRegistry } from "../../agent/testing/agent-view-fixtures.js";
import type { DirectReply } from "../../agent/subagent-direct.js";
import { setLocale } from "../../i18n/index.js";
import { Keybindings, plainTheme } from "../../tui.js";
import { AgentView } from "./agent-view.js";
import { SubagentTracker } from "./subagent-view.js";
import { lines } from "./test-support.js";

const CTRL_X = "\x18";

function view(reply: DirectReply, mode: "queue" | "interrupt" = "queue") {
  const calls: { text: string; interrupt: boolean | undefined }[] = [];
  const registry = fakeRegistry([info("t1")], {
    message: async (_id, text, interrupt) => {
      calls.push({ text, interrupt });
      return reply;
    },
  });
  const v = new AgentView("t1", {
    theme: plainTheme(),
    keys: new Keybindings(),
    registry: () => registry,
    tracker: new SubagentTracker(() => 0),
    approvals: () => new Set(),
    now: () => 0,
    rows: () => 12,
    render: () => undefined,
    siblings: () => ["t1"],
    close: () => undefined,
    stop: async () => undefined,
    enterMode: () => mode,
  });
  v.focused = true;
  const type = (text: string): void => {
    for (const ch of text) v.handleInput(ch);
  };
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return { v, calls, type, settle, text: () => lines(v, 70).join("\n") };
}

describe("子 Agent 视图：打断并发送", () => {
  it("Ctrl+X 带 interrupt，Enter 不带；提示打断结果", async () => {
    setLocale("zh");
    const f = view("interrupted");
    f.type("改做 B");
    f.v.handleInput(CTRL_X);
    await f.settle();
    expect(f.calls).toEqual([{ text: "改做 B", interrupt: true }]);
    expect(f.text()).toContain("已打断 t1，这条消息立即开始新一轮");
    f.type("补充");
    f.v.handleInput("\r");
    await f.settle();
    expect(f.calls.at(-1)).toEqual({ text: "补充", interrupt: false });
  });

  it("外部 Agent 不支持打断：提示已排队（en）", async () => {
    setLocale("en");
    try {
      const f = view("queuedNoInterrupt");
      f.type("do X");
      f.v.handleInput(CTRL_X);
      await f.settle();
      expect(f.text()).toContain("t1 cannot be interrupted here; queued");
    } finally {
      setLocale("zh");
    }
  });

  it("空输入 Ctrl+X 不发送；interrupt 模式下 Enter 打断、Ctrl+X 排队", async () => {
    const f = view("interrupted", "interrupt");
    f.v.handleInput(CTRL_X);
    await f.settle();
    expect(f.calls).toEqual([]);
    f.type("now");
    f.v.handleInput("\r");
    f.type("later");
    f.v.handleInput(CTRL_X);
    await f.settle();
    expect(f.calls).toEqual([
      { text: "now", interrupt: true },
      { text: "later", interrupt: false },
    ]);
  });
});
