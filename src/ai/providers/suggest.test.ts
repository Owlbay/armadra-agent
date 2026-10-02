import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import { closest, describeLookupFailure, editDistance } from "./suggest.js";

let h: ComposeHarness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

describe("候选与报错文案", () => {
  it("editDistance", () => {
    expect(editDistance("packy", "packy")).toBe(0);
    expect(editDistance("pakcy", "packy")).toBe(2);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("deepseek", "deepsek")).toBe(1);
  });

  it("closest：包含关系优先，其次编辑距离；太远的不算", () => {
    const ids = ["claude-sonnet-5", "deepseek-v4-flash", "deepseek-v4-pro", "kimi-k2.5", "gpt-5.4"];
    expect(closest("deepseek-v4-flsh", ids)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(closest("sonnet", ids)).toEqual(["claude-sonnet-5"]);
    expect(closest("zzz", ids)).toEqual([]);
    expect(closest("kimi", ids, 1)).toEqual(["kimi-k2.5"]);
  });

  it("describeLookupFailure 按原因给文案", () => {
    expect(
      describeLookupFailure("p/m@x", {
        ok: false,
        reason: "channel_not_found",
        candidates: ["p/m@chat", "p/m@messages"],
      }),
    ).toBe("渠道不存在：p/m@x；该模型可用渠道：p/m@chat, p/m@messages");
    expect(
      describeLookupFailure("pakcy/m", {
        ok: false,
        reason: "provider_not_found",
        candidates: ["packy"],
      }),
    ).toBe("供应商不存在：pakcy/m；最接近的供应商：packy");
    expect(
      describeLookupFailure("p/zz", { ok: false, reason: "not_found", candidates: [] }),
    ).toContain("ama models list");
  });

  it("CLI：渠道不存在 / 供应商写错 / 模型写错都退出 4 并给出准确原因", async () => {
    h = composeHarness();
    expect(await h.run(["-p", "hi", "--model", "fake/echo@nope"])).toBe(4);
    expect(h.stderr()).toContain("渠道不存在：fake/echo@nope；该模型没有可选渠道");
    h.err.length = 0;
    expect(await h.run(["-p", "hi", "--model", "fkae/echo"])).toBe(4);
    expect(h.stderr()).toContain("供应商不存在：fkae/echo；最接近的供应商：fake");
    h.err.length = 0;
    expect(await h.run(["-p", "hi", "--model", "fake/ecoh"])).toBe(4);
    expect(h.stderr()).toContain("模型不存在：fake/ecoh；最接近的模型：fake/echo");
  });
});
