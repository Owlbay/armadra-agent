import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeHarness,
  recordingHost,
  type ComposeHarness,
} from "../../test/helpers/compose-harness.js";
import type { HostApi } from "../host/types.js";
import type { ApprovalRequest } from "../permissions/types.js";
import type { AgentSessionImpl } from "../agent/session.js";
import {
  cacheSettingsFrom,
  currentSession,
  idleTimeoutFrom,
  switchSession,
} from "./compose-session.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

const bashCall = (command: string) => ({
  steps: [{ toolCall: { name: "bash", arguments: { command } } }],
});

function toolResults(messages: readonly { role: string }[]) {
  return messages.filter((m) => m.role === "toolResult") as { isError?: boolean }[];
}

function hostApi(): HostApi {
  return (globalThis as Record<string, unknown>)["__amaHostEventsApi"] as HostApi;
}

describe("composeSession：审批链", () => {
  it("宿主 setBroker 在会话创建之后调用也生效", async () => {
    h = composeHarness([bashCall("echo hi"), { text: "done" }]);
    const host = recordingHost(h.home);
    const runtime = await h.boot(["--model", "fake/echo", "--host", host.path]);
    const asked: ApprovalRequest[] = [];
    hostApi().approvals.setBroker({ ask: async (r) => (asked.push(r), "allow") });
    await runtime.session.prompt("go");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.toolName).toBe("bash");
    expect(toolResults(runtime.session.messages)[0]?.isError).not.toBe(true);
    const names = host.events().map((e) => e.name);
    expect(names).toContain("tool_approval_requested");
    expect(names).toContain("tool_approval_resolved");
    expect(names).toContain("tool_call");
    await runtime.dispose();
  });

  it("宿主弃权后走 setUiBroker 设置的 UI；撤下后无人作答 → deny", async () => {
    h = composeHarness([bashCall("echo a"), { text: "1" }, bashCall("echo b"), { text: "2" }]);
    const runtime = await h.boot(["--model", "fake/echo"]);
    const seen: string[] = [];
    runtime.approvals.setUiBroker({ ask: async (r) => (seen.push(r.toolName), "deny") });
    await runtime.session.prompt("first");
    expect(seen).toEqual(["bash"]);
    expect(toolResults(runtime.session.messages)[0]?.isError).toBe(true);
    runtime.approvals.setUiBroker(undefined);
    await runtime.session.prompt("second");
    expect(seen).toHaveLength(1);
    expect(toolResults(runtime.session.messages)[1]?.isError).toBe(true);
    await runtime.dispose();
  });
});

describe("switchSession", () => {
  it("new：旧会话 dispose，HostApi.session.id() 与 currentSession 跟随新会话", async () => {
    h = composeHarness();
    const host = recordingHost(h.home);
    const runtime = await h.boot(["--model", "fake/echo", "--host", host.path]);
    await runtime.session.prompt("one");
    const firstId = hostApi().session.id();
    const next = await switchSession(runtime, { kind: "new" });
    expect(currentSession(runtime)).toBe(next);
    expect(hostApi().session.id()).toBe(next.state.sessionId);
    expect(next.state.sessionId).not.toBe(firstId);
    await expect(runtime.session.prompt("x")).rejects.toMatchObject({ code: "session_closed" });
    await next.prompt("two");
    expect(next.getLastAssistantText()).toBe("two");
    const starts = host.events().filter((e) => e.name === "session_start");
    expect(starts.map((e) => (e.event as { reason: string }).reason)).toEqual(["startup", "new"]);
    await runtime.dispose();
  });

  it("resume / fork 回到已落盘的会话", async () => {
    h = composeHarness();
    const runtime = await h.boot(["--model", "fake/echo"]);
    await runtime.session.prompt("keep me");
    const file = runtime.session.state.sessionFile as string;
    const id = runtime.session.state.sessionId;
    const fresh = await switchSession(runtime, { kind: "new" });
    expect(fresh.messages).toHaveLength(0);
    const resumed = await switchSession(runtime, { kind: "resume", id: id.slice(0, 8) });
    expect(resumed.state.sessionFile).toBe(file);
    expect(resumed.getLastAssistantText()).toBe("keep me");
    const leaf = resumed.entries.at(-1)?.id as string;
    const forked = await switchSession(runtime, { kind: "fork", entryId: leaf });
    expect(forked.state.sessionFile).not.toBe(file);
    expect(forked.getLastAssistantText()).toBe("keep me");
    await runtime.dispose();
  });
});

describe("启动期预检", () => {
  it("模型的协议没有实现 → 退出 4，提示协议名", async () => {
    h = composeHarness();
    h.home.write("home/.config/ama/config.json", {
      version: 1,
      providers: {
        future: {
          api: "future-api",
          baseUrl: "http://127.0.0.1:9",
          requiresApiKey: false,
          models: [{ id: "m1" }],
        },
      },
    });
    expect(await h.run(["-p", "--model", "future/m1", "hi"])).toBe(4);
    expect(h.stderr()).toContain("协议 future-api 尚未实现");
  });
});

describe("缓存设置与事件桥接（第三波 §1.10 / §1.12）", () => {
  it("cacheSettingsFrom：config cache 段 + AMA_CACHE_WARMING / AMA_CACHE_RETENTION 覆盖，非法值 warning", () => {
    const warnings: string[] = [];
    const config = { cache: { warming: "off" as const, minSavingsUsd: 0.2 } };
    expect(cacheSettingsFrom(config, {})).toEqual({ warming: "off", minSavingsUsd: 0.2 });
    expect(
      cacheSettingsFrom(config, { AMA_CACHE_WARMING: "idle", AMA_CACHE_RETENTION: "long" }),
    ).toEqual({ warming: "idle", retention: "long", minSavingsUsd: 0.2 });
    expect(
      cacheSettingsFrom({}, { AMA_CACHE_WARMING: "always", AMA_CACHE_RETENTION: "1h" }, (m) =>
        warnings.push(m),
      ),
    ).toEqual({});
    expect(warnings).toHaveLength(2);
  });

  it("组装的会话读 cache 配置与环境变量；宿主 onWarmingDecision 现取；cache_miss / context_pressure 桥接到宿主总线", async () => {
    vi.stubEnv("AMA_CACHE_WARMING", "idle");
    try {
      h = composeHarness([{ text: "ok" }]);
      h.home.write(
        "home/.config/ama/config.json",
        JSON.stringify({ version: 1, cache: { retention: "long", warmSubagents: true } }),
      );
      const host = recordingHost(h.home);
      const runtime = await h.boot(["--model", "fake/echo", "--host", host.path]);
      const session = runtime.session as AgentSessionImpl;
      expect(session.cache.cacheSettings).toMatchObject({
        warming: "idle",
        retention: "long",
        warmSubagents: true,
      });
      expect(session.options.warmingDecider?.()).toBeUndefined();
      const handler = () => "stop" as const;
      const off = hostApi().cache?.onWarmingDecision(handler);
      expect(session.options.warmingDecider?.()).toBe(handler);
      off?.();
      expect(session.options.warmingDecider?.()).toBeUndefined();
      const seen: { name: string; event: unknown }[] = [];
      hostApi().events.on("cache_miss", (event) => void seen.push({ name: "cache_miss", event }));
      hostApi().events.on(
        "context_pressure",
        (event) => void seen.push({ name: "context_pressure", event }),
      );
      session.emit({ type: "cache_miss", missedTokens: 5000, reason: "idle", idleMs: 400_000 });
      session.emit({ type: "context_pressure", percent: 72, threshold: 70 });
      await new Promise((resolve) => setImmediate(resolve));
      expect(seen).toEqual([
        { name: "cache_miss", event: { missedTokens: 5000, reason: "idle", idleMs: 400_000 } },
        { name: "context_pressure", event: { percent: 72, threshold: 70 } },
      ]);
      await runtime.session.prompt("hi");
      expect(h.fake.calls[0]?.options).toMatchObject({ cacheRetention: "long" });
      await runtime.dispose();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("请求空闲超时（W4-C）", () => {
  it("idleTimeoutFrom：AMA_IDLE_TIMEOUT_MS > request.idleTimeoutMs；非法值 warning 后回落", () => {
    const warnings: string[] = [];
    const config = { request: { idleTimeoutMs: 90_000 } };
    expect(idleTimeoutFrom({}, {})).toBeUndefined();
    expect(idleTimeoutFrom(config, {})).toBe(90_000);
    expect(idleTimeoutFrom(config, { AMA_IDLE_TIMEOUT_MS: "0" })).toBe(0);
    expect(idleTimeoutFrom(config, { AMA_IDLE_TIMEOUT_MS: "abc" }, (m) => warnings.push(m))).toBe(
      90_000,
    );
    expect(warnings[0]).toContain("AMA_IDLE_TIMEOUT_MS=abc");
  });

  it("配置的空闲超时随每次请求的 StreamOptions 下发", async () => {
    h = composeHarness([{ text: "ok" }]);
    h.home.write(
      "home/.config/ama/config.json",
      JSON.stringify({ version: 1, request: { idleTimeoutMs: 45_000 } }),
    );
    const runtime = await h.boot(["--model", "fake/echo"]);
    await runtime.session.prompt("hi");
    expect(h.fake.calls[0]?.options).toMatchObject({ idleTimeoutMs: 45_000 });
    await runtime.dispose();
  });
});

describe("第五波装配（W5-C0）", () => {
  it("--max-cost 与 config limits / fallbackModel 只透传到会话选项，并提示尚未生效", async () => {
    h = composeHarness([{ text: "ok" }]);
    h.home.write(
      "home/.config/ama/config.json",
      JSON.stringify({ version: 1, limits: { maxTurns: 9 }, fallbackModel: "fake/reasoning" }),
    );
    const runtime = await h.boot(["--model", "fake/echo", "--max-cost", "2", "--agent-dir", "/a"]);
    const session = runtime.session as AgentSessionImpl;
    expect(session.options.limits).toEqual({ maxTurns: 9, maxCostUsd: 2 });
    expect(session.options.fallbackModel).toBe("fake/reasoning");
    expect(session.options.maxTurns).toBeUndefined();
    const warnings = runtime.warnings.join("\n");
    expect(warnings).toContain("--max-cost 尚未实现");
    expect(warnings).not.toContain("--agent-dir 尚未实现"); // [W5-G] 已接入
    await runtime.dispose();
  });

  it("会话带组装表的扩展工厂；subagent_* / plan_* 桥接到宿主总线", async () => {
    h = composeHarness([{ text: "ok" }]);
    const host = recordingHost(h.home);
    const runtime = await h.boot(["--model", "fake/echo", "--host", host.path]);
    const session = runtime.session as AgentSessionImpl;
    expect(Array.isArray(session.options.extensions)).toBe(true);
    const seen: string[] = [];
    for (const name of [
      "subagent_start",
      "subagent_end",
      "plan_proposed",
      "plan_resolved",
    ] as const)
      hostApi().events.on(name, (event) => void seen.push(`${name}:${JSON.stringify(event)}`));
    session.emit({ type: "subagent_end", taskId: "t1", status: "completed" });
    session.emit({ type: "plan_resolved", planId: "p1", decision: "reject" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([
      'subagent_end:{"taskId":"t1","status":"completed"}',
      'plan_resolved:{"planId":"p1","decision":"reject"}',
    ]);
    await runtime.dispose();
  });
});
