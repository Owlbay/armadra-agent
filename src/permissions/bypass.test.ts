import { describe, expect, it } from "vitest";
import { createBypassGate } from "./bypass.js";

describe("Bypass 确认闸门", () => {
  it("非 Bypass 同步放行不问；Bypass 首次问，确认后不再问；取消后下次还问", async () => {
    let asked = 0;
    const answers = [false, true];
    const gate = createBypassGate(async () => {
      asked++;
      return answers.shift() ?? false;
    });
    expect(gate("auto")).toBe(true);
    expect(gate("allowlist")).toBe(true);
    expect(await gate("full-auto")).toBe(false);
    expect(await gate("full-auto")).toBe(true);
    expect(gate("full-auto")).toBe(true);
    expect(asked).toBe(2);
  });

  it("启动时已在 Bypass：视为已确认", () => {
    const gate = createBypassGate(async () => {
      throw new Error("不该问");
    }, true);
    expect(gate("full-auto")).toBe(true);
  });
});
