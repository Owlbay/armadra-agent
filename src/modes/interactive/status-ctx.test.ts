/**
 * 状态栏上下文项：full 的 `Ctx 3.0% 8.2k/272k auto` 与丢弃顺序、compact 的 < 1% 一位小数、`≈` 估算标记、
 * 与档一对齐的着色阈值、流式 usage 的 ≤ 2 Hz 采样，以及会话事件里的刷新时机与「窗口未知」提示。
 */

import { describe, expect, it } from "vitest";
import type {
  AgentSession,
  SessionContextStats,
  SessionEvent,
  SessionStats,
} from "../../agent/types.js";
import type { AssistantMessage, Usage } from "../../ai/types.js";
import { plainTheme, type Theme } from "../../tui.js";
import { createSessionEventHandler, type SessionEventDeps } from "./session-events.js";
import { StatusBar, type StatusBarSource } from "./status-bar.js";
import { LIVE_CTX_INTERVAL_MS, ctxPercentText, ctxWarnAt } from "./status-ctx.js";
import { golden } from "./test-support.js";

const PREFIX: SessionContextStats = {
  source: "prefix",
  usageTokens: 0,
  trailingTokens: 1_100,
  autoCompactAt: 255_616,
  pruneAt: 178_931,
};

function stats(partial: Partial<SessionStats> = {}): SessionStats {
  return {
    sessionId: "s",
    sessionFile: undefined,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    contextTokens: 1_100,
    contextWindow: 272_000,
    contextPercent: 0.4,
    context: PREFIX,
    ...partial,
  };
}

function bar(
  layout: "full" | "compact",
  current: () => SessionStats,
  extra: Partial<StatusBarSource> = {},
  theme: Theme = plainTheme(),
): StatusBar {
  const session = {
    state: {
      model: { provider: "chatgpt", id: "gpt-6-astra" },
      thinkingLevel: "medium",
      permissionMode: "default",
    },
    getStats: current,
  } as unknown as AgentSession;
  return new StatusBar(
    {
      session: () => session,
      preset: () => "default",
      layout: () => layout,
      git: () => ({ dir: "proj", info: { branch: "master", shortHead: "5ae9e54" } }),
      sessionStartedAt: () => 0,
      now: () => 15_000,
      ...extra,
    },
    theme,
  );
}

const usage = (input: number, output = 0): Usage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
});

describe("状态栏上下文项", () => {
  it("格式与阈值：full 一位小数，compact < 1% 保留一位；warning 与档一裁剪阈值对齐", () => {
    expect(ctxPercentText(3, true)).toBe("3.0%");
    expect(ctxPercentText(0.4, false)).toBe("0.4%");
    expect(ctxPercentText(0, false)).toBe("0%");
    expect(ctxPercentText(34.4, false)).toBe("34%");
    expect(ctxWarnAt(stats())).toBeCloseTo(178_931 / 272_000, 6);
    expect(ctxWarnAt({ contextWindow: 272_000 })).toBe(0.7);
    expect(ctxWarnAt(stats({ contextWindow: undefined }))).toBe(0.7);
  });

  it("0 条消息：前缀基线不为 0、带 ≈；full 显示已用量 / 窗口与 auto，compact 余量表一位小数", () => {
    const full = bar("full", () => stats());
    expect(full.render(160)[0]).toMatch(/medium \| Ctx ≈0\.4% 1\.1k\/272k auto \| proj ⎇ master/);
    const compact = bar("compact", () => stats());
    expect(compact.render(160)[0]).toContain("ctx ▯▯▯▯▯▯▯▯▯▯ ≈0.4%");
    expect(compact.render(80)[0]).toContain("ctx ≈0.4%");
    const ascii = bar("compact", () => stats(), {}, plainTheme({ ascii: true }));
    expect(ascii.render(80)[0]).toContain("ctx ~0.4%");
  });

  it("full 丢弃顺序（160 / 80 / 45 列）：先丢 auto、/窗口，再丢已用量；自动压缩关闭时没有 auto", () => {
    const used = stats({
      contextTokens: 8_200,
      contextPercent: 3,
      context: { ...PREFIX, source: "usage", usageTokens: 8_000, trailingTokens: 200 },
    });
    const b = bar("full", () => used);
    const rows = [160, 120, 80, 60, 45, 34].map((w) => `# ${w}\n|${b.render(w)[0]}|`);
    golden("status-ctx-widths", rows.join("\n") + "\n");
    expect(b.render(160)[0]).toContain("| Ctx 3.0% 8.2k/272k auto |");
    expect(b.render(80)[0]).toContain("| Ctx 3.0% 8.2k/272k |");
    expect(b.render(60)[0]).toContain("| Ctx 3.0% 8.2k |");
    expect(b.render(45)[0]).toContain("| Ctx 3.0% 8.2k |");
    expect(b.render(34)[0]).toContain("| Ctx 3.0% | 15s");
    const { autoCompactAt: _a, pruneAt: _p, ...manual } = used.context!;
    const off = bar("full", () => ({ ...used, context: manual }));
    expect(off.render(160)[0]).toContain("| Ctx 3.0% 8.2k/272k |");
    const unknown = bar("full", () => ({
      ...used,
      contextWindow: undefined,
      contextPercent: undefined,
      context: manual,
    }));
    expect(unknown.render(160)[0]).toContain("| Ctx ? 8.2k |");
  });

  it("着色：越过档一裁剪阈值即 warning（低于 70%）", () => {
    const tagged = Object.assign(Object.create(plainTheme()) as Theme, {
      fg: (c: string, t: string) => `<${c}>${t}`,
    });
    const at = (percent: number): string =>
      bar("full", () => stats({ contextPercent: percent }), {}, tagged).render(200)[0]!;
    expect(at(65)).toContain("<success>≈65.0%");
    expect(at(66)).toContain("<warning>≈66.0%");
    expect(at(91)).toContain("<error>≈91.0%");
  });

  it("流式 usage：在途请求的上下文量 ≤ 2 Hz 采样，替代估算；消息结束后回到统计值", () => {
    let now = 0;
    const b = bar("full", () => stats(), { now: () => now });
    expect(b.noteStreaming(undefined)).toBe(false);
    expect(b.noteStreaming(usage(0))).toBe(false);
    expect(b.noteStreaming(usage(54_000))).toBe(true);
    expect(b.render(160)[0]).toContain("| Ctx 19.9% 54k/272k auto |");
    now += LIVE_CTX_INTERVAL_MS - 1;
    expect(b.noteStreaming(usage(54_000, 300))).toBe(false);
    now += 1;
    expect(b.noteStreaming(usage(54_000, 600))).toBe(true);
    expect(b.render(160)[0]).toContain("| Ctx 20.1% 55k/272k auto |");
    b.clearStreaming();
    expect(b.render(160)[0]).toContain("| Ctx ≈0.4% 1.1k/272k auto |");
  });
});

describe("会话事件：状态栏刷新时机", () => {
  function rig(window: number | undefined) {
    const calls: string[] = [];
    const notices: string[] = [];
    const current = stats({ contextWindow: window });
    const status = {
      refresh: () => void calls.push("refresh"),
      current: () => current,
      noteStreaming: (u: Usage | undefined) => void calls.push(`live ${u?.input ?? "-"}`),
      clearStreaming: () => void calls.push("clear"),
    };
    const noop = (): void => {};
    const view = new Proxy(
      {},
      {
        get: (_t, key) =>
          key === "addNotice" ? (_level: string, text: string) => notices.push(text) : noop,
      },
    );
    const deps = {
      view,
      tools: {},
      status,
      area: { onEvent: () => false },
      agentUi: () => ({ onEvent: () => false }),
      indicator: { onEvent: noop, sync: noop },
      session: () =>
        ({ state: { model: { provider: "astr", id: "gemini-flash" } } }) as unknown as AgentSession,
      setQueue: noop,
      notice: noop,
      render: noop,
    } as unknown as SessionEventDeps;
    return { handle: createSessionEventHandler(deps), calls, notices };
  }
  const assistant = (input: number): AssistantMessage =>
    ({ role: "assistant", content: [], usage: usage(input) }) as unknown as AssistantMessage;
  const user = { role: "user", content: "hi", timestamp: 0 } as const;

  it("用户消息落盘后刷新；流式 usage 交给状态栏采样；助手消息结束清在途值再刷新", () => {
    const { handle, calls } = rig(272_000);
    handle({ type: "message_start", message: user } as SessionEvent);
    expect(calls).toEqual([]);
    handle({ type: "message_end", message: user } as SessionEvent);
    expect(calls).toEqual(["refresh"]);
    handle({
      type: "message_update",
      message: assistant(52_000),
      assistantMessageEvent: { type: "text_delta" },
    } as unknown as SessionEvent);
    expect(calls.at(-1)).toBe("live 52000");
    handle({ type: "message_end", message: assistant(52_000) } as SessionEvent);
    expect(calls.slice(-2)).toEqual(["clear", "refresh"]);
  });

  it("模型没有上下文窗口：同一模型只提示一次怎么补", () => {
    const { handle, notices } = rig(undefined);
    handle({ type: "message_end", message: user } as SessionEvent);
    handle({ type: "agent_settled" } as SessionEvent);
    handle({ type: "message_end", message: user } as SessionEvent);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("astr/gemini-flash");
    expect(notices[0]).toContain("ama models discover");
    expect(rig(272_000).notices).toEqual([]);
  });
});
