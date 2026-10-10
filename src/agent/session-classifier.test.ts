import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TranscriptContext } from "../ai/types.js";
import { CLASSIFIER_SYSTEM_PROMPT } from "../permissions/classifier.js";
import { PermissionPipeline } from "../permissions/pipeline.js";
import type { ApprovalRequest, AutoDecision } from "../permissions/types.js";
import { SessionManager } from "../session/manager.js";
import { AgentSessionImpl } from "./session.js";
import { CLASSIFY_USAGE_KIND } from "./session-classifier.js";
import { createHarness } from "./testing/harness.js";
import { createScriptedApi, type ScriptCall, type ScriptStep } from "./testing/scripted-api.js";
import { fakeModel, stubRegistry, stubTool } from "./testing/stubs.js";
import type { SessionEvent } from "./types.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "ama-auto-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const bashTool = () =>
  stubTool({
    name: "bash",
    permission: "execute",
    properties: { command: { type: "string" } },
    run: (input) => ({ content: `ran ${String(input["command"])}` }),
  });

const isClassify = (call: ScriptCall): boolean => call.options.purpose === "classify";

function userText(context: TranscriptContext): string {
  const last = context.messages.at(-1);
  return last?.role === "user" && typeof last.content === "string" ? last.content : "";
}

/** 分类请求按命令内容回答；主会话按顺序走 turns。 */
function router(turns: ScriptStep[], verdicts: Record<string, string>) {
  let turn = 0;
  return (call: ScriptCall): ScriptStep => {
    if (isClassify(call)) {
      const text = userText(call.context);
      const key = Object.keys(verdicts).find((k) => text.includes(k));
      return {
        text: key === undefined ? "nonsense" : (verdicts[key] as string),
        usage: { input: 50, output: 8 },
      };
    }
    return turns[turn++] ?? { text: "done" };
  };
}

const ALLOW = '{"decision":"allow","reason":"runs a local generator"}';
const ASK = '{"decision":"ask","reason":"deploys"}';

function endDecisions(events: SessionEvent[]): Record<string, AutoDecision | undefined> {
  const out: Record<string, AutoDecision | undefined> = {};
  for (const e of events) if (e.type === "tool_execution_end") out[e.toolCallId] = e.autoDecision;
  return out;
}

function errorsById(events: SessionEvent[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const e of events) if (e.type === "tool_execution_end") out[e.toolCallId] = e.isError;
  return out;
}

describe("auto 模式接分类器", () => {
  it("静态放行不调模型；未决定的问一次分类器，同样的调用命中缓存；ask 走审批并带 autoDecision", async () => {
    const pipeline = new PermissionPipeline({ mode: "auto", rules: [], cwd });
    const asked: ApprovalRequest[] = [];
    const h = createHarness({
      cwd,
      tools: [bashTool()],
      permission: pipeline,
      brokers: [{ ask: async (r) => (asked.push(r), "deny") }],
      script: router(
        [
          {
            toolCalls: [
              { id: "c1", name: "bash", args: { command: "node gen.js" } },
              { id: "c2", name: "bash", args: { command: "node   gen.js" } },
              { id: "c3", name: "bash", args: { command: "./deploy.sh prod" } },
              { id: "c4", name: "bash", args: { command: "ls -la" } },
              { id: "c5", name: "bash", args: { command: "rm -rf ./build" } },
            ],
          },
          { text: "done" },
        ],
        { "gen.js": ALLOW, "deploy.sh": ASK },
      ),
    });
    await h.session.prompt("generate the code, then deploy");
    const classify = h.scripted.calls.filter(isClassify);
    expect(classify).toHaveLength(2);
    const decisions = endDecisions(h.events);
    expect(decisions["c1"]).toEqual({
      layer: "classifier",
      decision: "allow",
      reason: "runs a local generator",
    });
    expect(decisions["c2"]).toMatchObject({ layer: "classifier", decision: "allow", cached: true });
    expect(decisions["c3"]).toMatchObject({
      layer: "classifier",
      decision: "ask",
      reason: "deploys",
    });
    expect(decisions["c4"]).toMatchObject({ layer: "static", decision: "allow" });
    expect(decisions["c5"]).toMatchObject({ layer: "rule", decision: "ask" });
    expect(asked.map((r) => r.autoDecision?.layer)).toEqual(["classifier", "rule"]);
    const requests = h.events.filter((e) => e.type === "permission_request");
    expect(
      requests.map((e) => (e.type === "permission_request" ? e.autoDecision?.reason : "")),
    ).toEqual(["deploys", "recursive or forced rm"]);
    expect(errorsById(h.events)).toEqual({ c1: false, c2: false, c3: true, c4: false, c5: true });
    expect(pipeline.autoDecisions().map((d) => d.layer)).toEqual([
      "classifier",
      "classifier",
      "classifier",
      "static",
      "rule",
    ]);
  });

  it("分类请求独立：系统提示 + 一条用户消息、不带工具、purpose classify；不进转录，用量记 usage 条目", async () => {
    const pipeline = new PermissionPipeline({ mode: "auto", rules: [], cwd });
    const h = createHarness({
      cwd,
      tools: [bashTool()],
      permission: pipeline,
      script: router(
        [
          { toolCalls: [{ name: "bash", args: { command: "node gen.js" } }] },
          { text: "first" },
          { toolCalls: [{ name: "bash", args: { command: "node other.js" } }] },
          { text: "second" },
        ],
        { "gen.js": ALLOW, "other.js": ALLOW },
      ),
    });
    await h.session.prompt("please generate");
    await h.session.prompt("and the other one");
    const classify = h.scripted.calls.filter(isClassify);
    expect(classify).toHaveLength(2);
    for (const call of classify) {
      expect(call.options).toMatchObject({
        purpose: "classify",
        cacheRetention: "none",
        thinkingLevel: "off",
      });
      expect(call.options.maxTokens).toBeLessThanOrEqual(256);
      expect(call.context.messages).toHaveLength(2);
      const system = call.context.messages[0];
      expect(system?.role === "system" && system.sections["preamble"]).toBe(
        CLASSIFIER_SYSTEM_PROMPT,
      );
      expect(system?.role === "system" && system.toolsAdded).toBeFalsy();
    }
    expect(userText(classify[0]!.context)).toContain("please generate");
    expect(userText(classify[1]!.context)).toContain("and the other one");
    // 主会话请求：每一次都以前一次的消息为前缀，且不含分类器的提示
    const main = h.scripted.calls.filter((c) => !isClassify(c));
    expect(main).toHaveLength(4);
    for (let i = 1; i < main.length; i++) {
      const prev = JSON.stringify(main[i - 1]!.context.messages);
      const cur = JSON.stringify(
        main[i]!.context.messages.slice(0, main[i - 1]!.context.messages.length),
      );
      expect(cur).toBe(prev);
    }
    for (const call of main) expect(JSON.stringify(call.context)).not.toContain("tool_call_data");
    const usage = h.session.entries.filter((e) => e.type === "usage");
    expect(usage.map((e) => (e.type === "usage" ? e.kind : ""))).toEqual([
      CLASSIFY_USAGE_KIND,
      CLASSIFY_USAGE_KIND,
    ]);
    expect(h.session.agent.messages.some((m) => JSON.stringify(m).includes("tool_call_data"))).toBe(
      false,
    );
  });

  it("无人值守：分类器 allow 照常执行，ask 按拒绝且不发审批请求；分类出错按 ask", async () => {
    const pipeline = new PermissionPipeline({ mode: "auto", rules: [], cwd });
    const h = createHarness({
      cwd,
      tools: [bashTool()],
      permission: pipeline,
      unattended: true,
      script: router(
        [
          {
            toolCalls: [
              { id: "a", name: "bash", args: { command: "node gen.js" } },
              { id: "b", name: "bash", args: { command: "./deploy.sh" } },
              { id: "c", name: "bash", args: { command: "python weird.py" } },
            ],
          },
          { text: "done" },
        ],
        { "gen.js": ALLOW, "deploy.sh": ASK },
      ),
    });
    await h.session.prompt("go");
    expect(errorsById(h.events)).toEqual({ a: false, b: true, c: true });
    expect(endDecisions(h.events)["c"]).toMatchObject({
      layer: "classifier",
      decision: "ask",
      reason: "classifier returned invalid output",
    });
    expect(h.events.some((e) => e.type === "permission_request")).toBe(false);
  });

  it("permission.autoModel：用指定模型分类；找不到时回落到会话模型", async () => {
    const main = fakeModel();
    const cheap = fakeModel({ id: "cheap", maxTokens: 100 });
    const run = async (model: string): Promise<ScriptCall[]> => {
      const scripted = createScriptedApi(
        router(
          [{ toolCalls: [{ name: "bash", args: { command: "node gen.js" } }] }, { text: "ok" }],
          {
            "gen.js": ALLOW,
          },
        ),
      );
      const session = new AgentSessionImpl({
        sessionManager: SessionManager.inMemory(cwd),
        providers: stubRegistry([main, cheap], [scripted.api]),
        model: main,
        tools: [bashTool()],
        permission: new PermissionPipeline({ mode: "auto", rules: [], cwd }),
        permissionClassifier: { model },
      });
      await session.prompt("go");
      return scripted.calls.filter(isClassify);
    };
    const cheapCalls = await run("fake/cheap");
    expect(cheapCalls.map((c) => c.model.id)).toEqual(["cheap"]);
    expect(cheapCalls[0]!.options.maxTokens).toBe(100);
    expect((await run("fake/missing")).map((c) => c.model.id)).toEqual(["echo"]);
  });

  it("[ME-D] autoModel 未配：用会话供应商目录的 small 模型；找不到时用会话模型；autoModel 优先", async () => {
    const main = fakeModel({ provider: "deepseek", id: "deepseek-v4-pro" });
    const small = fakeModel({ provider: "deepseek", id: "deepseek-flash" });
    const other = fakeModel({ provider: "deepseek", id: "other" });
    const run = async (models: (typeof main)[], auto?: string) => {
      const scripted = createScriptedApi(
        router(
          [{ toolCalls: [{ name: "bash", args: { command: "node gen.js" } }] }, { text: "ok" }],
          { "gen.js": ALLOW },
        ),
      );
      const session = new AgentSessionImpl({
        sessionManager: SessionManager.inMemory(cwd),
        providers: stubRegistry(models, [scripted.api]),
        model: main,
        tools: [bashTool()],
        permission: new PermissionPipeline({ mode: "auto", rules: [], cwd }),
        ...(auto !== undefined ? { permissionClassifier: { model: auto } } : {}),
      });
      await session.prompt("go");
      return {
        classify: scripted.calls.filter(isClassify).map((c) => c.model.id),
        turns: scripted.calls.filter((c) => !isClassify(c)).map((c) => c.model.id),
      };
    };
    const withSmall = await run([main, small]);
    expect(withSmall.classify).toEqual(["deepseek-flash"]);
    // 主会话请求不受影响
    expect(withSmall.turns).toEqual(["deepseek-v4-pro", "deepseek-v4-pro"]);
    expect((await run([main])).classify).toEqual(["deepseek-v4-pro"]);
    expect((await run([main, small, other], "deepseek/other")).classify).toEqual(["other"]);
  });

  it("[#153] 中转 / 自定义供应商：按会话模型继承的目录条目找模型表里列出的同厂商小模型", async () => {
    const relay = (id: string) => fakeModel({ provider: "relay", id });
    const run = async (session: string, listed: string[], auto?: string) => {
      const scripted = createScriptedApi(
        router(
          [{ toolCalls: [{ name: "bash", args: { command: "node gen.js" } }] }, { text: "ok" }],
          { "gen.js": ALLOW },
        ),
      );
      const logs: string[] = [];
      const models = [session, ...listed.filter((id) => id !== session)].map(relay);
      const agent = new AgentSessionImpl({
        sessionManager: SessionManager.inMemory(cwd),
        providers: stubRegistry(models, [scripted.api]),
        model: models[0]!,
        tools: [bashTool()],
        permission: new PermissionPipeline({ mode: "auto", rules: [], cwd }),
        log: (level, message) => logs.push(`${level} ${message}`),
        ...(auto !== undefined ? { permissionClassifier: { model: auto } } : {}),
      });
      await agent.prompt("go");
      return {
        classify: scripted.calls.filter(isClassify).map((c) => c.model.id),
        turns: scripted.calls.filter((c) => !isClassify(c)).map((c) => c.model.id),
        picked: logs.filter((l) => l.includes("permission classifier model")),
      };
    };
    // 别名继承：deepseek-v4-flash → deepseek/deepseek-flash（deepseek 的 small）
    const aliased = await run("deepseek-v4-pro", ["deepseek-v4-flash"]);
    expect(aliased.classify).toEqual(["deepseek-v4-flash"]);
    expect(aliased.turns).toEqual(["deepseek-v4-pro", "deepseek-v4-pro"]);
    expect(aliased.picked).toEqual(["debug permission classifier model: relay/deepseek-v4-flash"]);
    // 小模型 id 与目录相同；思考档后缀的会话模型照样推断
    expect((await run("gpt-6-sol", ["gpt-6-luna"])).classify).toEqual(["gpt-6-luna"]);
    expect((await run("gpt-6-sol-high", ["gpt-6-luna"])).classify).toEqual(["gpt-6-luna"]);
    // 模型表没列出小模型 / 小模型只有思考档变体：用会话模型（不合成）
    expect((await run("deepseek-v4-pro", [])).classify).toEqual(["deepseek-v4-pro"]);
    expect((await run("gpt-6-sol", ["gpt-6-luna-high"])).classify).toEqual(["gpt-6-sol"]);
    // 会话模型本身就是小模型、或不继承任何目录条目：用会话模型
    expect((await run("deepseek-v4-flash", ["deepseek-v4-pro"])).classify).toEqual([
      "deepseek-v4-flash",
    ]);
    expect((await run("my-model", ["deepseek-v4-flash"])).classify).toEqual(["my-model"]);
    // permission.autoModel 仍优先
    expect(
      (await run("deepseek-v4-pro", ["deepseek-v4-flash", "other"], "relay/other")).classify,
    ).toEqual(["other"]);
  });

  it("其它模式不调分类器，tool_execution_end 不带 autoDecision", async () => {
    const h = createHarness({
      cwd,
      tools: [bashTool()],
      permission: new PermissionPipeline({ mode: "full-auto", rules: [], cwd }),
      script: router(
        [{ toolCalls: [{ id: "x", name: "bash", args: { command: "node gen.js" } }] }],
        {},
      ),
    });
    await h.session.prompt("go");
    expect(h.scripted.calls.filter(isClassify)).toHaveLength(0);
    expect(endDecisions(h.events)["x"]).toBeUndefined();
  });
});
