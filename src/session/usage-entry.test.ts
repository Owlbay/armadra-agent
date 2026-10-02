import { describe, expect, it } from "vitest";
import { computeStats } from "../agent/session-state.js";
import type { AssistantMessage, Usage } from "../ai/types.js";
import { createTmpHome } from "../../test/helpers/tmp-home.js";
import { SessionManager } from "./manager.js";
import { buildProjection, entryToMessage } from "./projection.js";

const usage = (input: number, cacheRead: number, total?: number): Usage => {
  const u: Usage = {
    input,
    output: 1,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + cacheRead + 1,
  };
  if (total !== undefined) u.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total };
  return u;
};

const assistant = (text: string, u: Usage): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "fake",
  provider: "fake",
  model: "echo",
  usage: u,
  stopReason: "stop",
  timestamp: 1,
});

describe("usage 条目（第三波 §1.7）：不进投影，进统计", () => {
  it("投影跳过；token 与费用计入；消息数不变；落盘后重开仍在", () => {
    const home = createTmpHome("ama-c1b-usage-");
    try {
      const manager = SessionManager.create(home.path("sessions"), "/work");
      manager.append({ type: "message", message: { role: "user", content: "hi", timestamp: 1 } });
      manager.append({ type: "message", message: assistant("a", usage(100, 900, 0.01)) });
      const warm = manager.append({
        type: "usage",
        kind: "cache_warm",
        provider: "fake",
        model: "echo",
        usage: usage(1, 1000, 0.002),
      });
      manager.append({ type: "message", message: { role: "user", content: "q2", timestamp: 2 } });
      expect(entryToMessage(warm)).toBeUndefined();
      const projection = buildProjection(manager.branch());
      expect(projection.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      const stats = computeStats({
        sessionId: manager.id,
        sessionFile: undefined,
        branch: manager.branch(),
        contextTokens: 10,
        contextWindow: 100,
      });
      expect(stats.tokens).toMatchObject({ input: 101, cacheRead: 1900, output: 2 });
      expect(stats.cost).toBeCloseTo(0.012);
      expect(stats.assistantMessages).toBe(1);
      expect(stats.userMessages).toBe(2);

      const file = manager.flush() as string;
      manager.close();
      const reopened = SessionManager.open(file);
      expect(reopened.entries().filter((e) => e.type === "usage")).toHaveLength(1);
      expect(buildProjection(reopened.branch()).messages).toHaveLength(3);
      reopened.close();
    } finally {
      home.cleanup();
    }
  });

  it("任一 usage 条目缺成本 → 会话费用 undefined（显示 $?）", () => {
    const manager = SessionManager.inMemory("/work");
    manager.append({ type: "message", message: assistant("a", usage(1, 0, 0.01)) });
    manager.append({
      type: "usage",
      kind: "cache_warm",
      provider: "p",
      model: "m",
      usage: usage(1, 1),
    });
    const stats = computeStats({
      sessionId: manager.id,
      sessionFile: undefined,
      branch: manager.branch(),
      contextTokens: undefined,
      contextWindow: undefined,
    });
    expect(stats.cost).toBeUndefined();
  });
});
