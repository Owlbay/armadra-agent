import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../agent/types.js";
import { Container, Loader, plainTheme } from "../../tui.js";
import { QueueView, RunIndicator } from "./run-indicator.js";
import { assistant, lines } from "./test-support.js";
import { ToolTracker } from "./tool-view.js";

function setup(backgroundKey?: string) {
  const theme = plainTheme();
  const loader = new Loader(() => undefined, { theme, now: () => 0, intervalMs: 1e9 });
  const slot = new Container();
  const tools = new ToolTracker({ theme, now: () => 0 });
  const indicator = new RunIndicator({
    ...{ theme, loader, slot, tools, render: () => undefined },
    ...(backgroundKey !== undefined ? { backgroundKey } : {}),
  });
  const verb = (): string => (slot.children.length === 0 ? "" : lines(slot, 60)[0]!);
  const send = (event: unknown): void => indicator.onEvent(event as SessionEvent);
  return { indicator, tools, verb, send, loader, slot };
}

describe("运行指示", () => {
  it("动词按最深状态：工具 > 重试 > 压缩 > 流式 > 思考；审批时等待确认", () => {
    const { indicator, tools, verb, send, loader } = setup();
    send({ type: "agent_start" });
    expect(verb()).toBe("⠋ 思考中 · 0s · Esc 中断");
    send({
      type: "message_update",
      message: assistant([{ type: "text", text: "x".repeat(4000) }]),
    });
    expect(verb()).toBe("⠋ 回复中 · 0s · ↓≈1.0k · Esc 中断");
    tools.start({ toolCallId: "a", toolName: "bash", args: {} });
    send({ type: "tool_execution_start" });
    expect(verb()).toBe("⠋ 运行 bash · 0s · Esc 中断");
    tools.start({ toolCallId: "b", toolName: "read", args: {} });
    tools.start({ toolCallId: "c", toolName: "glob", args: {}, parentToolCallId: "b" });
    send({ type: "tool_execution_start" });
    expect(verb()).toBe("⠋ 运行 2 个工具 · 0s · Esc 中断");
    indicator.setApproval(true);
    expect(verb()).toBe("⠋ 等待确认 · 0s");
    indicator.setApproval(false);
    for (const id of ["a", "b", "c"]) tools.end(id, { content: "" }, false);
    send({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 2000, errorMessage: "" });
    expect(verb()).toBe("⠋ 重试 2/3 · 2s 后");
    send({ type: "auto_retry_end", success: true, attempt: 2 });
    send({ type: "message_end", message: assistant([]) });
    send({ type: "compaction_start", trigger: "threshold" });
    expect(verb()).toBe("⠋ 压缩上下文 · 0s · Esc 中断");
    send({ type: "compaction_end" });
    send({ type: "agent_settled" });
    expect(verb()).toBe("");
    expect(loader.running).toBe(false);
  });

  it("[W7-A] 有子 Agent 任务时带「↓ Agent 栏」，窄屏整项丢掉；任务出现 / 消失按帧刷新", () => {
    const { indicator, tools, verb, send, loader, slot } = setup();
    let agents = false;
    indicator.agents = () => agents;
    send({ type: "agent_start" });
    tools.start({ toolCallId: "a", toolName: "task", args: {} });
    send({ type: "tool_execution_start" });
    expect(verb()).toBe("⠋ 运行 task · 0s · Esc 中断");
    // 子任务在工具开始之后才登记：下一帧补上
    agents = true;
    loader.tick();
    expect(verb()).toBe("⠙ 运行 task · 0s · Esc 中断 · ↓ Agent 栏");
    expect(lines(slot, 28)[0]).toBe("⠙ 运行 task · 0s · Esc 中断");
    indicator.setApproval(true);
    expect(verb()).toBe("⠙ 等待确认 · 0s");
    indicator.setApproval(false);
    agents = false;
    loader.tick();
    expect(verb()).toBe("⠹ 运行 task · 0s · Esc 中断");
  });

  it("[W7-C] 前台任务时带「Ctrl+B 转后台」、停靠审批时「↓ 处理审批」替换「↓ Agent 栏」；窄屏从后往前丢", () => {
    const { indicator, tools, verb, send, loader, slot } = setup("Ctrl+B");
    let blocking = true;
    let docked = false;
    indicator.agents = () => true;
    indicator.background = () => blocking;
    indicator.docked = () => docked;
    send({ type: "agent_start" });
    tools.start({ toolCallId: "a", toolName: "task", args: {} });
    send({ type: "tool_execution_start" });
    expect(verb()).toBe("⠋ 运行 task · 0s · Esc 中断 · Ctrl+B 转后台 · ↓ Agent 栏");
    expect(lines(slot, 44)[0]).toBe("⠋ 运行 task · 0s · Esc 中断 · Ctrl+B 转后台");
    expect(lines(slot, 30)[0]).toBe("⠋ 运行 task · 0s · Esc 中断");
    // 转后台之后、子任务的审批停靠
    blocking = false;
    docked = true;
    loader.tick();
    expect(verb()).toBe("⠙ 运行 task · 0s · Esc 中断 · ↓ 处理审批");
    docked = false;
    loader.tick();
    expect(verb()).toBe("⠹ 运行 task · 0s · Esc 中断 · ↓ Agent 栏");
  });

  it("[W7-C] 没有按键绑定时不带转后台提示", () => {
    const { indicator, verb, send } = setup();
    indicator.background = () => true;
    send({ type: "agent_start" });
    expect(verb()).toBe("⠋ 思考中 · 0s · Esc 中断");
  });

  it("排队消息：缩进 2 列、中文标签、超过 3 条折叠、末行按键提示", () => {
    const queue = new QueueView(plainTheme());
    queue.setQueue(["一", "二"], ["三", "四"]);
    expect(lines(queue, 60)).toEqual([
      "  … 另 1 条",
      "  ↳ 插话  二",
      "  ↳ 之后  三",
      "  ↳ 之后  四",
      "    Alt+↑ 取回 · Esc 回填并中断",
    ]);
    queue.setQueue([], []);
    expect(lines(queue, 60)).toEqual([]);
  });
});
