/**
 * 子 Agent 视图的直接对话与实时数据（docs/wave6-plan.md §1.3、D3）。[W6-A]
 *
 * `registry.message()`：ama 运行中 → followUp（steered）、结束后 → 后台续聊（resumed）、句柄被 LRU 释放后
 * 按会话文件重开；外部 Agent 运行中 → 排队到运行结束再续聊（queued）；子会话 user 消息 `origin:"direct"`。
 * `registry.live()`：排队标记、observe / entries、外部环形缓冲（DisplayRing 上限）。
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { AgentCatalog } from "../agents/catalog.js";
import { DisplayRing } from "../agents/task-record.js";
import { sessionDirForCwd } from "../session/store.js";
import type { SessionLine } from "../session/types.js";
import type {
  SubagentEvent,
  SubagentResult,
  SubagentRunRequest,
  SubagentRunner,
} from "../tools/types.js";
import { registryOf } from "./subagent-registry.js";
import type { ScriptCall, ScriptStep } from "./testing/scripted-api.js";
import { stubTool } from "./testing/stubs.js";
import {
  agentDef,
  isChild,
  lastIsToolResult,
  subagentHarness,
  userTexts,
  waitUntil,
} from "./testing/subagent-harness.js";
import type { ToolDefinition } from "../tools/types.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function dir(): string {
  home = createTmpHome("ama-w6a-direct-");
  return sessionDirForCwd(home.dataDir, home.cwd);
}

/** 子会话第一次请求调用 gate（等测试放行），之后回「answer N」（N = 看到的 user 消息数）。 */
function gated() {
  let release: () => void = () => undefined;
  let entered = false;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tool = stubTool({
    name: "gate",
    run: async () => {
      entered = true;
      await gate;
      return { content: "opened" };
    },
  }) as ToolDefinition;
  const script = (call: ScriptCall): ScriptStep => {
    if (isChild(call)) {
      const users = userTexts(call.context).length;
      const gatedOnce = call.context.messages.some((m) => m.role === "toolResult");
      if (users === 1 && !gatedOnce) return { toolCalls: [{ name: "gate", args: {} }] };
      return { text: `answer ${users}` };
    }
    if (lastIsToolResult(call)) return { text: "parent done" };
    const last = userTexts(call.context).at(-1) ?? "";
    if (last === "go")
      return {
        toolCalls: [
          { name: "task", args: { prompt: "first", agent: "explore", background: true } },
        ],
      };
    return { text: "ok" };
  };
  return { tool, script, release: () => release(), entered: () => entered };
}

function childUsers(file: string): { content: unknown; origin?: string }[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as SessionLine)
    .flatMap((l) =>
      l.type === "message" && l.message.role === "user"
        ? [
            {
              content: l.message.content,
              ...(l.message.origin ? { origin: l.message.origin } : {}),
            },
          ]
        : [],
    );
}

describe("registry.message：ama 子会话", () => {
  it("运行中 → steered，followUp 在回合结束投递（origin direct）；结束后 → resumed 后台续聊", async () => {
    const g = gated();
    const h = subagentHarness({ dir: dir(), extraTools: [g.tool], script: g.script });
    await h.session.prompt("go");
    const registry = registryOf(h.manager.id)!;
    await waitUntil(g.entered);
    const live = registry.live("t1")!;
    expect(live.info.status).toBe("running");
    expect(live.queued).toBe(false);
    expect(live.entries?.().length).toBeGreaterThan(0);
    const seen: string[] = [];
    const off = live.observe!((event) => seen.push(event.type));
    expect(await registry.message("t1", "also check tests")).toBe("steered");
    g.release();
    await waitUntil(() => registry.get("t1")?.status === "completed");
    off();
    expect(seen).toContain("message_start");
    expect(registry.output("t1")).toBe("answer 2");
    const file = registry.get("t1")!.sessionRef!.sessionFile!;
    expect(childUsers(file)).toEqual([
      { content: "first" },
      { content: "also check tests", origin: "direct" },
    ]);

    expect(await registry.message("t1", "one more")).toBe("resumed");
    await waitUntil(
      () => registry.get("t1")?.status === "completed" && registry.output("t1") === "answer 3",
    );
    expect(childUsers(file).at(-1)).toEqual({ content: "one more", origin: "direct" });
    // 续聊完成后父会话照常收 <task-notification>
    await waitUntil(
      () =>
        h.session.messages.filter(
          (m) => m.role === "user" && String(m.content).startsWith("<task-notification"),
        ).length === 2,
    );
    await h.session.dispose();
  });

  it("句柄被 LRU 释放后：resumed 按会话文件重开，首条消息 origin direct", async () => {
    const h = subagentHarness({
      dir: dir(),
      env: { catalog: new AgentCatalog(), retain: 0 },
      script: (call) =>
        isChild(call)
          ? { text: `answer ${userTexts(call.context).length}` }
          : lastIsToolResult(call)
            ? { text: "parent done" }
            : { toolCalls: [{ name: "task", args: { prompt: "first", agent: "explore" } }] },
    });
    await h.session.prompt("go");
    const registry = registryOf(h.manager.id)!;
    expect(registry.live("t1")?.entries).toBeUndefined();
    expect(await registry.message("t1", "again")).toBe("resumed");
    await waitUntil(() => registry.output("t1") === "answer 2");
    const file = registry.get("t1")!.sessionRef!.sessionFile!;
    expect(childUsers(file)).toEqual([
      { content: "first" },
      { content: "again", origin: "direct" },
    ]);
    await expect(registry.message("t1", "  ")).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(registry.message("t9", "x")).rejects.toMatchObject({ code: "task_not_found" });
    await h.session.dispose();
  });

  it("并发池满时排队：live.queued，消息排到运行结束后续聊", async () => {
    const g = gated();
    const h = subagentHarness({
      dir: dir(),
      env: { catalog: new AgentCatalog(), maxConcurrent: 1 },
      extraTools: [g.tool],
      script: (call) => {
        if (isChild(call)) return g.script(call);
        if (lastIsToolResult(call) || userTexts(call.context).at(-1) !== "go")
          return { text: "parent done" };
        return {
          toolCalls: [
            { name: "task", args: { prompt: "first", agent: "explore", background: true } },
            { name: "task", args: { prompt: "second", agent: "explore", background: true } },
          ],
        };
      },
    });
    await h.session.prompt("go");
    const registry = registryOf(h.manager.id)!;
    await waitUntil(g.entered);
    await waitUntil(() => registry.live("t2")?.queued === true);
    expect(await registry.message("t2", "queued note")).toBe("queued");
    expect(registry.live("t2")?.pending).toBe(1);
    g.release();
    await waitUntil(
      () => registry.get("t2")?.status === "completed" && registry.live("t2")?.pending === 0,
    );
    const file = registry.get("t2")!.sessionRef!.sessionFile!;
    await waitUntil(() => childUsers(file).some((u) => u.origin === "direct"));
    expect(childUsers(file).at(-1)).toEqual({ content: "queued note", origin: "direct" });
    await h.session.dispose();
  });
});

/** 外部 runner：start 后等测试放行；send 记下文本并立即完成。 */
function fakeExternal() {
  const sent: string[] = [];
  let finish: () => void = () => undefined;
  let emit: (event: SubagentEvent) => void = () => undefined;
  const result = (text: string): SubagentResult => ({
    text,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop",
    isError: false,
  });
  const runner: SubagentRunner = {
    id: "codex",
    start: async (request: SubagentRunRequest) => {
      emit = request.onEvent;
      let current = new Promise<SubagentResult>(
        (resolve) => (finish = () => resolve(result("done"))),
      );
      return {
        id: "ext-1",
        send: async (text) => {
          sent.push(text);
          current = Promise.resolve(result(`reply ${text}`));
        },
        wait: () => current,
        stop: async () => finish(),
      };
    },
  };
  return { runner, sent, finish: () => finish(), emit: (e: SubagentEvent) => emit(e) };
}

describe("registry.message：外部 Agent", () => {
  it("运行中 → queued，运行结束后以 send 续聊；环形缓冲记录展示事件", async () => {
    const ext = fakeExternal();
    const catalog = new AgentCatalog([agentDef("codex", { runner: "codex" })]);
    const h = subagentHarness({
      dir: dir(),
      env: { catalog, runners: () => ext.runner },
      script: (call) =>
        lastIsToolResult(call) || userTexts(call.context).at(-1) !== "go"
          ? { text: "parent done" }
          : {
              toolCalls: [
                { name: "task", args: { prompt: "p", agent: "codex", background: true } },
              ],
            },
    });
    await h.session.prompt("go");
    const registry = registryOf(h.manager.id)!;
    await waitUntil(
      () =>
        registry.live("t1")?.queued === false && registry.live("t1")?.info.sessionRef !== undefined,
    );
    ext.emit({ type: "text", delta: "hel" });
    ext.emit({ type: "text", delta: "lo" });
    ext.emit({ type: "tool", toolName: "shell", status: "started", id: "c1", at: 5 });
    ext.emit({ type: "turn", turn: 1 });
    const recent = registry.live("t1")!.recent;
    expect(recent.map((e) => [e.kind, e.text ?? e.toolName])).toEqual([
      ["text", "hello"],
      ["tool", "shell"],
      ["turn", undefined],
    ]);
    expect(await registry.message("t1", "and then?")).toBe("queued");
    ext.finish();
    await waitUntil(() => ext.sent.length === 1);
    expect(ext.sent).toEqual(["and then?"]);
    await waitUntil(() => registry.output("t1") === "reply and then?");
    await h.session.dispose();
  });
});

describe("DisplayRing", () => {
  it("相邻同类文本合并；超过条数 / 字节上限从最旧的丢", () => {
    const ring = new DisplayRing(3, 200);
    ring.push({ at: 1, kind: "text", text: "a", turn: 0 });
    ring.push({ at: 2, kind: "text", text: "b", turn: 0 });
    expect(ring.items()).toEqual([{ at: 1, kind: "text", text: "ab", turn: 0 }]);
    ring.push({ at: 3, kind: "tool", toolName: "x", status: "started" });
    ring.push({ at: 4, kind: "turn", turn: 1 });
    ring.push({ at: 5, kind: "notice", text: "n", level: "info" });
    expect(ring.items().map((e) => e.at)).toEqual([3, 4, 5]);
    ring.push({ at: 6, kind: "text", text: "x".repeat(500), turn: 2 });
    expect(ring.items()).toHaveLength(1);
    expect(ring.size).toBeLessThanOrEqual(200);
  });

  it("缺省上限 2000 条", () => {
    const ring = new DisplayRing();
    for (let i = 0; i < 2100; i++) ring.push({ at: i, kind: "turn", turn: i });
    expect(ring.items()).toHaveLength(2000);
    expect(ring.items()[0]?.at).toBe(100);
  });
});
