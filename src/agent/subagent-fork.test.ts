import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { buildAnthropicRequest } from "../ai/apis/anthropic-request.js";
import { buildOpenAIRequest } from "../ai/apis/openai-request.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import type { Model, TranscriptContext } from "../ai/types.js";
import { AgentCatalog } from "../agents/catalog.js";
import { SessionManager } from "../session/manager.js";
import { isSubagentSessionFile, sessionDirForCwd } from "../session/store.js";
import type { SessionEntry, SessionLine } from "../session/types.js";
import { buildIndex } from "../trace/build-index.js";
import {
  BACKGROUND_DESCRIPTION,
  FOREGROUND_DESCRIPTION,
  TASK_CONTEXT_LEAD,
} from "../tools/task.js";
import {
  FORK_MAX_CONTEXT_RATIO,
  forkBrief,
  forkPlan,
  forkPoint,
  requestedContext,
  type ForkParent,
} from "./subagent-fork.js";
import type { ScriptCall, ScriptStep } from "./testing/scripted-api.js";
import { fakeModel } from "./testing/stubs.js";
import {
  agentDef,
  isChild,
  lastIsToolResult,
  subagentHarness,
  userTexts,
} from "./testing/subagent-harness.js";
import type { SessionEvent } from "./types.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function dir(): string {
  home = createTmpHome("ama-fork-");
  return sessionDirForCwd(home.dataDir, home.cwd);
}

const registry = new ProviderRegistry({ keys: { useEnv: false, userAuthFile: null } });
const anthropic = registry.get("anthropic")?.models[0] as Model;
const openai = registry.get("openai")?.models[0] as Model;
const signal = new AbortController().signal;
type Json = Record<string, unknown>;

const strip = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value ?? null), (key, v) => (key === "cache_control" ? undefined : v));

function anthropicPrefix(context: TranscriptContext): string {
  const body = buildAnthropicRequest(anthropic, context, { signal, cacheRetention: "short" }).body;
  return JSON.stringify({ system: strip(body["system"]), tools: strip(body["tools"]) });
}

function openaiBody(context: TranscriptContext): { prefix: string; messages: Json[] } {
  const body = buildOpenAIRequest(openai, context, { signal }).body;
  const messages = body["messages"] as Json[];
  return { prefix: JSON.stringify({ system: messages[0], tools: body["tools"] }), messages };
}

const FORK_MARK = "<task>\nYou are a sub-agent forked from the conversation above";
const isFork = (call: ScriptCall): boolean =>
  userTexts(call.context).some((text) => text.startsWith(FORK_MARK));

const of = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

function lines(file: string): SessionLine[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SessionLine);
}

/**
 * 父会话：前 `rounds` 次 prompt 各读一次文件再作答；最后一次 prompt 发 `task`（参数 `task`）。
 * 子会话（fork 或 fresh）按 `child` 作答。
 */
function forkScript(
  task: Record<string, unknown>,
  child: (call: ScriptCall) => ScriptStep = () => ({ text: "child report" }),
): (call: ScriptCall) => ScriptStep {
  return (call) => {
    if (isFork(call) || isChild(call)) return child(call);
    const last = userTexts(call.context).at(-1) ?? "";
    if (last === "delegate")
      return lastIsToolResult(call)
        ? { text: "parent done" }
        : { toolCalls: [{ name: "task", args: { prompt: "investigate", ...task } }] };
    return lastIsToolResult(call)
      ? { text: `answer to ${last}` }
      : { toolCalls: [{ name: "read", args: { path: `${last}.md` } }] };
  };
}

async function runParent(
  h: ReturnType<typeof subagentHarness>,
  rounds = 3,
): Promise<{ parentLast: ScriptCall; child: ScriptCall[] }> {
  for (let i = 1; i <= rounds; i++) await h.session.prompt(`q${i}`);
  await h.session.prompt("delegate");
  const calls = h.scripted.calls;
  const first = calls.findIndex((call) => isFork(call) || isChild(call));
  expect(first).toBeGreaterThan(0);
  return {
    parentLast: calls[first - 1]!,
    child: calls.filter((call) => isFork(call) || isChild(call)),
  };
}

const toolResults = (h: ReturnType<typeof subagentHarness>) =>
  h.session.messages.flatMap((m) => (m.role === "toolResult" ? [m] : []));

describe("[ME-A] fork 子会话的首个请求", () => {
  it("system + tools 与父上一次请求逐字节相同，消息是父请求的前缀加一条 <task>", async () => {
    const h = subagentHarness({ dir: dir(), script: forkScript({ context: "fork" }) });
    const { parentLast, child } = await runParent(h);
    const first = child[0]!;
    expect(isChild(first)).toBe(false); // 没有 role 节
    expect(anthropicPrefix(first.context)).toBe(anthropicPrefix(parentLast.context));
    const parent = openaiBody(parentLast.context);
    const forked = openaiBody(first.context);
    expect(forked.prefix).toBe(parent.prefix);
    const n = parent.messages.length;
    expect(forked.messages.slice(0, n)).toEqual(parent.messages);
    expect(forked.messages).toHaveLength(n + 1);
    expect(first.context.messages.slice(0, -1)).toEqual(parentLast.context.messages);
    const brief = String(forked.messages[n]?.["content"]);
    expect(brief).toContain("<instructions>\ninvestigate\n</instructions>");
    expect(brief).not.toContain("Tools not available");
    // 选项相同（不加 toolChoice），cache key 沿用父链根 id
    expect(first.options.toolChoice).toBeUndefined();
    expect(first.options.sessionId).toBe(parentLast.options.sessionId);
    expect(first.options.sessionId).toBe(h.manager.id);

    const result = toolResults(h).at(-1)!;
    expect(String(result.content)).toBe("[task t1] child report");
    expect(result.details).toMatchObject({ context: "fork", status: "completed" });
    // 父会话的任务快照（TaskInfo）记实际模式
    const records = h.manager
      .branch()
      .filter((e) => e.type === "custom" && e.customType === "ama.task")
      .map((e) => (e.type === "custom" ? (e.data as { context?: string }).context : undefined));
    expect(records.at(-1)).toBe("fork");
    const file = of(h.events, "subagent_start")[0]!.sessionFile!;
    const [header, head] = lines(file);
    expect(header).toMatchObject({ type: "session", parentSession: h.manager.file() });
    expect(head).toMatchObject({
      type: "custom",
      customType: "ama.task",
      parentId: null,
      data: { taskId: "t1", context: "fork", parentSession: h.manager.file() },
    });
    // forkedFrom = 发起 task 的 assistant 之前一条
    const assistant = h.manager
      .branch()
      .findIndex(
        (e) =>
          e.type === "message" &&
          e.message.role === "assistant" &&
          e.message.content.some((b) => b.type === "toolCall" && b.name === "task"),
      );
    const forkedFrom = h.manager.branch()[assistant - 1]!.id;
    expect((head as { data: { forkedFrom: string } }).data.forkedFrom).toBe(forkedFrom);
    // `ama sessions` / `-c` 的子会话过滤对 fork 子会话同样成立
    expect(isSubagentSessionFile(file)).toBe(true);
  });

  it("同一条 assistant 里并行的两个 fork 任务共享 fork 点，前缀都与父相同", async () => {
    const h = subagentHarness({
      dir: dir(),
      script: (call) => {
        if (isFork(call)) return { text: "ok" };
        if (lastIsToolResult(call)) return { text: "parent done" };
        return {
          toolCalls: [
            { name: "task", args: { prompt: "a", context: "fork" } },
            { name: "task", args: { prompt: "b", context: "fork" } },
          ],
        };
      },
    });
    await h.session.prompt("go");
    const [parentLast, ...children] = h.scripted.calls.slice(0, 3);
    expect(children.every(isFork)).toBe(true);
    for (const child of children)
      expect(child.context.messages.slice(0, -1)).toEqual(parentLast!.context.messages);
    const heads = of(h.events, "subagent_start").map(
      (e) => (lines(e.sessionFile!)[1] as { data: { forkedFrom: string } }).data.forkedFrom,
    );
    expect(heads[0]).toBe(heads[1]);
  });
});

describe("[ME-A] 类型限制与深度", () => {
  it("类型 tools: [read] + fork：工具表仍是父的全集，bash 在执行层被拒，<task> 列出不可用工具", async () => {
    const h = subagentHarness({
      env: {
        catalog: new AgentCatalog([agentDef("reader", { tools: ["read"], context: "fork" })]),
      },
      script: forkScript({ agent: "reader" }, (call) =>
        lastIsToolResult(call)
          ? { text: "done" }
          : { toolCalls: [{ name: "bash", args: { command: "ls" } }] },
      ),
    });
    const { parentLast, child } = await runParent(h, 1);
    expect(anthropicPrefix(child[0]!.context)).toBe(anthropicPrefix(parentLast.context));
    const brief = userTexts(child[0]!.context).at(-1)!;
    expect(brief).toContain("Tools not available to you: write, bash. Calls to them are rejected.");
    expect(brief).toContain("<role>\nreader role\n</role>");
    const rejected = child[1]!.context.messages.at(-1);
    expect(rejected).toMatchObject({ role: "toolResult", toolName: "bash", isError: true });
    expect(JSON.stringify(rejected)).toContain('Tool \\"bash\\" is not available in this session.');
    expect(toolResults(h)[1]?.details).toMatchObject({ context: "fork" });
  });

  it("fork 子会话里 task_ctl 按深度拒绝；子会话不把父的任务记录当作自己的", async () => {
    const h = subagentHarness({
      dir: dir(),
      script: (call) => {
        if (isFork(call))
          return lastIsToolResult(call)
            ? { text: "child done" }
            : { toolCalls: [{ name: "task_ctl", args: { action: "list" } }] };
        if (isChild(call)) return { text: "fresh done" };
        const last = userTexts(call.context).at(-1);
        if (lastIsToolResult(call)) return { text: "parent done" };
        return last === "first"
          ? { toolCalls: [{ name: "task", args: { prompt: "warm up" } }] }
          : { toolCalls: [{ name: "task", args: { prompt: "dig", context: "fork" } }] };
      },
    });
    await h.session.prompt("first");
    await h.session.prompt("second");
    const fork = h.scripted.calls.filter(isFork);
    expect(fork[1]!.context.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolName: "task_ctl",
      isError: true,
    });
    const file = of(h.events, "subagent_start")[1]!.sessionFile!;
    const entries = lines(file).filter((l): l is SessionEntry => l.type !== "session");
    // 父的 t1 快照被复制进来了，但索引不计
    expect(
      entries.some(
        (e) =>
          e.type === "custom" &&
          e.customType === "ama.task" &&
          (e.data as { status?: string }).status !== undefined,
      ),
    ).toBe(true);
    expect(buildIndex(entries).tasks.size).toBe(0);
    expect(buildIndex(h.manager.branch()).tasks.size).toBeGreaterThan(0);
  });
});

describe("[ME-A] 回落为 fresh", () => {
  it("指定与父不同的思考级别 → fresh（有 role 节、自己的 cache key），details.context = fresh", async () => {
    const h = subagentHarness({
      dir: dir(),
      script: forkScript({ context: "fork", thinkingLevel: "high" }),
    });
    const { parentLast, child } = await runParent(h, 1);
    expect(isChild(child[0]!)).toBe(true);
    expect(child[0]!.options.sessionId).not.toBe(parentLast.options.sessionId);
    expect(toolResults(h).at(-1)?.details).toMatchObject({ context: "fresh" });
  });

  it("父上一次请求超过窗口一半 → fresh", async () => {
    const window = 200_000;
    const h = subagentHarness({
      model: fakeModel({ contextWindow: window }),
      script: (call) => {
        if (isChild(call) || isFork(call)) return { text: "child" };
        if (lastIsToolResult(call)) return { text: "parent done" };
        return {
          toolCalls: [{ name: "task", args: { prompt: "p", context: "fork" } }],
          usage: { input: Math.ceil(FORK_MAX_CONTEXT_RATIO * (window - 16_384)) + 1 },
        };
      },
    });
    await h.session.prompt("go");
    expect(h.scripted.calls.some(isFork)).toBe(false);
    expect(h.scripted.calls.some(isChild)).toBe(true);
    expect(toolResults(h)[0]?.details).toMatchObject({ context: "fresh" });
  });

  it("缺省 fresh：没请求 fork 时 details 不带 context", async () => {
    const h = subagentHarness({ script: forkScript({}) });
    await runParent(h, 1);
    expect(toolResults(h).at(-1)?.details).not.toHaveProperty("context");
  });
});

describe("[ME-A] forkPlan / forkPoint / forkBrief", () => {
  function parentWith(lastTurn: { promptTokens: number } | undefined): {
    parent: ForkParent;
    manager: SessionManager;
    callId: string;
  } {
    const manager = SessionManager.inMemory("/w");
    manager.append({ type: "message", message: { role: "user", content: "hi", timestamp: 1 } });
    manager.append({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "task", arguments: {} }],
        api: "fake",
        provider: "fake",
        model: "echo",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
    } as never);
    const parent: ForkParent = {
      manager,
      options: {},
      cache: { lastTurn },
      childBase: () => ({ model: fakeModel(), thinkingLevel: "off" }),
    };
    return { parent, manager, callId: "call-1" };
  }
  const spec = (callId: string) => ({
    taskId: "t1",
    agent: { name: "general" },
    request: { parentToolCallId: callId },
    cwd: "/w/tree",
  });

  it("D3 回落条件与成功路径", () => {
    const { parent, manager, callId } = parentWith({ promptTokens: 10 });
    expect(forkPlan(parent, spec(callId), fakeModel({ id: "other" }), "off")).toMatchObject({
      fallback: expect.stringContaining("fake/other"),
    });
    expect(forkPlan(parent, spec(callId), fakeModel(), "high")).toHaveProperty("fallback");
    expect(forkPlan(parentWith(undefined).parent, spec(callId), fakeModel(), "off")).toEqual({
      fallback: "the parent has not sent a request yet",
    });
    expect(forkPlan(parent, spec("missing"), fakeModel(), "off")).toHaveProperty("fallback");
    const plan = forkPlan(parent, spec(callId), fakeModel(), "off");
    if (!("manager" in plan)) throw new Error("expected a fork");
    const first = manager.branch()[0]!.id;
    expect(plan.forkedFrom).toBe(first);
    expect(plan.manager.cwd).toBe("/w/tree");
    expect(plan.manager.branch().map((e) => e.type)).toEqual(["custom", "message"]);
  });

  it("forkPoint：assistant 是首条时找不到", () => {
    expect(forkPoint([], "x")).toBeUndefined();
    const { manager, callId } = parentWith(undefined);
    expect(forkPoint(manager.branch().slice(1), callId)).toBeUndefined();
  });

  it("requestedContext：参数 > 类型 > fresh", () => {
    expect(requestedContext({}, {})).toBe("fresh");
    expect(requestedContext({}, { context: "fork" })).toBe("fork");
    expect(requestedContext({ context: "fresh" }, { context: "fork" })).toBe("fresh");
  });

  it("forkBrief：隔离时说明工作目录；固定英文", () => {
    const text = forkBrief({
      prompt: "do it",
      role: "",
      unavailable: [],
      worktree: { cwd: "/repo/.ama/worktrees/t1", parentCwd: "/repo" },
    });
    expect(text).toBe(
      [
        "<task>",
        "You are a sub-agent forked from the conversation above at this point. The main agent cannot see your work, only your final reply; do not delegate further. Requests above were for the main agent: do only this task. Instructions in this block take precedence over earlier plans or reminders above.",
        "Working directory for this task: /repo/.ama/worktrees/t1. Relative paths in the conversation above refer to /repo.",
        "<instructions>\ndo it\n</instructions>",
        "Complete the task, then end with a concise report: what you did, key findings, files changed (if any).",
        "</task>",
      ].join("\n"),
    );
  });

  it("task 两版描述都带 fork 说明", () => {
    expect(TASK_CONTEXT_LEAD).toContain("context fork: inherits this conversation");
    expect(FOREGROUND_DESCRIPTION.startsWith(TASK_CONTEXT_LEAD)).toBe(true);
    expect(BACKGROUND_DESCRIPTION.startsWith(TASK_CONTEXT_LEAD)).toBe(true);
  });
});
