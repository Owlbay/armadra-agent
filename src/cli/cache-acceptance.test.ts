/**
 * 模型调用效率整体验收（docs/model-efficiency-plan.md §4 第 1 条）：组装后的会话跑
 * 「20 回合（中途加工具、删工具）→ 退出 → 改 AGENTS.md → resume → /compact → 再 10 回合」，
 * 发给供应商的 system 全程逐字节相同；工具表只在加工具那一次末尾追加一项，之后（含删工具、
 * resume、压缩）逐字节不变；会话文件里 system 条目只有 1 条全量，其余都是补丁。
 * 单项行为（移除提醒、压缩后补丁位置、AGENTS.md 提醒）由 cache-stability.test.ts 分别覆盖。
 */

import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { buildAnthropicRequest } from "../ai/apis/anthropic-request.js";
import { buildOpenAIRequest } from "../ai/apis/openai-request.js";
import type { FakeResponse } from "../ai/fake/fake-script.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import type { Model, SystemMessage, TranscriptContext } from "../ai/types.js";
import type { AgentSessionImpl } from "../agent/session.js";
import type { ToolDefinition } from "../tools/types.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

const registry = new ProviderRegistry({ keys: { useEnv: false, userAuthFile: null } });
const anthropic = registry.get("anthropic")?.models[0] as Model;
const openai = registry.get("openai")?.models[0] as Model;
const signal = new AbortController().signal;

type Json = Record<string, unknown>;

const stripCache = (items: unknown): unknown =>
  JSON.parse(JSON.stringify(items ?? null), (key, value) =>
    key === "cache_control" ? undefined : value,
  );

function prefix(context: TranscriptContext): { system: string; tools: Json[] } {
  const a = buildAnthropicRequest(anthropic, context, { signal, cacheRetention: "short" }).body;
  const o = buildOpenAIRequest(openai, context, { signal }).body;
  return {
    system: JSON.stringify([a["system"], (o["messages"] as Json[])[0]]),
    tools: [...(stripCache(a["tools"]) as Json[]), ...(o["tools"] as Json[])],
  };
}

const note: ToolDefinition = {
  name: "canvas_note",
  description: "Post a note on the canvas.",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  permission: "read",
  execute: async () => ({ content: "ok" }),
};

/** 30 回合：每 4 回合一次 read；之后一直回摘要形状的文本（摘要请求与收尾回合共用）。 */
function script(): FakeResponse[] {
  const out: FakeResponse[] = [];
  for (let i = 0; i < 20; i++) {
    if (i % 4 === 0)
      out.push({ steps: [{ toolCall: { name: "read", arguments: { path: "AGENTS.md" } } }] });
    out.push({ text: `answer ${i}` });
  }
  out.push({ text: "## Goal\nok" });
  return out;
}

describe("模型调用效率整体验收：前缀不变量（§4-1）", () => {
  it("20 回合 + 加工具 + 删工具 + resume 改 AGENTS.md + /compact + 10 回合：system 全程相同，工具表只追加一次", async () => {
    h = composeHarness();
    h.fake.setScript({ version: 1, responses: script(), whenExhausted: "repeat-last" });
    h.home.write("work/AGENTS.md", "project rules v1");
    const first = await h.boot(["--model", "fake/echo"]);
    const all = first.session.getTools().map((tool) => tool.name);
    expect(all).toContain("bash");
    const marks: Record<string, number> = {};
    const turn = () => h.fake.calls.filter((c) => c.options.purpose !== "summary").length;
    for (let i = 0; i < 20; i++) {
      if (i === 8) {
        marks["added"] = turn();
        (first.session as AgentSessionImpl).addTool(note);
      }
      if (i === 14) first.session.setActiveTools([...all.filter((n) => n !== "bash"), note.name]);
      await first.session.prompt(`question ${i}`);
    }
    await first.dispose();

    h.home.write("work/AGENTS.md", "project rules v2");
    const resumed = await h.boot(["--model", "fake/echo", "--continue"]);
    marks["resume"] = turn();
    await resumed.session.prompt("after resume");
    marks["compact"] = turn();
    await resumed.session.compact();
    for (let i = 0; i < 10; i++) await resumed.session.prompt(`tail ${i}`);
    expect(resumed.session.entries.filter((e) => e.type === "compaction")).toHaveLength(1);

    const turns = h.fake.calls.filter((c) => c.options.purpose !== "summary");
    expect(turns.length).toBe(20 + 5 + 1 + 10);
    const head = prefix(turns[0]!.context);
    expect(head.system).toContain("project rules v1");
    const grown = prefix(turns[marks["added"]!]!.context).tools;
    // 加工具：Anthropic 与 OpenAI 两份工具表各在末尾多一项，前面不变
    const half = head.tools.length / 2;
    expect(grown).toHaveLength(head.tools.length + 2);
    expect(JSON.stringify(grown.slice(0, half))).toBe(JSON.stringify(head.tools.slice(0, half)));
    expect(grown[half]?.["name"]).toBe("canvas_note");
    turns.forEach((call, i) => {
      const p = prefix(call.context);
      expect(p.system, `turn ${i}`).toBe(head.system);
      const tools = i < marks["added"]! ? head.tools : grown;
      expect(JSON.stringify(p.tools), `turn ${i}`).toBe(JSON.stringify(tools));
    });
    // 压缩前与压缩后各段内：上一次请求的消息逐条是下一次的前缀
    const sent = (i: number): string[] =>
      (buildOpenAIRequest(openai, turns[i]!.context, { signal }).body["messages"] as Json[]).map(
        (m) => JSON.stringify(m),
      );
    for (let i = 1; i < turns.length; i++) {
      if (i === marks["compact"]) continue;
      const prev = sent(i - 1);
      expect(sent(i).slice(0, prev.length), `turn ${i}`).toEqual(prev);
    }
    const r = marks["resume"]!;
    const resumeTail = sent(r)
      .slice(sent(r - 1).length)
      .join("\n");
    expect(resumeTail).toContain("project rules v2");
    expect(resumeTail).toContain('Tool \\"bash\\" is available again.');
    expect(resumeTail).toContain('Tool \\"canvas_note\\" is no longer available');

    const systems = resumed.session.entries.flatMap((e) =>
      e.type === "message" && e.message.role === "system" ? [e.message as SystemMessage] : [],
    );
    expect(systems.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(systems[0]!.sections)).toContain("preamble");
    for (const patch of systems.slice(1)) expect(patch.sections["preamble"]).toBeUndefined();
    await resumed.dispose();
  });
});
