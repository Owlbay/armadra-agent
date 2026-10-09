/**
 * 记忆的组装（docs/wave6-plan.md §3.1、§3.4、§3.6、D8、D9、D11、D12）：开关与作用域、系统节、前缀稳定、
 * reload / 压缩只产生 memory 节补丁、resume 沿用、AMA_MEMORY。
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { buildAnthropicRequest } from "../ai/apis/anthropic-request.js";
import { normalizeContext } from "../ai/context.js";
import type { FakeResponse } from "../ai/fake/fake-script.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import type { Model, SystemMessage, TranscriptContext } from "../ai/types.js";
import type { AgentSession } from "../agent/types.js";
import { MemoryStore } from "../memory/store.js";
import { replaySystem } from "../session/projection.js";
import {
  memoryEnvOverride,
  memoryOf,
  reloadMemorySection,
  resolveMemory,
} from "./compose-memory.js";

let h: ComposeHarness | undefined;
let dirs: string[] = [];
afterEach(() => {
  h?.cleanup();
  h = undefined;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const anthropic = new ProviderRegistry({ keys: { useEnv: false, userAuthFile: null } }).get(
  "anthropic",
)?.models[0] as Model;
const signal = new AbortController().signal;

function prefix(context: TranscriptContext): string {
  const body = buildAnthropicRequest(anthropic, context, { signal, cacheRetention: "short" }).body;
  return JSON.stringify({ system: body["system"], tools: body["tools"] }, (k, v: unknown) =>
    k === "cache_control" ? undefined : v,
  );
}

function systemMessages(session: AgentSession): SystemMessage[] {
  return session.entries.flatMap((e) =>
    e.type === "message" && e.message.role === "system" ? [e.message as SystemMessage] : [],
  );
}

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "ama-mem-compose-")));
  dirs.push(d);
  return d;
}

describe("resolveMemory：开关与作用域", () => {
  const base = { cwd: "/w", dataDir: "/d" };

  it("缺省关闭；开启后 user + project（项目需信任，否则跳过并记下）", () => {
    expect(resolveMemory({ ...base, config: {}, trusted: true })).toBeUndefined();
    expect(
      resolveMemory({ ...base, config: { memory: { enabled: false } }, trusted: true }),
    ).toBeUndefined();
    const on = resolveMemory({ ...base, config: { memory: { enabled: true } }, trusted: true });
    expect(on?.scopes).toEqual(["user", "project"]);
    expect(on?.skipped).toEqual([]);
    const untrusted = resolveMemory({
      ...base,
      config: { memory: { enabled: true } },
      trusted: false,
    });
    expect(untrusted?.scopes).toEqual(["user"]);
    expect(untrusted?.skipped).toEqual([{ scope: "project", reason: "untrusted" }]);
    const only = resolveMemory({
      ...base,
      config: { memory: { enabled: true, scopes: ["project"], indexMaxBytes: 100 } },
      trusted: true,
    });
    expect(only?.scopes).toEqual(["project"]);
    expect(only?.store.limits.indexMaxBytes).toBe(100);
  });

  it("嵌入宿主：只认 profile.memory；有 dir 只有 workspace；没 dir 报配置错误；显式 false 可关", () => {
    const user = { memory: { enabled: true } };
    expect(resolveMemory({ ...base, config: user, trusted: true, embedded: {} })).toBeUndefined();
    const ws = resolveMemory({
      ...base,
      config: {},
      trusted: false,
      embedded: { memory: { enabled: true, dir: "/ws/memory" } },
    });
    expect(ws?.scopes).toEqual(["workspace"]);
    expect(ws?.store.root("workspace")).toBe("/ws/memory");
    expect(ws?.options.embedded).toBe(true);
    expect(() =>
      resolveMemory({
        ...base,
        config: {},
        trusted: true,
        embedded: { memory: { enabled: true } },
      }),
    ).toThrow("memory.dir is missing");
    expect(
      resolveMemory({
        ...base,
        config: { memory: { enabled: false } },
        trusted: true,
        embedded: { memory: { enabled: true, dir: "/ws" } },
      }),
    ).toBeUndefined();
  });

  it("AMA_MEMORY=0|1（true / false / on / off），其它值忽略", () => {
    expect(memoryEnvOverride({ AMA_MEMORY: "1" })).toBe(true);
    expect(memoryEnvOverride({ AMA_MEMORY: "on" })).toBe(true);
    expect(memoryEnvOverride({ AMA_MEMORY: "0" })).toBe(false);
    expect(memoryEnvOverride({ AMA_MEMORY: "False" })).toBe(false);
    expect(memoryEnvOverride({ AMA_MEMORY: "maybe" })).toBeUndefined();
    expect(memoryEnvOverride({})).toBeUndefined();
  });
});

/** 每回合一次 memory 写（create / delete 交替）再回答。 */
function writeScript(rounds: number): FakeResponse[] {
  const out: FakeResponse[] = [];
  for (let i = 0; i < rounds; i++) {
    const path = `/memories/user/n${i % 3}.md`;
    const args =
      i % 4 === 3
        ? { command: "delete", path: `/memories/user/n${(i - 1) % 3}.md` }
        : { command: "create", path, file_text: `note ${i}` };
    out.push({ steps: [{ toolCall: { name: "memory", arguments: args } }] });
    out.push({ text: `answer ${i}` });
  }
  return out;
}

describe("会话里的记忆", () => {
  it("开启：memory 工具在活动集、节在 skills 之后；20 回合多次 create / delete，system + tools 逐字节不变", async () => {
    h = composeHarness(writeScript(20));
    const runtime = await h.boot([
      "--model",
      "fake/echo",
      "--memory",
      "--trust",
      "--permission-mode",
      "full-auto",
    ]);
    for (let i = 0; i < 20; i++) await runtime.session.prompt(`q${i}`);
    expect(h.fake.calls).toHaveLength(40);
    const first = prefix(h.fake.calls[0]!.context);
    expect(first).toContain('"name":"memory"');
    expect(first).toContain("<memory_index note=");
    const sections = Object.keys(systemMessages(runtime.session)[0]!.sections);
    expect(sections.indexOf("memory")).toBe(sections.indexOf("skills") + 1);
    for (const call of h.fake.calls) expect(prefix(call.context)).toBe(first);
    expect(systemMessages(runtime.session)).toHaveLength(1);
    expect(existsSync(join(h.home.env["AMA_DATA_DIR"]!, "memory", "user", "n1.md"))).toBe(true);
    await runtime.dispose();
  });

  it("/memory reload：只产生一条 memory 节补丁（工具表不变）；没变化时不补丁", async () => {
    h = composeHarness([{ text: "a" }, { text: "b" }, { text: "c" }]);
    const runtime = await h.boot(["--model", "fake/echo", "--memory"]);
    await runtime.session.prompt("q0");
    expect(reloadMemorySection(runtime.session)).toEqual({ changed: false });
    const store = memoryOf(runtime.session)!.store;
    await store.create("/memories/user/pnpm.md", "用 pnpm");
    expect(reloadMemorySection(runtime.session)).toEqual({ changed: true });
    await runtime.session.prompt("q1");
    const systems = systemMessages(runtime.session);
    expect(systems).toHaveLength(2);
    expect(Object.keys(systems[1]!.sections)).toEqual(["memory"]);
    expect(systems[1]!.sections["memory"]).toContain("[pnpm](/memories/user/pnpm.md) — 用 pnpm");
    expect(systems[1]!.toolsAdded).toBeUndefined();
    expect(systems[1]!.toolsRemoved).toBeUndefined();
    await runtime.session.prompt("q2");
    expect(systemMessages(runtime.session)).toHaveLength(2);
    await runtime.dispose();
  });

  it("压缩结束后重渲染 memory 节（压缩是重置点）", async () => {
    const replies: FakeResponse[] = Array.from({ length: 8 }, () => ({ text: "## Goal\nx" }));
    h = composeHarness(replies);
    const runtime = await h.boot(["--model", "fake/echo", "--memory"]);
    await runtime.session.prompt("q0");
    await runtime.session.prompt("q1");
    await memoryOf(runtime.session)!.store.create("/memories/user/after.md", "压缩前写的");
    await runtime.session.compact();
    await runtime.session.prompt("q2");
    const last = h.fake.calls.at(-1)!;
    // 压缩后重渲染的 memory 节以尾部上下文送达：开头的 system 不变，新条目在提醒里
    expect(prefix(last.context)).not.toContain("/memories/user/after.md");
    const reminder = normalizeContext(last.context).messages.find(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("<system-reminder>"),
    );
    expect(JSON.stringify(reminder?.content)).toContain("/memories/user/after.md");
    const patch = systemMessages(runtime.session).at(-1)!;
    expect(Object.keys(patch.sections)).toEqual(["memory"]);
    await runtime.dispose();
  });

  it("resume 沿用会话里的 memory 节，新写的条目不自动进前缀", async () => {
    h = composeHarness([{ text: "a" }, { text: "b" }]);
    const first = await h.boot(["--model", "fake/echo", "--memory"]);
    await first.session.prompt("q0");
    const before = systemMessages(first.session)[0]!.sections["memory"];
    await memoryOf(first.session)!.store.create("/memories/user/late.md", "后来写的");
    await first.dispose();
    const resumed = await h.boot(["--model", "fake/echo", "--memory", "--continue"]);
    await resumed.session.prompt("q1");
    expect(prefix(h.fake.calls[1]!.context)).not.toContain("late.md");
    expect(systemMessages(resumed.session)).toHaveLength(1);
    expect(systemMessages(resumed.session)[0]!.sections["memory"]).toBe(before);
    await resumed.dispose();
  });

  it("AMA_MEMORY=1 开启；--no-memory 优先于 AMA_MEMORY", async () => {
    h = composeHarness([{ text: "a" }], { env: { AMA_MEMORY: "1" } });
    const on = await h.boot(["--model", "fake/echo"]);
    expect(on.tools.active().map((t) => t.name)).toContain("memory");
    expect(memoryOf(on.session)).toBeDefined();
    await on.dispose();
    const off = await h.boot(["--model", "fake/echo", "--no-memory"]);
    expect(off.tools.list()).not.toContain("memory");
    expect(memoryOf(off.session)).toBeUndefined();
    await off.dispose();
  });

  it("未受信任：项目作用域不读不写，模型写 /memories/project 被拒", async () => {
    h = composeHarness([
      {
        steps: [
          {
            toolCall: {
              name: "memory",
              arguments: { command: "create", path: "/memories/project/a.md", file_text: "x" },
            },
          },
        ],
      },
      { text: "ok" },
    ]);
    const runtime = await h.boot([
      "--model",
      "fake/echo",
      "--memory",
      "--permission-mode",
      "full-auto",
    ]);
    await runtime.session.prompt("q");
    const system = systemMessages(runtime.session)[0]!.sections["memory"];
    expect(system).toContain('<scope name="user">');
    expect(system).not.toContain('<scope name="project">');
    const result = runtime.session.entries.find(
      (e) => e.type === "message" && e.message.role === "toolResult",
    );
    expect(JSON.stringify(result)).toContain("unknown memory scope");
    expect(existsSync(join(h.home.env["AMA_DATA_DIR"]!, "memory", "projects"))).toBe(false);
    await runtime.dispose();
  });

  it("子会话：工具定义与 memory 节同父，写命令在执行层被拒（full-auto 也拒）", async () => {
    h = composeHarness([
      {
        steps: [
          { toolCall: { name: "task", arguments: { prompt: "remember x", background: false } } },
        ],
      },
      {
        steps: [
          {
            toolCall: {
              name: "memory",
              arguments: { command: "create", path: "/memories/user/x.md", file_text: "x" },
            },
          },
        ],
      },
      { text: "child done" },
      { text: "parent done" },
    ]);
    h.home.write("home/.config/ama/config.json", { version: 1, tools: { default: ["+task"] } });
    const runtime = await h.boot([
      "--model",
      "fake/echo",
      "--memory",
      "--permission-mode",
      "full-auto",
    ]);
    await runtime.session.prompt("go");
    expect(h.fake.calls).toHaveLength(4);
    const parent = h.fake.calls[0]!.context;
    const child = h.fake.calls[1]!.context;
    const memoryDecl = (c: TranscriptContext) =>
      JSON.stringify(replaySystem(c.messages)?.tools.find((t) => t.name === "memory"));
    const sectionOf = (c: TranscriptContext) => replaySystem(c.messages)?.sections["memory"];
    expect(sectionOf(parent)).toContain("<memory_index");
    expect(memoryDecl(parent)).toContain('"name":"memory"');
    expect(memoryDecl(child)).toBe(memoryDecl(parent));
    expect(sectionOf(child)).toBe(sectionOf(parent));
    const childResult = h.fake.calls[2]!.context.messages.at(-1);
    expect(childResult).toMatchObject({
      role: "toolResult",
      toolName: "memory",
      isError: true,
      content: "subagents cannot modify memory",
    });
    expect(existsSync(join(h.home.env["AMA_DATA_DIR"]!, "memory", "user", "x.md"))).toBe(false);
    await runtime.dispose();
  });

  it("工作空间目录：节里只有 workspace，条目来自 dir", async () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    await new MemoryStore({ workspace: dir }).create("/memories/workspace/ws.md", "工作空间笔记");
    const runtime = resolveMemory({
      config: {},
      cwd: "/w",
      dataDir: "/d",
      trusted: true,
      embedded: { memory: { enabled: true, dir } },
    })!;
    const section = runtime.renderSection()!;
    expect(section).toContain('<scope name="workspace">');
    expect(section).toContain("[ws](/memories/workspace/ws.md) — 工作空间笔记");
    expect(section).not.toContain('scope name="user"');
  });
});
