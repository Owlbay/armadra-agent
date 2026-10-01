import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { currentSession, switchSession } from "../cli/compose-session.js";
import type { Runtime } from "../cli/runtime.js";
import { parseSlash, runSlashCommand, type CommandContext } from "./commands-core.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

function context(runtime: Runtime): CommandContext {
  return {
    runtime,
    session: () => currentSession(runtime),
    switchSession: (request) => switchSession(runtime, request),
  };
}

describe("斜杠命令语义层", () => {
  it("解析：别名、参数；非命令与 /skill: / 模板交给提示", async () => {
    expect(parseSlash("/quit")).toEqual({ name: "exit", args: "" });
    expect(parseSlash("  /model  fake/echo ")).toEqual({ name: "model", args: "fake/echo" });
    expect(parseSlash("hello")).toBeUndefined();
    h = composeHarness();
    const runtime = await h.boot(["--model", "fake/echo"]);
    const ctx = context(runtime);
    expect(await runSlashCommand("/skill:review x", ctx)).toBeUndefined();
    expect(await runSlashCommand("/fix bug", ctx)).toBeUndefined();
    expect(await runSlashCommand("plain text", ctx)).toBeUndefined();
    expect(await runSlashCommand("/exit", ctx)).toEqual({ kind: "exit" });
    expect(await runSlashCommand("/help", ctx)).toMatchObject({ kind: "handled" });
    await runtime.dispose();
  });

  it("缺参数 → pick；带参数直接生效", async () => {
    h = composeHarness();
    const runtime = await h.boot(["--model", "fake/echo"]);
    const ctx = context(runtime);
    for (const [line, what] of [
      ["/model", "model"],
      ["/resume", "session"],
      ["/fork", "tree"],
      ["/permission", "permission"],
      ["/thinking", "thinking"],
    ] as const) {
      expect(await runSlashCommand(line, ctx)).toEqual({ kind: "pick", what });
    }
    await runSlashCommand("/model fake/reasoning", ctx);
    expect(ctx.session().state.model?.id).toBe("reasoning");
    await runSlashCommand("/permission plan", ctx);
    expect(ctx.session().state.permissionMode).toBe("plan");
    await runSlashCommand("/thinking high", ctx);
    expect(ctx.session().state.thinkingLevel).toBe("high");
    await expect(runSlashCommand("/thinking huge", ctx)).rejects.toMatchObject({
      code: "invalid_arguments",
    });
    const tools = await runSlashCommand("/tools read, grep", ctx);
    expect(tools).toMatchObject({
      kind: "handled",
      message: expect.stringContaining("活动：grep, read"),
    });
    await runtime.dispose();
  });

  it("/new /resume /fork 经 switchSession；/session 含缓存命中率；/compact", async () => {
    h = composeHarness([
      { text: "first", usage: { input: 10, output: 1, cacheRead: 30 } },
      { text: "## Goal\nsummary" },
    ]);
    const runtime = await h.boot(["--model", "fake/echo"]);
    const ctx = context(runtime);
    await ctx.session().prompt("hello");
    const firstId = ctx.session().state.sessionId;
    expect((await runSlashCommand("/session", ctx)) as { message: string }).toMatchObject({
      message: expect.stringContaining("命中率 75%"),
    });
    const fresh = await runSlashCommand("/new", ctx);
    expect(fresh).toMatchObject({
      kind: "handled",
      message: expect.stringContaining("已新建会话"),
    });
    expect(ctx.session().state.sessionId).not.toBe(firstId);
    await runSlashCommand(`/resume ${firstId.slice(0, 8)}`, ctx);
    expect(ctx.session().state.sessionId).toBe(firstId);
    const leaf = ctx.session().entries.at(-1)?.id as string;
    await runSlashCommand(`/fork ${leaf}`, ctx);
    expect(ctx.session().state.sessionId).not.toBe(firstId);
    expect(await runSlashCommand("/hooks", ctx)).toEqual({
      kind: "handled",
      message: "没有已加载的 Hook",
    });
    await runtime.dispose();
  });
});
