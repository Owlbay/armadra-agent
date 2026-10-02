/**
 * 启动序列测试桩：注入 RuntimeDeps 的最小实现（供应商、会话、工具、权限、会话组装、模式），
 * 记录组装材料与 Runtime。src/cli 下的启动序列测试共用。
 */

import { join } from "node:path";
import type { ModelLookup, ProviderData, ProviderRegistryApi } from "../../src/ai/types.js";
import type { AgentSession } from "../../src/agent/types.js";
import type {
  CliIo,
  ProviderBuildInput,
  RuntimeDeps,
  SessionAssembly,
} from "../../src/cli/deps.js";
import type { Runtime } from "../../src/cli/runtime.js";
import { AmaError } from "../../src/errors.js";
import type { PermissionPipelineApi } from "../../src/permissions/types.js";
import type { SessionEntry, SessionManagerApi } from "../../src/session/types.js";
import type { ToolDefinition, ToolRegistryApi } from "../../src/tools/types.js";
import type { TmpHome } from "./tmp-home.js";

const PROVIDERS: ProviderData[] = [
  {
    id: "fake",
    name: "Fake",
    api: "fake",
    baseUrl: "http://fake",
    envKeys: ["FAKE_API_KEY"],
    requiresApiKey: true,
    builtin: true,
    models: [
      {
        id: "echo",
        name: "Echo",
        provider: "fake",
        api: "fake",
        input: ["text"],
        reasoning: false,
        maxTokens: 100,
      },
    ],
  },
];

function registry(input: ProviderBuildInput, keys: Record<string, string>): ProviderRegistryApi {
  return {
    list: () => PROVIDERS,
    get: (id) => PROVIDERS.find((p) => p.id === id),
    findModel(ref): ModelLookup {
      const [providerId, modelId] = ref.includes("/") ? ref.split("/") : [undefined, ref];
      for (const provider of PROVIDERS) {
        if (providerId !== undefined && provider.id !== providerId) continue;
        const model = provider.models.find((m) => m.id === modelId);
        if (model !== undefined) return { ok: true, model, provider };
      }
      return { ok: false, reason: "not_found", candidates: ["fake/echo"] };
    },
    async resolveApiKey(id) {
      if (input.cliApiKey !== undefined) return { apiKey: input.cliApiKey.apiKey, source: "cli" };
      const key = keys[id];
      return key === undefined
        ? { apiKey: undefined, source: "none" }
        : { apiKey: key, source: "env", origin: "FAKE_API_KEY" };
    },
    // 零配置选模型跳过协议未实现的供应商：桩协议只需存在，测试不发请求。
    getApi: (api) =>
      api === "fake"
        ? {
            id: "fake",
            stream: () => {
              throw new Error("not used");
            },
          }
        : undefined,
  };
}

export function sessionManager(cwd: string, entries: SessionEntry[] = []): SessionManagerApi {
  return {
    id: "sess-1",
    cwd,
    file: () => undefined,
    header: () => ({
      type: "session",
      version: 1,
      id: "sess-1",
      timestamp: "",
      cwd,
      agent: { name: "ama", version: "0" },
    }),
    entries: () => entries,
    getEntry: () => undefined,
    leafId: () => null,
    append: () => {
      throw new Error("not used");
    },
    setLeaf: () => undefined,
    branch: () => entries,
    getEntries: () => ({ entries, leafId: null }),
    getTree: () => [],
    name: () => undefined,
    setName: () => undefined,
    fork: () => {
      throw new Error("not used");
    },
  };
}

export function toolRegistry(): ToolRegistryApi {
  const tools = new Map<string, ToolDefinition>();
  for (const name of ["read", "bash", "task"]) {
    tools.set(name, {
      name,
      description: name,
      parameters: { type: "object" },
      permission: "read",
      execute: async () => ({ content: "" }),
    });
  }
  const disabled = new Set<string>();
  let active: readonly string[] | undefined;
  const list = () => [...tools.keys()].filter((n) => !disabled.has(n)).sort();
  return {
    register: (tool) => void tools.set(tool.name, tool),
    disable: (name) => void disabled.add(name),
    get: (name) => tools.get(name),
    list,
    active: () =>
      (active ?? list()).filter((n) => !disabled.has(n)).map((n) => tools.get(n) as ToolDefinition),
    setActive: (names) => {
      active = names;
    },
  };
}

export interface Harness {
  deps: RuntimeDeps;
  io: CliIo;
  out: string[];
  err: string[];
  keys: Record<string, string>;
  calls: {
    assembly?: SessionAssembly;
    runtime?: Runtime;
    disposed: number;
    providerInput?: ProviderBuildInput;
  };
  entries: SessionEntry[];
}

export function harness(home: TmpHome): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const keys: Record<string, string> = { fake: "k" };
  const entries: SessionEntry[] = [];
  const calls: Harness["calls"] = { disposed: 0 };
  const deps: RuntimeDeps = {
    providers: {
      create: (input) => {
        calls.providerInput = input;
        return registry(input, keys);
      },
    },
    sessions: {
      open: (request, ctx) => {
        if (request.kind === "resume" && request.id === "missing") {
          throw new AmaError("session_not_found", "会话不存在：missing");
        }
        if (request.kind === "resume" && request.id === "gone-cwd")
          return sessionManager(join(ctx.cwd, "deleted"));
        return sessionManager(ctx.cwd, entries);
      },
    },
    tools: { create: () => toolRegistry() },
    permissions: {
      create: ({ mode, rules }) =>
        ({
          mode,
          setMode: () => undefined,
          rules: rules as never,
          check: () => ({ decision: "allow", step: "mode" }),
          rememberForSession: () => undefined,
        }) as PermissionPipelineApi,
    },
    session: {
      create: (assembly) => {
        calls.assembly = assembly;
        const session = {
          state: {
            sessionId: assembly.sessionManager.id,
            sessionFile: undefined,
            cwd: assembly.paths.cwd,
            model: { provider: assembly.model.provider, id: assembly.model.id },
            permissionMode: assembly.permission.mode,
            isStreaming: false,
          },
          dispose: async () => {
            calls.disposed++;
          },
        };
        return session as unknown as AgentSession;
      },
    },
    modes: {
      print: async (runtime) => {
        calls.runtime = runtime;
        return 0;
      },
      line: async (runtime) => {
        calls.runtime = runtime;
        return 0;
      },
    },
  };
  const io: CliIo = {
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env: home.env,
    cwd: home.cwd,
    readStdin: async () => "",
  };
  return { deps, io, out, err, keys, calls, entries };
}
