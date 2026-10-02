import { describe, expect, it } from "vitest";
import type { AgentSession, SessionEvent, SessionStats } from "../../agent/types.js";
import { MemoryTerminal, TUI, plainTheme } from "../../tui.js";
import { backgroundJobText, limitReachedText, modelFallbackText } from "./event-notices.js";
import { EventPrinter } from "./line/line-render.js";
import { MessageView } from "./message-view.js";
import { StatusBar } from "./status-bar.js";
import { golden, lines } from "./test-support.js";

const FALLBACK: Extract<SessionEvent, { type: "model_fallback" }> = {
  type: "model_fallback",
  from: { provider: "anthropic", id: "claude-sonnet-4-5" },
  to: { provider: "openai", id: "gpt-5" },
  reason: "overloaded",
};
const LIMIT: Extract<SessionEvent, { type: "limit_reached" }> = {
  type: "limit_reached",
  kind: "cost",
  value: 1.234,
  limit: 1,
};
const JOB_START: Extract<SessionEvent, { type: "background_job" }> = {
  type: "background_job",
  jobId: "j1",
  phase: "started",
  command: "pnpm dev --port 5173",
  pid: 4242,
  outputPath: "/tmp/j1.log",
};

function session(model: { provider: string; id: string }): AgentSession {
  return {
    state: { model, thinkingLevel: "off", permissionMode: "default" },
    getStats: () =>
      ({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      }) as SessionStats,
  } as unknown as AgentSession;
}

describe("harness 提示（W5-H2 事件）", () => {
  it("文本", () => {
    expect(limitReachedText(LIMIT)).toBe(
      "已到费用上限 $1.00（本次运行已用 $1.23），本次运行停止；发新消息继续（--max-cost / limits.maxCostUsd）",
    );
    expect(limitReachedText({ ...LIMIT, kind: "turns", value: 20, limit: 20 })).toBe(
      "已到回合上限（20 回合），本次运行停止；发新消息继续（--max-turns / limits.maxTurns）",
    );
    expect(modelFallbackText(FALLBACK)).toBe(
      "anthropic/claude-sonnet-4-5 不可用（overloaded），本次请求改用 openai/gpt-5，回复后切回",
    );
    expect(backgroundJobText(JOB_START)).toBe("后台命令 j1 已启动：pnpm dev --port 5173");
    expect(backgroundJobText({ ...JOB_START, phase: "exited", exitCode: 1 })).toBe(
      "后台命令 j1 已退出（码 1）：pnpm dev --port 5173",
    );
    expect(backgroundJobText({ ...JOB_START, phase: "stopped" })).toBe(
      "后台命令 j1 已停止：pnpm dev --port 5173",
    );
  });

  it("消息区帧：回退、到限、后台命令", () => {
    const theme = plainTheme();
    const view = new MessageView({ theme });
    view.addNotice("warn", modelFallbackText(FALLBACK));
    view.addNotice("info", backgroundJobText(JOB_START));
    view.addNotice("info", backgroundJobText({ ...JOB_START, phase: "exited", exitCode: 0 }));
    view.addNotice("warn", limitReachedText(LIMIT));
    const terminal = new MemoryTerminal({ columns: 80, rows: 12 });
    const tui = new TUI(terminal);
    tui.addChild(view);
    tui.start();
    tui.renderNow();
    const shot = ["# harness notices · viewport 80x12", ...terminal.viewport().map((l) => `|${l}`)];
    tui.stop();
    golden("harness-notices-80x12", shot.join("\n") + "\n");
  });

  it("状态栏：回退中显示 主模型 → 回退模型，切回后消失", () => {
    let fallback: { from: string; to: string } | undefined = {
      from: "anthropic/claude-sonnet-4-5",
      to: "openai/gpt-5",
    };
    const bar = new StatusBar(
      {
        session: () => session({ provider: "openai", id: "gpt-5" }),
        preset: () => "default",
        fallback: () => fallback,
      },
      plainTheme(),
    );
    expect(lines(bar, 120)[0]).toMatch(/claude-sonnet-4-5 → openai\/gpt-5 · ctx \?$/);
    expect(lines(bar, 80)[0]).toMatch(/claude-sonnet-4-5 → gpt-5/);
    const ascii = new StatusBar(
      { session: () => session(FALLBACK.to), preset: () => "default", fallback: () => fallback },
      plainTheme({ ascii: true }),
    );
    expect(lines(ascii, 80)[0]).toContain("claude-sonnet-4-5 -> gpt-5");
    fallback = undefined;
    expect(lines(bar, 120)[0]).not.toContain("→");
  });

  it("line 模式：一行提示，agent_settled 的 limit_reached 不重复", () => {
    const out: string[] = [];
    const err: string[] = [];
    const printer = new EventPrinter(
      (t) => void out.push(t),
      (t) => void err.push(t),
    );
    printer.handle(LIMIT);
    printer.handle({ type: "agent_settled", warning: "limit_reached" } as SessionEvent);
    printer.handle(FALLBACK);
    printer.handle(JOB_START);
    expect(err).toEqual([
      `ama: ${limitReachedText(LIMIT)}\n`,
      `ama: ${modelFallbackText(FALLBACK)}\n`,
      `ama: ${backgroundJobText(JOB_START)}\n`,
    ]);
    printer.handle({
      type: "plan_proposed",
      planId: "p",
      version: 1,
      markdown: "",
      steps: [],
      filePath: "/d/p-v1.md",
    });
    expect(out.at(-1)).toBe(
      "◇ 计划 v1 待审批（/d/p-v1.md）：/plan approve [模式|fresh] 批准 · /plan reject 放弃 · 直接输入修改意见\n",
    );
  });
});
