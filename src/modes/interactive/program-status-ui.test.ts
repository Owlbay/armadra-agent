/**
 * 交互界面的 OSC 7501 程序状态：状态机单测（合成事件）+ 真实组装根 + fake 供应商 + MemoryTerminal 的整轮。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "../../agent/types.js";
import { msg } from "../../i18n/index.js";
import type { ProgramStatusReport } from "../../tui/program-status.js";
import { DA1_QUERY, PROGRAM_STATUS_QUERY } from "../../tui/program-status.js";
import type { MemoryTerminal } from "../../tui.js";
import { ProgramStatusTracker } from "./program-status-ui.js";
import { assistant, cleanupStarted, start, started } from "./test-support.js";

afterEach(cleanupStarted);

const OSC = /\x1b\]7501;([^\x1b\x07]*)(?:\x1b\\|\x07)/g;

interface Parsed {
  state: string;
  id?: string;
  kind?: string;
  msg?: string;
  title?: string;
  app?: string;
}

function parse(body: string): Parsed {
  const out: Record<string, string> = {};
  for (const pair of body.split(":")) {
    const [k, v] = pair.split("=") as [string, string];
    out[k] = k === "msg" || k === "title" ? Buffer.from(v, "base64").toString("utf8") : v;
  }
  return out as unknown as Parsed;
}

function reports(terminal: MemoryTerminal): Parsed[] {
  return [...terminal.output.matchAll(OSC)]
    .map((m) => m[1]!)
    .filter((b) => b !== "?")
    .map(parse);
}

const label = (r: { state: string; kind?: string }): string =>
  r.kind !== undefined ? `${r.state}:${r.kind}` : r.state;

/** 根记录的状态序列（相邻重复合并：working 下 msg 变化不算新状态）。 */
function rootStates(terminal: MemoryTerminal): string[] {
  const out: string[] = [];
  for (const r of reports(terminal)) {
    if (r.id !== undefined) continue;
    const l = label(r);
    if (out.at(-1) !== l) out.push(l);
  }
  return out;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("状态机（合成事件）", () => {
  function tracker() {
    const sent: ProgramStatusReport[] = [];
    const t = new ProgramStatusTracker({ report: (r) => void sent.push(r) }, () => "/w");
    return { t, sent, ev: (e: unknown) => t.onEvent(e as SessionEvent) };
  }

  it("审批 → blocked:permission（工具 · 目标），结束回 working", () => {
    const { t, ev } = tracker();
    ev({ type: "agent_start" });
    expect(t.root()).toMatchObject({ state: "working", msg: msg().interactive.view.run.thinking });
    ev({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: {} });
    expect(t.root().msg).toBe(msg().interactive.view.run.runningTool("bash"));
    ev({
      type: "permission_request",
      requestId: "r1",
      toolName: "bash",
      input: { command: "rm -rf build" },
    });
    expect(t.root()).toEqual({ state: "blocked", kind: "permission", msg: "bash · rm -rf build" });
    ev({ type: "permission_resolved", requestId: "r1", decision: "allow" });
    expect(t.root().state).toBe("working");
  });

  it("计划待审批 → blocked:question；登录失效 → blocked:auth，下一回合解除", () => {
    const { t, ev } = tracker();
    ev({ type: "plan_proposed", planId: "p", version: 1, markdown: "", steps: [] });
    expect(t.root()).toMatchObject({ state: "blocked", kind: "question" });
    ev({ type: "plan_resolved", planId: "p", decision: "approve" });
    expect(t.root().state).toBe("idle");
    ev({ type: "agent_start" });
    ev({
      type: "message_end",
      message: assistant([], { stopReason: "error", errorMessage: "auth_expired: relogin" }),
    });
    ev({ type: "agent_end", stopReason: "error", willRetry: false });
    ev({ type: "agent_settled" });
    expect(t.root()).toEqual({ state: "blocked", kind: "auth", msg: "auth_expired: relogin" });
    t.acknowledge();
    expect(t.root().kind).toBe("auth");
    ev({ type: "agent_start" });
    expect(t.root().state).toBe("working");
  });

  it("重试中的 agent_end 不结束回合；done 后用户按键回 idle", () => {
    const { t, ev } = tracker();
    ev({ type: "agent_start" });
    ev({ type: "agent_end", stopReason: "error", willRetry: true });
    expect(t.root().state).toBe("working");
    ev({ type: "agent_end", stopReason: "stop", willRetry: false });
    ev({ type: "agent_settled" });
    expect(t.root().state).toBe("done");
    t.acknowledge();
    expect(t.root().state).toBe("idle");
  });

  it("子 Agent 任务：task/<短 id> 子记录，审批 blocked，结束 done，下一回合清掉", () => {
    const { sent, ev } = tracker();
    ev({ type: "agent_start" });
    ev({
      type: "subagent_start",
      taskId: "t:1234567890abcdef",
      description: "扫描依赖",
      agent: "explore",
    });
    ev({
      type: "permission_request",
      requestId: "r",
      toolName: "read",
      input: { path: "/w/a.ts" },
      context: { depth: 1, taskId: "t:1234567890abcdef" },
    });
    const id = "task/t_1234567890";
    const task = (): ProgramStatusReport[] => sent.filter((r) => r.id === id);
    expect(task().at(-1)).toMatchObject({
      state: "blocked",
      kind: "permission",
      msg: "read · a.ts",
    });
    expect(task().at(-1)?.title).toBe("扫描依赖");
    ev({ type: "permission_resolved", requestId: "r", decision: "allow" });
    expect(task().at(-1)?.state).toBe("working");
    ev({ type: "subagent_update", taskId: "t:1234567890abcdef", kind: "tool", toolName: "grep" });
    expect(task().at(-1)?.msg).toBe(msg().interactive.view.run.runningTool("grep"));
    ev({ type: "subagent_end", taskId: "t:1234567890abcdef", status: "failed" });
    expect(task().at(-1)?.state).toBe("error");
    ev({ type: "agent_start" });
    expect(task().at(-1)).toEqual({ id, state: "clear" });
  });
});

describe("交互模式整轮（fake 供应商）", () => {
  it("auto 检测通过：idle → working → blocked → working → done；回复不进输入框；退出 clear", async () => {
    const s = await start(
      [
        { steps: [{ toolCall: { name: "bash", arguments: { command: "echo hi" }, id: "c1" } }] },
        { text: "好了。" },
      ],
      { programStatus: { timeoutMs: 5000, throttleMs: 0 } },
    );
    expect(s.terminal.output).toContain(PROGRAM_STATUS_QUERY + DA1_QUERY);
    expect(reports(s.terminal)).toEqual([]);
    s.type("\x1b]7501;?\x1b\\\x1b[?62;22c");
    expect(s.handle.editor.getText()).toBe("");
    expect(reports(s.terminal)).toEqual([{ state: "idle", app: "ama" }]);
    const asked = s.until((e) => e.type === "permission_request");
    s.type("跑一下");
    s.terminal.sendInput("\r");
    await asked;
    await tick();
    const settled = s.until((e) => e.type === "agent_settled");
    s.terminal.sendInput("y");
    await settled;
    await tick();
    expect(rootStates(s.terminal)).toEqual([
      "idle",
      "working",
      "blocked:permission",
      "working",
      "done",
    ]);
    const blocked = reports(s.terminal).find((r) => r.state === "blocked");
    expect(blocked?.msg).toBe("bash · echo hi");
    s.type("x");
    expect(rootStates(s.terminal).at(-1)).toBe("idle");
    s.handle.exit(0);
    await s.done;
    expect(reports(s.terminal).at(-1)).toEqual({ state: "clear", app: "ama" });
  });

  it("出错 → error（带 msg）；登录失效 → blocked:auth；中断 → idle", async () => {
    const s = await start(
      [
        { error: { kind: "custom", status: 400, message: "boom" } },
        { error: { kind: "custom", status: 401, message: "auth_expired: login expired" } },
        { delayMs: 10_000, text: "慢" },
      ],
      { programStatus: { timeoutMs: 5000, throttleMs: 0 } },
    );
    s.type("\x1b]7501;?\x07");
    const send = async (text: string) => {
      const settled = s.until((e) => e.type === "agent_settled");
      s.handle.editor.setText(text);
      s.terminal.sendInput("\r");
      return settled;
    };
    await send("一");
    expect(reports(s.terminal).at(-1)).toMatchObject({ state: "error" });
    expect(reports(s.terminal).at(-1)?.msg).toContain("boom");
    await send("二");
    expect(label(reports(s.terminal).at(-1)!)).toBe("blocked:auth");
    const running = s.until((e) => e.type === "agent_start");
    const settled = send("三");
    await running;
    s.terminal.sendInput("\x1b");
    s.terminal.flushInput();
    await settled;
    expect(rootStates(s.terminal).slice(-2)).toEqual(["working", "idle"]);
    s.handle.exit(0);
    await s.done;
  });

  it("DA1 先到：判不支持，不写任何报告；不给选项时不检测", async () => {
    const s = await start([{ text: "ok" }], { programStatus: { timeoutMs: 5000 } });
    s.type("\x1b[?1;2c");
    const settled = s.until((e) => e.type === "agent_settled");
    s.type("hi");
    s.terminal.sendInput("\r");
    await settled;
    expect(reports(s.terminal)).toEqual([]);
    s.handle.exit(0);
    await s.done;
    await cleanupStarted();
    const plain = await start([]);
    expect(plain.terminal.output).not.toContain("7501");
    plain.handle.exit(0);
    await plain.done;
    expect(started.h).toBeDefined();
  });
});
