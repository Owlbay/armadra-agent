import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, ToolResultMessage } from "../ai/types.js";
import { SessionManager } from "../session/manager.js";
import { buildProjection } from "../session/projection.js";
import type { AgentMessage } from "../session/types.js";
import { BREAKDOWN_CATEGORIES, breakdownMessages, largestToolResults } from "./breakdown.js";
import { estimateMessagesTokens, estimateProjectedTokens, IMAGE_TOKENS } from "./estimate.js";

const SECRET = "SECRET-BODY-should-never-appear";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const assistant = (
  content: AssistantMessage["content"],
  extra: Partial<AssistantMessage> = {},
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "fake",
  provider: "fake",
  model: "echo",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
  ...extra,
});
const result = (toolName: string, text: string, id = "c1"): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName,
  content: text,
  isError: false,
  timestamp: 0,
});

/** 覆盖全部类别的一组消息（长度故意取奇数，检验余数分配）。 */
function sample(): AgentMessage[] {
  return [
    {
      role: "system",
      sections: { preamble: "You are a test agent.", rules: "r".repeat(37), cwd: "/w" },
      toolsAdded: [
        { name: "read", description: "Read a file", parameters: { type: "object" } },
        { name: "bash", description: "Run a command ".repeat(5), parameters: { type: "object" } },
      ],
      timestamp: 0,
    },
    user("fix the 缓存 bug please"),
    {
      role: "user",
      content: [
        { type: "text", text: "see image" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      timestamp: 0,
    },
    assistant([
      { type: "thinking", thinking: "let me think about it." },
      { type: "text", text: "Looking." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } },
      { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls -la" } },
    ]),
    result("read", `${SECRET} ${"x".repeat(999)}`, "c1"),
    result("bash", `${SECRET} short`, "c2"),
    {
      role: "toolResult",
      toolCallId: "c3",
      toolName: "read",
      content: [
        { type: "text", text: "png" },
        { type: "image", data: "BBBB", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: 0,
    },
    { role: "system", sections: { cwd: "/w2", memory: null }, timestamp: 0 },
    {
      role: "custom",
      customType: "ama.hook_context",
      content: `${SECRET} hook`,
      display: false,
      timestamp: 0,
    },
    { role: "compactionSummary", summary: "## Goal\nsummary", tokensBefore: 10, timestamp: 0 },
    { role: "branchSummary", summary: "left branch", fromId: "x", timestamp: 0 },
  ];
}

function tokensOf(b: ReturnType<typeof breakdownMessages>, category: string): number {
  return b.entries.find((e) => e.category === category)?.tokens ?? -1;
}

describe("上下文分类明细", () => {
  it("各类别之和 = estimateMessagesTokens；固定类别顺序", () => {
    const messages = sample();
    const b = breakdownMessages(messages);
    expect(b.entries.map((e) => e.category)).toEqual([...BREAKDOWN_CATEGORIES]);
    expect(b.total).toBe(estimateMessagesTokens(messages));
    expect(b.entries.reduce((sum, e) => sum + e.tokens, 0)).toBe(b.total);
    // 每条消息单独看也守恒
    for (const message of messages) {
      const one = breakdownMessages([message]);
      expect(one.entries.reduce((sum, e) => sum + e.tokens, 0)).toBe(
        estimateMessagesTokens([message]),
      );
    }
    for (const category of BREAKDOWN_CATEGORIES) expect(tokensOf(b, category)).toBeGreaterThan(0);
    expect(b.prefixTokens).toBe(tokensOf(b, "system") + tokensOf(b, "tools"));
    expect(b.hasSystem).toBe(true);
  });

  it("按节、按工具、按工具名、按摘要类型汇总", () => {
    const b = breakdownMessages(sample());
    const parts = (category: string) =>
      Object.fromEntries(
        (b.entries.find((e) => e.category === category)?.parts ?? []).map((p) => [
          p.name,
          p.tokens,
        ]),
      );
    // 补丁也计入（cwd 两次），null 节按空串计 0
    expect(Object.keys(parts("system")).sort()).toEqual(["cwd", "memory", "preamble", "rules"]);
    expect(parts("system")["memory"]).toBe(0);
    expect(Object.keys(parts("tools")).sort()).toEqual(["bash", "read"]);
    expect(parts("tools")["bash"]).toBeGreaterThan(parts("tools")["read"] ?? 0);
    expect(Object.keys(parts("toolResults")).sort()).toEqual(["bash", "read"]);
    expect(Object.keys(parts("toolCalls")).sort()).toEqual(["bash", "read"]);
    expect(parts("summaries")).toMatchObject({ compaction: expect.any(Number), branch: 3 });
    expect(Object.keys(parts("custom"))).toEqual(["ama.hook_context"]);
  });

  it("附件图片：用户消息与工具结果里的每张 1 600，单列一类", () => {
    const b = breakdownMessages(sample());
    const images = b.entries.find((e) => e.category === "images");
    expect(images?.tokens).toBe(2 * IMAGE_TOKENS);
    expect(images?.count).toBe(2);
    expect(images?.parts.map((p) => p.name).sort()).toEqual(["toolResult", "user"]);
  });

  it("工具结果按出现顺序编号；Top-N 按大小，结果里没有正文", () => {
    const b = breakdownMessages(sample());
    expect(b.toolResults.map((r) => [r.ordinal, r.toolName])).toEqual([
      [1, "read"],
      [2, "bash"],
      [3, "read"],
    ]);
    const top = largestToolResults(b, 2);
    expect(top.map((r) => r.ordinal)).toEqual([3, 1]);
    expect(largestToolResults(b, 0)).toEqual([]);
    expect(JSON.stringify(b)).not.toContain("SECRET");
    expect(JSON.stringify(b)).not.toContain("xxxx");
  });

  it("空会话：全部为 0，没有 system", () => {
    const b = breakdownMessages([]);
    expect(b.total).toBe(0);
    expect(b.entries.every((e) => e.tokens === 0 && e.parts.length === 0)).toBe(true);
    expect(b.hasSystem).toBe(false);
    expect(b.toolResults).toEqual([]);
  });

  it("工具表为空数组（`[]` 也计 1 token）仍守恒", () => {
    const messages: AgentMessage[] = [
      { role: "system", sections: {}, toolsAdded: [], timestamp: 0 },
    ];
    const b = breakdownMessages(messages);
    expect(b.total).toBe(estimateMessagesTokens(messages));
    expect(tokensOf(b, "tools")).toBe(b.total);
  });

  it("压缩后：按投影拆分，压缩前的消息不再计入，摘要单列", () => {
    const m = SessionManager.inMemory("/w");
    m.append({ type: "message", message: user("old ".repeat(300)) });
    m.append({
      type: "message",
      message: assistant([{ type: "text", text: "old answer" }], {
        usage: {
          input: 5000,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5010,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    });
    const kept = m.append({ type: "message", message: user("kept question") });
    m.append({
      type: "compaction",
      summary: "## Goal\ncompacted",
      firstKeptEntryId: kept.id,
      tokensBefore: 5010,
    });
    const branch = m.branch();
    const items = buildProjection(branch).items;
    const messages = items.map((item) => item.message);
    const b = breakdownMessages(messages);
    const estimate = estimateProjectedTokens(items, branch);
    // usage 早于压缩，不再采信：全量估算，与分类合计一致
    expect(estimate.lastUsageIndex).toBeNull();
    expect(estimate.tokens).toBe(b.total);
    expect(tokensOf(b, "summaries")).toBeGreaterThan(0);
    expect(tokensOf(b, "assistant")).toBe(0);
    expect(tokensOf(b, "user")).toBe(estimateMessagesTokens([user("kept question")]));
  });
});
