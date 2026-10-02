import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { AgentCatalog } from "../agents/catalog.js";
import { sessionDirForCwd } from "../session/store.js";
import type { ToolResultMessage } from "../ai/types.js";
import type { SubagentResult, SubagentRunRequest, SubagentRunner } from "../tools/types.js";
import { registryOf } from "./subagent-registry.js";
import type { ScriptCall, ScriptStep } from "./testing/scripted-api.js";
import {
  agentDef,
  firstUser,
  isChild,
  lastIsToolResult,
  sleepTool,
  subagentHarness,
  userTexts,
  waitUntil,
} from "./testing/subagent-harness.js";
import type { SessionEvent } from "./types.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function dir(): string {
  home = createTmpHome("ama-w5g-reg-");
  return sessionDirForCwd(home.dataDir, home.cwd);
}

const of = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

type H = ReturnType<typeof subagentHarness>;
const results = (h: H) =>
  h.session.messages.flatMap((m) => (m.role === "toolResult" ? [m as ToolResultMessage] : []));
const lastUser = (call: ScriptCall) => userTexts(call.context).at(-1) ?? "";

/** 父会话按最后一条 user 文本选动作；子会话回「answer N」（N = 它看到的 user 消息数）。 */
function script(parent: Record<string, ScriptStep>) {
  return (call: ScriptCall): ScriptStep => {
    if (isChild(call)) return { text: `answer ${userTexts(call.context).length}` };
    if (lastIsToolResult(call)) return { text: "parent done" };
    return parent[lastUser(call)] ?? { text: `ack ${lastUser(call).slice(0, 40)}` };
  };
}

const task = (args: Record<string, unknown>): ScriptStep => ({
  toolCalls: [{ name: "task", args }],
});

describe("taskId 续聊", () => {
  it("续聊复用同一子会话与 JSONL；子会话看到前后两条消息", async () => {
    const h = subagentHarness({
      dir: dir(),
      script: script({
        one: task({ prompt: "first" }),
        two: task({ prompt: "second", taskId: "t1" }),
      }),
    });
    await h.session.prompt("one");
    await h.session.prompt("two");
    const [a, b] = results(h);
    expect(String(a?.content)).toBe("[task t1] answer 1");
    expect(String(b?.content)).toBe("[task t1] answer 2");
    const file = (a?.details as { sessionFile: string }).sessionFile;
    expect((b?.details as { sessionFile: string }).sessionFile).toBe(file);
    const users = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((l) => l.type === "message" && l.message.role === "user")
      .map((l) => l.message.content);
    expect(users).toEqual(["first", "second"]);
    expect(of(h.events, "subagent_start").map((e) => e.taskId)).toEqual(["t1", "t1"]);
  });

  it("句柄被 LRU 释放后按会话文件重开接上；运行中 / 未知 / 内存会话被释放 → 错误", async () => {
    const h = subagentHarness({
      dir: dir(),
      env: { catalog: new AgentCatalog(), retain: 0 },
      script: script({
        one: task({ prompt: "first" }),
        two: task({ prompt: "second", taskId: "t1" }),
        three: task({ prompt: "x", taskId: "t9" }),
      }),
    });
    await h.session.prompt("one");
    await h.session.prompt("two");
    await h.session.prompt("three");
    expect(results(h).map((r) => String(r.content))).toEqual([
      "[task t1] answer 1",
      "[task t1] answer 2",
      "Unknown task t9.",
    ]);
    const memory = subagentHarness({
      env: { catalog: new AgentCatalog(), retain: 0 },
      script: script({ one: task({ prompt: "a" }), two: task({ prompt: "b", taskId: "t1" }) }),
    });
    await memory.session.prompt("one");
    await memory.session.prompt("two");
    expect(String(results(memory)[1]?.content)).toMatch(/cannot be continued/);
  });
});

describe("resume 重建注册表", () => {
  it("从父会话 custom{ama.task} 重建：完成的保留、运行中的标 interrupted；序号接续；续聊重开子会话", async () => {
    const first = subagentHarness({
      dir: dir(),
      script: script({ one: task({ prompt: "first" }) }),
    });
    await first.session.prompt("one");
    await first.session.dispose();
    // 模拟崩溃时还在跑的后台任务
    const file = first.manager.file() as string;
    const crashed = subagentHarness({ file, script: script({}) });
    crashed.manager.append({
      type: "custom",
      customType: "ama.task",
      data: {
        taskId: "t2",
        agent: "explore",
        runner: "ama",
        description: "",
        background: true,
        status: "running",
        startedAt: 1,
      },
    });
    await crashed.session.dispose();

    const resumed = subagentHarness({
      file,
      script: script({
        two: task({ prompt: "again", taskId: "t1" }),
        three: task({ prompt: "new" }),
      }),
    });
    const registry = registryOf(resumed.manager.id);
    expect(registry?.list().map((t) => [t.taskId, t.status])).toEqual([
      ["t1", "completed"],
      ["t2", "interrupted"],
    ]);
    await resumed.session.prompt("two");
    await resumed.session.prompt("three");
    expect(
      results(resumed)
        .slice(-2)
        .map((r) => String(r.content)),
    ).toEqual(["[task t1] answer 2", "[task t3] answer 1"]);
    await resumed.session.dispose();
  });
});

describe("后台运行与完成通知", () => {
  it("两个后台 explore：父不等、通知按完成顺序作为 followUp 到达，内容是最终报告", async () => {
    const counter = { running: 0, peak: 0 };
    const h = subagentHarness({
      dir: dir(),
      extraTools: [sleepTool(counter, 60)],
      script: (call) => {
        if (isChild(call)) {
          const slept = call.context.messages.filter((m) => m.role === "toolResult").length;
          if (slept < (firstUser(call) === "slow" ? 3 : 1))
            return { toolCalls: [{ name: "sleep", args: {} }] };
          return { text: `report ${firstUser(call)}` };
        }
        if (lastIsToolResult(call)) return { text: "parent done" };
        const text = lastUser(call);
        if (text === "go")
          return {
            toolCalls: [
              { name: "task", args: { prompt: "slow", agent: "explore", background: true } },
              { name: "task", args: { prompt: "fast", agent: "explore", background: true } },
            ],
          };
        return { text: `ack ${text.slice(0, 40)}` };
      },
    });
    await h.session.prompt("go");
    expect(of(h.events, "subagent_end")).toHaveLength(0);
    const started = results(h).map((r) => String(r.content));
    expect(started[0]).toMatch(/^\[task t1\] Started background task t1 \(agent explore\)/);
    expect(results(h)[0]?.details).toMatchObject({ taskId: "t1", status: "running" });
    // 父在后台任务期间照常对话
    await h.session.prompt("still here?");
    expect(h.session.getLastAssistantText()).toBe("ack still here?");
    const notes = () =>
      h.session.messages.flatMap((m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.startsWith("<task-notification")
          ? [m]
          : [],
      );
    await waitUntil(() => notes().length === 2);
    await h.session.waitForIdle();
    const [n1, n2] = notes();
    expect(n1?.content).toMatch(
      /^<task-notification taskId="t2" agent="explore" status="completed" turns="2"/,
    );
    expect(n1?.content).toContain("report fast");
    expect(n2?.content).toMatch(/taskId="t1"/);
    expect(n2?.content).toContain("report slow");
    expect(n1).toMatchObject({ origin: "task" });
    const end = of(h.events, "subagent_end");
    expect(end.map((e) => [e.taskId, e.status])).toEqual([
      ["t2", "completed"],
      ["t1", "completed"],
    ]);
    // 后台任务的全文总写 outputFile
    expect(readFileSync(end[0]!.outputFile!, "utf8")).toBe("report fast");
    await h.session.dispose();
  });

  it("父 abort 级联前台子任务；dispose 停止后台任务", async () => {
    const hang = (call: ScriptCall): ScriptStep =>
      isChild(call)
        ? { kind: "hang", text: "partial" }
        : lastIsToolResult(call)
          ? { text: "parent done" }
          : lastUser(call) === "fg"
            ? task({ prompt: "wait" })
            : task({ prompt: "bg", background: true });
    const h = subagentHarness({ script: hang });
    const run = h.session.prompt("fg");
    await waitUntil(() => of(h.events, "subagent_start").length === 1);
    await h.session.abort();
    await run;
    expect(of(h.events, "subagent_end")[0]).toMatchObject({ taskId: "t1", status: "aborted" });
    await h.session.prompt("bg");
    await waitUntil(() => of(h.events, "subagent_start").length === 2);
    const registry = registryOf(h.manager.id)!;
    expect(registry.get("t2")?.status).toBe("running");
    await h.session.dispose();
    await waitUntil(() => registry.get("t2")?.status === "aborted");
    expect(registryOf(h.manager.id)).toBeUndefined();
  });
});

describe("外部 runner（统一入口）", () => {
  function stubRunner(log: SubagentRunRequest[], sends: string[]): SubagentRunner {
    return {
      id: "claude",
      async start(request) {
        log.push(request);
        request.onEvent({ type: "tool", toolName: "Edit", status: "started" });
        request.onEvent({ type: "text", delta: "external says hi" });
        request.onEvent({ type: "usage", unit: "usd", amount: 0.25 });
        request.onEvent({ type: "turn", turn: 1 });
        let text = `external: ${request.prompt}`;
        const result = (): SubagentResult => ({
          text,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: "stop",
          isError: false,
        });
        return {
          id: "ext-session-1",
          send: async (more) => {
            sends.push(more);
            text = `external: ${more}`;
          },
          wait: async () => result(),
          stop: async () => undefined,
        };
      },
    };
  }

  it("task(agent=外部) 走 SubagentRunner：prompt / cwd / 模式透传，事件统一，续聊用 send", async () => {
    const log: SubagentRunRequest[] = [];
    const sends: string[] = [];
    const runner = stubRunner(log, sends);
    const h = subagentHarness({
      env: {
        catalog: new AgentCatalog([agentDef("claude", { runner: "claude", source: "host" })]),
        runners: (agent) => (agent.runner === "claude" ? runner : undefined),
      },
      script: script({
        one: task({ prompt: "review", agent: "claude", budgetUsd: 2 }),
        two: task({ prompt: "more", taskId: "t1" }),
        three: task({ prompt: "x", agent: "codex-missing" }),
      }),
    });
    await h.session.prompt("one");
    await h.session.prompt("two");
    expect(log[0]).toMatchObject({
      prompt: "review",
      cwd: "/work",
      mode: "full-auto",
      budgetUsd: 2,
    });
    expect(sends).toEqual(["more"]);
    expect(results(h).map((r) => String(r.content))).toEqual([
      "[task t1] external: review",
      "[task t1] external: more",
    ]);
    expect(of(h.events, "subagent_start")[0]).toMatchObject({ agent: "claude", runner: "claude" });
    expect(of(h.events, "subagent_update").map((u) => u.kind)).toContain("tool");
    const info = registryOf(h.manager.id)?.get("t1");
    expect(info).toMatchObject({
      runner: "claude",
      costUsd: 0.25,
      sessionRef: { runner: "claude", sessionId: "ext-session-1" },
    });
  });

  it("外部类型没有可用 runner → 错误", async () => {
    const h = subagentHarness({
      env: { catalog: new AgentCatalog([agentDef("codex", { runner: "codex" })]) },
      script: script({ one: task({ prompt: "x", agent: "codex" }) }),
    });
    await h.session.prompt("one");
    expect(String(results(h)[0]?.content)).toMatch(
      /External agent "codex" \(codex\) is not available/,
    );
  });
});
