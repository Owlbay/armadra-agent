import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import { sharedCacheReporting } from "../../ai/cache/reporting.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import { emptyArgs } from "../../cli/args.js";
import type { ComposeOptions } from "../../cli/compose.js";
import { RPC_COMMAND_TYPES } from "./commands.js";
import { runRpcMode } from "./rpc-mode.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

type Line = Record<string, unknown>;

interface Driver {
  send(command: object): void;
  waitFor(predicate: (line: Line) => boolean, label?: string): Promise<Line>;
  lines: Line[];
}

async function drive(
  script: FakeResponse[] | undefined,
  steps: (d: Driver) => Promise<void>,
  options: ComposeOptions = {},
): Promise<{ code: number; lines: Line[]; raw: string[] }> {
  h = composeHarness(script);
  const runtime = await h.boot(["--mode", "rpc", "--model", "fake/echo"], options);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const raw: string[] = [];
  const lines: Line[] = [];
  let buffer = "";
  stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      raw.push(buffer.slice(0, at));
      lines.push(JSON.parse(buffer.slice(0, at)) as Line);
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
  });
  const done = runRpcMode(
    runtime,
    { args: emptyArgs(), prompt: undefined, io: h.io },
    { stdin, stdout },
  );
  const driver: Driver = {
    lines,
    send: (command) => void stdin.write(`${JSON.stringify(command)}\n`),
    async waitFor(predicate, label = "line") {
      const started = Date.now();
      for (;;) {
        const hit = lines.findLast(predicate);
        if (hit !== undefined) return hit;
        if (Date.now() - started > 5000)
          throw new Error(`timeout waiting for ${label}: ${lines.map((l) => l["type"]).join(",")}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
  await steps(driver);
  stdin.end();
  const code = await done;
  await runtime.dispose();
  return { code, lines, raw };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 归一化时间戳、id、版本、临时路径（实施计划 R7）。 */
function normalize(line: Line, root: string): string {
  return JSON.stringify(line, (key, value: unknown) => {
    if (key === "timestamp" || key === "durationMs") return 0;
    if (key === "version" && typeof value === "string") return "<version>";
    if (typeof value !== "string") return value;
    if (UUID.test(value)) return "<uuid>";
    if (/^[0-9a-f]{8}$/.test(value)) return "<id>";
    // Windows 上临时目录之后的路径分隔符是 \，统一成 / 才能与黄金记录比对。
    return value
      .split(root)
      .join("<root>")
      .replace(/<root>[^\s"]*/g, (path) => path.replace(/\\/g, "/"));
  });
}

function golden(name: string, actual: string): void {
  const file = new URL(`../../../test/fixtures/rpc/${name}`, import.meta.url);
  if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(file)) writeFileSync(file, actual);
  expect(actual).toBe(readFileSync(file, "utf8"));
}

const settled = (l: Line) => l["type"] === "agent_settled";

describe("RPC 模式", () => {
  it("黄金记录：hello → prompt → 事件序列 → agent_settled；关 stdin 有序退出 0", async () => {
    const { code, lines } = await drive(
      [{ text: "hello back", usage: { input: 10, output: 2 } }],
      async (d) => {
        await d.waitFor((l) => l["type"] === "hello", "hello");
        d.send({ id: "1", type: "prompt", message: "hi" });
        await d.waitFor(settled, "agent_settled");
        d.send({ id: "2", type: "get_last_assistant_text" });
        await d.waitFor((l) => l["id"] === "2");
      },
    );
    expect(code).toBe(0);
    expect(lines[0]).toMatchObject({ type: "hello", protocolVersion: 1, agent: "ama" });
    expect(lines.find((l) => l["id"] === "1")).toMatchObject({
      success: true,
      data: { disposition: "started" },
    });
    expect(lines.find((l) => l["id"] === "2")).toMatchObject({ data: { text: "hello back" } });
    expect(JSON.stringify(lines)).not.toContain('"partial"');
    golden("prompt.out.jsonl", lines.map((l) => normalize(l, h.home.root)).join("\n") + "\n");
  });

  it("set_client_capabilities 之前 ask → deny；之后 permission_response 作答", async () => {
    const bash = (command: string): FakeResponse => ({
      steps: [{ toolCall: { name: "bash", arguments: { command } } }],
    });
    const { lines } = await drive(
      [bash("echo one"), { text: "a" }, bash("echo two"), { text: "b" }],
      async (d) => {
        d.send({ id: "p1", type: "prompt", message: "first" });
        await d.waitFor(settled);
        d.send({ id: "c", type: "set_client_capabilities", capabilities: ["approvals"] });
        await d.waitFor((l) => l["id"] === "c");
        d.send({ id: "p2", type: "prompt", message: "second" });
        const request = await d.waitFor(
          (l) => isRequest(l) && d.lines.filter(isRequest).length === 2,
        );
        d.send({
          id: "r",
          type: "permission_response",
          requestId: request["requestId"],
          decision: "allow",
        });
        await d.waitFor((l) => settled(l) && d.lines.filter(settled).length === 2);
      },
    );
    const resolved = lines.filter((l) => l["type"] === "permission_resolved");
    expect(resolved.map((l) => l["decision"])).toEqual(["deny", "allow"]);
    expect(lines.find((l) => l["id"] === "r")).toMatchObject({ data: { accepted: true } });
    const results = lines.filter((l) => l["type"] === "tool_execution_end") as {
      isError: boolean;
    }[];
    expect(results.map((r) => r.isError)).toEqual([true, false]);
  });

  it("审批超时 → deny 并发 permission_resolved；permission_request 带 timeoutMs", async () => {
    const { lines } = await drive(
      [
        { steps: [{ toolCall: { name: "bash", arguments: { command: "echo x" } } }] },
        { text: "k" },
      ],
      async (d) => {
        d.send({ type: "set_client_capabilities", capabilities: ["approvals"] });
        d.send({ type: "prompt", message: "go" });
        await d.waitFor(settled);
      },
      { approvalTimeoutMs: 40 },
    );
    expect(lines.find(isRequest)).toMatchObject({ timeoutMs: 40, toolName: "bash" });
    expect(lines.find((l) => l["type"] === "permission_resolved")).toMatchObject({
      decision: "deny",
    });
  });

  it("permission_request 带执行前预览 preview（只读统计，拒绝后目录仍在）", async () => {
    const { lines } = await drive(
      [
        { steps: [{ toolCall: { name: "bash", arguments: { command: "rm -rf build" } } }] },
        { text: "k" },
      ],
      async (d) => {
        mkdirSync(join(h.home.cwd, "build", "sub"), { recursive: true });
        writeFileSync(join(h.home.cwd, "build", "a.o"), "abc");
        writeFileSync(join(h.home.cwd, "build", "sub", "b.o"), "de");
        d.send({ type: "set_client_capabilities", capabilities: ["approvals"] });
        d.send({ type: "prompt", message: "go" });
        const request = await d.waitFor(isRequest, "permission_request");
        d.send({ type: "permission_response", requestId: request["requestId"], decision: "deny" });
        await d.waitFor(settled);
      },
    );
    expect(lines.find(isRequest)?.["preview"]).toEqual({
      kind: "bash",
      lines: ["删除 build/：目录，2 个文件，5 B"],
      severity: "warn",
      affected: [{ path: "build/", exists: true, files: 2, bytes: 5 }],
    });
    expect(existsSync(join(h.home.cwd, "build", "a.o"))).toBe(true);
  });

  it("解析失败、未知命令、busy 都回错误响应；abort 中断运行后关 stdin 退出 0", async () => {
    const started = Date.now();
    const { code, lines } = await drive([{ delayMs: 10_000, text: "slow" }], async (d) => {
      d.send({ id: "x", type: "no_such" });
      await d.waitFor((l) => l["id"] === "x");
      (d as unknown as { send(raw: object): void }).send({});
      d.send({ id: "a", type: "prompt", message: "slow one" });
      await d.waitFor((l) => l["type"] === "agent_start");
      d.send({ id: "b", type: "prompt", message: "again" });
      await d.waitFor((l) => l["id"] === "b");
      d.send({ id: "c", type: "abort" });
      await d.waitFor((l) => l["id"] === "c");
    });
    expect(code).toBe(0);
    expect(lines.find((l) => l["type"] === "agent_end")).toMatchObject({ stopReason: "aborted" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(lines.find((l) => l["id"] === "x")).toMatchObject({
      success: false,
      error: "未知命令：no_such",
    });
    expect(lines.find((l) => l["command"] === "parse")).toMatchObject({ success: false });
    expect(lines.find((l) => l["id"] === "b")).toMatchObject({ success: false, code: "busy" });
  });
});

describe("RPC 模式：stdin 结束", () => {
  it("已开始的运行跑完再退出（管道里一次性写完命令也能拿到回复）", async () => {
    const { code, lines } = await drive([{ delayMs: 50, text: "late reply" }], async (d) => {
      d.send({ id: "p", type: "prompt", message: "hi" });
      await d.waitFor((l) => l["id"] === "p");
    });
    expect(code).toBe(0);
    expect(lines.find((l) => l["type"] === "agent_end")).toMatchObject({ stopReason: "stop" });
    expect(JSON.stringify(lines)).toContain("late reply");
  });
});

describe("RPC 命令表", () => {
  it("37 条命令都有处理器；状态 / 模型 / 工具 / 会话类命令往返成功", async () => {
    expect(RPC_COMMAND_TYPES).toHaveLength(37);
    const { lines } = await drive([{ text: "one" }, { text: "two" }], async (d) => {
      d.send({ id: "p", type: "prompt", message: "hello" });
      await d.waitFor(settled);
      const queries: object[] = [
        { type: "get_state" },
        { type: "get_messages" },
        { type: "get_session_stats" },
        { type: "get_available_models" },
        { type: "get_available_thinking_levels" },
        { type: "set_thinking_level", level: "low" },
        { type: "set_model", provider: "fake", modelId: "reasoning" },
        { type: "set_steering_mode", mode: "all" },
        { type: "set_follow_up_mode", mode: "all" },
        { type: "set_auto_compaction", enabled: false },
        { type: "set_auto_retry", enabled: false },
        { type: "abort_retry" },
        { type: "clear_queue" },
        { type: "get_tools" },
        { type: "set_active_tools", names: ["read", "grep"] },
        { type: "set_permission_mode", mode: "plan" },
        { type: "get_commands" },
        { type: "get_skills" },
        { type: "get_entries" },
        { type: "get_tree" },
        { type: "set_session_name", name: "demo" },
        { type: "get_fork_messages" },
        { type: "abort" },
      ];
      queries.forEach((q, i) => d.send({ ...q, id: `q${i}` }));
      await d.waitFor((l) => l["id"] === `q${queries.length - 1}`);
      const fork = (await d.waitFor((l) => l["id"] === "q21"))["data"] as {
        messages: { entryId: string }[];
      };
      d.send({ id: "f", type: "fork", entryId: fork.messages[0]?.entryId });
      await d.waitFor((l) => l["id"] === "f");
      d.send({ id: "n", type: "new_session" });
      await d.waitFor((l) => l["id"] === "n");
      d.send({ id: "s", type: "get_state" });
      await d.waitFor((l) => l["id"] === "s");
    });
    const failures = lines.filter((l) => l["type"] === "response" && l["success"] !== true);
    expect(failures).toEqual([]);
    const byId = (id: string) =>
      lines.find((l) => l["id"] === id)?.["data"] as Record<string, unknown>;
    expect(byId("q2")).toHaveProperty("tokens");
    const models = byId("q3")["models"] as { provider: string; hasKey: boolean }[];
    expect(models.find((m) => m.provider === "fake")?.hasKey).toBe(true);
    expect(JSON.stringify(models)).not.toMatch(/apiKey/);
    expect(byId("q14")).toEqual({ names: ["grep", "read"] });
    expect(byId("s")).toMatchObject({ permissionMode: "plan", messageCount: 0 });
    expect(lines.filter((l) => l["type"] === "session_start")).toHaveLength(3);
  });
});

describe("RPC 回滚", () => {
  it("黄金记录：get_rewind_points → rewind 预览 → rewind（对话 + 代码）→ session_rewound，文件真的回到之前", async () => {
    const { lines } = await drive(
      [
        { text: "one" },
        {
          steps: [
            { toolCall: { name: "write", arguments: { path: "c.txt", content: "gamma\n" } } },
          ],
        },
        { text: "two" },
      ],
      async (d) => {
        d.send({ id: "m", type: "set_permission_mode", mode: "auto-edit" });
        await d.waitFor((l) => l["id"] === "m");
        d.send({ id: "p1", type: "prompt", message: "first" });
        await d.waitFor(settled);
        d.send({ id: "p2", type: "prompt", message: "second" });
        await d.waitFor((l) => settled(l) && d.lines.filter(settled).length === 2);
        expect(existsSync(join(h.home.cwd, "c.txt"))).toBe(true);
        d.send({ id: "pts", type: "get_rewind_points" });
        const points = (await d.waitFor((l) => l["id"] === "pts"))["data"] as {
          points: { entryId: string }[];
        };
        const target = points.points[1]?.entryId;
        d.send({ id: "dry", type: "rewind", entryId: target, mode: "both", dryRun: true });
        await d.waitFor((l) => l["id"] === "dry");
        d.send({ id: "rw", type: "rewind", entryId: target, mode: "both" });
        await d.waitFor((l) => l["id"] === "rw");
        d.send({ id: "bad", type: "summarize_up_to", entryId: "missing" });
        await d.waitFor((l) => l["id"] === "bad");
        d.send({ id: "after", type: "get_rewind_points" });
        await d.waitFor((l) => l["id"] === "after");
      },
    );
    expect(existsSync(join(h.home.cwd, "c.txt"))).toBe(false);
    expect(lines.find((l) => l["id"] === "dry")).toMatchObject({
      success: true,
      data: { code: { deleted: ["c.txt"] } },
    });
    expect(lines.find((l) => l["id"] === "rw")).toMatchObject({
      success: true,
      data: { conversation: { draft: { text: "second" } }, code: { deleted: ["c.txt"] } },
    });
    expect(lines.find((l) => l["id"] === "bad")).toMatchObject({ code: "invalid_arguments" });
    const from = lines.findIndex((l) => l["id"] === "pts");
    golden(
      "rewind.out.jsonl",
      lines
        .slice(from)
        .filter((l) => l["type"] !== "entry_appended")
        .map((l) => normalize(l, h.home.root))
        .join("\n") + "\n",
    );
  });
});

describe("RPC set_permission_mode", () => {
  it("接受 auto 与 allowlist；未知模式报 invalid_arguments", async () => {
    const { lines } = await drive([{ text: "one" }], async (d) => {
      d.send({ id: "a", type: "set_permission_mode", mode: "auto" });
      d.send({ id: "b", type: "set_permission_mode", mode: "allowlist" });
      d.send({ id: "c", type: "set_permission_mode", mode: "yolo" });
      d.send({ id: "s", type: "get_state" });
      await d.waitFor((l) => l["id"] === "s");
    });
    const byId = (id: string) => lines.find((l) => l["id"] === id) as Record<string, unknown>;
    expect(byId("a")).toMatchObject({ success: true, data: { mode: "auto" } });
    expect(byId("b")).toMatchObject({ success: true, data: { mode: "allowlist" } });
    expect(byId("c")).toMatchObject({ success: false });
    expect(JSON.stringify(byId("c"))).toContain("invalid_arguments");
    expect(byId("s")["data"]).toMatchObject({ permissionMode: "allowlist" });
  });
});

describe("RPC get_session_stats.cache [W3-C2]", () => {
  it("形状：三态、最近 / 会话命中率、未命中按原因、保温状态、余量；未命中与余量事件在流里", async () => {
    sharedCacheReporting.clear();
    const { lines } = await drive(
      [
        { text: "one", usage: { input: 2_000, output: 10, cacheRead: 140_000 } },
        { text: "two", usage: { input: 150_000, output: 10 } },
      ],
      async (d) => {
        d.send({ id: "p1", type: "prompt", message: "first" });
        await d.waitFor(settled);
        d.send({ id: "p2", type: "prompt", message: "second" });
        await d.waitFor((l) => l["type"] === "agent_settled" && settledCount(d) >= 2);
        d.send({ id: "st", type: "get_session_stats" });
        await d.waitFor((l) => l["id"] === "st");
      },
    );
    const stats = lines.find((l) => l["id"] === "st")?.["data"] as Record<string, unknown>;
    expect(stats["cache"]).toEqual({
      reporting: "reported",
      lastHitRate: 0,
      hitRate: 140_000 / 292_000,
      reBilledTokens: 142_000,
      reBilledUsd: expect.closeTo(0.1278, 4),
      misses: { count: 1, byReason: { evicted: 1 } },
      warming: { mode: "streaming", state: "stopped", reason: "no_ttl" },
      contextRemainingTokens: expect.any(Number),
      estimatedTurnsLeft: expect.any(Number),
    });
    const types = lines.map((l) => l["type"]);
    expect(types).toContain("context_pressure");
    expect(types).toContain("cache_miss");
  });
});

function settledCount(d: Driver): number {
  return d.lines.filter((l) => l["type"] === "agent_settled").length;
}

function isRequest(line: Line): boolean {
  return line["type"] === "permission_request";
}
