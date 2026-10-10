/**
 * 组装根级：`ama.trace` 写入扩展已装进组装表（docs/history/wave6-plan.md §2.7、§9 W6-C0 验收）。[W6-C0]
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import type { Runtime } from "./runtime.js";
import { TRACE_CUSTOM_TYPE, type TraceEntryData } from "../trace/types.js";
import type { SessionEntry } from "../session/types.js";

let harnesses: ComposeHarness[] = [];
let runtimes: Runtime[] = [];
afterEach(async () => {
  for (const r of runtimes) await r.dispose();
  for (const h of harnesses) h.cleanup();
  harnesses = [];
  runtimes = [];
});

function traces(entries: readonly SessionEntry[]): TraceEntryData[] {
  return entries.flatMap((e) =>
    e.type === "custom" && e.customType === TRACE_CUSTOM_TYPE ? [e.data as TraceEntryData] : [],
  );
}

describe("ama.trace（组装根）", () => {
  it("fake 一次请求恰好写一条 step，带请求计时与 assistant 引用", async () => {
    const h = composeHarness([{ text: "hello", usage: { input: 10, output: 2 } }]);
    harnesses.push(h);
    const runtime = await h.boot(["--model", "fake/echo"]);
    runtimes.push(runtime);
    await runtime.session.prompt("hi");
    const all = traces(runtime.session.entries);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: "step", attempt: 1, outputTokens: 2 });
    const step = all[0] as { assistantEntryId?: string; requestAt?: number; doneAt?: number };
    expect(step.requestAt).toBeTypeOf("number");
    expect(step.doneAt).toBeTypeOf("number");
    const assistant = runtime.session.entries.find((e) => e.id === step.assistantEntryId);
    expect(assistant?.type === "message" && assistant.message.role).toBe("assistant");
  });

  it("task 子会话（depth 1）也写；父会话的 step 带 task 调用的计时", async () => {
    const h = composeHarness([
      { steps: [{ toolCall: { name: "task", arguments: { prompt: "run", agent: "general" } } }] },
      { text: "sub done" },
      { text: "all done" },
    ]);
    harnesses.push(h);
    const runtime = await h.boot(["--model", "fake/echo", "--tools", "read,task", "--trust"]);
    runtimes.push(runtime);
    runtime.approvals.setUiBroker({ ask: async () => "allow" });
    await runtime.session.prompt("go");
    const parent = traces(runtime.session.entries);
    expect(parent.filter((t) => t.kind === "step")).toHaveLength(2);
    expect(parent[0]).toMatchObject({ kind: "step", tools: [{ id: "fake_call_0" }] });
    const task = runtime.session.entries.findLast(
      (e) => e.type === "custom" && e.customType === "ama.task",
    );
    const file = (task?.type === "custom" ? task.data : undefined) as
      { sessionRef?: { sessionFile?: string } } | undefined;
    const childFile = file?.sessionRef?.sessionFile;
    expect(childFile).toBeTypeOf("string");
    const child = readFileSync(childFile as string, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionEntry);
    expect(traces(child).filter((t) => t.kind === "step")).toHaveLength(1);
  });
});
