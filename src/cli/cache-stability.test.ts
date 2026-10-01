/**
 * 缓存保证（设计 §9.1）：组装后的会话连续 20 回合，发给供应商的 system + tools 部分逐字节相同；
 * 宿主中途注册工具后，system 不变、工具表只在末尾追加；缓存命中率统计。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  composeHarness,
  recordingHost,
  type ComposeHarness,
} from "../../test/helpers/compose-harness.js";
import { buildAnthropicRequest } from "../ai/apis/anthropic-request.js";
import { buildOpenAIRequest } from "../ai/apis/openai-request.js";
import type { FakeResponse } from "../ai/fake/fake-script.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import type { Model, TranscriptContext } from "../ai/types.js";
import type { HostApi } from "../host/types.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

const registry = new ProviderRegistry({ keys: { useEnv: false, userAuthFile: null } });
const anthropic = registry.get("anthropic")?.models[0] as Model;
const openai = registry.get("openai")?.models[0] as Model;
const signal = new AbortController().signal;

type Json = Record<string, unknown>;

function stripCache(items: unknown): unknown {
  return JSON.parse(JSON.stringify(items ?? null), (key, value) =>
    key === "cache_control" ? undefined : value,
  );
}

/** 每次请求的「前缀」：Anthropic 的 system 块 + tools；OpenAI 的首条 system 消息 + tools。 */
function prefixes(context: TranscriptContext): { anthropic: Json; openai: Json } {
  const a = buildAnthropicRequest(anthropic, context, { signal, cacheRetention: "short" }).body;
  const o = buildOpenAIRequest(openai, context, { signal }).body;
  return {
    anthropic: { system: a["system"], tools: stripCache(a["tools"]) },
    openai: { system: (o["messages"] as Json[])[0], tools: o["tools"] },
  };
}

/** 20 回合：每三回合一次 read 工具调用（工具结果也进上下文）。 */
function script(rounds: number): FakeResponse[] {
  const out: FakeResponse[] = [];
  for (let i = 0; i < rounds; i++) {
    if (i % 3 === 0)
      out.push({ steps: [{ toolCall: { name: "read", arguments: { path: "AGENTS.md" } } }] });
    out.push({
      text: `answer ${i}`,
      usage: { input: 100, output: 5, cacheRead: i === 0 ? 0 : 900, cacheWrite: i === 0 ? 900 : 0 },
    });
  }
  return out;
}

describe("缓存保证（设计 §9.1）", () => {
  it("连续 20 回合 system + tools 逐字节相同；缓存命中率 = cacheRead /（input + cacheRead + cacheWrite）", async () => {
    h = composeHarness(script(20));
    h.home.write("work/AGENTS.md", "project rules");
    h.home.write(
      "home/.config/ama/skills/review/SKILL.md",
      "---\nname: review\ndescription: Review code\n---\nbody\n",
    );
    const runtime = await h.boot(["--model", "fake/echo"]);
    for (let i = 0; i < 20; i++) await runtime.session.prompt(`question ${i}`);
    expect(h.fake.calls.length).toBeGreaterThanOrEqual(27);
    const first = prefixes(h.fake.calls[0]!.context);
    expect(JSON.stringify(first.anthropic)).toContain("project rules");
    for (const call of h.fake.calls) {
      const p = prefixes(call.context);
      expect(JSON.stringify(p.anthropic)).toBe(JSON.stringify(first.anthropic));
      expect(JSON.stringify(p.openai)).toBe(JSON.stringify(first.openai));
    }
    const systems = runtime.session.entries.filter(
      (e) => e.type === "message" && e.message.role === "system",
    );
    expect(systems).toHaveLength(1);
    const stats = runtime.session.getStats();
    const { input, cacheRead, cacheWrite } = stats.tokens;
    expect(stats.cacheHitRate).toBeCloseTo(cacheRead / (input + cacheRead + cacheWrite));
    expect(stats.cacheHitRate).toBeGreaterThan(0);
    await runtime.dispose();
  });

  it("宿主中途注册工具：system 不变，工具表在末尾追加，转录只多一条补丁", async () => {
    h = composeHarness();
    const host = recordingHost(h.home);
    const runtime = await h.boot(["--model", "fake/echo", "--host", host.path]);
    for (let i = 0; i < 3; i++) await runtime.session.prompt(`q${i}`);
    const before = prefixes(h.fake.calls.at(-1)!.context);
    const api = (globalThis as Record<string, unknown>)["__amaHostEventsApi"] as HostApi;
    api.tools.register({
      name: "canvas_note",
      description: "Post a note on the canvas.",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      permission: "read",
      promptGuidelines: ["Use canvas_note for status."],
      execute: async () => ({ content: "ok" }),
    });
    for (let i = 0; i < 3; i++) await runtime.session.prompt(`r${i}`);
    expect(runtime.session.getTools().map((t) => t.name)).toContain("canvas_note");
    for (const call of h.fake.calls.slice(-3)) {
      const after = prefixes(call.context);
      expect(JSON.stringify(after.anthropic["system"])).toBe(
        JSON.stringify(before.anthropic["system"]),
      );
      expect(JSON.stringify(after.openai["system"])).toBe(JSON.stringify(before.openai["system"]));
      const tools = after.anthropic["tools"] as Json[];
      expect(JSON.stringify(tools.slice(0, -1))).toBe(JSON.stringify(before.anthropic["tools"]));
      expect(tools.at(-1)?.["name"]).toBe("canvas_note");
    }
    const systems = runtime.session.entries.flatMap((e) =>
      e.type === "message" && e.message.role === "system" ? [e.message] : [],
    );
    expect(systems).toHaveLength(2);
    expect(systems[1]).toMatchObject({ sections: {} });
    expect(systems[1]?.toolsAdded?.map((t) => t.name)).toEqual(["canvas_note"]);
    await runtime.dispose();
  });
});
