import { describe, expect, it } from "vitest";
import { baseRules, DESTRUCTIVE_RULE, LOCATE_RULE, PARALLEL_READS_RULE } from "./prompt-rules.js";

describe("系统提示通用规则", () => {
  it("有工具才给；并行只读的提示只在 read 直接可用时给", () => {
    expect(baseRules([])).toEqual([]);
    expect(baseRules([{ name: "bash" }, { name: "read" }])).toEqual([
      DESTRUCTIVE_RULE,
      PARALLEL_READS_RULE,
    ]);
    expect(baseRules([{ name: "codemode" }])).toEqual([DESTRUCTIVE_RULE]);
  });

  it("[S-A] 先定位再读：grep 与 glob 都直接可用才给，缺一个或只有 codemode 都不给", () => {
    const names = (...list: string[]) => list.map((name) => ({ name }));
    expect(baseRules(names("bash", "glob", "grep", "read"))).toEqual([
      DESTRUCTIVE_RULE,
      PARALLEL_READS_RULE,
      LOCATE_RULE,
    ]);
    expect(baseRules(names("bash", "grep", "read"))).not.toContain(LOCATE_RULE);
    expect(baseRules(names("bash", "glob", "read"))).not.toContain(LOCATE_RULE);
    expect(baseRules(names("bash", "edit", "read", "write"))).not.toContain(LOCATE_RULE);
    expect(baseRules(names("codemode"))).toEqual([DESTRUCTIVE_RULE]);
  });
});
