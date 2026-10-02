import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../test/helpers/tmp-home.js";
import { createDefaultApiRegistry } from "./ai/apis/api.js";
import { FakeProvider } from "./ai/fake/fake-provider.js";
import type { FakeResponse } from "./ai/fake/fake-script.js";
import { AgentSessionImpl } from "./agent/session.js";
import { detectSandboxCapability } from "./codemode/capability.js";
import * as sdk from "./index.js";
import {
  createAgentSession,
  createRuntime,
  type RewindPoint,
  type RewindResult,
  type SessionCacheStats,
} from "./sdk.js";
import type { ToolDefinition } from "./tools/types.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function fakeApis(script?: FakeResponse[]) {
  const fake = new FakeProvider(script);
  const apis = createDefaultApiRegistry();
  apis.register(fake.api);
  return { fake, apis };
}

const hello: ToolDefinition<{ name?: string }> = {
  name: "sdk_hello",
  description: "Say hello.",
  parameters: { type: "object", properties: { name: { type: "string" } } },
  permission: "read",
  execute: async (input) => ({ content: `hello ${input.name ?? "world"}` }),
};

describe("SDK", () => {
  it("index 再导出 createAgentSession / createRuntime 与常用实现类", () => {
    expect(sdk.createAgentSession).toBe(createAgentSession);
    expect(sdk.createRuntime).toBe(createRuntime);
    for (const name of [
      "SessionManager",
      "ProviderRegistry",
      "FakeProvider",
      "loadConfig",
      "createToolRegistry",
    ])
      expect(typeof (sdk as Record<string, unknown>)[name]).toBe("function");
  });

  it("createAgentSession：内存会话一次往返，tools: none 不发工具", async () => {
    const { fake, apis } = fakeApis();
    const session = await createAgentSession({
      model: "fake/echo",
      tools: "none",
      apis,
      auth: { kind: "none" },
    });
    expect(session).toBeInstanceOf(AgentSessionImpl);
    await session.prompt("hi there");
    expect(session.getLastAssistantText()).toBe("hi there");
    expect(session.state.sessionFile).toBeUndefined();
    expect(session.getTools()).toEqual([]);
    expect(fake.calls).toHaveLength(1);
    await session.dispose();
  });

  it("[RW-B] rewindPoints / rewind：内存会话仅对话回滚，回填原消息后可继续", async () => {
    const { fake, apis } = fakeApis();
    const session = await createAgentSession({
      model: "fake/echo",
      tools: "none",
      apis,
      auth: { kind: "none" },
    });
    await session.prompt("one");
    await session.prompt("two");
    const points: RewindPoint[] = session.rewindPoints();
    expect(points.map((p) => [p.text, p.hasCheckpoint])).toEqual([
      ["one", false],
      ["two", false],
    ]);
    const result: RewindResult = await session.rewind({
      entryId: points[1]!.entryId,
      mode: "conversation",
    });
    expect(result.conversation?.draft).toEqual({ text: "two" });
    await session.prompt("three");
    expect(session.rewindPoints().map((p) => p.text)).toEqual(["one", "three"]);
    expect(fake.calls).toHaveLength(3);
    await session.dispose();
  });

  it("[W3-C2] 统计类型从 sdk 导出：getStats().cache 是 SessionCacheStats", async () => {
    const { apis } = fakeApis([{ text: "ok", usage: { input: 100, output: 1, cacheRead: 300 } }]);
    const session = await createAgentSession({
      model: "fake/echo",
      tools: "none",
      apis,
      auth: { kind: "none" },
    });
    await session.prompt("hi");
    const cache: SessionCacheStats | undefined = session.getStats().cache;
    expect(cache).toMatchObject({ reporting: "reported", lastHitRate: 0.75, reBilledTokens: 0 });
    await session.dispose();
  });

  it("缺省预设 + extraTools；permission.ask 回调作答", async () => {
    const { apis } = fakeApis([
      { steps: [{ toolCall: { name: "sdk_hello", arguments: { name: "ama" } } }] },
      { steps: [{ toolCall: { name: "bash", arguments: { command: "echo hi" } } }] },
      { text: "done" },
    ]);
    const asked: string[] = [];
    const session = await createAgentSession({
      model: { provider: "fake", id: "echo" },
      apis,
      extraTools: [hello as ToolDefinition],
      permission: { ask: async (request) => (asked.push(request.toolName), "deny") },
    });
    // default 预设跟随预设：沙箱 strict（Node ≥ 25）时带 codemode，否则不带
    const codemode = detectSandboxCapability().strict ? ["codemode"] : [];
    expect(session.getTools().map((t) => t.name)).toEqual([
      "bash",
      ...codemode,
      "edit",
      "glob",
      "grep",
      "read",
      "sdk_hello",
      "write",
    ]);
    await session.prompt("go");
    const results = session.messages.filter((m) => m.role === "toolResult");
    expect(results.map((m) => [m.toolName, m.isError === true])).toEqual([
      ["sdk_hello", false],
      ["bash", true],
    ]);
    expect(asked).toEqual(["bash"]);
    await session.dispose();
  });

  it("permission.mode auto：安全名单（含 autoSafeCommands 追加）静态放行，删除类经 ask 回调并带 autoDecision", async () => {
    const { fake, apis } = fakeApis([
      { steps: [{ toolCall: { name: "bash", arguments: { command: "pwd" } } }] },
      { steps: [{ toolCall: { name: "bash", arguments: { command: "node --version" } } }] },
      { steps: [{ toolCall: { name: "bash", arguments: { command: "rm -rf ./build" } } }] },
      { text: "done" },
    ]);
    const asked: unknown[] = [];
    const session = await createAgentSession({
      model: "fake/echo",
      apis,
      permission: {
        mode: "auto",
        autoSafeCommands: ["node --version"],
        ask: async (request) => (asked.push(request.autoDecision), "deny"),
      },
    });
    expect(session.state.permissionMode).toBe("auto");
    await session.prompt("go");
    const results = session.messages.filter((m) => m.role === "toolResult");
    expect(results.map((m) => m.isError === true)).toEqual([false, false, true]);
    expect(asked).toEqual([{ layer: "rule", decision: "ask", reason: "recursive or forced rm" }]);
    expect(fake.calls.every((c) => c.options.purpose !== "classify")).toBe(true);
    await session.dispose();
  });

  it("没有任何 key 也没给模型 → no_api_key；模型不存在 → model_not_found", async () => {
    await expect(createAgentSession({ auth: { kind: "none" } })).rejects.toMatchObject({
      code: "no_api_key",
    });
    await expect(createAgentSession({ model: "fake/nope" })).rejects.toMatchObject({
      code: "model_not_found",
    });
  });

  it("createRuntime 与 CLI 同一条启动序列：读用户级配置、AGENTS.md，不进入模式", async () => {
    home = createTmpHome();
    home.write("home/.config/ama/config.json", { version: 1, tools: { preset: "minimal" } });
    home.write("work/AGENTS.md", "sdk rules");
    const { fake, apis } = fakeApis();
    const runtime = await createRuntime({
      cwd: home.cwd,
      env: { ...home.env, AMA_NO_LOCAL_PROBE: "1" },
      model: "fake/echo",
      unattended: true,
      compose: { apis, probeLocal: false },
    });
    expect(runtime.mode).toBe("print");
    expect(runtime.session.getTools().map((t) => t.name)).toEqual([
      "bash",
      "edit",
      "read",
      "write",
    ]);
    await runtime.session.prompt("ping");
    expect(runtime.session.getLastAssistantText()).toBe("ping");
    const system = fake.calls[0]?.context.messages[0];
    expect(system?.role === "system" ? system.sections["project_context"] : "").toContain(
      "sdk rules",
    );
    await runtime.dispose();
  });
});
