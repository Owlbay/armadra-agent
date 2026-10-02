/**
 * W5-G 组装根级验收：RPC 黄金记录 `subagent.out.jsonl`（subagent_* 事件）；子会话首请求的
 * tools + system 指纹与父相同（设计 §9.1，D23）；`--agent-dir` 定义文件生效。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { buildAnthropicRequest } from "../ai/apis/anthropic-request.js";
import { buildOpenAIRequest } from "../ai/apis/openai-request.js";
import type { FakeResponse } from "../ai/fake/fake-script.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import type { Model, TranscriptContext } from "../ai/types.js";
import { emptyArgs } from "../cli/args.js";
import { runRpcMode } from "../modes/rpc/rpc-mode.js";
import { sessionAgents, taskRegistryView } from "./subagent-registry.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

type Line = Record<string, unknown>;
type Json = Record<string, unknown>;

const script: FakeResponse[] = [
  {
    steps: [
      {
        toolCall: {
          name: "task",
          arguments: { prompt: "find the config loader", agent: "explore", description: "find" },
        },
      },
    ],
  },
  { text: "src/config/load.ts:12", usage: { input: 50, output: 5 } },
  { text: "done", usage: { input: 60, output: 1 } },
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function normalize(line: Line, root: string): string {
  return JSON.stringify(line, (key, value: unknown) => {
    if (["timestamp", "durationMs", "startedAt", "endedAt"].includes(key)) return 0;
    if (typeof value !== "string") return value;
    return value
      .split(root)
      .join("<root>")
      .replace(/\\/g, "/")
      .replace(UUID, "<uuid>")
      .replace(/\/sessions\/[^/]+\//g, "/sessions/<cwd>/")
      .replace(/\d{4}-\d{2}-\d{2}T[\d-]+(?:\.\d+)?Z?/g, "<time>");
  });
}

function golden(name: string, actual: string): void {
  const file = new URL(`../../test/fixtures/rpc/${name}`, import.meta.url);
  if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(file)) writeFileSync(file, actual);
  expect(actual).toBe(readFileSync(file, "utf8"));
}

describe("RPC 黄金记录：子 Agent 事件", () => {
  it("subagent.out.jsonl：task(explore) → subagent_start / update / end → 工具结果", async () => {
    h = composeHarness(script);
    const runtime = await h.boot([
      "--mode",
      "rpc",
      "--model",
      "fake/echo",
      "--tools",
      "read,task",
      "--permission-mode",
      "full-auto",
    ]);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const lines: Line[] = [];
    let buffer = "";
    stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        lines.push(JSON.parse(buffer.slice(0, at)) as Line);
        buffer = buffer.slice(at + 1);
      }
    });
    const done = runRpcMode(
      runtime,
      { args: emptyArgs(), prompt: undefined, io: h.io },
      { stdin, stdout },
    );
    stdin.write(
      `${JSON.stringify({ id: "p", type: "prompt", message: "where is config loaded?" })}\n`,
    );
    const started = Date.now();
    while (!lines.some((l) => l["type"] === "agent_settled")) {
      if (Date.now() - started > 5000) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
    const sessionId = runtime.session.state.sessionId;
    expect(taskRegistryView(sessionId)?.list()).toMatchObject([
      { taskId: "t1", agent: "explore", status: "completed", turns: 1 },
    ]);
    expect(sessionAgents(sessionId).map((a) => a.name)).toEqual(["general", "explore", "plan"]);
    stdin.write(`${JSON.stringify({ id: "t", type: "get_tasks" })}\n`);
    stdin.write(`${JSON.stringify({ id: "a", type: "get_agents" })}\n`);
    while (!lines.some((l) => l["id"] === "a")) {
      if (Date.now() - started > 5000) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(lines.find((l) => l["id"] === "t")).toMatchObject({
      success: true,
      data: { tasks: [{ taskId: "t1", agent: "explore", status: "completed" }] },
    });
    stdin.end();
    expect(await done).toBe(0);
    await runtime.dispose();
    const kept = lines.filter((l) => {
      const type = String(l["type"]);
      return (
        type.startsWith("subagent_") ||
        type.startsWith("tool_execution_") ||
        type === "response" ||
        type === "agent_settled"
      );
    });
    expect(kept.map((l) => l["type"])).toEqual([
      "response",
      "tool_execution_start",
      "subagent_start",
      "subagent_update",
      "subagent_update",
      "subagent_end",
      "tool_execution_end",
      "agent_settled",
      "response",
      "response",
    ]);
    golden("subagent.out.jsonl", kept.map((l) => normalize(l, h.home.root)).join("\n") + "\n");
  });
});

const registry = new ProviderRegistry({ keys: { useEnv: false, userAuthFile: null } });
const anthropic = registry.get("anthropic")?.models[0] as Model;
const openai = registry.get("openai")?.models[0] as Model;
const signal = new AbortController().signal;

function stripCache(items: unknown): unknown {
  return JSON.parse(JSON.stringify(items ?? null), (key, value) =>
    key === "cache_control" ? undefined : value,
  );
}

function request(context: TranscriptContext): { anthropic: Json; openai: Json } {
  return {
    anthropic: buildAnthropicRequest(anthropic, context, { signal, cacheRetention: "short" }).body,
    openai: buildOpenAIRequest(openai, context, { signal }).body,
  };
}

describe("缓存：子会话首请求与父共用 tools + system 前缀（D23）", () => {
  it("工具表逐字节相同；父的 system 块是子的前缀，子只在末尾多一个 role 块", async () => {
    h = composeHarness(script);
    h.home.write("work/AGENTS.md", "project rules");
    const runtime = await h.boot([
      "--model",
      "fake/echo",
      "--tools",
      "read,grep,task",
      "--permission-mode",
      "full-auto",
    ]);
    await runtime.session.prompt("where is config loaded?");
    expect(h.fake.calls).toHaveLength(3);
    const parent = request(h.fake.calls[0]!.context);
    const child = request(h.fake.calls[1]!.context);
    expect(JSON.stringify(stripCache(child.anthropic["tools"]))).toBe(
      JSON.stringify(stripCache(parent.anthropic["tools"])),
    );
    expect(JSON.stringify(child.openai["tools"])).toBe(JSON.stringify(parent.openai["tools"]));
    const parentSystem = stripCache(parent.anthropic["system"]) as Json[];
    const childSystem = stripCache(child.anthropic["system"]) as Json[];
    expect(childSystem).toHaveLength(parentSystem.length + 1);
    expect(JSON.stringify(childSystem.slice(0, -1))).toBe(JSON.stringify(parentSystem));
    expect(String(childSystem.at(-1)?.["text"])).toContain("You are a sub-agent");
    expect(JSON.stringify(parentSystem)).toContain("project rules");
    const parentOpenAI = String((parent.openai["messages"] as Json[])[0]?.["content"]);
    const childOpenAI = String((child.openai["messages"] as Json[])[0]?.["content"]);
    expect(childOpenAI.startsWith(parentOpenAI)).toBe(true);
    // 父后续请求的前缀不受子会话影响
    const after = request(h.fake.calls[2]!.context);
    expect(JSON.stringify(after.anthropic["system"])).toBe(
      JSON.stringify(parent.anthropic["system"]),
    );
    await runtime.dispose();
  });
});

describe("--agent-dir", () => {
  it("定义文件生效：task 描述列出、类型角色进子会话 role 节；未信任项目的 .ama/agents 跳过并提示", async () => {
    h = composeHarness([
      {
        steps: [{ toolCall: { name: "task", arguments: { prompt: "review", agent: "reviewer" } } }],
      },
      { text: "looks fine" },
      { text: "done" },
    ]);
    h.home.write("defs/reviewer.md", "---\ndescription: Reviews diffs\n---\nCite file:line.\n");
    h.home.write("work/.ama/agents/local.md", "---\ndescription: local one\n---\n");
    const runtime = await h.boot([
      "--model",
      "fake/echo",
      "--tools",
      "read,task",
      "--permission-mode",
      "full-auto",
      "--agent-dir",
      `${h.home.root}/defs`,
    ]);
    await runtime.session.prompt("check it");
    const first = h.fake.calls[0]!.context.messages[0] as { toolsAdded?: Json[] };
    const task = first.toolsAdded?.find((t) => t["name"] === "task");
    expect(String(task?.["description"])).toContain("- reviewer: Reviews diffs");
    expect(String(task?.["description"])).not.toContain("local one");
    const childSystem = h.fake.calls[1]!.context.messages[0] as {
      sections: Record<string, string>;
    };
    expect(childSystem.sections["role"]).toContain("Cite file:line.");
    expect(runtime.warnings.join("\n")).toMatch(/项目未信任，跳过子 Agent 定义目录 .*agents/);
    await runtime.dispose();
  });
});
