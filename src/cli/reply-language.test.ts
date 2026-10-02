/**
 * D22 `ui.replyLanguage` (W6-S): one English rule appended at the end of the `rules` section at session
 * start; unset = the system prompt is byte-for-byte what it was. Budget: the rule is the only addition.
 */

import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import type { SystemMessage } from "../ai/types.js";
import { replyLanguageRule } from "./compose-session.js";

let h: ComposeHarness | undefined;
afterEach(() => h?.cleanup());

async function systemSections(config?: object): Promise<Record<string, string | null>> {
  h?.cleanup();
  h = composeHarness();
  if (config !== undefined) h.home.write("home/.config/ama/config.json", { version: 1, ...config });
  const runtime = await h.boot(["--model", "fake/echo"]);
  await runtime.session.prompt("hi");
  const system = runtime.session.entries.flatMap((e) =>
    e.type === "message" && e.message.role === "system" ? [e.message as SystemMessage] : [],
  )[0]!;
  await runtime.dispose();
  // temp dirs differ per harness: compare with the root replaced
  const root = h.home.root;
  return Object.fromEntries(
    Object.entries(system.sections).map(([k, v]) => [
      k,
      v === null ? v : v.split(root).join("<root>"),
    ]),
  );
}

describe("ui.replyLanguage", () => {
  it("unset: no rule; set: exactly one rule at the end of rules, nothing else changes", async () => {
    const plain = await systemSections();
    const empty = await systemSections({ ui: { replyLanguage: "  " } });
    const chinese = await systemSections({ ui: { replyLanguage: "Chinese" } });
    expect(JSON.stringify(plain)).not.toContain("Reply to the user");
    expect(empty).toEqual(plain);
    expect(chinese["rules"]).toBe(`${plain["rules"]}\n- ${replyLanguageRule("Chinese")}`);
    const rest = (sections: Record<string, string | null>) => ({ ...sections, rules: null });
    expect(rest(chinese)).toEqual(rest(plain));
    // budget: the only addition is the rule line (≈ 9 tokens)
    const added = JSON.stringify(chinese).length - JSON.stringify(plain).length;
    expect(added).toBe(`\\n- ${replyLanguageRule("Chinese")}`.length);
  });
});
