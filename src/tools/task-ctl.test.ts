import { describe, expect, it } from "vitest";
import { makeToolContext } from "../../test/helpers/tool-context.js";
import type { ToolResultMessage } from "../ai/types.js";
import type { ScriptCall, ScriptStep } from "../agent/testing/scripted-api.js";
import {
  firstUser,
  isChild,
  lastIsToolResult,
  sleepTool,
  subagentHarness,
  userTexts,
  waitUntil,
} from "../agent/testing/subagent-harness.js";
import { createTaskCtlTool } from "./task-ctl.js";

const results = (h: ReturnType<typeof subagentHarness>) =>
  h.session.messages.flatMap((m) => (m.role === "toolResult" ? [m as ToolResultMessage] : []));
const lastUser = (call: ScriptCall) => userTexts(call.context).at(-1) ?? "";
/** 后台通知会在父空闲时开新回合：等空闲再说话，忙时排进 followUp。 */
async function say(h: ReturnType<typeof subagentHarness>, text: string): Promise<void> {
  await h.session.waitForIdle();
  await h.session.prompt(text, { streamingBehavior: "followUp" });
  await h.session.waitForIdle();
}
const ctl = (args: Record<string, unknown>): ScriptStep => ({
  toolCalls: [{ name: "task_ctl", args }],
});

describe("task_ctl", () => {
  it("list / output / wait 超时 / stop：运行中的后台任务", async () => {
    const parent: Record<string, ScriptStep> = {
      start: {
        toolCalls: [
          { name: "task", args: { prompt: "long", background: true, description: "dig" } },
        ],
      },
      list: ctl({ action: "list" }),
      output: ctl({ action: "output", taskId: "t1" }),
      wait: ctl({ action: "wait", taskId: "t1", timeoutMs: 10 }),
      stop: ctl({ action: "stop", taskId: "t1" }),
      unknown: ctl({ action: "wait", taskId: "t7" }),
    };
    const h = subagentHarness({
      script: (call) => {
        if (isChild(call)) return { kind: "hang", text: "half done" };
        if (lastIsToolResult(call)) return { text: "ok" };
        return parent[lastUser(call)] ?? { text: "?" };
      },
    });
    await h.session.prompt("start");
    await waitUntil(() => h.events.some((e) => e.type === "subagent_update" && e.kind === "text"));
    for (const step of ["list", "output", "wait", "stop", "list", "unknown"]) await say(h, step);
    const contents = results(h).map((r) => String(r.content));
    expect(contents[1]).toMatch(/^t1 · general · running · \d+s · background — dig$/);
    expect(contents[2]).toBe("Task t1 is running; output so far:\nhalf done");
    expect(contents[3]).toMatch(/^Task t1 is still running \(0 turns so far\)/);
    expect(contents[4]).toBe("Task t1 aborted.");
    expect(contents[5]).toMatch(/^t1 · general · aborted/);
    expect(contents[6]).toBe("Unknown task t7.");
    expect(results(h)[6]?.isError).toBe(true);
    await h.session.dispose();
  });

  it("wait 拿到最终报告；send 向已完成任务追加消息（后台）", async () => {
    const counter = { running: 0, peak: 0 };
    const parent: Record<string, ScriptStep> = {
      start: { toolCalls: [{ name: "task", args: { prompt: "job", background: true } }] },
      wait: ctl({ action: "wait", taskId: "t1", timeoutMs: 5000 }),
      send: ctl({ action: "send", taskId: "t1", prompt: "and more" }),
    };
    const h = subagentHarness({
      extraTools: [sleepTool(counter, 20)],
      script: (call) => {
        if (isChild(call)) {
          if (!lastIsToolResult(call) && userTexts(call.context).length === 1)
            return { toolCalls: [{ name: "sleep", args: {} }] };
          return {
            text: `report for ${userTexts(call.context).length} messages (${firstUser(call)})`,
          };
        }
        if (lastIsToolResult(call)) return { text: "ok" };
        return parent[lastUser(call)] ?? { text: "noted" };
      },
    });
    await h.session.prompt("start");
    await say(h, "wait");
    const waited = results(h)[1];
    expect(String(waited?.content)).toBe("[task t1 completed]\nreport for 1 messages (job)");
    await say(h, "send");
    expect(String(results(h)[2]?.content)).toMatch(/^Started background task t1/);
    await waitUntil(() =>
      h.session.messages.some(
        (m) => m.role === "user" && String(m.content).includes("report for 2 messages"),
      ),
    );
    await h.session.dispose();
  });

  it("子会话里不可用；参数校验", async () => {
    const tool = createTaskCtlTool();
    expect(
      (await tool.execute({ action: "list" }, makeToolContext("/w", { depth: 1 }))).isError,
    ).toBe(true);
    const top = makeToolContext("/w");
    expect(await tool.execute({ action: "list" }, top)).toEqual({ content: "No sub-agent tasks." });
    expect((await tool.execute({ action: "wait" }, top)).content).toBe("wait needs taskId");
    expect(tool.annotations?.pollable).toBe(true);
  });
});
