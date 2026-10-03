/**
 * [W7-B2] RPC `background_task`（docs/agents-concurrency-plan.md §2.5）：黄金记录 background.out.jsonl——前台
 * task 运行中转后台 → 工具调用立即返回固定文本、`subagent_background`，父继续；任务结束后 `subagent_end` 与
 * `origin: "task"` 的通知回合。fake 供应商父子共用一份脚本：子会话的首个请求带延迟，父阻塞在前台 task 上，
 * 请求先后因此确定。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import type { AgentSession, SessionEvent } from "../../agent/types.js";
import { emptyArgs } from "../../cli/args.js";
import type { RpcCommandMap, RpcW7Results } from "../../rpc.js";
import { runRpcMode } from "./rpc-mode.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

type Line = Record<string, unknown>;

const script: FakeResponse[] = [
  {
    steps: [
      {
        toolCall: {
          name: "task",
          arguments: {
            prompt: "scan the repo",
            agent: "explore",
            description: "scan",
            background: false,
          },
        },
      },
    ],
  },
  { delayMs: 400, text: "child report", usage: { input: 50, output: 5 } },
  { text: "parent continues", usage: { input: 60, output: 2 } },
  { text: "noted the report", usage: { input: 70, output: 3 } },
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
  const file = new URL(`../../../test/fixtures/rpc/${name}`, import.meta.url);
  if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(file)) writeFileSync(file, actual);
  expect(actual).toBe(readFileSync(file, "utf8"));
}

async function until(lines: Line[], match: (l: Line) => boolean, from = 0): Promise<Line> {
  const started = Date.now();
  for (;;) {
    const found = lines.slice(from).find(match);
    if (found !== undefined) return found;
    if (Date.now() - started > 5000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("RPC background_task", () => {
  it("接口形状：命令参数、返回值、事件与 SDK 方法", () => {
    expectTypeOf<RpcCommandMap["background_task"]>().toEqualTypeOf<{ taskId?: string }>();
    expectTypeOf<RpcW7Results["background_task"]>().toEqualTypeOf<{ backgrounded: string[] }>();
    expectTypeOf<Extract<SessionEvent, { type: "subagent_background" }>>().toEqualTypeOf<{
      type: "subagent_background";
      taskId: string;
      parentToolCallId: string;
      reason: "user" | "timeout" | "host";
    }>();
    expectTypeOf<AgentSession["backgroundTask"]>().toBeFunction();
  });

  it("background.out.jsonl：前台 task 转后台 → 立即返回、父继续 → 任务结束 → 通知回合", async () => {
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
    const send = (command: Line): void => void stdin.write(`${JSON.stringify(command)}\n`);
    send({ id: "p", type: "prompt", message: "scan in the background" });
    await until(lines, (l) => l["type"] === "subagent_start");
    send({ id: "b", type: "background_task" });
    const response = await until(lines, (l) => l["id"] === "b");
    expect(response).toMatchObject({ success: true, data: { backgrounded: ["t1"] } });
    const end = await until(
      lines,
      (l) => l["type"] === "tool_execution_end" && l["toolName"] === "task",
    );
    expect(JSON.stringify(end)).toContain("Moved to the background");
    // 已在后台 / 不存在的任务：空表；参数类型不对：invalid_arguments
    send({ id: "again", type: "background_task", taskId: "t1" });
    send({ id: "none", type: "background_task", taskId: "t9" });
    send({ id: "bad", type: "background_task", taskId: 1 });
    await until(lines, (l) => l["id"] === "bad");
    expect(lines.find((l) => l["id"] === "again")).toMatchObject({ data: { backgrounded: [] } });
    expect(lines.find((l) => l["id"] === "none")).toMatchObject({ data: { backgrounded: [] } });
    expect(lines.find((l) => l["id"] === "bad")).toMatchObject({
      success: false,
      code: "invalid_arguments",
    });
    const isNotification = (l: Line): boolean =>
      l["type"] === "message_end" &&
      (l["message"] as { role?: string; origin?: string }).role === "user" &&
      JSON.stringify(l["message"]).includes("<task-notification");
    const at = lines.indexOf(await until(lines, isNotification));
    await until(lines, (l) => l["type"] === "agent_settled", at);
    stdin.end();
    expect(await done).toBe(0);
    await runtime.dispose();
    const kept = lines.filter((l) => {
      const type = String(l["type"]);
      return (
        type.startsWith("subagent_") ||
        type.startsWith("tool_execution_") ||
        (type === "response" && ["p", "b"].includes(String(l["id"]))) ||
        type === "agent_settled" ||
        isNotification(l)
      );
    });
    golden("background.out.jsonl", kept.map((l) => normalize(l, h.home.root)).join("\n") + "\n");
    expect(kept.map((l) => l["type"])).toEqual([
      "response",
      "tool_execution_start",
      "subagent_start",
      "subagent_background",
      "response",
      "tool_execution_end",
      "agent_settled",
      "subagent_update",
      "subagent_update",
      "subagent_end",
      "message_end",
      "agent_settled",
    ]);
  });
});
