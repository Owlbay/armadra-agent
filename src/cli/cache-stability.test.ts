/**
 * 缓存保证（设计 §9.1）：组装后的会话连续 20 回合，发给供应商的 system + tools 部分逐字节相同；
 * 宿主中途注册工具后，system 不变、工具表只在末尾追加；缓存命中率统计。
 * 第三波 §1.5 / §1.8：25 回合里一次服务端淘汰只报一次 `cache_miss{evicted}`；`/compact` 的
 * 摘要请求以上一次真实请求为逐字节前缀续写，压缩后的首个请求是重置点不算未命中。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeHarness,
  recordingHost,
  type ComposeHarness,
} from "../../test/helpers/compose-harness.js";
import { buildAnthropicRequest } from "../ai/apis/anthropic-request.js";
import { buildOpenAIRequest } from "../ai/apis/openai-request.js";
import type { FakeResponse } from "../ai/fake/fake-script.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import type { Model, SystemMessage, TranscriptContext } from "../ai/types.js";
import type { SessionEvent } from "../agent/types.js";
import type { AgentSessionImpl } from "../agent/session.js";
import { changedSections, fingerprintContext } from "../ai/cache/fingerprint.js";
import { detectMiss } from "../ai/cache/miss.js";
import { sharedCacheReporting } from "../ai/cache/reporting.js";
import { record } from "../agent/testing/cache-records.js";
import { missReasonText } from "../modes/session-report.js";
import type { SessionEntry } from "../session/types.js";
import { SUMMARY_CONTINUATION_PREAMBLE } from "../compaction/summarize-tier.js";
import type { HostApi } from "../host/types.js";

let h: ComposeHarness;
afterEach(() => {
  h?.cleanup();
  vi.useRealTimers();
});

const registry = new ProviderRegistry({ keys: { useEnv: false, userAuthFile: null } });
const anthropic = registry.get("anthropic")?.models[0] as Model;
const openai = registry.get("openai")?.models[0] as Model;
const deepseek = registry.get("deepseek")?.models[0] as Model;
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

  it("resume 时 AGENTS.md 变了：开头 system + tools 不变，上一次请求的消息逐条是前缀，新内容在尾部提醒里", async () => {
    h = composeHarness([{ text: "a" }, { text: "b" }]);
    h.home.write("work/AGENTS.md", "project rules v1");
    const first = await h.boot(["--model", "fake/echo"]);
    await first.session.prompt("q0");
    await first.dispose();
    h.home.write("work/AGENTS.md", "project rules v2");
    const resumed = await h.boot(["--model", "fake/echo", "--continue"]);
    await resumed.session.prompt("q1");
    const [a, b] = h.fake.calls.map((call) => call.context) as [
      TranscriptContext,
      TranscriptContext,
    ];
    expect(JSON.stringify(prefixes(b))).toBe(JSON.stringify(prefixes(a)));
    expect(JSON.stringify(prefixes(a).anthropic)).toContain("project rules v1");
    const sent = (context: TranscriptContext): Json[] =>
      buildOpenAIRequest(deepseek, context, { signal }).body["messages"] as Json[];
    const before = sent(a);
    const after = sent(b);
    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    const tail = JSON.stringify(after.slice(before.length));
    expect(tail).toContain("<system-reminder>");
    expect(tail).toContain("project rules v2");
    await resumed.dispose();
  });
});

describe("auto 权限模式的分类请求不影响主会话缓存（§7.4）", () => {
  it("6 回合各分类一次：主会话请求 system + tools 逐字节相同、消息逐次为前缀；分类请求独立且不进转录", async () => {
    const out: FakeResponse[] = [];
    for (let i = 0; i < 6; i++) {
      out.push({
        steps: [{ toolCall: { name: "bash", arguments: { command: `node --version ${i}` } } }],
      });
      out.push({ text: '{"decision":"allow","reason":"prints the node version"}' });
      out.push({ text: `answer ${i}` });
    }
    h = composeHarness(out);
    const runtime = await h.boot(["--model", "fake/echo", "--permission-mode", "auto"]);
    for (let i = 0; i < 6; i++) await runtime.session.prompt(`question ${i}`);
    const classify = h.fake.calls.filter((c) => c.options.purpose === "classify");
    const main = h.fake.calls.filter((c) => c.options.purpose !== "classify");
    expect(classify).toHaveLength(6);
    expect(main).toHaveLength(12);
    const first = prefixes(main[0]!.context);
    for (let i = 0; i < main.length; i++) {
      const p = prefixes(main[i]!.context);
      expect(JSON.stringify(p.anthropic)).toBe(JSON.stringify(first.anthropic));
      expect(JSON.stringify(p.openai)).toBe(JSON.stringify(first.openai));
      if (i === 0) continue;
      const prev = main[i - 1]!.context.messages;
      expect(JSON.stringify(main[i]!.context.messages.slice(0, prev.length))).toBe(
        JSON.stringify(prev),
      );
      expect(JSON.stringify(main[i]!.context)).not.toContain("tool_call_data");
    }
    for (const call of classify) {
      expect(call.context.messages).toHaveLength(2);
      expect(call.options).toMatchObject({ cacheRetention: "none" });
    }
    const results = runtime.session.messages.filter((m) => m.role === "toolResult");
    expect(results.every((m) => m.isError !== true)).toBe(true);
    const usage = runtime.session.entries.filter(
      (e) => e.type === "usage" && e.kind === "permission_classify",
    );
    expect(usage).toHaveLength(6);
    await runtime.dispose();
  });
});

/** 25 回合：第 `miss` 回合服务端淘汰（读 0），第 `compactAfter` 回合后手动压缩。 */
function evictionScript(rounds: number, miss: number, compactAfter: number): FakeResponse[] {
  const out: FakeResponse[] = [];
  const prompt = (i: number) => 30_000 + 500 * i;
  for (let i = 0; i < rounds; i++) {
    const p = prompt(i);
    let usage: FakeResponse["usage"];
    if (i === 0) usage = { input: 0, cacheWrite: p, output: 5 };
    else if (i === miss || i === compactAfter + 1) usage = { input: p, output: 5 };
    else usage = { input: 500, cacheRead: p - 500, output: 5 };
    out.push({ text: `answer ${i}`, usage });
    if (i === compactAfter) {
      // 手动压缩切在最后一条助手消息上（split turn）：历史与回合前缀各一份摘要
      out.push({ text: "## Goal\ncheckpoint", usage: { input: 300, cacheRead: p, output: 50 } });
      out.push({ text: "## Turn So Far\nq", usage: { input: 300, cacheRead: p, output: 20 } });
    }
  }
  return out;
}

describe("未命中与摘要续写（第三波 §1.5 / §1.8）", () => {
  it("25 回合：一次淘汰只报一次 evicted；/compact 续写上一次真实请求的逐字节前缀；压缩后首个请求不算未命中", async () => {
    const rounds = 25;
    const missAt = 9;
    const compactAfter = 17;
    h = composeHarness(evictionScript(rounds, missAt, compactAfter));
    h.home.write("work/AGENTS.md", "project rules");
    const runtime = await h.boot(["--model", "fake/echo"]);
    const events: SessionEvent[] = [];
    runtime.session.subscribe((event) => events.push(event));
    for (let i = 0; i < rounds; i++) {
      await runtime.session.prompt(`question ${i}`);
      if (i === compactAfter) await runtime.session.compact();
    }
    expect(h.fake.calls).toHaveLength(rounds + 2);
    const first = prefixes(h.fake.calls[0]!.context);
    for (const call of h.fake.calls) {
      const p = prefixes(call.context);
      expect(JSON.stringify(p.anthropic)).toBe(JSON.stringify(first.anthropic));
      expect(JSON.stringify(p.openai)).toBe(JSON.stringify(first.openai));
    }

    const turn = h.fake.calls[compactAfter]!;
    const summary = h.fake.calls[compactAfter + 1]!;
    for (const call of h.fake.calls.slice(compactAfter + 1, compactAfter + 3)) {
      expect(call.options).toMatchObject({ purpose: "summary" });
      expect(call.options).not.toHaveProperty("toolChoice");
    }
    const last = summary.context.messages.at(-1);
    expect(last?.role === "user" && String(last.content)).toMatch(
      new RegExp(`^${SUMMARY_CONTINUATION_PREAMBLE.slice(0, 20)}`),
    );
    const n = turn.context.messages.length;
    expect(JSON.stringify(summary.context.messages.slice(0, n))).toBe(
      JSON.stringify(turn.context.messages),
    );

    const misses = events.filter((e) => e.type === "cache_miss");
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({
      reason: "evicted",
      missedTokens: 30_000 + 500 * (missAt - 1),
    });
    const cache = runtime.session.getStats().cache!;
    expect(cache).toMatchObject({
      reporting: "reported",
      misses: { count: 1, byReason: { evicted: 1 } },
    });
    expect(cache.lastHitRate).toBeGreaterThan(0.98);
    expect(cache.warming).toMatchObject({ state: "stopped", reason: "no_ttl" });
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// [ME-B] 开头只写一次（D4 / D5）、档一 / 档二边界（D6）、按节指纹（D15）、软窗口（D16）
// ---------------------------------------------------------------------------

/** 用配置整条声明 fake/echo（fake 供应商不读 modelOverrides）。 */
function fakeEchoConfig(model: Json = {}, extra: Json = {}): Json {
  return {
    version: 1,
    providers: {
      fake: {
        api: "fake",
        baseUrl: "fake://local",
        requiresApiKey: false,
        models: [
          {
            id: "echo",
            contextWindow: 200_000,
            cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
            ...model,
          },
        ],
      },
    },
    ...extra,
  };
}

/** 脚本用完后一直重复最后一条（摘要请求的次数随切点变化，不逐条写）。 */
function harnessRepeating(...responses: FakeResponse[]): ComposeHarness {
  const harness = composeHarness();
  harness.fake.setScript({ version: 1, responses, whenExhausted: "repeat-last" });
  return harness;
}

const turnCalls = () => h.fake.calls.filter((c) => c.options.purpose !== "summary");
const summaryCalls = () => h.fake.calls.filter((c) => c.options.purpose === "summary");
const sentMessages = (context: TranscriptContext): Json[] =>
  buildOpenAIRequest(deepseek, context, { signal }).body["messages"] as Json[];

describe("开头只写一次（ME D4 / D5）", () => {
  it("压缩前有补丁：压缩后首个请求 system + tools 与压缩前逐字节相同，补丁在摘要后的提醒里；再压缩一次仍相同", async () => {
    h = harnessRepeating({ text: "## Goal\nok" });
    h.home.write("work/AGENTS.md", "project rules v1");
    const first = await h.boot(["--model", "fake/echo"]);
    await first.session.prompt("q0");
    await first.dispose();
    h.home.write("work/AGENTS.md", "project rules v2");
    const resumed = await h.boot(["--model", "fake/echo", "--continue"]);
    await resumed.session.prompt("q1");
    await resumed.session.prompt("q2");
    await resumed.session.compact();
    await resumed.session.prompt("q3");
    await resumed.session.prompt("q4");
    await resumed.session.compact();
    await resumed.session.prompt("q5");
    expect(resumed.session.entries.filter((e) => e.type === "compaction")).toHaveLength(2);

    const turns = turnCalls();
    expect(turns).toHaveLength(6);
    const head = JSON.stringify(prefixes(turns[0]!.context));
    expect(head).toContain("project rules v1");
    for (const call of turns) expect(JSON.stringify(prefixes(call.context))).toBe(head);
    for (const call of [turns[3]!, turns[5]!]) {
      const [summary, reminder] = sentMessages(call.context).slice(1);
      expect(String(summary?.["content"])).toContain("<summary>");
      expect(String(reminder?.["content"])).toMatch(/^<system-reminder>\n/);
      expect(String(reminder?.["content"])).toContain("project rules v2");
    }
    // 会话文件里仍只有一条全量 system + 一条补丁（检查点与合成补丁不落盘）
    const systems = resumed.session.entries.filter(
      (e) => e.type === "message" && e.message.role === "system",
    );
    expect(systems).toHaveLength(2);
    // 首个请求不含提醒（prompt-budget 只量首个请求，提醒文案不进预算）
    expect(JSON.stringify(turns[0]!.context)).not.toContain("<system-reminder>");
    await resumed.dispose();
  });

  it("移除工具：声明保留、尾部提醒，调用被拒；加回只提醒 available again；system + tools 与指纹始终不变", async () => {
    h = composeHarness([
      { text: "a" },
      { text: "b" },
      { steps: [{ toolCall: { name: "bash", arguments: { command: "echo hi" } } }] },
      { text: "c" },
      { text: "d" },
    ]);
    const runtime = await h.boot(["--model", "fake/echo"]);
    const all = runtime.session.getTools().map((tool) => tool.name);
    expect(all).toContain("bash");
    await runtime.session.prompt("q0");
    runtime.session.setActiveTools(all.filter((name) => name !== "bash"));
    await runtime.session.prompt("q1");
    await runtime.session.prompt("q2");
    runtime.session.setActiveTools(all);
    await runtime.session.prompt("q3");

    const calls = h.fake.calls;
    expect(calls).toHaveLength(5);
    const head = JSON.stringify(prefixes(calls[0]!.context));
    const fingerprint = JSON.stringify(fingerprintContext(calls[0]!.context, anthropic));
    for (let i = 0; i < calls.length; i++) {
      expect(JSON.stringify(prefixes(calls[i]!.context))).toBe(head);
      expect(JSON.stringify(fingerprintContext(calls[i]!.context, anthropic))).toBe(fingerprint);
      if (i === 0) continue;
      const prev = sentMessages(calls[i - 1]!.context);
      expect(JSON.stringify(sentMessages(calls[i]!.context).slice(0, prev.length))).toBe(
        JSON.stringify(prev),
      );
    }
    const tail = (i: number) => JSON.stringify(sentMessages(calls[i]!.context).slice(-2));
    expect(tail(1)).toContain('Tool \\"bash\\" is no longer available in this session');
    const rejected = runtime.session.messages.find(
      (m) => m.role === "toolResult" && m.toolName === "bash",
    );
    expect(rejected).toMatchObject({ isError: true });
    expect(JSON.stringify(rejected)).toContain('Tool \\"bash\\" is not available in this session.');
    expect(tail(4)).toContain('Tool \\"bash\\" is available again.');
    await runtime.dispose();
  });
});

/** n 次 read（各读一个约 `chars` 字符的文件），之后回文本 `final`。 */
function readLoop(n: number, final: FakeResponse, chars = 8000): FakeResponse[] {
  for (let i = 0; i < n; i++)
    h.home.write(`work/f${i}.txt`, `${"x".repeat(79)}\n`.repeat(Math.ceil(chars / 80)));
  const out: FakeResponse[] = [];
  for (let i = 0; i < n; i++)
    out.push({ steps: [{ toolCall: { name: "read", arguments: { path: `f${i}.txt` } } }] });
  return [...out, final];
}

let runtimeEntries: readonly SessionEntry[] = [];
const prunes = () =>
  runtimeEntries.filter((e) => e.type === "context_edit" && e.reason === "prune");

describe("档一 / 档二边界（ME D6）", () => {
  const config = fakeEchoConfig(
    { contextWindow: 60_000 },
    { compaction: { prune: { clearAtLeast: 2000 } }, cache: { warming: "off" } },
  );

  // 窗口 60k、预留 16k → 预算 43.6k；8 个结果可裁约 6k。52k：裁完仍超预算、续写放得进窗口；38k：裁完就够
  it("裁完仍超预算：不裁、直接以上一次请求为前缀续写摘要；裁完够：只裁不摘要", async () => {
    sharedCacheReporting.clear();
    h = harnessRepeating();
    h.home.write("home/.config/ama/config.json", config);
    h.fake.setScript({
      version: 1,
      responses: [...readLoop(8, { text: "a", usage: { input: 52_000 } }), { text: "## Goal\ns" }],
      whenExhausted: "repeat-last",
    });
    const runtime = await h.boot(["--model", "fake/echo"]);
    await runtime.session.prompt("read them all");
    await runtime.session.prompt("next");
    runtimeEntries = runtime.session.entries;
    const at = runtimeEntries.findIndex((e) => e.type === "compaction");
    expect(at).toBeGreaterThan(0);
    expect(prunes()).toEqual([]);
    const lastTurn = h.fake.calls[8]!;
    const summary = summaryCalls()[0]!;
    expect(summary.options.cacheRetention).not.toBe("none");
    const n = lastTurn.context.messages.length;
    expect(JSON.stringify(summary.context.messages.slice(0, n))).toBe(
      JSON.stringify(lastTurn.context.messages),
    );
    await runtime.dispose();

    sharedCacheReporting.clear();
    h.cleanup();
    h = harnessRepeating();
    h.home.write("home/.config/ama/config.json", config);
    h.fake.setScript({
      version: 1,
      responses: [...readLoop(8, { text: "a", usage: { input: 38_000 } }), { text: "b" }],
      whenExhausted: "repeat-last",
    });
    const second = await h.boot(["--model", "fake/echo"]);
    await second.session.prompt("read them all");
    await second.session.prompt("next");
    runtimeEntries = second.session.entries;
    expect(prunes().length).toBeGreaterThan(0);
    expect(runtimeEntries.some((e) => e.type === "compaction")).toBe(false);
    expect(summaryCalls()).toEqual([]);
    await second.dispose();
  });

  it("缓存已冷（目录 TTL 300 s，空闲 600 s）：不续写，摘要走独立请求（cacheRetention none）", async () => {
    sharedCacheReporting.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    h = harnessRepeating(
      { text: "a", usage: { input: 0, cacheWrite: 5000 } },
      { text: "b", usage: { input: 0, cacheWrite: 55_000 } },
      { text: "## Goal\ns" },
    );
    h.home.write(
      "home/.config/ama/config.json",
      fakeEchoConfig(
        { contextWindow: 60_000, promptCache: { short: 300 } },
        {
          cache: { warming: "off" },
        },
      ),
    );
    const runtime = await h.boot(["--model", "fake/echo"]);
    await runtime.session.prompt("q0");
    await runtime.session.prompt("q1");
    vi.setSystemTime(1_000_000 + 600_000);
    expect((runtime.session as AgentSessionImpl).cache.isCold()).toBe(true);
    await runtime.session.prompt("q2");
    expect(runtime.session.entries.some((e) => e.type === "compaction")).toBe(true);
    const summaries = summaryCalls();
    expect(summaries.length).toBeGreaterThan(0);
    for (const call of summaries) expect(call.options.cacheRetention).toBe("none");
    expect(summaries[0]!.context.messages.at(-1)).not.toMatchObject({
      content: expect.stringMatching(new RegExp(`^${SUMMARY_CONTINUATION_PREAMBLE.slice(0, 20)}`)),
    });
    await runtime.dispose();
  });
});

describe("按节指纹与软窗口（ME D15 / D16）", () => {
  it("只有 hooks 节变了：cache_miss.detail 为 system:hooks，提示文案带节名", async () => {
    h = composeHarness();
    const runtime = await h.boot(["--model", "fake/echo"]);
    await runtime.session.prompt("q0");
    const context = h.fake.calls[0]!.context;
    const [head, ...rest] = context.messages;
    expect(head?.role).toBe("system");
    const changed: TranscriptContext = {
      messages: [
        {
          ...(head as SystemMessage),
          sections: { ...(head as SystemMessage).sections, hooks: "h" },
        },
        ...rest,
      ],
    };
    const a = fingerprintContext(context, anthropic);
    const b = fingerprintContext(changed, anthropic);
    expect(Object.keys(a.sections ?? {})).toContain("preamble");
    expect(changedSections(a, b)).toEqual(["hooks"]);
    const miss = detectMiss(
      record({ cacheWrite: 30_000, fingerprint: a }),
      record({ at: 1000, input: 30_000, fingerprint: b }),
      300_000,
      { reporting: "reported" },
    );
    expect(miss).toMatchObject({ reason: "prefix_changed", detail: "system:hooks" });
    expect(missReasonText(miss!)).toContain("hooks");
    await runtime.dispose();
  });

  it("compaction.contextBudget 64k：1M 窗口的模型按 64k 裁剪与给阈值；不设则不裁", async () => {
    const run = async (compaction: Json): Promise<SessionEntry[]> => {
      sharedCacheReporting.clear();
      h?.cleanup();
      h = harnessRepeating();
      h.home.write(
        "home/.config/ama/config.json",
        fakeEchoConfig({ contextWindow: 1_000_000 }, { compaction, cache: { warming: "off" } }),
      );
      h.fake.setScript({ version: 1, responses: readLoop(10, { text: "done" }, 16_000) });
      const runtime = await h.boot(["--model", "fake/echo"]);
      await runtime.session.prompt("read them all");
      const stats = runtime.session.getStats().context;
      const budget = (compaction["contextBudget"] as number | undefined) ?? 1_000_000;
      expect(stats?.autoCompactAt).toBe(budget - 16_384);
      expect(stats?.pruneAt).toBe(Math.floor(0.7 * (budget - 16_384)));
      const entries = [...runtime.session.entries];
      await runtime.dispose();
      return entries;
    };
    const isPrune = (e: SessionEntry) => e.type === "context_edit" && e.reason === "prune";
    const soft = await run({ contextBudget: 65_536, prune: { clearAtLeast: 2000 } });
    expect(soft.filter(isPrune).length).toBeGreaterThan(0);
    expect(soft.some((e) => e.type === "compaction")).toBe(false);
    const full = await run({ prune: { clearAtLeast: 2000 } });
    expect(full.filter(isPrune)).toEqual([]);
  });
});
