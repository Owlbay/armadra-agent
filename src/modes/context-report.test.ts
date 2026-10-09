import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import type { AgentSession, SessionState, SessionStats } from "../agent/types.js";
import type { AssistantMessage } from "../ai/types.js";
import { currentSession, switchSession } from "../cli/compose-session.js";
import { setLocale } from "../i18n/index.js";
import type { AgentMessage } from "../session/types.js";
import { plainTheme } from "../tui/theme.js";
import { runSlashCommand, BUILTIN_COMMANDS } from "./commands-core.js";
import { contextPanel, contextSnapshot, describeContext } from "./context-report.js";
import { lines } from "./interactive/test-support.js";

const SECRET = "SECRET-BODY";

const usage = (totalTokens: number): AssistantMessage["usage"] => ({
  input: totalTokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function assistant(content: AssistantMessage["content"], total = 0): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "fake",
    provider: "fake",
    model: "echo",
    usage: usage(total),
    stopReason: "stop",
    timestamp: 0,
  };
}

function conversation(): AgentMessage[] {
  return [
    {
      role: "system",
      sections: { preamble: "p".repeat(400), rules: "r".repeat(2000), cwd: "/w" },
      toolsAdded: [
        { name: "read", description: "d".repeat(300), parameters: { type: "object" } },
        { name: "bash", description: "d".repeat(900), parameters: { type: "object" } },
      ],
      timestamp: 0,
    },
    { role: "user", content: "fix it", timestamp: 0 },
    assistant([
      { type: "thinking", thinking: "t".repeat(200) },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
      { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } },
    ]),
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: `${SECRET} ${"x".repeat(12_000)}`,
      isError: false,
      timestamp: 0,
    },
    {
      role: "toolResult",
      toolCallId: "c2",
      toolName: "bash",
      content: `${SECRET} ${"y".repeat(800)}`,
      isError: false,
      timestamp: 0,
    },
    assistant([{ type: "text", text: "Done. ".repeat(20) }], 9_000),
    {
      role: "user",
      content: [
        { type: "text", text: "and this" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      timestamp: 0,
    },
  ];
}

function fakeSession(
  messages: AgentMessage[],
  options: { window?: number | undefined; auto?: boolean } = {},
): AgentSession {
  const window = "window" in options ? options.window : 200_000;
  return {
    messages,
    state: { autoCompaction: options.auto ?? true } as SessionState,
    getStats: () => ({ contextWindow: window }) as SessionStats,
  } as unknown as AgentSession;
}

afterEach(() => setLocale("zh"));

describe("/context 报告", () => {
  it("文本黄金（zh）：来源、窗口、剩余、自动压缩阈值、按类别与 Top-N；不含正文", () => {
    const text = describeContext(fakeSession(conversation()));
    expect(text).toBe(
      [
        "上下文",
        "  已用      10.6k / 200k（5.3%）",
        "  剩余      189k token",
        "  来源      usage 实测 9k + 估算 1.6k",
        "  自动压缩  184k 触发，还差 ≈ 173k",
        "  裁剪      超过 129k 时清理旧工具结果",
        "",
        "按类别（估算，5.8k）",
        "  系统提示与工具声明按会话里存的 system 消息计入；全量估算可能与 usage 实测不同。",
        "  系统提示         600  ▮▯▯▯▯▯▯▯▯▯ 10%  rules 500 · preamble 100 · cwd 0",
        "  工具声明         333  ▮▯▯▯▯▯▯▯▯▯ 6%  bash 241 · read 91",
        "  用户消息           4  ▯▯▯▯▯▯▯▯▯▯ 0%",
        "  助手文本          30  ▯▯▯▯▯▯▯▯▯▯ 1%",
        "  推理              50  ▯▯▯▯▯▯▯▯▯▯ 1%",
        "  工具调用参数      10  ▯▯▯▯▯▯▯▯▯▯ 0%  bash 5 · read 5",
        "  工具结果        3.2k  ▮▮▮▮▮▯▯▯▯▯ 55%  read 3k · bash 203",
        "  附件图片        1.6k  ▮▮▮▯▯▯▯▯▯▯ 27%  1 张 · 用户 1.6k",
        "  摘要               0  ▯▯▯▯▯▯▯▯▯▯ 0%",
        "  自定义消息         0  ▯▯▯▯▯▯▯▯▯▯ 0%",
        "",
        "最大的工具结果（前 5）",
        "  #1      3k  read",
        "  #2     203  bash",
      ].join("\n"),
    );
    expect(text).not.toContain(SECRET);
  });

  it("en：同形输出", () => {
    setLocale("en");
    const text = describeContext(fakeSession(conversation()));
    expect(text).toContain("Source        reported usage 9k + estimated 1.6k");
    expect(text).toContain("Auto-compact  at 184k, ≈ 173k to go");
    expect(text).toContain("Tool results");
    expect(text).toContain("Largest tool results (top 5)");
    expect(text).not.toContain(SECRET);
  });

  it("空会话：全量估算、前缀待计入、没有工具结果", () => {
    const text = describeContext(fakeSession([]));
    expect(text).toContain("来源      全量估算（还没有可用的 usage）");
    expect(text).toContain("系统提示与工具声明在首次请求后才计入。");
    expect(text).toContain("上下文里还没有消息。");
    expect(text).toContain("没有工具结果");
  });

  it("窗口未知、自动压缩关闭", () => {
    expect(describeContext(fakeSession(conversation(), { window: undefined }))).toContain(
      "自动压缩  窗口未知",
    );
    const off = describeContext(fakeSession(conversation(), { auto: false }));
    expect(off).toContain("自动压缩  关闭");
    expect(off).not.toContain("裁剪");
    const snap = contextSnapshot(fakeSession(conversation(), { window: undefined }));
    expect(snap.percent).toBeUndefined();
    expect(snap.compactAt).toBeUndefined();
  });

  it("面板帧（100 列）", () => {
    const frame = lines(contextPanel(fakeSession(conversation()), plainTheme()), 100);
    expect(frame.join("\n")).toBe(
      [
        "▎ 上下文",
        "▎ 已用      10.6k / 200k（5.3%）",
        "▎ 剩余      189k token",
        "▎ 来源      usage 实测 9k + 估算 1.6k",
        "▎ 自动压缩  184k 触发，还差 ≈ 173k",
        "▎ 裁剪      超过 129k 时清理旧工具结果",
        "▎",
        "▎ 按类别（估算，5.8k）",
        "▎   系统提示与工具声明按会话里存的 system 消息计入；全量估算可能与 usage 实测不同。",
        "▎   系统提示         600  ▮▯▯▯▯▯▯▯▯▯ 10%  rules 500 · preamble 100 · cwd 0",
        "▎   工具声明         333  ▮▯▯▯▯▯▯▯▯▯ 6%  bash 241 · read 91",
        "▎   用户消息           4  ▯▯▯▯▯▯▯▯▯▯ 0%",
        "▎   助手文本          30  ▯▯▯▯▯▯▯▯▯▯ 1%",
        "▎   推理              50  ▯▯▯▯▯▯▯▯▯▯ 1%",
        "▎   工具调用参数      10  ▯▯▯▯▯▯▯▯▯▯ 0%  bash 5 · read 5",
        "▎   工具结果        3.2k  ▮▮▮▮▮▯▯▯▯▯ 55%  read 3k · bash 203",
        "▎   附件图片        1.6k  ▮▮▮▯▯▯▯▯▯▯ 27%  1 张 · 用户 1.6k",
        "▎   摘要               0  ▯▯▯▯▯▯▯▯▯▯ 0%",
        "▎   自定义消息         0  ▯▯▯▯▯▯▯▯▯▯ 0%",
        "▎",
        "▎ 最大的工具结果（前 5）",
        "▎   #1      3k  read",
        "▎   #2     203  bash",
      ].join("\n"),
    );
  });
});

describe("/context 命令", () => {
  let h: ComposeHarness | undefined;
  afterEach(() => h?.cleanup());

  it("登记在内置命令表；真实会话一轮后与 getStats().contextTokens 一致", async () => {
    expect(BUILTIN_COMMANDS.map((c) => c.name)).toContain("context");
    h = composeHarness();
    const runtime = await h.boot(["--model", "fake/echo"]);
    const ctx = {
      runtime,
      session: () => currentSession(runtime),
      switchSession: (request: Parameters<typeof switchSession>[1]) =>
        switchSession(runtime, request),
    };
    const before = await runSlashCommand("/context", ctx);
    expect(before).toMatchObject({ kind: "handled" });
    // 首次请求前：与状态栏的启动基线同一口径——系统提示与工具声明按将要发送的内容估算
    const fresh = contextSnapshot(ctx.session());
    expect(fresh.prefixPending).toBe(true);
    expect(fresh.estimate.tokens).toBe(ctx.session().getStats().contextTokens);
    expect(fresh.estimate.tokens).toBeGreaterThan(0);
    expect(fresh.breakdown.prefixTokens).toBe(fresh.breakdown.total);
    expect(fresh.breakdown.entries.map((e) => e.category)).toEqual(
      expect.arrayContaining(["system", "tools"]),
    );
    await ctx.session().prompt("hello there");
    const session = ctx.session();
    const snap = contextSnapshot(session);
    expect(snap.estimate.tokens).toBe(session.getStats().contextTokens);
    expect(snap.prefixPending).toBe(false);
    expect(snap.breakdown.hasSystem).toBe(true);
    expect(snap.breakdown.prefixTokens).toBeGreaterThan(0);
    const after = await runSlashCommand("/context", ctx);
    expect(after).toMatchObject({ kind: "handled", message: expect.stringContaining("上下文") });
    const help = await runSlashCommand("/help", ctx);
    expect(help).toMatchObject({ message: expect.stringContaining("/context") });
    await runtime.dispose();
  });
});
