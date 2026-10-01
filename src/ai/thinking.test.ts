import { describe, expect, it } from "vitest";
import {
  budgetedMaxTokens,
  clampThinkingLevel,
  discreteThinkingLevel,
  getSupportedLevels,
  isThinkingLevel,
  thinkingBudget,
} from "./thinking.js";

describe("thinking", () => {
  it("非推理模型只有 off；xhigh 需显式映射；null 级别不支持", () => {
    expect(getSupportedLevels({ reasoning: false })).toEqual(["off"]);
    expect(getSupportedLevels({ reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(
      getSupportedLevels({
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh" },
      }),
    ).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("钳位：先向上、再向下", () => {
    const model = { reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null } };
    expect(clampThinkingLevel(model, "minimal")).toBe("high");
    expect(clampThinkingLevel(model, "xhigh")).toBe("high");
    expect(clampThinkingLevel({ reasoning: false }, "high")).toBe("off");
    const noOff = { reasoning: true, thinkingLevelMap: { off: null } };
    expect(clampThinkingLevel(noOff, "off")).toBe("minimal");
  });

  it("预算：映射表的数字优先；budgetedMaxTokens 留出回答空间", () => {
    expect(thinkingBudget({ reasoning: true }, "medium")).toBe(8192);
    expect(thinkingBudget({ reasoning: true, thinkingLevelMap: { high: 30000 } }, "high")).toBe(
      30000,
    );
    expect(budgetedMaxTokens(64000, 4000, 8192)).toEqual({ maxTokens: 12192, budget: 8192 });
    expect(budgetedMaxTokens(64000, undefined, 16384)).toEqual({ maxTokens: 64000, budget: 16384 });
    expect(budgetedMaxTokens(8000, 8000, 16384)).toEqual({ maxTokens: 8000, budget: 6976 });
    expect(budgetedMaxTokens(1500, undefined, 2048).budget).toBe(476);
  });

  it("离散级别（Google thinkingLevel）：映射字串优先、xhigh → high、数字映射返回 undefined", () => {
    const plain = { reasoning: true };
    expect(discreteThinkingLevel(plain, "minimal")).toBe("minimal");
    expect(discreteThinkingLevel(plain, "xhigh")).toBe("high");
    const mapped = {
      reasoning: true,
      thinkingLevelMap: { low: "LOW", medium: "high", high: 32768 },
    };
    expect(discreteThinkingLevel(mapped, "low")).toBe("low");
    expect(discreteThinkingLevel(mapped, "medium")).toBe("high");
    expect(discreteThinkingLevel(mapped, "high")).toBeUndefined();
    expect(
      discreteThinkingLevel({ reasoning: true, thinkingLevelMap: { low: "dynamic" } }, "low"),
    ).toBeUndefined();
  });

  it("isThinkingLevel", () => {
    expect(isThinkingLevel("xhigh")).toBe(true);
    expect(isThinkingLevel("max")).toBe(false);
  });
});
