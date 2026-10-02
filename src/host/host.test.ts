import { afterAll, describe, expect, it } from "vitest";
import { createTmpHome } from "../../test/helpers/tmp-home.js";
import { AmaError, StartupError } from "../errors.js";
import type { ToolDefinition, ToolRegistryApi, ToolSource } from "../tools/types.js";
import { AgentEventBus, createHostApi, type HostApiDeps } from "./api-impl.js";
import { activateHost, disposeHost, loadHostModule } from "./loader.js";
import type { AgentEventName, AgentEvents, HostModule } from "./types.js";
import { HOST_API_VERSION } from "./types.js";

const tmp = createTmpHome("ama-host-");
afterAll(() => tmp.cleanup());

/** 最小工具注册表桩（B3 的 ToolRegistry 实现同一接口）。 */
export function stubRegistry(names: string[] = ["read", "bash", "task"]): ToolRegistryApi & {
  sources: Map<string, ToolSource>;
} {
  const tools = new Map<string, ToolDefinition>();
  const sources = new Map<string, ToolSource>();
  const disabled = new Set<string>();
  let active: string[] | undefined;
  const make = (name: string): ToolDefinition => ({
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    permission: "read",
    execute: async () => ({ content: "" }),
  });
  for (const name of names) {
    tools.set(name, make(name));
    sources.set(name, "builtin");
  }
  const list = () => [...tools.keys()].filter((n) => !disabled.has(n)).sort();
  return {
    sources,
    register(tool, source) {
      if (tools.has(tool.name)) throw new AmaError("tool_exists", tool.name);
      tools.set(tool.name, tool);
      sources.set(tool.name, source);
    },
    disable: (name) => void disabled.add(name),
    get: (name) => tools.get(name),
    list,
    active: () =>
      (active ?? list()).filter((n) => !disabled.has(n)).map((n) => tools.get(n) as ToolDefinition),
    setActive: (names) => {
      active = [...names];
    },
  };
}

function deps(extra: Partial<HostApiDeps> = {}): HostApiDeps {
  return {
    mode: "print",
    env: { ARMADRA_NODE_ID: "n1" },
    session: {
      id: () => "s1",
      file: () => undefined,
      cwd: () => "/w",
      model: () => ({ provider: "fake", id: "echo" }),
    },
    tools: stubRegistry(),
    bus: new AgentEventBus(),
    sendUser: async () => "queued",
    stderr: () => undefined,
    ...extra,
  };
}

const ALL_EVENTS: { [K in AgentEventName]: AgentEvents[K] } = {
  session_start: { sessionId: "s1", cwd: "/w", reason: "startup" },
  before_agent_start: { prompt: "hi" },
  agent_start: {},
  turn_start: {},
  turn_end: {},
  tool_call: { toolCallId: "t1", toolName: "bash", input: {} },
  tool_result: { toolCallId: "t1", toolName: "bash", isError: false },
  agent_end: { stopReason: "stop", willRetry: false },
  agent_before_settle: {},
  agent_settled: {},
  session_compact: { tokensBefore: 10 },
  model_select: { model: { id: "echo", provider: "fake" } },
  tool_approval_requested: { requestId: "r1", toolName: "bash" },
  tool_approval_resolved: { requestId: "r1", decision: "allow" },
  hook_executed: { event: "Stop", command: "x", exitCode: 0, durationMs: 1 },
  session_shutdown: {},
  cache_miss: { missedTokens: 38_200, missedCost: 0.11, reason: "idle", idleMs: 420_000 },
  context_pressure: { percent: 72, threshold: 70, estimatedTurnsLeft: 9 },
};

describe("HostApi 实现", () => {
  it("测试适配器收齐全部 AgentEvents；处理器异常只记日志", async () => {
    const logged: string[] = [];
    const bus = new AgentEventBus((level, message) => logged.push(`${level}:${message}`));
    const binding = createHostApi(deps({ bus }));
    const received: string[] = [];
    const module: HostModule = {
      hostApi: HOST_API_VERSION,
      create(api) {
        for (const name of Object.keys(ALL_EVENTS) as AgentEventName[]) {
          api.events.on(name, (event) => {
            received.push(name);
            expect(event).toEqual(ALL_EVENTS[name]);
          });
        }
        api.events.on("turn_end", () => {
          throw new Error("observer bug");
        });
        return { id: "collector" };
      },
    };
    const handle = await activateHost({ module, binding });
    expect(handle?.adapter.id).toBe("collector");
    for (const [name, payload] of Object.entries(ALL_EVENTS)) {
      await bus.emit(name as AgentEventName, payload as never);
    }
    expect(received).toEqual(Object.keys(ALL_EVENTS));
    expect(logged).toEqual(["error:宿主事件处理器异常（turn_end）"]);
  });

  it("工具注册 / 禁用、指令、broker、状态、sendUser", async () => {
    const tools = stubRegistry();
    const statuses: string[] = [];
    const binding = createHostApi(
      deps({
        tools,
        onStatus: (k, t) => statuses.push(`${k}=${t ?? ""}`),
        sendUser: async (_t, o) => (o === "host" ? "started" : "queued"),
      }),
    );
    const { api } = binding;
    expect(api.version).toBe(1);
    expect(api.agent.name).toBe("ama");
    expect(api.env["ARMADRA_NODE_ID"]).toBe("n1");
    api.tools.register({ ...(tools.get("read") as ToolDefinition), name: "canvas_send" });
    expect(tools.sources.get("canvas_send")).toBe("host");
    expect(() =>
      api.tools.register({ ...(tools.get("read") as ToolDefinition), name: "bash" }),
    ).toThrow(/已存在/);
    expect(() =>
      api.tools.register({ ...(tools.get("read") as ToolDefinition), name: "Bad Name" }),
    ).toThrow(/不合法/);
    api.tools.disable("task");
    expect(api.tools.list()).toEqual(["bash", "canvas_send", "read"]);
    expect(binding.registeredTools).toEqual(["canvas_send"]);
    expect(binding.disabledTools).toEqual(["task"]);
    api.instructions.add({ kind: "text", text: "be nice", name: "armadra" });
    expect(binding.instructions).toEqual([{ kind: "text", text: "be nice", name: "armadra" }]);
    const broker = { ask: async () => "allow" as const };
    api.approvals.setBroker(broker);
    expect(binding.broker()).toBe(broker);
    api.ui.setStatus("canvas", "3 节点");
    api.ui.setStatus("canvas");
    expect(statuses).toEqual(["canvas=3 节点", "canvas="]);
    expect(binding.status().size).toBe(0);
    expect(await api.messages.sendUser("hi")).toBe("started");
    expect(api.session.model()).toEqual({ provider: "fake", id: "echo" });
  });

  it("ui.notify：print 写 stderr，交互模式交给 UI", () => {
    const err: string[] = [];
    const ui: string[] = [];
    createHostApi(deps({ stderr: (t) => err.push(t), notify: (m) => ui.push(m) })).api.ui.notify(
      "a",
      "warn",
    );
    createHostApi(
      deps({ mode: "interactive", stderr: (t) => err.push(t), notify: (m) => ui.push(m) }),
    ).api.ui.notify("b");
    expect(err).toEqual(["ama: [host warn] a\n"]);
    expect(ui).toEqual(["b"]);
  });

  it("setNotify：晚绑定覆盖构造时的 notify，传 undefined 恢复；print 仍写 stderr（契约 A8）", () => {
    const err: string[] = [];
    const early: string[] = [];
    const late: string[] = [];
    const binding = createHostApi(
      deps({ mode: "interactive", stderr: (t) => err.push(t), notify: (m) => early.push(m) }),
    );
    binding.api.ui.notify("1");
    binding.setNotify((m, level) => late.push(`${level}:${m}`));
    binding.api.ui.notify("2", "error");
    binding.setNotify();
    binding.api.ui.notify("3");
    expect(early).toEqual(["1", "3"]);
    expect(late).toEqual(["error:2"]);

    const bare = createHostApi(deps({ mode: "rpc", stderr: (t) => err.push(t) }));
    bare.api.ui.notify("4");
    bare.setNotify((m) => late.push(m));
    bare.api.ui.notify("5");
    bare.setNotify(undefined);
    bare.api.ui.notify("6");
    const printing = createHostApi(deps({ stderr: (t) => err.push(t) }));
    printing.setNotify((m) => late.push(m));
    printing.api.ui.notify("7");
    expect(late).toEqual(["error:2", "5"]);
    expect(err).toEqual(["ama: [host] 4\n", "ama: [host] 6\n", "ama: [host] 7\n"]);
  });
});

describe("HostApi.cache（W3-C0）", () => {
  it("onWarmingDecision：最后注册的生效，注销后回到前一个；非函数报错", async () => {
    const binding = createHostApi(deps());
    const cache = binding.api.cache;
    expect(cache).toBeDefined();
    expect(binding.warmingDecider()).toBeUndefined();
    const first = cache!.onWarmingDecision(() => "warm");
    const offSecond = cache!.onWarmingDecision(async (d) => (d.probability < 1 ? "stop" : "warm"));
    const decision = {
      action: "warm" as const,
      phase: "idle" as const,
      promptTokens: 40_000,
      warmCost: 0.012,
      missCost: 0.5,
      probability: 0.15,
    };
    expect(await binding.warmingDecider()?.(decision)).toBe("stop");
    offSecond();
    offSecond();
    expect(await binding.warmingDecider()?.(decision)).toBe("warm");
    first();
    expect(binding.warmingDecider()).toBeUndefined();
    expect(() => cache!.onWarmingDecision("warm" as never)).toThrow(/需要函数/);
  });
});

describe("loader", () => {
  const cjs = (body: string) => tmp.write(`mods/m${Math.random().toString(36).slice(2)}.cjs`, body);
  const mjs = (body: string) => tmp.write(`mods/m${Math.random().toString(36).slice(2)}.mjs`, body);

  async function exitCodeOf(promise: Promise<unknown>): Promise<number | undefined> {
    try {
      await promise;
      return undefined;
    } catch (error) {
      expect(error).toBeInstanceOf(StartupError);
      return (error as StartupError).exitCode;
    }
  }

  it("CJS module.exports 与 ESM 默认 / 具名导出", async () => {
    const a = cjs(`module.exports = { hostApi: 1, create: (api) => ({ id: "cjs-" + api.mode }) };`);
    const b = mjs(`export default { hostApi: 1, create: () => ({ id: "esm-default" }) };`);
    const c = mjs(
      `export const hostApi = 1; export function create() { return { id: "esm-named" }; }`,
    );
    const ids: string[] = [];
    for (const path of [a, b, c]) {
      const handle = await activateHost({ module: path, binding: createHostApi(deps()) });
      ids.push(handle?.adapter.id ?? "none");
      expect(handle?.source).toBe(path);
    }
    expect(ids).toEqual(["cjs-print", "esm-default", "esm-named"]);
  });

  it("hostApi 版本不等 → 78", async () => {
    const path = cjs(`module.exports = { hostApi: 2, create: () => ({ id: "x" }) };`);
    expect(await exitCodeOf(loadHostModule(path))).toBe(78);
  });

  it("加载失败 / 不是适配器 / create 抛错 / 超时 → 6", async () => {
    expect(await exitCodeOf(loadHostModule(tmp.path("mods/none.cjs")))).toBe(6);
    expect(await exitCodeOf(loadHostModule(cjs(`throw new Error("boom")`)))).toBe(6);
    expect(await exitCodeOf(loadHostModule(cjs(`module.exports = { foo: 1 };`)))).toBe(6);
    const throws = cjs(`module.exports = { hostApi: 1, create() { throw new Error("nope"); } };`);
    expect(await exitCodeOf(activateHost({ module: throws, binding: createHostApi(deps()) }))).toBe(
      6,
    );
    const hangs = cjs(`module.exports = { hostApi: 1, create: () => new Promise(() => {}) };`);
    expect(
      await exitCodeOf(
        activateHost({ module: hangs, binding: createHostApi(deps()), timeoutMs: 50 }),
      ),
    ).toBe(6);
  });

  it("create 返回 undefined → 不激活；dispose 幂等", async () => {
    const off = cjs(
      `module.exports = { hostApi: 1, create: (api) => api.env.ARMADRA_NODE_ID ? { id: "on" } : undefined };`,
    );
    const binding = createHostApi(deps({ env: {} }));
    expect(await activateHost({ module: off, binding })).toBeUndefined();
    let disposed = 0;
    const module: HostModule = {
      hostApi: 1,
      create: () => ({ id: "d", dispose: () => void disposed++ }),
    };
    const handle = await activateHost({ module, binding: createHostApi(deps()) });
    await disposeHost(handle);
    await disposeHost(handle);
    expect(disposed).toBe(1);
  });
});
