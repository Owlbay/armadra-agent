import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { currentSession, switchSession } from "../cli/compose-session.js";
import type { Runtime } from "../cli/runtime.js";
import { AgentSessionImpl } from "../agent/session.js";
import { sharedCacheReporting } from "../ai/cache/reporting.js";
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
      message: expect.stringContaining("命中率    最近 75% · 会话 75%"),
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

  it("/cache：缓存段；warm 切换本会话保温；fingerprint 打印最近一次请求的哈希；参数错误", async () => {
    sharedCacheReporting.clear();
    h = composeHarness([{ text: "ok", usage: { input: 2_000, output: 5, cacheRead: 6_000 } }]);
    const runtime = await h.boot(["--model", "fake/echo"]);
    const ctx = context(runtime);
    const before = (await runSlashCommand("/cache fingerprint", ctx)) as { message: string };
    expect(before.message).toBe("还没有真实请求（指纹在第一次请求后记录）");
    await ctx.session().prompt("hello");
    const panel = (await runSlashCommand("/cache", ctx)) as { message: string };
    const rows = panel.message.split("\n");
    expect(rows.slice(0, 6)).toEqual([
      "缓存",
      "  输入      8k = 缓存读 6k（75%）+ 未缓存 2k",
      "  报告状态  reported",
      "  命中率    最近 75% · 会话 75%",
      "  未命中    0 次",
      "  保温      streaming · 已停止：模型目录没有缓存 TTL",
    ]);
    expect(rows[6]).toMatch(/^ {2}上下文 {4}\d+%，余量 ≈ /);
    expect(await runSlashCommand("/cache warm idle", ctx)).toEqual({
      kind: "handled",
      message: "保温：idle（本会话）",
    });
    const session = ctx.session() as AgentSessionImpl;
    expect(session.cache.mode()).toBe("idle");
    expect(session.getStats().cache?.warming.mode).toBe("idle");
    expect(await runSlashCommand("/cache warm", ctx)).toMatchObject({ message: "保温：idle" });
    const print = (await runSlashCommand("/cache fingerprint", ctx)) as { message: string };
    expect(print.message).toMatch(
      /^前缀指纹（最近一次请求）\n {2}system {2}[0-9a-f]{16}\n {2}tools {3}[0-9a-f]{16}\n {2}model {3}fake\/echo$/,
    );
    await expect(runSlashCommand("/cache warm hot", ctx)).rejects.toMatchObject({
      code: "invalid_arguments",
    });
    await expect(runSlashCommand("/cache frob", ctx)).rejects.toMatchObject({
      code: "invalid_arguments",
    });
    await runtime.dispose();
  });
});
