/**
 * W5-EG 端到端（零费用）：ama 经 `task(agent="acp:ama")` 驱动另一个 ama（`--mode acp` + fake 供应商），
 * 两边都是真实组装的运行时，中间只有内存管道（docs/wave5-plan.md §5.6–§5.7、§7.6）。
 * 覆盖前台、后台 + 通知、续聊（同一外部会话）、stop 后续聊（resume 重开）、审批交人（带来源标注）
 * 与无人值守拒绝。
 */

import { afterEach, describe, expect, it } from "vitest";
import { amaAcpChild, type AmaAcpChild } from "../../test/helpers/ama-acp-child.js";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import type { SessionEvent } from "../agent/types.js";
import type { FakeResponse } from "../ai/fake/fake-script.js";
import type { Runtime } from "../cli/runtime.js";
import { AGENT_SESSION_CUSTOM } from "../drivers/store.js";
import type { MemoryTransport } from "../drivers/test-support.js";
import type { ApprovalRequest } from "../permissions/types.js";
import { externalTesting } from "./external.js";

const harnesses: ComposeHarness[] = [];
const runtimes: Runtime[] = [];
const children: AmaAcpChild[] = [];
afterEach(async () => {
  delete externalTesting.driverDeps;
  for (const c of children.splice(0)) await c.cleanup();
  for (const r of runtimes.splice(0)) await r.dispose().catch(() => undefined);
  for (const h of harnesses.splice(0)) h.cleanup();
});

interface Parent {
  h: ComposeHarness;
  runtime: Runtime;
  child: Runtime;
  asked: ApprovalRequest[];
  events: SessionEvent[];
  spawns: MemoryTransport[];
  wire(): string;
}

/** 父 ama（fake 脚本 `parent`）+ 子 ama（`--mode acp`，fake 脚本 `child`，cwd 与父相同）。 */
async function setup(
  parent: FakeResponse[],
  child: FakeResponse[],
  options: { argv?: string[]; config?: object } = {},
): Promise<Parent> {
  const h = composeHarness(parent);
  harnesses.push(h);
  if (options.config !== undefined) h.home.write("home/.config/ama/config.json", options.config);
  const c = await amaAcpChild(h.home.cwd, child);
  children.push(c);
  expect(c.runtime.mode).toBe("rpc");
  const runtime = await h.boot([
    "--model",
    "fake/echo",
    "--tools",
    "read,task",
    "--trust",
    ...(options.argv ?? []),
  ]);
  runtimes.push(runtime);
  const asked: ApprovalRequest[] = [];
  runtime.approvals.setUiBroker({
    ask: async (request) => {
      asked.push(request);
      return "allow";
    },
  });
  const events: SessionEvent[] = [];
  runtime.session.subscribe((e) => void events.push(e));
  return { h, runtime, child: c.runtime, asked, events, spawns: c.spawns, wire: c.wire };
}

const taskCall = (args: Record<string, unknown>): FakeResponse => ({
  steps: [{ toolCall: { name: "task", arguments: args } }],
});

const ctl = (args: Record<string, unknown>): FakeResponse => ({
  steps: [{ toolCall: { name: "task_ctl", arguments: args } }],
});

function toolResults(runtime: Runtime): string[] {
  return runtime.session.messages
    .filter((m) => "role" in m && m.role === "toolResult")
    .map((m) => JSON.stringify((m as { content: unknown }).content));
}

async function until(check: () => boolean, label: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("task(agent=acp:ama)：ama 驱动 ama", () => {
  it("前台：首次运行确认 → 子 ama 的 bash 审批交给人（带来源）→ 结果回到父", async () => {
    const p = await setup(
      [
        taskCall({ prompt: "run it", agent: "acp:ama", description: "child", background: false }),
        { text: "parent done" },
      ],
      [
        { steps: [{ toolCall: { name: "bash", arguments: { command: "echo from-child" } } }] },
        { text: "child ran it", usage: { input: 20, output: 4 } },
      ],
    );
    await p.runtime.session.prompt("delegate");
    // ① task 工具本身（default 模式 execute）② 首次以 acp:ama 运行 ③ 子 ama 的 bash
    expect(p.asked.map((r) => r.toolName)).toEqual(["task", "task", "agent:acp:ama"]);
    expect(p.asked[1]).toMatchObject({ input: { agent: "acp:ama", mode: "default" } });
    const childSession = p.child.session.state.sessionId;
    expect(p.asked[2]!.context).toMatchObject({
      depth: 1,
      taskId: "t1",
      origin: { agent: "acp:ama", sessionId: childSession, toolCall: { kind: "execute" } },
    });
    const requests = p.events.filter((e) => e.type === "permission_request");
    // [W6-C0] 本会话工具调用的审批带 toolCallId（轨迹算审批等待）；外部 Agent 的请求不带
    expect(requests.map((e) => (e.type === "permission_request" ? e.context : null))).toEqual([
      { toolCallId: "fake_call_0" },
      { taskId: "t1" },
      {
        depth: 1,
        taskId: "t1",
        origin: expect.objectContaining({ agent: "acp:ama", sessionId: childSession }),
      },
    ]);
    const result = toolResults(p.runtime)[0]!;
    expect(result).toContain("[task t1]");
    expect(result).toContain("child ran it");
    expect(result).toContain("bash: echo from-child");
    expect(toolResults(p.child).join("\n")).toContain("from-child");
    // 外部会话引用（续聊用）带 taskId；原始事件不落盘
    const branch = p.events.filter(
      (e) =>
        e.type === "entry_appended" &&
        e.entry.type === "custom" &&
        e.entry.customType === AGENT_SESSION_CUSTOM,
    );
    expect(branch.map((e) => (e.type === "entry_appended" ? e.entry : null))).toMatchObject([
      { data: { agent: "acp:ama", runner: "acp", sessionId: childSession, taskId: "t1" } },
    ]);
    expect(p.events.some((e) => e.type === "subagent_start" && e.runner === "acp:ama")).toBe(true);
    expect(p.events.find((e) => e.type === "subagent_end")).toMatchObject({ status: "completed" });
  });

  it("续聊：task{taskId} 在同一外部会话里追加一轮（不重开进程）", async () => {
    const p = await setup(
      [
        taskCall({ prompt: "first", agent: "acp:ama", background: false }),
        taskCall({ prompt: "second", taskId: "t1", background: false }),
        { text: "parent done" },
      ],
      [{ text: "child one" }, { text: "child two" }],
      { argv: ["--permission-mode", "full-auto"] },
    );
    await p.runtime.session.prompt("go");
    const results = toolResults(p.runtime);
    expect(results[0]).toContain("child one");
    expect(results[1]).toContain("child two");
    expect(p.spawns).toHaveLength(1);
    const userTurns = p.child.session.messages.filter((m) => "role" in m && m.role === "user");
    expect(userTurns).toHaveLength(2);
  });

  it("后台 + 通知：立即返回 taskId，完成后父会话收到 <task-notification>", async () => {
    const p = await setup(
      [
        taskCall({ prompt: "bg work", agent: "acp:ama", background: true }),
        { text: "waiting" },
        { text: "got the report" },
      ],
      [{ delayMs: 100, text: "background report" }],
      { argv: ["--permission-mode", "full-auto"] },
    );
    await p.runtime.session.prompt("start it");
    expect(toolResults(p.runtime)[0]).toContain("Started background task t1");
    await until(() => p.h.fake.calls.length >= 3, "notification turn");
    await p.runtime.session.waitForIdle?.();
    const last = JSON.stringify(p.h.fake.calls[2]!.context.messages);
    expect(last).toContain(
      '<task-notification taskId=\\"t1\\" agent=\\"acp:ama\\" status=\\"completed\\"',
    );
    expect(last).toContain("background report");
  });

  it("stop 与 stop 后续聊：task_ctl stop 中断子回合；再续聊以外部会话 id resume 重开", async () => {
    const p = await setup(
      [
        taskCall({ prompt: "slow", agent: "acp:ama", background: true }),
        // 先等子 ama 的模型调用真正开始（之后再 stop，续聊才拿到脚本的下一条）
        ctl({ action: "wait", taskId: "t1", timeoutMs: 200 }),
        ctl({ action: "stop", taskId: "t1" }),
        taskCall({ prompt: "resume please", taskId: "t1", background: false }),
        { text: "parent done" },
      ],
      [{ delayMs: 10_000, text: "late" }, { text: "resumed" }],
      { argv: ["--permission-mode", "full-auto"] },
    );
    await p.runtime.session.prompt("go");
    const results = toolResults(p.runtime);
    expect(results[1]).toContain("Task t1 is still running");
    expect(results[2]).toContain("Task t1 aborted");
    expect(results[3]).toContain("resumed");
    expect(p.spawns).toHaveLength(2);
    expect(p.wire()).toContain('"method":"session/cancel"');
    expect(p.wire()).toContain('"method":"session/resume"');
    expect(p.wire()).toContain(`"sessionId":"${p.child.session.state.sessionId}"`);
  });

  it("无人值守（-p）：首次运行由 allow 规则放行，子 ama 的审批一律拒绝、不问人", async () => {
    const p = await setup(
      [taskCall({ prompt: "try", agent: "acp:ama" }), { text: "parent done" }],
      [
        { steps: [{ toolCall: { name: "bash", arguments: { command: "echo nope" } } }] },
        { text: "denied, stopping" },
      ],
      { argv: ["-p"], config: { version: 1, permission: { allow: ["task"] } } },
    );
    expect(p.runtime.mode).toBe("print");
    await p.runtime.session.prompt("delegate");
    expect(p.asked).toEqual([]);
    expect(toolResults(p.runtime)[0]).toContain("denied, stopping");
    const child = toolResults(p.child).join("\n");
    expect(child).toContain("denied");
    expect(child).not.toContain('"nope\\n"');
  });

  it("无人值守且没有 allow 规则：task 本身被拒，不起外部进程", async () => {
    const p = await setup(
      [taskCall({ prompt: "try", agent: "acp:ama" }), { text: "parent done" }],
      [{ text: "never" }],
      { argv: ["-p"] },
    );
    await p.runtime.session.prompt("delegate");
    expect(p.spawns).toHaveLength(0);
    expect(toolResults(p.runtime)[0]).toMatch(/approval|unattended/i);
  });

  it("未信任的项目：外部 Agent 不启动并提示 ama trust", async () => {
    const h = composeHarness([
      taskCall({ prompt: "x", agent: "acp:ama", background: false }),
      { text: "ok" },
    ]);
    harnesses.push(h);
    externalTesting.driverDeps = {
      spawn: () => {
        throw new Error("must not spawn");
      },
    };
    const runtime = await h.boot([
      "--model",
      "fake/echo",
      "--tools",
      "read,task",
      "--permission-mode",
      "full-auto",
    ]);
    runtimes.push(runtime);
    await runtime.session.prompt("go");
    expect(toolResults(runtime)[0]).toContain("ama trust");
  });
});

describe("permission_request.context：ama 子会话", () => {
  it("task(general) 的子会话审批带 depth 1 与 taskId；主会话自己的审批只带 toolCallId（W6-C0）", async () => {
    const h = composeHarness([
      { steps: [{ toolCall: { name: "bash", arguments: { command: "echo main" } } }] },
      { steps: [{ toolCall: { name: "task", arguments: { prompt: "run", agent: "general" } } }] },
      { steps: [{ toolCall: { name: "bash", arguments: { command: "echo sub" } } }] },
      { text: "sub done" },
      { text: "all done" },
    ]);
    harnesses.push(h);
    const runtime = await h.boot(["--model", "fake/echo", "--tools", "read,bash,task", "--trust"]);
    runtimes.push(runtime);
    runtime.approvals.setUiBroker({ ask: async () => "allow" });
    const events: SessionEvent[] = [];
    runtime.session.subscribe((e) => void events.push(e));
    await runtime.session.prompt("go");
    const requests = events.flatMap((e) =>
      e.type === "permission_request" ? [{ tool: e.toolName, context: e.context }] : [],
    );
    expect(requests).toEqual([
      { tool: "bash", context: { toolCallId: "fake_call_0" } },
      { tool: "task", context: { toolCallId: "fake_call_0" } },
      { tool: "bash", context: { depth: 1, taskId: "t1", toolCallId: "fake_call_0" } },
    ]);
  });
});
