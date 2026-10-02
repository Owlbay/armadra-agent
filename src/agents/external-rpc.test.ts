/**
 * W5-EG 组装根级验收：RPC 黄金记录 `external.out.jsonl`（`task(agent="acp:ama")` 的三次审批——
 * task 工具、首次运行确认、子 ama 的 bash——都发给 RPC 客户端，`permission_request.context` 标出
 * 任务与外部会话）；`get_agents` 的外部探测缓存；宿主 `runners.provide` 注入的 runner 走同一入口。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { amaAcpChild, type AmaAcpChild } from "../../test/helpers/ama-acp-child.js";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import type { FakeResponse } from "../ai/fake/fake-script.js";
import { emptyArgs } from "../cli/args.js";
import type { Runtime } from "../cli/runtime.js";
import { runRpcMode } from "../modes/rpc/rpc-mode.js";
import type { SubagentRunRequest } from "../tools/types.js";
import { cachedAgentInfos } from "./external.js";

let h: ComposeHarness | undefined;
let child: AmaAcpChild | undefined;
let runtime: Runtime | undefined;
afterEach(async () => {
  await runtime?.dispose().catch(() => undefined);
  await child?.cleanup();
  h?.cleanup();
  h = child = runtime = undefined;
});

type Line = Record<string, unknown>;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function normalize(line: Line, root: string): string {
  return JSON.stringify(line, (key, value: unknown) => {
    if (["timestamp", "durationMs", "startedAt", "endedAt"].includes(key)) return 0;
    // 子 ama 的用量随系统提示与工具表变化，不进黄金
    if (key === "usage") return "<usage>";
    if (typeof value !== "string") return value;
    return value.split(root).join("<root>").replace(/\\/g, "/").replace(UUID, "<uuid>");
  });
}

function golden(name: string, actual: string): void {
  const file = new URL(`../../test/fixtures/rpc/${name}`, import.meta.url);
  if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(file)) writeFileSync(file, actual);
  expect(actual).toBe(readFileSync(file, "utf8"));
}

/** 起 RPC 模式；返回收到的行、发送函数与等待函数。 */
function drive(rt: Runtime, io: ComposeHarness["io"]) {
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
  const done = runRpcMode(rt, { args: emptyArgs(), prompt: undefined, io }, { stdin, stdout });
  const send = (msg: Line): void => void stdin.write(`${JSON.stringify(msg)}\n`);
  const waitFor = async (check: (l: Line) => boolean, label: string): Promise<Line> => {
    const started = Date.now();
    for (;;) {
      const hit = lines.find(check);
      if (hit !== undefined) return hit;
      if (Date.now() - started > 5000) throw new Error(`timeout: ${label}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { lines, send, waitFor, done, end: () => stdin.end() };
}

const parentScript: FakeResponse[] = [
  {
    steps: [
      {
        toolCall: {
          name: "task",
          arguments: { prompt: "run it", agent: "acp:ama", description: "child" },
        },
      },
    ],
  },
  { text: "parent done" },
];

describe("RPC 黄金记录：外部 Agent 的审批", () => {
  it("external.out.jsonl：permission_request.context 标出任务与外部会话；人答允许", async () => {
    h = composeHarness(parentScript);
    child = await amaAcpChild(h.home.cwd, [
      { steps: [{ toolCall: { name: "bash", arguments: { command: "echo from-child" } } }] },
      { text: "child ran it" },
    ]);
    runtime = await h.boot([
      "--mode",
      "rpc",
      "--model",
      "fake/echo",
      "--tools",
      "read,task",
      "--trust",
    ]);
    const answered = new Set<string>();
    const d = drive(runtime, h.io);
    d.send({ id: "c", type: "set_client_capabilities", capabilities: ["approvals"] });
    d.send({ id: "p", type: "prompt", message: "delegate" });
    for (let i = 0; i < 3; i++) {
      const request = await d.waitFor(
        (l) => l["type"] === "permission_request" && !answered.has(String(l["requestId"])),
        `permission_request ${i + 1}`,
      );
      answered.add(String(request["requestId"]));
      d.send({ type: "permission_response", requestId: request["requestId"], decision: "allow" });
    }
    await d.waitFor((l) => l["type"] === "agent_settled", "agent_settled");
    d.end();
    expect(await d.done).toBe(0);
    const kept = d.lines.filter((l) => {
      const type = String(l["type"]);
      return (
        type.startsWith("permission_") ||
        type.startsWith("subagent_") ||
        type.startsWith("tool_execution_") ||
        type === "response" ||
        type === "agent_settled"
      );
    });
    const requests = kept.filter((l) => l["type"] === "permission_request");
    expect(requests.map((l) => l["toolName"])).toEqual(["task", "task", "agent:acp:ama"]);
    expect(requests[2]).toMatchObject({
      context: {
        depth: 1,
        taskId: "t1",
        origin: { agent: "acp:ama", sessionId: child.runtime.session.state.sessionId },
      },
    });
    golden("external.out.jsonl", kept.map((l) => normalize(l, h!.home.root)).join("\n") + "\n");
  });
});

describe("get_agents 与宿主 runner", () => {
  it("get_agents：探测结果缓存后带上外部 Agent 的安装与版本", async () => {
    h = composeHarness([{ text: "hi" }]);
    child = await amaAcpChild(h.home.cwd, []);
    // 打开探测（setup 缺省关闭）；探测本身用注入的 probe，不看本机 PATH
    const saved = process.env["AMA_NO_AGENT_PROBE"];
    delete process.env["AMA_NO_AGENT_PROBE"];
    try {
      runtime = await h.boot(["--mode", "rpc", "--model", "fake/echo", "--tools", "read,task"]);
    } finally {
      process.env["AMA_NO_AGENT_PROBE"] = saved;
    }
    const sessionId = runtime.session.state.sessionId;
    const started = Date.now();
    while (cachedAgentInfos(sessionId) === undefined) {
      if (Date.now() - started > 5000) throw new Error("probe timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
    const d = drive(runtime, h.io);
    d.send({ id: "a", type: "get_agents" });
    const response = await d.waitFor((l) => l["id"] === "a", "get_agents");
    d.end();
    await d.done;
    const agents = (response["data"] as { agents: Line[] }).agents;
    const byName = new Map(agents.map((a) => [a["name"], a]));
    expect(byName.get("claude")).toMatchObject({
      runner: "claude",
      installed: true,
      version: "0.5.0",
    });
    expect(byName.get("acp:ama")).toMatchObject({ runner: "acp:ama", installed: true });
    expect(agents.slice(0, 3).map((a) => a["name"])).toEqual(["general", "explore", "plan"]);
  });

  it("宿主 runners.provide：注入的 runner 以 task(agent=<id>) 出现；内置外部 Agent 不可用", async () => {
    h = composeHarness([
      { steps: [{ toolCall: { name: "task", arguments: { prompt: "draw", agent: "canvas" } } }] },
      { steps: [{ toolCall: { name: "task", arguments: { prompt: "x", agent: "claude" } } }] },
      { text: "done" },
    ]);
    const seen: SubagentRunRequest[] = [];
    (globalThis as Record<string, unknown>)["__amaHostRunnerSeen"] = seen;
    const host = h.home.write(
      "work/host-runner.cjs",
      `module.exports = { hostApi: 1, create(api) {
  api.runners.provide({
    id: "canvas",
    description: "Canvas node",
    async start(req) {
      globalThis.__amaHostRunnerSeen.push(req);
      return {
        id: "node-1",
        async send() {},
        async wait() {
          return { text: "drawn by host", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "stop", isError: false, status: "completed" };
        },
        async stop() {},
      };
    },
  });
  return { id: "canvas-host" };
} };`,
    );
    runtime = await h.boot([
      "--model",
      "fake/echo",
      "--tools",
      "read,task",
      "--permission-mode",
      "full-auto",
      "--trust",
      "--host",
      host,
    ]);
    const first = h.fake.calls.length;
    await runtime.session.prompt("go");
    const description = String(
      (h.fake.calls[first]!.context.messages[0] as { toolsAdded?: Line[] }).toolsAdded?.find(
        (t) => t["name"] === "task",
      )?.["description"],
    );
    expect(description).toContain("- canvas: Canvas node");
    expect(description).not.toContain("claude");
    const results = runtime.session.messages
      .filter((m) => "role" in m && m.role === "toolResult")
      .map((m) => JSON.stringify((m as { content: unknown }).content));
    expect(results[0]).toContain("drawn by host");
    // [W6-I3] 进 task 结果（模型可见）的错误固定英文
    expect(results[1]).toMatch(/come from the host/);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ prompt: "draw", taskId: "t1", mode: "full-auto" });
  });
});
