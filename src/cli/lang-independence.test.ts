/**
 * 语言无关（docs/wave6-plan.md §5.4、D18、D20）：同一脚本在 `AMA_LANG=zh` 与 `en` 下各跑一遍，发给供应商的
 * system + tools + messages 逐字节相同。脚本覆盖会把文本送进模型的路径：工具结果截断标记、读图失败、
 * 拒绝理由、普通工具结果。[W6-C0]
 */

import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { buildAnthropicRequest } from "../ai/apis/anthropic-request.js";
import { buildOpenAIRequest } from "../ai/apis/openai-request.js";
import type { FakeResponse } from "../ai/fake/fake-script.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import type { Model } from "../ai/types.js";
import { setLocale, type Locale } from "../i18n/index.js";

let harnesses: ComposeHarness[] = [];
afterEach(() => {
  for (const h of harnesses) h.cleanup();
  harnesses = [];
  setLocale("zh");
});

const registry = new ProviderRegistry({ keys: { useEnv: false, userAuthFile: null } });
const anthropic = registry.get("anthropic")?.models[0] as Model;
const openai = registry.get("openai")?.models[0] as Model;
const signal = new AbortController().signal;

const SCRIPT: FakeResponse[] = [
  {
    steps: [
      { toolCall: { id: "call_read", name: "read", arguments: { path: "big.txt" } } },
      { toolCall: { id: "call_img", name: "read", arguments: { path: "missing.png" } } },
      { toolCall: { id: "call_bash", name: "bash", arguments: { command: "rm -rf build" } } },
    ],
  },
  { text: "done" },
  { steps: [{ toolCall: { id: "call_small", name: "read", arguments: { path: "AGENTS.md" } } }] },
  { text: "ok" },
];

async function run(locale: Locale): Promise<string[]> {
  setLocale(locale);
  const h = composeHarness(structuredClone(SCRIPT), { env: { AMA_LANG: locale } });
  harnesses.push(h);
  h.home.write("work/AGENTS.md", "project rules");
  h.home.write("work/big.txt", `${"x".repeat(400)}\n`.repeat(40));
  h.home.write("home/.config/ama/config.json", {
    version: 1,
    tools: { maxToolResultChars: 2_000 },
    permission: { deny: ["bash(rm *)"] },
  });
  const runtime = await h.boot(["--model", "fake/echo", "--trust"]);
  await runtime.session.prompt("first");
  await runtime.session.prompt("second");
  await runtime.dispose();
  expect(h.fake.calls.length).toBe(4);
  // 两次运行的临时目录不同：路径换成占位再比
  const roots = [realpathSync(h.home.root), h.home.root, basename(h.home.root)];
  return h.fake.calls.map((call) =>
    roots.reduce(
      (text, root) => text.split(JSON.stringify(root).slice(1, -1)).join("<root>"),
      JSON.stringify({
        anthropic: buildAnthropicRequest(anthropic, call.context, {
          signal,
          cacheRetention: "short",
        }).body,
        openai: buildOpenAIRequest(openai, call.context, { signal }).body,
      }),
    ),
  );
}

describe("发给模型的请求与界面语言无关", () => {
  it("AMA_LANG=zh 与 en 两遍，每次请求体逐字节相同", async () => {
    const zh = await run("zh");
    const en = await run("en");
    expect(en).toEqual(zh);
    // 确实走到了截断、读图失败与拒绝三条路径
    const last = zh.at(-1) ?? "";
    expect(last).toContain("chars omitted");
    expect(last).toContain("missing.png");
    expect(last).toContain("call_bash");
  });
});
