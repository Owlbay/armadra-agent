/**
 * [W7-B1] 转后台原语与缺省后台（docs/agents-concurrency-plan.md §2.3、§2.5、§2.6、§4 B1 项）。
 */

import { describe, expect, it } from "vitest";
import { AgentCatalog } from "../agents/catalog.js";
import { subagentEnvironment } from "../cli/compose-agents.js";
import type { ComposeExtensionDeps } from "../cli/compose-extensions.js";
import { backgroundedText } from "../agents/result.js";
import type { ToolResultMessage } from "../ai/types.js";
import type { ToolDefinition } from "../tools/types.js";
import type { TaskRecord } from "../agents/task-record.js";
import { backgroundedResult, resolveTaskBackground, startedResult } from "./subagent-background.js";
import { registryOf } from "./subagent-registry.js";
import type { ScriptCall, ScriptStep } from "./testing/scripted-api.js";
import { stubTool, waitOrAbort } from "./testing/stubs.js";
import {
  agentDef,
  isChild,
  lastIsToolResult,
  subagentHarness,
  userTexts,
  waitUntil,
} from "./testing/subagent-harness.js";
import type { SessionEvent } from "./types.js";

type H = ReturnType<typeof subagentHarness>;

const of = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);
const results = (h: H) =>
  h.session.messages.flatMap((m) => (m.role === "toolResult" ? [m as ToolResultMessage] : []));
const lastUser = (call: ScriptCall) => userTexts(call.context).at(-1) ?? "";
const notes = (h: H) =>
  h.session.messages.flatMap((m) =>
    m.role === "user" && typeof m.content === "string" && m.content.startsWith("<task-notification")
      ? [m]
      : [],
  );
const task = (args: Record<string, unknown>): ScriptStep => ({
  toolCalls: [{ name: "task", args }],
});

/** 子会话里的闸门工具：开闸（或中止）前一直等。 */
function gate(): { tool: ToolDefinition; open(): void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const tool = stubTool({
    name: "gate",
    run: async (_input, ctx) => {
      if (ctx.signal.aborted) return { content: "aborted", isError: true };
      await Promise.race([
        opened,
        new Promise<void>((resolve) =>
          ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      return { content: ctx.signal.aborted ? "aborted" : "opened" };
    },
  }) as ToolDefinition;
  return { tool, open };
}

/** 父会话里的慢工具（让父回合在通知到达时仍忙着）。 */
const busyTool = (ms: number): ToolDefinition =>
  stubTool({
    name: "busy",
    run: async (_input, ctx) => {
      await waitOrAbort(ms, ctx.signal);
      return { content: "busy done" };
    },
  }) as ToolDefinition;

/** 子会话：先过闸，再回「report <prompt>」；父会话按最后一条 user 文本选动作。 */
function script(parent: Record<string, ScriptStep>) {
  return (call: ScriptCall): ScriptStep => {
    if (isChild(call)) {
      if (!lastIsToolResult(call)) return { toolCalls: [{ name: "gate", args: {} }] };
      return { text: `report ${userTexts(call.context)[0] ?? ""}` };
    }
    if (lastIsToolResult(call)) return { text: "parent done" };
    return parent[lastUser(call)] ?? { text: `ack ${lastUser(call).slice(0, 40)}` };
  };
}

describe("前台任务转后台（background）", () => {
  it("工具立即以固定文案返回、发 subagent_background；父回合 Esc 不影响它；结束后照常通知", async () => {
    const g = gate();
    const h = subagentHarness({
      extraTools: [g.tool],
      script: script({ go: task({ prompt: "work" }), hang: { kind: "hang" } }),
    });
    const run = h.session.prompt("go");
    await waitUntil(() => of(h.events, "subagent_start").length === 1);
    const registry = registryOf(h.manager.id)!;
    expect(registry.blocking()).toEqual(["t1"]);
    expect(h.session.backgroundTask(undefined, "user")).toEqual(["t1"]);
    await run; // 父回合不再等子任务
    const [result] = results(h);
    expect(String(result?.content)).toBe(
      "[task t1] Moved to the background by the user; it was not interrupted. A " +
        "<task-notification> arrives when it finishes; use task_ctl to wait, stop or read output. " +
        "Do not wait for it unless the user asks.",
    );
    expect(result?.isError).toBe(false);
    expect(result?.details).toMatchObject({ taskId: "t1", status: "running" });
    expect(of(h.events, "subagent_background")).toEqual([
      {
        type: "subagent_background",
        taskId: "t1",
        parentToolCallId: expect.any(String) as string,
        reason: "user",
      },
    ]);
    expect(registry.get("t1")).toMatchObject({ status: "running", background: true });
    expect(registry.blocking()).toEqual([]);
    // 已在后台：再转返回空
    expect(registry.background("t1")).toEqual([]);

    // 父开新回合后 Esc：只中止主回合，后台任务继续
    const second = h.session.prompt("hang");
    await waitUntil(() => h.scripted.calls.some((c) => lastUser(c) === "hang"));
    await h.session.abort();
    await second;
    expect(registry.get("t1")?.status).toBe("running");
    expect(of(h.events, "subagent_end")).toHaveLength(0);

    g.open();
    await waitUntil(() => notes(h).length === 1);
    await h.session.waitForIdle();
    expect(notes(h)[0]).toMatchObject({ origin: "task" });
    expect(notes(h)[0]?.content).toMatch(/^<task-notification taskId="t1" agent="general"/);
    expect(notes(h)[0]?.content).toContain("report work");
    expect(of(h.events, "subagent_end")[0]).toMatchObject({ taskId: "t1", status: "completed" });
    // 不在运行：空数组
    expect(h.session.backgroundTask("t1")).toEqual([]);
    expect(h.session.backgroundTask()).toEqual([]);
    await h.session.dispose();
  });

  it("未转后台的前台任务仍随父 abort 中止（现状不变）", async () => {
    const g = gate();
    const h = subagentHarness({
      extraTools: [g.tool],
      script: script({ go: task({ prompt: "w" }) }),
    });
    const run = h.session.prompt("go");
    await waitUntil(() => of(h.events, "subagent_start").length === 1);
    await h.session.abort();
    await run;
    expect(of(h.events, "subagent_end")[0]).toMatchObject({ taskId: "t1", status: "aborted" });
    expect(of(h.events, "subagent_background")).toHaveLength(0);
    expect(notes(h)).toHaveLength(0);
  });

  it("task_ctl wait 被 background() 打断：立即返回固定文案，任务继续并通知", async () => {
    const g = gate();
    const h = subagentHarness({
      extraTools: [g.tool],
      script: script({
        go: task({ prompt: "bg", background: true }),
        wait: {
          toolCalls: [
            { name: "task_ctl", args: { action: "wait", taskId: "t1", timeoutMs: 60_000 } },
          ],
        },
      }),
    });
    await h.session.prompt("go");
    const run = h.session.prompt("wait");
    const registry = registryOf(h.manager.id)!;
    await waitUntil(() => registry.blocking().includes("t1"));
    expect(h.session.backgroundTask(undefined, "user")).toEqual(["t1"]);
    await run;
    expect(String(results(h)[1]?.content)).toBe(
      "Task t1 is still running and was moved to the background by the user; do not wait again " +
        "— a <task-notification> arrives when it finishes.",
    );
    expect(registry.get("t1")?.status).toBe("running");
    // 已经是后台任务：不发 subagent_background
    expect(of(h.events, "subagent_background")).toHaveLength(0);
    g.open();
    await waitUntil(() => notes(h).length === 1);
    await h.session.dispose();
  });

  it("wait 的 signal 触发返回 undefined；未触发时照常等到结果", async () => {
    const g = gate();
    const h = subagentHarness({
      extraTools: [g.tool],
      script: script({ go: task({ prompt: "bg", background: true }) }),
    });
    await h.session.prompt("go");
    const registry = registryOf(h.manager.id)!;
    const controller = new AbortController();
    const waiting = registry.wait("t1", 60_000, { signal: controller.signal });
    controller.abort();
    expect(await waiting).toBeUndefined();
    const done = registry.wait("t1", 60_000);
    g.open();
    expect((await done)?.text).toBe("report bg");
    await h.session.dispose();
  });

  it("autoBackgroundAfterMs：前台任务到时自动转后台（reason timeout），文案带秒数", async () => {
    const g = gate();
    const h = subagentHarness({
      extraTools: [g.tool],
      env: { catalog: new AgentCatalog(), autoBackgroundAfterMs: 40 },
      script: script({ go: task({ prompt: "slow" }) }),
    });
    await h.session.prompt("go");
    expect(String(results(h)[0]?.content)).toBe(`[task t1] ${backgroundedText("timeout", 40)}`);
    expect(String(results(h)[0]?.content)).toMatch(/^\[task t1\] Still running after 0s and moved/);
    expect(of(h.events, "subagent_background")[0]).toMatchObject({ reason: "timeout" });
    g.open();
    await waitUntil(() => notes(h).length === 1);
    await h.session.dispose();
  });

  it("autoBackgroundAfterMs：到时前结束的任务照常前台返回、不转后台", async () => {
    const g = gate();
    g.open();
    const h = subagentHarness({
      extraTools: [g.tool],
      env: { catalog: new AgentCatalog(), autoBackgroundAfterMs: 5_000 },
      script: script({ go: task({ prompt: "quick" }) }),
    });
    await h.session.prompt("go");
    expect(String(results(h)[0]?.content)).toBe("[task t1] report quick");
    expect(of(h.events, "subagent_background")).toHaveLength(0);
  });

  it("转后台与结束竞争：已收尾的任务不动；先转的那次以文案返回、结果走通知（只出现一次）", async () => {
    const g = gate();
    const h = subagentHarness({
      extraTools: [g.tool],
      script: script({ go: task({ prompt: "r" }) }),
    });
    const run = h.session.prompt("go");
    await waitUntil(() => of(h.events, "subagent_start").length === 1);
    const registry = registryOf(h.manager.id)!;
    // 同一时刻：开闸（子任务即将结束）并立即转后台
    g.open();
    const moved = registry.background();
    await run;
    await h.session.waitForIdle();
    if (moved.length === 1) {
      await waitUntil(() => notes(h).length === 1);
      expect(String(results(h)[0]?.content)).toMatch(/Moved to the background/);
      expect(notes(h)[0]?.content).toContain("report r");
    } else {
      expect(String(results(h)[0]?.content)).toBe("[task t1] report r");
      expect(notes(h)).toHaveLength(0);
    }
    // 结束之后再转：空
    await waitUntil(() => registry.get("t1")?.status === "completed");
    expect(registry.background()).toEqual([]);
    expect(of(h.events, "subagent_end")).toHaveLength(1);
    await h.session.dispose();
  });
});

describe("#156 running 结果的 details.context", () => {
  const record = (context?: "fork" | "fresh") =>
    ({
      info: { taskId: "t1", ...(context === undefined ? {} : { context }) },
      agent: { name: "general" },
    }) as unknown as TaskRecord;

  it("startedResult 等一个宏任务：期间模式已知则带上，未知（排队）则不带", async () => {
    const known = record();
    const pending = new Promise<never>(() => undefined);
    setImmediate(() => (known.info.context = "fork"));
    expect(await startedResult(known, "/out/t1", pending)).toMatchObject({
      status: "running",
      context: "fork",
      outputFile: "/out/t1",
    });
    const queued = await startedResult(record(), undefined, pending);
    expect(queued).not.toHaveProperty("context");
    expect(queued.status).toBe("running");
    // 运行 promise 先失败也不抛
    const failed = await startedResult(record("fresh"), undefined, Promise.reject(new Error("x")));
    expect(failed.context).toBe("fresh");
  });

  it("backgroundedResult 带已知模式；未请求 fork 时不带", () => {
    expect(backgroundedResult(record("fork"), "user", 0).context).toBe("fork");
    expect(backgroundedResult(record(), "timeout", 1000)).not.toHaveProperty("context");
  });
});

describe("缺省后台（subagents.background）", () => {
  it("resolveTaskBackground：auto 交互后台、-p 前台；always / never 不看模式", () => {
    expect(resolveTaskBackground(undefined, false)).toBe(true);
    expect(resolveTaskBackground("auto", false)).toBe(true);
    expect(resolveTaskBackground("auto", true)).toBe(false);
    expect(resolveTaskBackground("always", true)).toBe(true);
    expect(resolveTaskBackground("never", false)).toBe(false);
  });

  it("组装：subagents.background / autoBackgroundAfterMs 按运行模式解析进注册表环境", () => {
    const env = (subagents: Record<string, unknown> | undefined, unattended: boolean) =>
      subagentEnvironment(
        {
          assembly: { config: subagents === undefined ? {} : { subagents }, unattended },
        } as unknown as ComposeExtensionDeps,
        new AgentCatalog(),
      );
    expect(env(undefined, false)).toMatchObject({ background: true });
    expect(env(undefined, true)).toMatchObject({ background: false });
    expect(env({ background: "never" }, false)).toMatchObject({ background: false });
    expect(env({ background: "always" }, true)).toMatchObject({ background: true });
    expect(env({ autoBackgroundAfterMs: 120_000 }, false).autoBackgroundAfterMs).toBe(120_000);
    expect(env({ autoBackgroundAfterMs: 0 }, false).autoBackgroundAfterMs).toBeUndefined();
  });

  it("优先级：调用参数 > 类型定义 > 配置", async () => {
    const g = gate();
    g.open();
    const h = subagentHarness({
      extraTools: [g.tool],
      env: {
        catalog: new AgentCatalog([agentDef("fg", { background: false })]),
        background: true,
      },
      script: script({
        a: task({ prompt: "default" }),
        b: task({ prompt: "typed", agent: "fg" }),
        c: task({ prompt: "explicit", background: false }),
      }),
    });
    await h.session.prompt("a");
    expect(String(results(h)[0]?.content)).toMatch(/^\[task t1\] Started background task t1/);
    await waitUntil(() => notes(h).length === 1);
    await h.session.waitForIdle();
    await h.session.prompt("b");
    await h.session.prompt("c");
    const texts = results(h).map((r) => String(r.content));
    expect(texts.slice(1)).toEqual(["[task t2] report typed", "[task t3] report explicit"]);
    await h.session.dispose();
  });

  it("不配置（-p / never 解析后）缺省前台", async () => {
    const g = gate();
    g.open();
    const h = subagentHarness({
      extraTools: [g.tool],
      env: { catalog: new AgentCatalog(), background: false },
      script: script({ a: task({ prompt: "x" }) }),
    });
    await h.session.prompt("a");
    expect(String(results(h)[0]?.content)).toBe("[task t1] report x");
  });
});

describe("通知与主会话交错（§2.3）", () => {
  it("父忙时：用户 steer 先投、通知等回合收尾后各开一轮；空闲时通知立即开一轮", async () => {
    const g = gate();
    const h = subagentHarness({
      extraTools: [g.tool, busyTool(120)],
      script: script({
        go: {
          toolCalls: [
            { name: "task", args: { prompt: "one", background: true } },
            { name: "task", args: { prompt: "two", background: true } },
          ],
        },
        busy: { toolCalls: [{ name: "busy", args: {} }] },
      }),
    });
    await h.session.prompt("go");
    const busy = h.session.prompt("busy");
    await waitUntil(() => h.scripted.calls.some((c) => lastUser(c) === "busy"));
    g.open(); // 两个后台任务在父回合进行中结束
    await waitUntil(() => of(h.events, "subagent_end").length === 2);
    await h.session.steer("user steer");
    await busy;
    await waitUntil(() => notes(h).length === 2);
    await h.session.waitForIdle();
    const users = h.session.messages.flatMap((m, i) =>
      m.role === "user" ? [{ i, text: String(m.content).slice(0, 20) }] : [],
    );
    const steerAt = users.find((u) => u.text === "user steer")!.i;
    const noteAt = h.session.messages.findIndex(
      (m) => m.role === "user" && String(m.content).startsWith("<task-notification"),
    );
    expect(steerAt).toBeLessThan(noteAt);
    // 每个通知后面紧跟它自己那一轮的 assistant 回复（不合并）
    for (const note of notes(h)) {
      const at = h.session.messages.indexOf(note);
      expect(h.session.messages[at + 1]?.role).toBe("assistant");
    }
    await h.session.dispose();
  });

  it("settled()：等到后台任务结束且通知回合跑完；会话关闭后立即返回", async () => {
    const g = gate();
    const h = subagentHarness({
      extraTools: [g.tool],
      script: script({ go: task({ prompt: "s", background: true }) }),
    });
    await h.session.prompt("go");
    const registry = registryOf(h.manager.id)!;
    let settled = false;
    const waiting = registry.settled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    g.open();
    await waiting;
    expect(notes(h)).toHaveLength(1);
    expect(h.session.state.isStreaming).toBe(false);
    await h.session.dispose();
    await registry.settled();
  });
});
