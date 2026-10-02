import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { normalizeContext } from "../ai/context.js";
import { DEFAULT_PREAMBLE } from "../agent/system-prompt.js";

let h: ComposeHarness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function systemOf(harness: ComposeHarness) {
  const call = harness.fake.calls[0];
  if (call === undefined) throw new Error("no request");
  return normalizeContext(call.context);
}

describe("--system-prompt", () => {
  it("缺省 append：作为最后一条规则，preamble 与工具表不变", async () => {
    h = composeHarness([{ text: "ok" }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(0);
    const base = systemOf(h);
    h.cleanup();
    h = composeHarness([{ text: "ok" }]);
    const code = await h.run([
      "-p",
      "hi",
      "--model",
      "fake/echo",
      "--system-prompt",
      "Always answer in French.",
    ]);
    expect(code).toBe(0);
    const system = systemOf(h);
    const rules = system.systemSections.find((s) => s.name === "rules")?.text ?? "";
    expect(rules.endsWith("- Always answer in French.")).toBe(true);
    expect(system.systemSections[0]).toEqual(base.systemSections[0]);
    expect(system.systemSections.find((s) => s.name === "tools")).toEqual(
      base.systemSections.find((s) => s.name === "tools"),
    );
    expect(system.tools).toEqual(base.tools);
  });

  it("replace：替换 preamble，工具表保留；@文件 相对 cwd 读取", async () => {
    h = composeHarness([{ text: "ok" }]);
    h.home.write("work/role.md", "You are a release bot.\n");
    const code = await h.run([
      "-p",
      "hi",
      "--model",
      "fake/echo",
      "--system-prompt",
      "@role.md",
      "--system-prompt-mode",
      "replace",
    ]);
    expect(code).toBe(0);
    const system = systemOf(h);
    expect(system.systemSections[0]).toEqual({ name: "preamble", text: "You are a release bot." });
    expect(system.systemPrompt).not.toContain(DEFAULT_PREAMBLE);
    expect(system.tools.length).toBeGreaterThan(0);
  });

  it("@文件 不存在 → 退出 3；--system-prompt-mode 单独使用 → 2", async () => {
    h = composeHarness([{ text: "ok" }]);
    expect(
      await h.run(["-p", "hi", "--model", "fake/echo", "--system-prompt", "@missing.md"]),
    ).toBe(3);
    expect(h.stderr()).toContain("--system-prompt 文件不存在");
    expect(await h.run(["-p", "hi", "--system-prompt-mode", "replace"])).toBe(2);
    expect(h.fake.calls).toHaveLength(0);
  });
});
