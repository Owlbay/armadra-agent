import { describe, expect, it } from "vitest";
import type { SubagentRequest, SubagentResult } from "./types.js";
import { makeToolContext } from "../../test/helpers/tool-context.js";
import { DEFAULT_SUBAGENT_CONCURRENCY, SubagentPool } from "../agent/session-subagent.js";
import { AgentCatalog } from "../agents/catalog.js";
import { bindTaskAgents, createTaskTool } from "./task.js";

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
      parentToolCallId: "call_1",
    });
    expect(requests[0]?.maxTurns).toBeUndefined(); // 缺省取类型的 max-turns（注册表）
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

  it("并发 ≤ 4 由会话的 SubagentPool 排队（task 不再自带信号量）", async () => {
    const pool = new SubagentPool(DEFAULT_SUBAGENT_CONCURRENCY);
    let running = 0;
    let peak = 0;
    const spawn = async (req: SubagentRequest) => {
      await pool.acquire(req.signal);
      try {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return result("ok");
      } finally {
        pool.release();
      }
    };
    const tool = createTaskTool();
    const runs = Array.from({ length: 7 }, (_, i) =>
      tool.execute({ prompt: `p${i}` }, makeToolContext("/w", { spawnSubagent: spawn })),
    );
    const results = await Promise.all(runs);
    expect(results.every((r) => r.content === "ok")).toBe(true);
    expect(peak).toBe(DEFAULT_SUBAGENT_CONCURRENCY);
  });

  it("父 abort：已中止不再起子会话；排队中被中止、运行中由子收到 signal，都返回 aborted", async () => {
    const pool = new SubagentPool(1);
    const spawn = async (req: SubagentRequest): Promise<SubagentResult> => {
      await pool.acquire(req.signal);
      try {
        // 与 runSubagent 相同：拿到名额后先看是否已中止
        if (req.signal.aborted) throw new Error("aborted");
        return await new Promise((resolve) => {
          req.signal.addEventListener("abort", () =>
            resolve(result("partial", { stopReason: "aborted", isError: true })),
          );
        });
      } finally {
        pool.release();
      }
    };
    const tool = createTaskTool();
    const first = makeToolContext("/w", { spawnSubagent: spawn });
    const second = makeToolContext("/w", { spawnSubagent: spawn });
    const p1 = tool.execute({ prompt: "long" }, first);
    const p2 = tool.execute({ prompt: "queued" }, second);
    second.controller.abort();
    first.controller.abort();
    expect((await p1).content).toBe("aborted by user");
    expect((await p2).content).toBe("aborted by user");
    let spawned = false;
    const done = makeToolContext("/w", {
      spawnSubagent: async () => ((spawned = true), result("x")),
    });
    done.controller.abort();
    expect((await tool.execute({ prompt: "x" }, done)).content).toBe("aborted by user");
    expect(spawned).toBe(false);
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

  it("[W5-G] 新参数透传；taskId 续聊忽略 agent / tools / model；后台结果带 taskId 前缀", async () => {
    const requests: SubagentRequest[] = [];
    const spawn = async (req: SubagentRequest) => {
      requests.push(req);
      return result(req.background === true ? "Started background task t1" : "report", {
        taskId: "t1",
        status: req.background === true ? "running" : "completed",
        outputFile: "/o/t1.md",
      });
    };
    const tool = createTaskTool();
    const ctx = makeToolContext("/w", { spawnSubagent: spawn });
    const started = await tool.execute(
      {
        prompt: "look",
        agent: "explore",
        background: true,
        isolation: "worktree",
        budgetUsd: 1,
        maxTurns: 5,
      },
      ctx,
    );
    expect(requests[0]).toMatchObject({
      agent: "explore",
      background: true,
      isolation: "worktree",
      budgetUsd: 1,
      maxTurns: 5,
    });
    expect(started).toMatchObject({
      content: "[task t1] Started background task t1",
      isError: false,
      details: { taskId: "t1", status: "running", outputFile: "/o/t1.md" },
    });
    await tool.execute(
      { prompt: "more", taskId: "t1", agent: "plan", tools: ["read"], model: "x/y" },
      ctx,
    );
    expect(requests[1]).toMatchObject({ prompt: "more", taskId: "t1" });
    expect(requests[1]?.agent).toBeUndefined();
    expect(requests[1]?.tools).toBeUndefined();
    expect(requests[1]?.model).toBeUndefined();
    const bad = await tool.execute({ prompt: "x", isolation: "docker" as never }, ctx);
    expect(bad.isError).toBe(true);
  });

  it("[W5-G] parallel；描述列出绑定的类型目录；rules 说明 task-notification 不是用户发言", () => {
    const tool = createTaskTool();
    expect(tool.executionMode).toBe("parallel");
    expect(tool.description).toContain("- explore: Read-only search");
    expect(tool.promptGuidelines?.join()).toContain("<task-notification>");
    bindTaskAgents(
      tool,
      new AgentCatalog([
        {
          name: "reviewer",
          description: "Reviews diffs",
          permissionMode: "plan",
          model: "inherit",
          maxTurns: 30,
          isolation: "none",
          background: false,
          runner: "ama",
          prompt: "",
          source: "user",
        },
      ]),
    );
    expect(tool.description).toContain("- reviewer: Reviews diffs");
  });
});
