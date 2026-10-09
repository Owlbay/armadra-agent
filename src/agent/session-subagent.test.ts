import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { AgentCatalog } from "../agents/catalog.js";
import { MAX_TURNS_NOTE, TASK_RESULT_LIMIT_BYTES } from "../agents/result.js";
import { sessionDirForCwd } from "../session/store.js";
import { PermissionPipeline } from "../permissions/pipeline.js";
import { FINAL_REPORT_PROMPT, readOnlyPermission } from "./session-subagent.js";
import {
  agentDef,
  firstUser,
  isChild,
  lastIsToolResult,
  parentTurn,
  sleepTool,
  subagentHarness,
} from "./testing/subagent-harness.js";
import type { SessionEvent } from "./types.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function dir(): string {
  home = createTmpHome("ama-w5g-");
  return sessionDirForCwd(home.dataDir, home.cwd);
}

const of = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

function toolResults(h: ReturnType<typeof subagentHarness>) {
  return h.session.messages.flatMap((m) => (m.role === "toolResult" ? [m] : []));
}

describe("只读类型（explore / plan）", () => {
  it("write 与非只读 bash 被拒，不弹审批；工具表仍与父相同", async () => {
    const asked: string[] = [];
    const h = subagentHarness({
      asked,
      script: (call) => {
        if (isChild(call)) {
          const done = call.context.messages.filter((m) => m.role === "toolResult").length;
          if (done === 0)
            return {
              toolCalls: [
                { name: "write", args: { path: "x" } },
                { name: "bash", args: { command: "rm -rf build" } },
                { name: "read", args: {} },
              ],
            };
          return { text: "explored" };
        }
        return parentTurn(call, [{ name: "task", args: { prompt: "look", agent: "explore" } }]);
      },
    });
    await h.session.prompt("go");
    const child = h.scripted.calls.filter(isChild);
    const results = child[1]!.context.messages.filter((m) => m.role === "toolResult");
    expect(results.map((r) => [r.toolName, r.isError])).toEqual([
      ["write", true],
      ["bash", true],
      ["read", false],
    ]);
    expect(asked).toEqual([]);
    const tools = (c: (typeof child)[number]) =>
      JSON.stringify((c.context.messages[0] as { toolsAdded?: unknown }).toolsAdded);
    expect(tools(child[0]!)).toBe(tools(h.scripted.calls[0]!));
    expect(tools(child[0]!)).toContain('"name":"task"');
    expect(toolResults(h)[0]).toMatchObject({ isError: false });
    expect(String(toolResults(h)[0]?.content)).toContain("explored");
  });

  it("general 继承父的模式（full-auto 下可写）", async () => {
    const h = subagentHarness({
      script: (call) =>
        isChild(call)
          ? lastIsToolResult(call)
            ? { text: "wrote" }
            : { toolCalls: [{ name: "write", args: {} }] }
          : parentTurn(call, [{ name: "task", args: { prompt: "edit" } }]),
    });
    await h.session.prompt("go");
    const child = h.scripted.calls.filter(isChild);
    expect(child[1]!.context.messages.at(-1)).toMatchObject({ toolName: "write", isError: false });
  });
});

describe("只读管线（readOnlyPermission）", () => {
  const check = (pipeline: ReturnType<typeof readOnlyPermission>, command: string) =>
    pipeline.check({
      toolName: "bash",
      permission: "execute",
      input: { command },
      unattended: false,
    }).decision;

  it("只读 bash 放行、其余拒绝；沿用父的 plan.bash（deny 更严）；ask 一律转 deny", () => {
    const parent = new PermissionPipeline({ mode: "full-auto", rules: [], cwd: "/w" });
    const ro = readOnlyPermission(parent, "/w");
    expect(ro.mode).toBe("plan");
    expect(check(ro, "ls")).toBe("allow");
    expect(check(ro, "rm -rf build")).toBe("deny");
    expect(
      ro.check({ toolName: "write", permission: "write", input: {}, unattended: false }).decision,
    ).toBe("deny");
    const strict = new PermissionPipeline({
      mode: "default",
      rules: [],
      cwd: "/w",
      planBash: "deny",
    });
    expect(check(readOnlyPermission(strict, "/w"), "ls")).toBe("deny");
    const asking = new PermissionPipeline({
      mode: "default",
      rules: [],
      cwd: "/w",
      planBash: "ask",
    });
    expect(check(readOnlyPermission(asking, "/w"), "make build")).toBe("deny");
    ro.setMode("full-auto");
    expect(ro.mode).toBe("plan");
  });
});

describe("父会话处于 plan（W5-F：plan 下放行 task，依赖子会话共用父的管线）", () => {
  it.each(["explore", "general"])("%s 子 Agent 写文件被拒、不弹审批", async (agent) => {
    const asked: string[] = [];
    const h = subagentHarness({
      mode: "plan",
      asked,
      script: (call) =>
        isChild(call)
          ? lastIsToolResult(call)
            ? { text: "tried" }
            : { toolCalls: [{ name: "write", args: { path: "x" } }] }
          : parentTurn(call, [{ name: "task", args: { prompt: "edit", agent } }]),
    });
    await h.session.prompt("go");
    const child = h.scripted.calls.filter(isChild);
    expect(child).toHaveLength(2);
    expect(child[1]!.context.messages.at(-1)).toMatchObject({ toolName: "write", isError: true });
    expect(asked).toEqual([]);
    expect(String(toolResults(h)[0]?.content)).toBe("[task t1] tried");
  });

  it("inherit 类型与父共用同一条管线对象（父切到 plan 后子会话随之只读）", async () => {
    const h = subagentHarness({
      script: (call) =>
        isChild(call)
          ? lastIsToolResult(call)
            ? { text: "tried" }
            : { toolCalls: [{ name: "write", args: {} }] }
          : parentTurn(call, [{ name: "task", args: { prompt: "edit" } }]),
    });
    h.session.setPermissionMode("plan");
    await h.session.prompt("go");
    const child = h.scripted.calls.filter(isChild);
    expect(child[1]!.context.messages.at(-1)).toMatchObject({ toolName: "write", isError: true });
  });
});

describe("同轮并行与并发上限", () => {
  const fanOut = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: "task", args: { prompt: `job ${i}` } }));

  it.each([
    [3, 3],
    [6, 4],
  ])("同一回复 %i 个 task：真并行，峰值 %i（池 4）", async (count, peak) => {
    const counter = { running: 0, peak: 0 };
    const h = subagentHarness({
      extraTools: [sleepTool(counter)],
      script: (call) =>
        isChild(call)
          ? lastIsToolResult(call)
            ? { text: `done ${firstUser(call)}` }
            : { toolCalls: [{ name: "sleep", args: {} }] }
          : parentTurn(call, fanOut(count)),
    });
    await h.session.prompt("go");
    expect(counter.peak).toBe(peak);
    expect(toolResults(h).map((r) => String(r.content))).toEqual(
      Array.from({ length: count }, (_, i) => `[task t${i + 1}] done job ${i}`),
    );
  });

  it("排队上限：超出 maxPending 直接报错（不要重试）", async () => {
    const counter = { running: 0, peak: 0 };
    const h = subagentHarness({
      env: { maxConcurrent: 1, maxPending: 1 },
      extraTools: [sleepTool(counter)],
      script: (call) =>
        isChild(call)
          ? lastIsToolResult(call)
            ? { text: "ok" }
            : { toolCalls: [{ name: "sleep", args: {} }] }
          : parentTurn(call, fanOut(3)),
    });
    await h.session.prompt("go");
    const contents = toolResults(h).map((r) => String(r.content));
    expect(contents.filter((c) => c.includes("Do not retry"))).toHaveLength(1);
  });
});

describe("结果上限、轮数耗尽、未知类型", () => {
  it("> 50 KB：头 70% + 尾 30%，全文写 outputs/", async () => {
    const big = `HEAD${"x".repeat(TASK_RESULT_LIMIT_BYTES)}TAIL`;
    const h = subagentHarness({
      dir: dir(),
      // 会话层通用截断（30 000 字符）在 task 自己的上限之后，这里放宽以便看到 task 的头尾
      maxToolResultChars: 200_000,
      script: (call) =>
        isChild(call) ? { text: big } : parentTurn(call, [{ name: "task", args: { prompt: "p" } }]),
    });
    await h.session.prompt("go");
    const result = toolResults(h)[0]!;
    const text = String(result.content);
    expect(text.startsWith("[task t1] HEAD")).toBe(true);
    expect(text.endsWith("TAIL")).toBe(true);
    expect(text).toMatch(/bytes omitted; full output: .*t1\.md/);
    const file = (result.details as { outputFile: string }).outputFile;
    expect(readFileSync(file, "utf8")).toBe(big);
    expect(file.startsWith(h.manager.directory()!)).toBe(true);
  });

  it("maxTurns 用尽且停在工具结果：收尾一轮只靠提示要报告（不发 toolChoice，ME-A D13），状态 max_turns", async () => {
    const h = subagentHarness({
      script: (call) => {
        if (!isChild(call))
          return parentTurn(call, [{ name: "task", args: { prompt: "p", maxTurns: 2 } }]);
        if (userTexts(call).includes(FINAL_REPORT_PROMPT)) return { text: "final report" };
        return { toolCalls: [{ name: "read", args: {} }] };
      },
    });
    await h.session.prompt("go");
    const child = h.scripted.calls.filter(isChild);
    expect(child).toHaveLength(3);
    // P2-5：收尾一轮的请求选项与前面相同（toolChoice 会让请求换一套参数、缓存前缀失效）
    expect(child.map((c) => c.options.toolChoice)).toEqual([undefined, undefined, undefined]);
    const result = toolResults(h)[0]!;
    expect(String(result.content)).toBe(`[task t1] ${MAX_TURNS_NOTE}\n\nfinal report`);
    expect(result.details).toMatchObject({ status: "max_turns" });
    expect(of(h.events, "subagent_end")[0]).toMatchObject({ status: "max_turns" });
  });

  it("收尾一轮仍调用工具：maxTurns 1 结束，结果回落为「没有文本」，状态 max_turns", async () => {
    const h = subagentHarness({
      script: (call) =>
        isChild(call)
          ? { toolCalls: [{ name: "read", args: {} }] }
          : parentTurn(call, [{ name: "task", args: { prompt: "p", maxTurns: 1 } }]),
    });
    await h.session.prompt("go");
    const child = h.scripted.calls.filter(isChild);
    expect(child).toHaveLength(2);
    expect(userTexts(child[1]!)).toContain(FINAL_REPORT_PROMPT);
    const result = toolResults(h)[0]!;
    expect(String(result.content)).toBe(
      `[task t1] ${MAX_TURNS_NOTE}\n\n(the sub-agent returned no text)`,
    );
    expect(result.details).toMatchObject({ status: "max_turns" });
  });

  it("未知类型 → 错误并列出可用类型；类型的 max-turns / role 生效", async () => {
    const h = subagentHarness({
      env: { catalog: new AgentCatalog([agentDef("reviewer", { maxTurns: 1 })]) },
      script: (call) => {
        if (isChild(call)) {
          const role = (call.context.messages[0] as { sections: Record<string, string> }).sections[
            "role"
          ];
          return lastIsToolResult(call) || userTexts(call).includes(FINAL_REPORT_PROMPT)
            ? { text: role ?? "" }
            : { toolCalls: [{ name: "read", args: {} }] };
        }
        return parentTurn(call, [
          { name: "task", args: { prompt: "a", agent: "nope" } },
          { name: "task", args: { prompt: "b", agent: "reviewer" } },
        ]);
      },
    });
    await h.session.prompt("go");
    const [unknown, reviewer] = toolResults(h).map((r) => String(r.content));
    expect(unknown).toMatch(/Unknown agent "nope"\. Available: general, explore, plan, reviewer/);
    expect(reviewer).toContain(MAX_TURNS_NOTE);
    expect(reviewer).toContain("reviewer role");
  });
});

describe("事件与子会话文件", () => {
  it("subagent_start / update / end；子会话 JSONL 首条 ama.task 带 taskId", async () => {
    const h = subagentHarness({
      dir: dir(),
      script: (call) =>
        isChild(call)
          ? lastIsToolResult(call)
            ? { text: "child text" }
            : { toolCalls: [{ name: "read", args: {} }] }
          : parentTurn(call, [{ name: "task", args: { prompt: "p", description: "look around" } }]),
    });
    await h.session.prompt("go");
    const start = of(h.events, "subagent_start")[0]!;
    expect(start).toMatchObject({
      taskId: "t1",
      agent: "general",
      runner: "ama",
      description: "look around",
      background: false,
      model: "fake/echo",
      cwd: "/work",
    });
    expect(existsSync(start.sessionFile!)).toBe(true);
    const updates = of(h.events, "subagent_update");
    expect(updates.map((u) => u.kind)).toEqual(["tool", "turn", "text", "turn"]);
    expect(updates.find((u) => u.kind === "text")?.textDelta).toBe("child text");
    expect(of(h.events, "subagent_end")[0]).toMatchObject({ taskId: "t1", status: "completed" });
    const lines = readFileSync(start.sessionFile!, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[1]).toMatchObject({
      customType: "ama.task",
      data: { taskId: "t1", agent: "general" },
    });
    const records = h.manager
      .entries()
      .filter((e) => e.type === "custom" && e.customType === "ama.task")
      .map((e) => (e.type === "custom" ? (e.data as { status: string }).status : ""));
    expect(records).toEqual(["running", "completed"]);
    expect(h.session.getStats().tasks).toEqual({
      total: 1,
      running: 0,
      byStatus: { completed: 1 },
    });
  });
});

function userTexts(call: Parameters<typeof firstUser>[0]): string[] {
  return call.context.messages.flatMap((m) =>
    m.role === "user" && typeof m.content === "string" ? [m.content] : [],
  );
}
