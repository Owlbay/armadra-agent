import { describe, expect, it } from "vitest";
import { baseRules, DESTRUCTIVE_RULE, PARALLEL_READS_RULE } from "./prompt-rules.js";

describe("系统提示通用规则", () => {
  it("有工具才给；并行只读的提示只在 read 直接可用时给", () => {
    expect(baseRules([])).toEqual([]);
    expect(baseRules([{ name: "bash" }, { name: "read" }])).toEqual([
      DESTRUCTIVE_RULE,
      PARALLEL_READS_RULE,
    ]);
    expect(baseRules([{ name: "codemode" }])).toEqual([DESTRUCTIVE_RULE]);
  });
});
