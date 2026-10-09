import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDecision, ApprovalRequest } from "../permissions/types.js";
import type { SubagentEvent, SubagentRunRequest } from "../tools/types.js";
import { AcpDriver } from "./acp/driver.js";
import { runFakeAcpAgent } from "./acp/testing/fake-agent.js";
import { ExternalAgents } from "./agents.js";
import { DriverPool } from "./pool.js";
import { claudeArgs } from "./native/claude-stream.js";
import { codexPolicy } from "./native/codex-normalize.js";
import { oneshotArgs } from "./native/oneshot.js";
import { clampMode } from "./permissions.js";
import { createProcessRunner, type ProcessRunnerDeps } from "./runner.js";
import { AGENT_SESSION_CUSTOM, AGENT_USAGE_CUSTOM, createAgentStore } from "./store.js";
import { memoryTransport, spawnRecorder } from "./test-support.js";
import type { AgentDriver, DriverCapabilities } from "./types.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function setup(
  approve: ProcessRunnerDeps["approve"] = async () => "allow",
  extra: Partial<ProcessRunnerDeps> = {},
) {
  const rec = spawnRecorder(() => memoryTransport((i, o) => runFakeAcpAgent(i, o)));
  const driver = new AcpDriver(
    "acp:fake",
    { kind: "acp", program: "fake", args: [] },
    {
      spawn: rec.spawn,
      cancelGraceMs: 50,
    },
  );
  const customs: { type: string; data: unknown }[] = [];
  const store = createAgentStore({ appendCustom: (type, data) => customs.push({ type, data }) });
  const asked: ApprovalRequest[] = [];
  const runner = createProcessRunner(driver, {
    approve: async (req, signal) => {
      asked.push(req);
      return approve(req, signal);
    },
    pool: new DriverPool(3),
    store,
    env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-secret" },
    trusted: () => true,
    ...extra,
  });
  return { rec, runner, customs, asked, store };
}

function request(prompt: string, extra: Partial<SubagentRunRequest> = {}) {
  const events: SubagentEvent[] = [];
  const req: SubagentRunRequest = {
    prompt,
    cwd: "/work",
    mode: "default",
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    ...extra,
  };
  return { req, events };
}

describe("ProcessRunner × 假 ACP Agent", () => {
  it("允许：审批带 origin 交给 approve（不经分类器），结果含摘要，记会话与用量；子进程环境已清理", async () => {
    const { runner, rec, customs, asked } = setup(async () => "allow");
    const { req, events } = request("[permission] write");
    const handle = await runner.start(req);
    cleanups.push(() => handle.stop());
    const result = await handle.wait();
    expect(result).toMatchObject({
      status: "completed",
      isError: false,
      stopReason: "end_turn",
      sessionRef: { runner: "acp:fake", sessionId: "fake-1" },
    });
    expect(result.text).toContain("wrote note.txt");
    expect(result.text).toContain("✓ edit Write note.txt");
    expect(result.text).toContain("/work/note.txt");
    expect(asked[0]).toMatchObject({
      toolName: "agent:acp:fake",
      reason: "mode",
      context: {
        depth: 1,
        origin: {
          agent: "acp:fake",
          sessionId: "fake-1",
          toolCall: { title: "Write note.txt", kind: "edit" },
        },
      },
    });
    expect(customs.map((c) => c.type)).toEqual([AGENT_SESSION_CUSTOM, AGENT_USAGE_CUSTOM]);
    expect(customs[1]!.data).toMatchObject({
      agent: "acp:fake",
      unit: "tokens",
      amount: 15,
      contextTokens: 15,
      contextWindow: 1000,
    });
    expect(rec.specs[0]!.env).toEqual({ PATH: "/bin" });
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["turn", "tool", "text", "usage"]),
    );
  });

  it("拒绝 → reject_once", async () => {
    const { runner } = setup(async () => "deny");
    const handle = await runner.start(request("[permission]").req);
    cleanups.push(() => handle.stop());
    expect((await handle.wait()).text).toContain("write rejected");
  });

  it("无人值守：不询问，直接 reject_once", async () => {
    const { runner, asked } = setup(async () => "allow", { unattended: true });
    const handle = await runner.start(request("[permission]").req);
    cleanups.push(() => handle.stop());
    expect((await handle.wait()).text).toContain("write rejected");
    expect(asked).toEqual([]);
  });

  it("父 abort：挂起的审批 signal 被取消、回 cancelled，任务 aborted", async () => {
    const controller = new AbortController();
    let approvalSignal: AbortSignal | undefined;
    const { runner } = setup(
      (_req, signal) =>
        new Promise<ApprovalDecision>((resolve) => {
          approvalSignal = signal;
          signal.addEventListener("abort", () => resolve("deny"));
          controller.abort();
        }),
    );
    const handle = await runner.start(request("[permission]", { signal: controller.signal }).req);
    const result = await handle.wait();
    expect(approvalSignal?.aborted).toBe(true);
    expect(result.status).toBe("aborted");
  });

  it("未信任目录拒绝启动", async () => {
    const { runner } = setup(async () => "allow", { trusted: () => false });
    await expect(runner.start(request("hi").req)).rejects.toMatchObject({
      code: "agent_untrusted",
    });
  });

  it("模式不得比父会话宽：auto → plan（set_mode plan）并提示", async () => {
    const { runner, rec } = setup(async () => "allow", { parentMode: () => "plan" });
    const { req, events } = request("hi", { mode: "auto" });
    const handle = await runner.start(req);
    cleanups.push(() => handle.stop());
    await handle.wait();
    expect(rec.last()!.wire.find((w) => w.msg["method"] === "session/set_mode")?.msg).toMatchObject(
      {
        params: { modeId: "plan" },
      },
    );
    expect(events[0]).toMatchObject({ type: "notice", text: expect.stringContaining("plan") });
  });

  it("maxMode 显式放宽：父 plan、maxMode default → default", async () => {
    const { runner, rec } = setup(async () => "allow", {
      parentMode: () => "plan",
      config: { "acp:fake": { maxMode: "default" } },
    });
    const handle = await runner.start(request("hi", { mode: "default" }).req);
    cleanups.push(() => handle.stop());
    await handle.wait();
    expect(rec.last()!.wire.some((w) => w.msg["method"] === "session/set_mode")).toBe(false);
  });

  it("外部 Agent 的上下文：回合中途变化时单独发一条只带占用与窗口的 usage，同值不重发；回合记账带上下文", async () => {
    const { runner, customs } = setup();
    const { req, events } = request("one");
    const handle = await runner.start(req);
    cleanups.push(() => handle.stop());
    await handle.send("two");
    await handle.wait();
    const context = events.filter((e) => e.type === "usage" && e.usage === undefined);
    expect(context).toEqual([
      { type: "usage", contextTokens: 15, contextWindow: 1000 },
      { type: "usage", contextTokens: 25, contextWindow: 1000 },
    ]);
    const usage = customs.filter((c) => c.type === AGENT_USAGE_CUSTOM).map((c) => c.data);
    expect(usage).toEqual([
      expect.objectContaining({ contextTokens: 15, contextWindow: 1000 }),
      expect.objectContaining({ contextTokens: 25, contextWindow: 1000 }),
    ]);
  });

  it("send 续聊同一会话；wait 拿最后一回合", async () => {
    const { runner } = setup();
    const handle = await runner.start(request("one").req);
    cleanups.push(() => handle.stop());
    await handle.send("two");
    const result = await handle.wait();
    expect(result.text).toBe("echo: two");
    expect(handle.id).toBe("fake-1");
  });

  it("超时：中断并以 failed 结束", async () => {
    const { runner } = setup(async () => "allow", { timeoutMs: 20 });
    const { req, events } = request("[slow]");
    const handle = await runner.start(req);
    cleanups.push(() => handle.stop());
    const result = await handle.wait();
    expect(result).toMatchObject({ status: "failed", stopReason: "timeout", isError: true });
    expect(events.some((e) => e.type === "notice" && e.text.includes("超时"))).toBe(true);
  });

  it("美元预算：单次超限中断；会话预算用尽不再启动", async () => {
    const { runner, store } = setup(async () => "allow", { config: { sessionBudgetUsd: 0.0015 } });
    const { req, events } = request("hi", { budgetUsd: 0.0005 });
    const handle = await runner.start(req);
    cleanups.push(() => handle.stop());
    await handle.wait();
    expect(events.some((e) => e.type === "notice" && e.text.includes("预算"))).toBe(true);
    store.recordUsage({ agent: "acp:fake", sessionId: "x", unit: "usd", amount: 0.002 });
    await expect(runner.start(request("again").req)).rejects.toMatchObject({
      code: "budget_exhausted",
    });
  });

  it("空闲关进程，之后 send 以 session/resume 重开", async () => {
    const { runner, rec } = setup(async () => "allow", { idleMs: 10 });
    const handle = await runner.start(request("one").req);
    cleanups.push(() => handle.stop());
    await handle.wait();
    await new Promise((r) => setTimeout(r, 40));
    await handle.send("two");
    const result = await handle.wait();
    expect(result.text).toBe("echo: two");
    expect(rec.specs).toHaveLength(2);
    expect(rec.last()!.wire.some((w) => w.msg["method"] === "session/resume")).toBe(true);
  });
});

function stub(
  kind: AgentDriver["kind"],
  installed: boolean,
  modes: DriverCapabilities["modes"],
): AgentDriver {
  return {
    agentId: "x",
    kind,
    probe: async () => ({
      installed,
      capabilities: {
        resume: "none",
        list: false,
        permissions: "none",
        steer: false,
        modes,
        usage: "none",
        images: false,
      },
    }),
    open: async () => {
      throw Object.assign(new Error(`opened ${kind}`), { code: kind });
    },
  };
}

describe("驱动选择（候选链）", () => {
  const deps = {
    approve: async () => "deny" as const,
    pool: new DriverPool(),
    env: {},
    trusted: () => true,
  };

  it("跳过未安装的；oneshot 只在只读模式下被选中", async () => {
    const runner = createProcessRunner(
      [stub("claude-stream", false, ["plan", "default"]), stub("oneshot", true, ["plan"])],
      deps,
    );
    await expect(runner.start(request("x", { mode: "plan" }).req)).rejects.toThrow(
      "opened oneshot",
    );
    await expect(runner.start(request("x", { mode: "default" }).req)).rejects.toThrow(
      "opened oneshot",
    );
    const none = createProcessRunner([stub("claude-stream", false, ["plan"])], deps);
    await expect(none.start(request("x").req)).rejects.toMatchObject({ code: "agent_unavailable" });
  });
});

describe("ExternalAgents", () => {
  const base = {
    env: {},
    cwd: "/work",
    approve: async () => "deny" as const,
    trusted: () => true,
    driverDeps: { spawn: () => memoryTransport((i, o) => runFakeAcpAgent(i, o)).transport },
  };

  it("有宿主：内置外部 runner 不可用，只认宿主注入的", () => {
    const agents = new ExternalAgents({ ...base, hosted: true });
    // [W6-I3] 进 task 结果（模型可见）的错误固定英文
    expect(() => agents.resolve("claude")).toThrow(/come from the host/);
    const runner = { id: "claude", description: "canvas node", start: async () => ({}) as never };
    const off = agents.hostRunners.provide(runner);
    expect(agents.resolve("claude")).toBe(runner);
    off();
    // [W6-I3] 进 task 结果（模型可见）的错误固定英文
    expect(() => agents.resolve("claude")).toThrow(/come from the host/);
  });

  it("独立：claude / codex / acp:<program> 解析为 ProcessRunner；未知报错；同 spec 复用", () => {
    const agents = new ExternalAgents({ ...base, hosted: false });
    const claude = agents.resolve("claude");
    expect(claude.id).toBe("claude");
    expect(agents.resolve("claude")).toBe(claude);
    expect(agents.resolve("acp:my-agent").id).toBe("acp:my-agent");
    expect(() => agents.resolve("nope")).toThrow(/unknown external agent/);
  });

  it("list：宿主 runner + 表里的 Agent（探测安装）", async () => {
    const agents = new ExternalAgents({ ...base, hosted: false });
    agents.hostRunners.provide({
      id: "canvas",
      description: "画布节点",
      start: async () => ({}) as never,
    });
    const list = await agents.list();
    expect(list[0]).toEqual({
      name: "canvas",
      description: "画布节点",
      runner: "canvas",
      source: "host",
    });
    expect(list.map((a) => a.name)).toEqual(
      expect.arrayContaining(["claude", "codex", "gemini", "ama"]),
    );
  });
});

describe("父会话 plan / allowlist 时外部 Agent 只能只读（真值表）", () => {
  const MODES = ["plan", "allowlist", "default", "auto-edit", "auto", "full-auto"] as const;
  // [父模式, 请求模式] → 实际模式（maxMode 未设）
  const TABLE: [(typeof MODES)[number], (typeof MODES)[number], (typeof MODES)[number]][] = [];
  for (const parent of MODES)
    for (const requested of MODES) {
      const order = (m: string) => MODES.indexOf(m as (typeof MODES)[number]);
      const strict = order(requested) <= order(parent) ? requested : parent;
      TABLE.push([parent, requested, strict === "allowlist" ? "plan" : strict]);
    }

  it.each(TABLE)("父 %s，请求 %s → %s", (parent, requested, expected) => {
    expect(clampMode(requested, parent, undefined)).toBe(expected);
    if (parent === "plan" || parent === "allowlist") expect(expected).toBe("plan");
  });

  it.each(["plan", "allowlist"] as const)("父 %s：各驱动的只读启动参数", (parent) => {
    const mode = clampMode("full-auto", parent, undefined);
    const claude = claudeArgs({ mode }, "s");
    expect(claude[claude.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(codexPolicy(mode, false)).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
    expect(oneshotArgs("claude", {}, { id: "s", resume: false }, "p")).toEqual(
      expect.arrayContaining(["--permission-mode", "plan"]),
    );
    expect(oneshotArgs("codex", {}, { id: "s", resume: false }, "p")).toContain(
      'sandbox_mode="read-only"',
    );
  });

  it.each(["plan", "allowlist"] as const)(
    "父 %s：ACP 选只读模式；没有只读模式的 Agent 拒绝启动",
    async (parent) => {
      const { runner, rec } = setup(async () => "allow", { parentMode: () => parent });
      const handle = await runner.start(request("hi", { mode: "auto" }).req);
      cleanups.push(() => handle.stop());
      await handle.wait();
      expect(
        rec.last()!.wire.find((w) => w.msg["method"] === "session/set_mode")?.msg,
      ).toMatchObject({
        params: { modeId: "plan" },
      });

      const minimal = spawnRecorder(() =>
        memoryTransport((i, o) => runFakeAcpAgent(i, o, { minimal: true })),
      );
      const strict = createProcessRunner(
        new AcpDriver(
          "acp:min",
          { kind: "acp", program: "min", args: [] },
          { spawn: minimal.spawn },
        ),
        {
          approve: async () => "allow",
          pool: new DriverPool(),
          env: {},
          trusted: () => true,
          parentMode: () => parent,
        },
      );
      await expect(strict.start(request("hi", { mode: "default" }).req)).rejects.toMatchObject({
        code: "agent_mode_unsupported",
      });
    },
  );

  it("maxMode 只放宽到它自己（用户级显式配置）", () => {
    expect(clampMode("auto", "plan", "default")).toBe("default");
    expect(clampMode("auto", "default", "plan")).toBe("plan");
  });
});
