import { describe, expect, it } from "vitest";
import type { SubagentRequest, SubagentResult } from "./types.js";
import { makeToolContext } from "../../test/helpers/tool-context.js";
import { MAX_TASK_CONCURRENCY, Semaphore, createTaskTool } from "./task.js";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 };

function result(text: string, extra: Partial<SubagentResult> = {}): SubagentResult {
  return {
    text,
    usage,
    stopReason: "stop",
    isError: false,
    sessionFile: "/s/child.jsonl",
    ...extra,
  };
}

describe("task", () => {
  it("经 spawnSubagent 创建子 Agent，结果 = 最后助手文本 + details", async () => {
    const requests: SubagentRequest[] = [];
    const ctx = makeToolContext("/w", {
      spawnSubagent: async (req) => {
        requests.push(req);
        req.onUpdate?.("working");
        return result("child answer");
      },
    });
    const tool = createTaskTool();
    const r = await tool.execute(
      { prompt: "do it", description: "d", tools: ["read", "task", "bash"], thinkingLevel: "low" },
      ctx,
    );
    expect(r).toMatchObject({
      content: "child answer",
      isError: false,
      details: { sessionFile: "/s/child.jsonl", usage, stopReason: "stop" },
    });
    expect(requests[0]).toMatchObject({
      prompt: "do it",
      description: "d",
      tools: ["read", "bash"],
      thinkingLevel: "low",
      maxTurns: 30,
      parentToolCallId: "call_1",
    });
    expect(requests[0]?.signal).toBe(ctx.signal);
    expect(ctx.updates).toEqual(["working"]);
  });

  it("深度 ≥ 1 或无 spawnSubagent → 错误", async () => {
    const tool = createTaskTool();
    const spawn = async () => result("x");
    const deep = await tool.execute(
      { prompt: "x" },
      makeToolContext("/w", { depth: 1, spawnSubagent: spawn }),
    );
    expect(deep.isError).toBe(true);
    const none = await tool.execute({ prompt: "x" }, makeToolContext("/w"));
    expect(none.isError).toBe(true);
  });

  it("参数校验", async () => {
    const tool = createTaskTool();
    const ctx = makeToolContext("/w", { spawnSubagent: async () => result("x") });
    expect((await tool.execute({ prompt: "" }, ctx)).isError).toBe(true);
    expect((await tool.execute({ prompt: "a", maxTurns: 0 }, ctx)).isError).toBe(true);
    expect((await tool.execute({ prompt: "a", thinkingLevel: "max" as never }, ctx)).isError).toBe(
      true,
    );
  });

  it("并发 ≤ 4，超出排队", async () => {
    let running = 0;
    let peak = 0;
    const spawn = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return result("ok");
    };
    const tool = createTaskTool();
    const runs = Array.from({ length: 7 }, (_, i) =>
      tool.execute({ prompt: `p${i}` }, makeToolContext("/w", { spawnSubagent: spawn })),
    );
    const results = await Promise.all(runs);
    expect(results.every((r) => r.content === "ok")).toBe(true);
    expect(peak).toBe(MAX_TASK_CONCURRENCY);
  });

  it("父 abort 级联：排队中立即返回，运行中由子收到 signal", async () => {
    const tool = createTaskTool({ maxConcurrency: 1 });
    const first = makeToolContext("/w", {
      spawnSubagent: (req) =>
        new Promise((resolve) => {
          req.signal.addEventListener("abort", () =>
            resolve(result("partial", { stopReason: "aborted", isError: true })),
          );
        }),
    });
    const second = makeToolContext("/w", { spawnSubagent: async () => result("never") });
    const p1 = tool.execute({ prompt: "long" }, first);
    const p2 = tool.execute({ prompt: "queued" }, second);
    second.controller.abort();
    expect((await p2).content).toBe("aborted by user");
    first.controller.abort();
    const r1 = await p1;
    expect(r1.isError).toBe(true);
    expect(r1.content).toBe("aborted by user");
  });

  it("子 Agent 抛错 → 错误结果", async () => {
    const tool = createTaskTool();
    const ctx = makeToolContext("/w", {
      spawnSubagent: async () => {
        throw new Error("model down");
      },
    });
    const r = await tool.execute({ prompt: "x" }, ctx);
    expect(r).toMatchObject({ isError: true, content: "Sub-agent failed: model down" });
  });

  it("Semaphore 释放幂等", async () => {
    const s = new Semaphore(1);
    const release = await s.acquire(new AbortController().signal);
    release();
    release();
    expect(s.running).toBe(0);
  });
});
