import { describe, expect, it } from "vitest";
import type { ToolDecl } from "../ai/types.js";
import { estimateMessageTokens, estimateTextTokens, type ContextEstimate } from "./estimate.js";
import { estimatePrefixTokens, withPrefixBaseline } from "./prefix-estimate.js";

const TOOLS: ToolDecl[] = [
  {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
];

const estimate = (partial: Partial<ContextEstimate>): ContextEstimate => ({
  tokens: 0,
  usageTokens: 0,
  trailingTokens: 0,
  lastUsageIndex: null,
  ...partial,
});

describe("启动前缀基线", () => {
  it("口径与 system 消息一致：命名节文本 + 工具声明 JSON（CJK 每字 1）", () => {
    const sections = { preamble: "You are ama.", cwd: "Current working directory: /work" };
    const tokens = estimatePrefixTokens(sections, TOOLS);
    expect(tokens).toBe(
      estimateMessageTokens({ role: "system", sections, toolsAdded: TOOLS, timestamp: 1 }),
    );
    expect(tokens).toBeGreaterThan(estimatePrefixTokens(sections, []));
    expect(estimatePrefixTokens({ host: "中文说明" }, [])).toBe(estimateTextTokens("中文说明"));
    expect(estimatePrefixTokens({}, [])).toBe(0);
  });

  it("来源：有 usage 照旧；有 system 消息为全量估算；还没有 system 消息时加前缀基线（懒算）", () => {
    let calls = 0;
    const prefix = (): number => {
      calls++;
      return 1_000;
    };
    const usage = estimate({ tokens: 5_200, usageTokens: 5_000, trailingTokens: 200 });
    expect(withPrefixBaseline(usage, false, prefix)).toEqual({ ...usage, source: "usage" });
    const full = estimate({ tokens: 3_000, trailingTokens: 3_000 });
    expect(withPrefixBaseline(full, true, prefix)).toEqual({ ...full, source: "estimate" });
    expect(calls).toBe(0);
    expect(withPrefixBaseline(estimate({ tokens: 20, trailingTokens: 20 }), false, prefix)).toEqual(
      estimate({ tokens: 1_020, trailingTokens: 1_020, source: "prefix" } as never),
    );
    expect(calls).toBe(1);
  });
});
