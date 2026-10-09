/**
 * 模型回退（W5-H2 H7，session-run.ts）：overloaded 先快速重试一次再切（[ME-C] D8）、可重试错误重试
 * 用尽后切，回复后切回主模型。
 */

import { describe, expect, it } from "vitest";
import { FakeProvider } from "../ai/fake/fake-provider.js";
import { SessionManager } from "../session/manager.js";
import { AgentSessionImpl } from "./session.js";
import { createScriptedApi, type ScriptCall, type ScriptStep } from "./testing/scripted-api.js";
import { fakeModel, stubRegistry, stubTool } from "./testing/stubs.js";
import type { SessionEvent } from "./types.js";

function setup(script: (call: ScriptCall) => ScriptStep, fallbackModel?: string) {
  const primary = fakeModel();
  const backup = fakeModel({ id: "backup", name: "Backup" });
  const scripted = createScriptedApi(script);
  const session = new AgentSessionImpl({
    sessionManager: SessionManager.inMemory("/work"),
    providers: stubRegistry([primary, backup], [scripted.api]),
    model: primary,
    tools: [stubTool({ name: "ls" })],
    retry: { baseDelayMs: 1, maxDelayMs: 2, maxRetries: 2 },
    ...(fallbackModel === undefined ? {} : { fallbackModel }),
  });
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  const models = () => scripted.calls.map((call) => call.model.id);
  return { session, events, models };
}

describe("模型回退（W5-H2 H7）", () => {
  it("overloaded：先快速重试一次，仍失败切到回退模型；回复后下一次请求回到主模型", async () => {
    const h = setup((call) => {
      if (call.index <= 1) return { kind: "error", message: "529 overloaded_error: Overloaded" };
      if (call.model.id === "backup") return { toolCalls: [{ name: "ls", args: {} }] };
      return { text: "done" };
    }, "fake/backup");
    await h.session.prompt("go");
    expect(h.models()).toEqual(["echo", "echo", "backup", "echo"]);
    const fallback = h.events.find((e) => e.type === "model_fallback");
    expect(fallback).toEqual({
      type: "model_fallback",
      from: { provider: "fake", id: "echo" },
      to: { provider: "fake", id: "backup" },
      reason: "529 overloaded_error: Overloaded",
    });
    const retries = h.events.filter((e) => e.type === "auto_retry_start");
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ attempt: 1 });
    expect(retries[0]?.type === "auto_retry_start" && retries[0].delayMs).toBeLessThanOrEqual(1300);
    expect(h.events.find((e) => e.type === "agent_settled")).toEqual({ type: "agent_settled" });
    expect(h.session.model().id).toBe("echo");
    // 切换与切回都落 model_change（缓存归因 model_changed）
    const changes = h.session.entries.filter((e) => e.type === "model_change");
    expect(changes.map((e) => (e.type === "model_change" ? e.modelId : ""))).toEqual([
      "echo",
      "backup",
      "echo",
    ]);
    // 失败尝试被剔除，回退模型看到的上下文里没有它
    const last = h.session.messages.at(-1);
    expect(last?.role === "assistant" && last.model).toBe("echo");
  });

  it("其它可重试错误：先按设置重试，用尽后切一次", async () => {
    const h = setup(
      (call) =>
        call.model.id === "backup"
          ? { text: "rescued" }
          : { kind: "error", message: "502 bad gateway" },
      "fake/backup",
    );
    await h.session.prompt("go");
    expect(h.models()).toEqual(["echo", "echo", "echo", "backup"]);
    expect(h.events.filter((e) => e.type === "auto_retry_start")).toHaveLength(2);
    expect(h.events.filter((e) => e.type === "model_fallback")).toHaveLength(1);
    expect(h.session.getLastAssistantText()).toBe("rescued");
    expect(h.session.model().id).toBe("echo");
  });

  it("回退也失败：每周期只切一次，按最终失败收尾，模型回到主模型", async () => {
    const h = setup(() => ({ kind: "error", message: "overloaded" }), "fake/backup");
    await h.session.prompt("go");
    expect(h.models().filter((id) => id === "backup")).toHaveLength(1);
    expect(h.events.find((e) => e.type === "agent_settled")).toEqual({
      type: "agent_settled",
      warning: "overloaded",
    });
    expect(h.session.model().id).toBe("echo");
  });

  it("没有配置 / 与当前模型相同 / 不可重试的错误：不回退", async () => {
    for (const fallback of [undefined, "fake/echo"]) {
      const h = setup(() => ({ kind: "error", message: "overloaded" }), fallback);
      await h.session.prompt("go");
      expect(h.models().every((id) => id === "echo")).toBe(true);
      expect(h.events.some((e) => e.type === "model_fallback")).toBe(false);
    }
    const fatal = setup(() => ({ kind: "error", message: "401 invalid api key" }), "fake/backup");
    await fatal.session.prompt("go");
    expect(fatal.models()).toEqual(["echo"]);
  });

  it("回退模型找不到：等于没配，照常重试后失败", async () => {
    const h = setup(() => ({ kind: "error", message: "overloaded" }), "fake/missing");
    await h.session.prompt("go");
    expect(h.models()).toEqual(["echo", "echo", "echo"]);
    expect(h.events.some((e) => e.type === "model_fallback")).toBe(false);
    expect(h.events.find((e) => e.type === "agent_settled")).toEqual({
      type: "agent_settled",
      warning: "overloaded",
    });
  });

  it("[ME-C] 429 带 Retry-After：退避取 max(指数退避, Retry-After) × U(0.8, 1.2)，上限 maxRetries + 2", async () => {
    const fake = new FakeProvider([
      { error: { kind: "rate_limit", retryAfterMs: 20_000 } },
      { text: "ok" },
    ]);
    const session = new AgentSessionImpl({
      sessionManager: SessionManager.inMemory("/work"),
      providers: stubRegistry([fakeModel()], [fake.api]),
      model: fakeModel(),
      tools: [],
      retry: { baseDelayMs: 1, maxDelayMs: 60_000, maxRetries: 3 },
    });
    const events: SessionEvent[] = [];
    let seen: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (seen = resolve));
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "auto_retry_start") seen();
    });
    const running = session.prompt("go");
    await started;
    await session.abort(); // 不真等 20 s
    await running;
    const retry = events.find((e) => e.type === "auto_retry_start");
    expect(retry).toMatchObject({ attempt: 1, maxAttempts: 5 });
    const delay = retry?.type === "auto_retry_start" ? retry.delayMs : 0;
    expect(delay).toBeGreaterThanOrEqual(16_000);
    expect(delay).toBeLessThanOrEqual(24_000);
  });
});
