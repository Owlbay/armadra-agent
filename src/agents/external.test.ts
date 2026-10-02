/**
 * W5-EG：外部 Agent 接入 task 的单元与联调层用例——名字解析、启动登记（PATH / 宿主）、
 * 首次运行确认的真值表、父会话模式 → Claude `--permission-mode` / Codex 策略的真值表、
 * `/agents` 数据合并。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionCore } from "../agent/session-core.js";
import type { SessionEvent } from "../agent/types.js";
import { HostRunnerRegistry } from "../drivers/host-runners.js";
import { AgentEventBus, createHostApi, hostRunnersOf } from "../host/api-impl.js";
import type { ToolRegistryApi } from "../tools/types.js";
import { ProgramProbe } from "../drivers/probe.js";
import {
  memoryTransport,
  readRecording,
  replayPeer,
  spawnRecorder,
} from "../drivers/test-support.js";
import { createLineReader } from "../modes/rpc/jsonl.js";
import { parseRule } from "../permissions/rules.js";
import type { ApprovalRequest, PermissionMode } from "../permissions/types.js";
import type { SubagentRunRequest } from "../tools/types.js";
import { AgentCatalog } from "./catalog.js";
import {
  SessionExternalAgents,
  externalDefinition,
  externalTesting,
  isExternalSpec,
  mergeAgentInfos,
  registerExternalAgents,
  type ExternalWiring,
} from "./external.js";

const tmp: string[] = [];
afterEach(() => {
  delete externalTesting.driverDeps;
  for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function wiring(extra: Partial<ExternalWiring> = {}): ExternalWiring {
  return { env: { PATH: "" }, hosted: false, trusted: true, probe: true, ...extra };
}

interface FakeCore {
  core: SessionCore;
  asked: ApprovalRequest[];
  events: SessionEvent[];
}

function fakeCore(options: {
  mode?: PermissionMode;
  allow?: string[];
  deny?: string[];
  unattended?: boolean;
  answer?: "allow" | "deny";
}): FakeCore {
  const asked: ApprovalRequest[] = [];
  const events: SessionEvent[] = [];
  const rules = [
    ...(options.allow ?? []).map((r) => parseRule(r, "allow", "user")),
    ...(options.deny ?? []).map((r) => parseRule(r, "deny", "user")),
  ];
  const core = {
    depth: 0,
    cwd: "/work",
    options: {
      permission: { mode: options.mode ?? "default", rules },
      unattended: options.unattended === true,
      brokers: [
        {
          ask: async (request: ApprovalRequest) => {
            asked.push(request);
            return options.answer ?? "allow";
          },
        },
      ],
    },
    manager: { id: "parent-session", branch: () => [] },
    appendEntry: () => undefined,
    emit: (event: SessionEvent) => void events.push(event),
    runHook: async () => undefined,
    log: () => undefined,
  } as unknown as SessionCore;
  return { core, asked, events };
}

function request(
  mode: PermissionMode,
  extra: Partial<SubagentRunRequest> = {},
): SubagentRunRequest {
  return {
    prompt: "say OK",
    cwd: "/work",
    mode,
    taskId: "t1",
    signal: new AbortController().signal,
    onEvent: () => undefined,
    ...extra,
  };
}

/** 只认 `/fake/<program>` 的探测（版本与 --help 固定）。 */
function fakeProbe(programs: string[], version: string): ProgramProbe {
  return new ProgramProbe({
    env: { PATH: "/fake" },
    platform: "linux",
    isFile: (path) => programs.some((p) => path.replace(/\\/g, "/") === `/fake/${p}`),
    runVersion: async () => `${version} choices: "manual"`,
  });
}

describe("外部 Agent 名字与登记", () => {
  it("claude / codex / acp:<program> / 驱动表 id 是外部 Agent；ama 与普通类型不是", () => {
    for (const name of ["claude", "codex", "acp:ama", "acp:zed-agent", "gemini"])
      expect(isExternalSpec(name)).toBe(true);
    for (const name of ["ama", "acp:", "general", "explore", "reviewer"])
      expect(isExternalSpec(name)).toBe(false);
  });

  it("PATH 上的 claude / codex 登记进描述；acp:* 按需解析、不进描述", () => {
    const dir = mkdtempSync(join(tmpdir(), "ama-ext-path-"));
    tmp.push(dir);
    const exe = join(dir, process.platform === "win32" ? "claude.cmd" : "claude");
    writeFileSync(exe, "");
    chmodSync(exe, 0o755);
    const catalog = new AgentCatalog();
    registerExternalAgents(catalog, wiring({ env: { PATH: dir, PATHEXT: ".CMD" } }));
    expect(catalog.names()).toEqual(["general", "explore", "plan", "claude"]);
    expect(catalog.describe()).toContain("- claude: External Claude Code CLI");
    expect(catalog.get("codex")?.runner).toBe("codex");
    expect(catalog.get("acp:ama")).toMatchObject({ name: "acp:ama", runner: "acp:ama" });
    expect(catalog.describe()).not.toContain("acp:ama");
    expect(catalog.get("nope")).toBeUndefined();
  });

  it("有宿主：不按 PATH 登记，只登记宿主注入的 runner；探测关闭时也不登记", () => {
    const dir = mkdtempSync(join(tmpdir(), "ama-ext-path-"));
    tmp.push(dir);
    writeFileSync(join(dir, "claude"), "");
    const hostRunners = new HostRunnerRegistry();
    hostRunners.provide({
      id: "canvas-node",
      description: "Armadra node",
      start: () => Promise.reject(new Error("unused")),
    });
    const hosted = new AgentCatalog();
    registerExternalAgents(hosted, wiring({ env: { PATH: dir }, hosted: true, hostRunners }));
    expect(hosted.names()).toEqual(["general", "explore", "plan", "canvas-node"]);
    expect(hosted.get("canvas-node")).toMatchObject({ runner: "canvas-node", source: "host" });
    const off = new AgentCatalog();
    registerExternalAgents(off, wiring({ env: { PATH: dir }, probe: false }));
    expect(off.names()).toEqual(["general", "explore", "plan"]);
  });

  it("有宿主时 task(agent=claude) 的 runner 启动即报「由宿主提供」", async () => {
    const { core } = fakeCore({ mode: "full-auto" });
    const ext = new SessionExternalAgents(core, wiring({ hosted: true }), new AgentCatalog());
    const runner = ext.runner(externalDefinition("claude"));
    await expect(runner!.start(request("default"))).rejects.toMatchObject({
      code: "agent_host_only",
    });
    expect(ext.runner({ ...externalDefinition("x"), runner: "ama" })).toBeUndefined();
  });

  it("/agents 数据：类型目录在前，探测补 installed / version，驱动表的 ama 显示为 acp:ama", () => {
    const merged = mergeAgentInfos(
      [
        { name: "general", description: "g", runner: "ama", source: "builtin" },
        { name: "claude", description: "c", runner: "claude", source: "builtin" },
      ],
      [
        {
          name: "claude",
          description: "Claude Code",
          runner: "claude",
          source: "builtin",
          installed: true,
          version: "2.1.3",
        },
        { name: "ama", description: "ama", runner: "ama", source: "builtin", installed: true },
        {
          name: "gemini",
          description: "Gemini CLI",
          runner: "gemini",
          source: "builtin",
          installed: false,
        },
      ],
    );
    expect(merged.map((a) => [a.name, a.runner, a.installed, a.version])).toEqual([
      ["general", "ama", undefined, undefined],
      ["claude", "claude", true, "2.1.3"],
      ["acp:ama", "acp:ama", true, undefined],
      ["gemini", "gemini", false, undefined],
    ]);
  });
});

describe("首次运行确认（execute 类，只问一次）", () => {
  const cases: {
    name: string;
    core: Parameters<typeof fakeCore>[0];
    outcome: "asked" | "allowed" | "denied";
  }[] = [
    { name: "default：问人", core: { mode: "default" }, outcome: "asked" },
    { name: "auto：问人（不经分类器）", core: { mode: "auto" }, outcome: "asked" },
    { name: "plan：问人（随后只读启动）", core: { mode: "plan" }, outcome: "asked" },
    { name: "full-auto：放行", core: { mode: "full-auto" }, outcome: "allowed" },
    {
      name: "allow 规则 task(acp:ama)：放行",
      core: { allow: ["task(acp:ama)"] },
      outcome: "allowed",
    },
    { name: "allow 规则 task：放行", core: { allow: ["task"] }, outcome: "allowed" },
    { name: "allowlist：拒绝（从不询问）", core: { mode: "allowlist" }, outcome: "denied" },
    { name: "无人值守：拒绝", core: { unattended: true }, outcome: "denied" },
    { name: "auto + 无人值守：拒绝", core: { mode: "auto", unattended: true }, outcome: "denied" },
    {
      name: "deny 规则 task(acp:*)：拒绝",
      core: { mode: "full-auto", deny: ["task(acp:*)"] },
      outcome: "denied",
    },
    { name: "人拒绝", core: { answer: "deny" }, outcome: "denied" },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const { core, asked, events } = fakeCore(c.core);
      let spawned = 0;
      externalTesting.driverDeps = {
        spawn: () => {
          spawned++;
          throw new Error("spawned");
        },
        probe: fakeProbe(["ama"], "0.5.0"),
      };
      const ext = new SessionExternalAgents(core, wiring(), new AgentCatalog());
      const runner = ext.runner(externalDefinition("acp:ama"))!;
      const run = runner.start(request("default"));
      if (c.outcome === "denied") {
        await expect(run).rejects.toMatchObject({ code: "permission_denied" });
        expect(spawned).toBe(0);
      } else {
        await expect(run).rejects.toThrow(/spawned/);
        expect(spawned).toBe(1);
      }
      const confirm = asked.filter((r) => r.toolName === "task");
      if (c.outcome === "asked" || c.name === "人拒绝") {
        expect(confirm).toHaveLength(1);
        expect(confirm[0]).toMatchObject({
          input: { agent: "acp:ama" },
          context: { depth: 0, taskId: "t1" },
        });
        expect(String((confirm[0]!.input as { note: string }).note)).toContain("existing login");
        const event = events.find((e) => e.type === "permission_request");
        expect(event).toMatchObject({ toolName: "task", context: { taskId: "t1" } });
      } else expect(confirm).toHaveLength(0);
    });
  }

  it("同一会话只问一次；不同 Agent 各问一次", async () => {
    const { core, asked } = fakeCore({ mode: "default" });
    externalTesting.driverDeps = {
      spawn: () => {
        throw new Error("spawned");
      },
      probe: fakeProbe(["ama"], "0.5.0"),
    };
    const ext = new SessionExternalAgents(core, wiring(), new AgentCatalog());
    const ama = ext.runner(externalDefinition("acp:ama"))!;
    await Promise.allSettled([ama.start(request("default")), ama.start(request("default"))]);
    await ama.start(request("default")).catch(() => undefined);
    expect(asked).toHaveLength(1);
    await ext
      .runner(externalDefinition("acp:other"))!
      .start(request("default"))
      .catch(() => undefined);
    expect(asked).toHaveLength(2);
  });
});

describe("父会话模式 → 外部 Agent 的权限（联调层真值表）", () => {
  const modes: PermissionMode[] = [
    "plan",
    "allowlist",
    "default",
    "auto-edit",
    "auto",
    "full-auto",
  ];

  it("Claude：plan / allowlist 只读启动，full-auto 最宽 auto（从不 bypassPermissions）", async () => {
    const expected = ["plan", "plan", "manual", "acceptEdits", "auto", "auto"];
    const got: string[] = [];
    for (const mode of modes) {
      const rec = spawnRecorder(() => {
        const peer = replayPeer(readRecording("claude/turn-basic.jsonl"));
        return memoryTransport((i, o) => peer.serve(i, o));
      });
      externalTesting.driverDeps = {
        spawn: rec.spawn,
        probe: fakeProbe(["claude"], "2.1.287"),
        cancelGraceMs: 20,
      };
      const { core } = fakeCore({ mode, allow: ["task"] });
      const ext = new SessionExternalAgents(core, wiring(), new AgentCatalog());
      const handle = await ext.runner(externalDefinition("claude"))!.start(request(mode));
      const args = rec.specs[0]!.args;
      got.push(String(args[args.indexOf("--permission-mode") + 1]));
      expect(args).not.toContain("bypassPermissions");
      expect(args).not.toContain("--dangerously-skip-permissions");
      await handle.stop();
    }
    expect(got).toEqual(expected);
  });

  it("Codex：plan / allowlist 为 never + read-only，full-auto 最宽 workspace-write（从不 danger-full-access）", async () => {
    const got: string[] = [];
    for (const mode of modes) {
      const threads: Record<string, unknown>[] = [];
      const rec = spawnRecorder(() =>
        memoryTransport(
          (input, output) =>
            new Promise<void>((resolve) => {
              createLineReader(
                input,
                (line) => {
                  const msg = JSON.parse(line) as {
                    id?: unknown;
                    method?: string;
                    params?: Record<string, unknown>;
                  };
                  if (msg.id === undefined) return;
                  let result: unknown = {};
                  if (msg.method === "initialize") result = { userAgent: "codex_cli_rs/0.160.0" };
                  if (msg.method === "thread/start") {
                    threads.push(msg.params ?? {});
                    result = { thread: { id: "th-1", sessionId: "th-1" }, model: "gpt-6" };
                  }
                  output.write(`${JSON.stringify({ id: msg.id, result })}\n`);
                },
                resolve,
              );
            }),
        ),
      );
      externalTesting.driverDeps = {
        spawn: rec.spawn,
        probe: fakeProbe(["codex"], "0.160.0"),
        cancelGraceMs: 20,
      };
      const { core } = fakeCore({ mode, allow: ["task"] });
      const ext = new SessionExternalAgents(core, wiring(), new AgentCatalog());
      const handle = await ext.runner(externalDefinition("codex"))!.start(request(mode));
      const params = threads[0] as { approvalPolicy: string; sandbox: string };
      got.push(`${params.approvalPolicy}/${params.sandbox}`);
      await handle.stop();
    }
    expect(got).toEqual([
      "never/read-only",
      "never/read-only",
      "on-request/read-only",
      "untrusted/workspace-write",
      "on-request/workspace-write",
      "never/workspace-write",
    ]);
    expect(got.join(" ")).not.toContain("danger-full-access");
  });

  it("请求的模式比父宽时夹到父模式（父 plan、task 请求 full-auto → Claude plan）", async () => {
    const rec = spawnRecorder(() => {
      const peer = replayPeer(readRecording("claude/turn-basic.jsonl"));
      return memoryTransport((i, o) => peer.serve(i, o));
    });
    externalTesting.driverDeps = {
      spawn: rec.spawn,
      probe: fakeProbe(["claude"], "2.1.287"),
      cancelGraceMs: 20,
    };
    const { core } = fakeCore({ mode: "plan", allow: ["task"] });
    const ext = new SessionExternalAgents(core, wiring(), new AgentCatalog());
    const handle = await ext.runner(externalDefinition("claude"))!.start(request("full-auto"));
    const args = rec.specs[0]!.args;
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    await handle.stop();
  });

  it("ama 的缺省子会话模型（subagents.defaultModel）不传给外部 CLI；agents.<id>.model 照传", async () => {
    const rec = spawnRecorder(() => {
      const peer = replayPeer(readRecording("claude/turn-basic.jsonl"));
      return memoryTransport((i, o) => peer.serve(i, o));
    });
    externalTesting.driverDeps = {
      spawn: rec.spawn,
      probe: fakeProbe(["claude"], "2.1.287"),
      cancelGraceMs: 20,
    };
    const { core } = fakeCore({ mode: "full-auto" });
    const ext = new SessionExternalAgents(
      core,
      wiring({ defaultModel: "anthropic/claude-x" }),
      new AgentCatalog(),
    );
    const runner = ext.runner(externalDefinition("claude"))!;
    const handle = await runner.start(request("default", { model: "anthropic/claude-x" }));
    expect(rec.specs[0]!.args).not.toContain("--model");
    await handle.stop();
  });
});

describe("HostRunnerRegistry", () => {
  it("provide / 注销触发 onChange；同名替换，旧注销函数不删新 runner", () => {
    const registry = new HostRunnerRegistry();
    let changes = 0;
    const off = registry.onChange(() => changes++);
    const a = { id: "n", description: "a", start: () => Promise.reject(new Error("x")) };
    const b = { ...a, description: "b" };
    const dropA = registry.provide(a);
    registry.provide(b);
    dropA();
    expect(registry.get("n")?.description).toBe("b");
    expect(changes).toBe(2);
    off();
    registry.provide(a);
    expect(changes).toBe(2);
    expect(() => registry.provide({ id: "", description: "", start: a.start })).toThrow(
      /runners.provide/,
    );
  });
});

describe("HostApi.runners（W5-EG）", () => {
  it("provide 进本适配器的注册表（hostRunnersOf）；注销后移除；坏 runner 报错", () => {
    const binding = createHostApi({
      mode: "rpc",
      session: {
        id: () => "s1",
        file: () => undefined,
        cwd: () => "/w",
        model: () => ({ provider: "fake", id: "echo" }),
      },
      tools: {} as ToolRegistryApi,
      bus: new AgentEventBus(),
      sendUser: async () => "queued",
      stderr: () => undefined,
    });
    const registry = hostRunnersOf(binding.api);
    expect(registry).toBeDefined();
    const runner = { id: "node", description: "d", start: () => Promise.reject(new Error("x")) };
    const off = binding.api.runners!.provide(runner);
    expect(registry!.get("node")).toBe(runner);
    off();
    expect(registry!.list()).toEqual([]);
    expect(() => binding.api.runners!.provide({ id: "x" } as never)).toThrow(/runners.provide/);
    expect(Object.isFrozen(binding.api.runners)).toBe(true);
  });
});
