/**
 * 子 Agent 视图的「打断并发送」（`registry.message(id, text, true)`）：
 * - ama 子会话运行中 → 中止它当前回合（工具按 abort 收尾）、立即以这条消息开新回合（origin direct），任务照常完成；
 * - 外部 Agent 驱动能中断回合 → `handle.interrupt`（排着的消息一起，在前）；不能 → 排到运行结束（queuedNoInterrupt）；
 * - ProcessRunner：ACP 驱动 `session/cancel` 后紧接着开下一回合，`wait()` 跟到它结束；oneshot 不支持。
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { AgentCatalog } from "../agents/catalog.js";
import { AcpDriver } from "../drivers/acp/driver.js";
import { runFakeAcpAgent } from "../drivers/acp/testing/fake-agent.js";
import { DriverPool } from "../drivers/pool.js";
import { createProcessRunner } from "../drivers/runner.js";
import { memoryTransport } from "../drivers/test-support.js";
import { sessionDirForCwd } from "../session/store.js";
import type { SessionLine } from "../session/types.js";
import type {
  SubagentResult,
  SubagentRunRequest,
  SubagentRunner,
  ToolDefinition,
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

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function dir(): string {
  home = createTmpHome("ama-interrupt-sub-");
  return sessionDirForCwd(home.dataDir, home.cwd);
}

function childLines(file: string): SessionLine[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as SessionLine);
}

describe("ama 子 Agent：打断并发送", () => {
  it("运行中的长工具被中止，消息立即开新回合；工具结果配对完整，任务照常完成", async () => {
    let entered = false;
    const hang = stubTool({
      name: "hang",
      run: (_input, ctx) =>
        new Promise((resolve) => {
          entered = true;
          ctx.signal.addEventListener("abort", () => resolve({ content: "stopped" }), {
            once: true,
          });
        }),
    }) as ToolDefinition;
    const script = (call: ScriptCall): ScriptStep => {
      if (isChild(call)) {
        const users = userTexts(call.context);
        if (users.length === 1) return { toolCalls: [{ name: "hang", args: {} }] };
        return { text: `now: ${users.at(-1)}` };
      }
      if (lastIsToolResult(call)) return { text: "parent done" };
      return userTexts(call.context).at(-1) === "go"
        ? {
            toolCalls: [
              { name: "task", args: { prompt: "first", agent: "explore", background: true } },
            ],
          }
        : { text: "ok" };
    };
    const h = subagentHarness({ dir: dir(), extraTools: [hang], script });
    await h.session.prompt("go");
    const registry = registryOf(h.manager.id)!;
    await waitUntil(() => entered);
    expect(await registry.message("t1", "switch to plan B", true)).toBe("interrupted");
    await waitUntil(() => registry.get("t1")?.status === "completed");
    expect(registry.output("t1")).toBe("now: switch to plan B");
    const lines = childLines(registry.get("t1")!.sessionRef!.sessionFile!);
    const messages = lines.flatMap((l) => (l.type === "message" ? [l.message] : []));
    expect(
      messages.flatMap((m) =>
        m.role === "user" ? [{ content: m.content, origin: m.origin }] : [],
      ),
    ).toEqual([
      { content: "first", origin: undefined },
      { content: "switch to plan B", origin: "direct" },
    ]);
    const calls = messages.flatMap((m) =>
      m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall").map((b) => b.id) : [],
    );
    const results = messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : []));
    expect(results).toEqual(calls);
    // 主会话不受影响：只收到一条任务完成通知
    await waitUntil(
      () =>
        h.session.messages.filter(
          (m) => m.role === "user" && String(m.content).startsWith("<task-notification"),
        ).length === 1,
    );
    await h.session.dispose();
  });
});

/** 外部 runner：start 后挂起直到 finish；`interrupt` 可选。 */
function fakeExternal(withInterrupt: boolean) {
  const interrupts: string[] = [];
  const sent: string[] = [];
  let finish: (text: string) => void = () => undefined;
  const result = (text: string): SubagentResult => ({
    text,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop",
    isError: false,
  });
  const runner: SubagentRunner = {
    id: "codex",
    start: async (_request: SubagentRunRequest) => {
      let current = new Promise<SubagentResult>(
        (resolve) => (finish = (text) => resolve(result(text))),
      );
      return {
        id: "ext-1",
        send: async (text) => {
          sent.push(text);
          current = Promise.resolve(result(`reply ${text}`));
        },
        wait: () => current,
        stop: async () => finish("stopped"),
        ...(withInterrupt
          ? {
              interrupt: async (text: string) => {
                interrupts.push(text);
                finish(`interrupted with ${text}`);
                return true;
              },
            }
          : {}),
      };
    },
  };
  return { runner, interrupts, sent, finish: (text: string) => finish(text) };
}

function externalHarness(ext: ReturnType<typeof fakeExternal>) {
  const catalog = new AgentCatalog([agentDef("codex", { runner: "codex" })]);
  return subagentHarness({
    dir: dir(),
    env: { catalog, runners: () => ext.runner },
    script: (call) =>
      lastIsToolResult(call) || userTexts(call.context).at(-1) !== "go"
        ? { text: "parent done" }
        : {
            toolCalls: [{ name: "task", args: { prompt: "p", agent: "codex", background: true } }],
          },
  });
}

describe("外部 Agent：打断并发送", () => {
  it("驱动能中断：排着的消息在前、一起交给 handle.interrupt", async () => {
    const ext = fakeExternal(true);
    const h = externalHarness(ext);
    await h.session.prompt("go");
    const registry = registryOf(h.manager.id)!;
    await waitUntil(() => registry.live("t1")?.info.sessionRef !== undefined);
    expect(await registry.message("t1", "earlier note")).toBe("queued");
    expect(await registry.message("t1", "stop and do X", true)).toBe("interrupted");
    expect(ext.interrupts).toEqual(["earlier note\n\nstop and do X"]);
    expect(registry.live("t1")?.pending).toBe(0);
    await waitUntil(() => registry.get("t1")?.status === "completed");
    expect(ext.sent).toEqual([]);
    await h.session.dispose();
  });

  it("驱动不能中断：退回排队（queuedNoInterrupt），运行结束后照常续聊", async () => {
    const ext = fakeExternal(false);
    const h = externalHarness(ext);
    await h.session.prompt("go");
    const registry = registryOf(h.manager.id)!;
    await waitUntil(() => registry.live("t1")?.info.sessionRef !== undefined);
    expect(await registry.message("t1", "do X", true)).toBe("queuedNoInterrupt");
    expect(registry.live("t1")?.pending).toBe(1);
    ext.finish("done");
    await waitUntil(() => ext.sent.length === 1);
    expect(ext.sent).toEqual(["do X"]);
    await h.session.dispose();
  });
});

describe("ProcessRunner.interrupt", () => {
  const deps = {
    approve: async () => "allow" as const,
    pool: new DriverPool(3),
    env: { PATH: "/bin" },
    trusted: () => true,
  };
  const request = (prompt: string): SubagentRunRequest => ({
    prompt,
    cwd: "/work",
    mode: "default",
    signal: new AbortController().signal,
    onEvent: () => undefined,
  });

  it("ACP：session/cancel 中断当前回合，紧接着以新消息开下一回合；wait() 跟到它结束", async () => {
    const driver = new AcpDriver(
      "acp:fake",
      { kind: "acp", program: "fake", args: [] },
      {
        spawn: () => memoryTransport((i, o) => runFakeAcpAgent(i, o)).transport,
        cancelGraceMs: 50,
      },
    );
    const runner = createProcessRunner(driver, deps);
    const handle = await runner.start(request("work forever [slow]"));
    const waited = handle.wait();
    await new Promise((r) => setTimeout(r, 30));
    expect(await handle.interrupt!("do this instead")).toBe(true);
    const result = await waited;
    expect(result.text).toContain("do this instead");
    expect(result.status).toBe("completed");
    await handle.stop();
  });

  it("空闲或 oneshot：返回 false（调用方退回排队）", async () => {
    const driver = new AcpDriver(
      "acp:fake",
      { kind: "acp", program: "fake", args: [] },
      { spawn: () => memoryTransport((i, o) => runFakeAcpAgent(i, o)).transport },
    );
    const handle = await createProcessRunner(driver, deps).start(request("hi"));
    await handle.wait();
    expect(await handle.interrupt!("x")).toBe(false);
    await handle.stop();
    const oneshot = Object.assign(Object.create(Object.getPrototypeOf(driver)), driver, {
      kind: "oneshot",
    });
    const slow = await createProcessRunner(oneshot, { ...deps }).start(request("[slow]"));
    await new Promise((r) => setTimeout(r, 30));
    expect(await slow.interrupt!("x")).toBe(false);
    await slow.stop();
  });
});
