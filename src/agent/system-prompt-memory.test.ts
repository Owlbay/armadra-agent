/**
 * `SECTION_ORDER` 的 memory 节（docs/history/wave6-plan.md §3.4；[W6-C0]）：在 skills 之后、hooks 之前；
 * 不给时节为 undefined，系统提示字节不变。
 */

import { describe, expect, it } from "vitest";
import { SECTION_ORDER, assembleSections, definedSections } from "./system-prompt.js";

describe("memory 节", () => {
  it("位置：skills → memory → hooks", () => {
    const order = [...SECTION_ORDER];
    expect(order.indexOf("memory")).toBe(order.indexOf("skills") + 1);
    expect(order.indexOf("hooks")).toBe(order.indexOf("memory") + 1);
  });

  it("不给 memory 时与之前逐字节相同；给了按位置插入", () => {
    const base = {
      tools: [],
      cwd: "/w",
      skillsIndex: "<available_skills></available_skills>",
      hookContext: "hook ctx",
    };
    const without = definedSections(assembleSections(base));
    expect(Object.keys(without)).toEqual(["preamble", "skills", "hooks", "cwd"]);
    expect(JSON.stringify(definedSections(assembleSections({ ...base, memory: "  " })))).toBe(
      JSON.stringify(without),
    );
    const withMemory = definedSections(assembleSections({ ...base, memory: "<memory_index/>" }));
    expect(Object.keys(withMemory)).toEqual(["preamble", "skills", "memory", "hooks", "cwd"]);
  });
});
