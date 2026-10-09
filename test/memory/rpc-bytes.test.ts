/**
 * RPC 精简事件的字节回归（docs/memory-plan.md D9、§2.7、§3「[M-G]」）。[M-G]
 *
 * 一次工具调用返回 1 MB 文本：未声明 `compact_events` 时 stdout 上含该文本的事件恰 5 条（message_start /
 * message_end / tool_execution_end / turn_end / entry_appended，现状基线）；声明后恰 2 条（message_end、
 * tool_execution_end），总字节比 < 0.45。`--output-format stream-json` 不受影响（仍是 5 条）。
 *
 * 1 MB 结果由 SDK 追加的只读工具给出：内置 `read` 单次输出有 50 KB 上限，造不出 1 MB 的单个结果；
 * `tools.maxToolResultChars` 放宽到 2 M，结果不被会话层截断。
 */

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/tools/types.js";
import type { FakeResponse } from "../../src/ai/fake/fake-script.js";
import { emptyArgs } from "../../src/cli/args.js";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.js";
import { composeHarness, type ComposeHarness } from "../helpers/compose-harness.js";

const MARKER = "M-G-BLOB-7f3a";
const BLOB = MARKER + "y".repeat(1024 * 1024 - MARKER.length);

const blobTool: ToolDefinition = {
  name: "blob",
  description: "Return a large text.",
  parameters: { type: "object", properties: {} },
  permission: "read",
  execute: async () => ({ content: BLOB }),
};

const script = (): FakeResponse[] => [
  { steps: [{ toolCall: { name: "blob", arguments: {} } }] },
  { text: "done" },
];

function harness(): ComposeHarness {
  const next = composeHarness(script());
  next.home.write("home/.config/ama/config.json", {
    version: 1,
    tools: { maxToolResultChars: 2_000_000 },
  });
  return next;
}

let h: ComposeHarness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

type Line = Record<string, unknown>;

async function runRpc(compact: boolean): Promise<{ raw: string[]; lines: Line[]; bytes: number }> {
  h = harness();
  const runtime = await h.boot(["--mode", "rpc", "--model", "fake/echo"], {
    extraTools: [blobTool],
  });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const raw: string[] = [];
  const lines: Line[] = [];
  let bytes = 0;
  let buffer = "";
  stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    buffer += chunk.toString("utf8");
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      raw.push(buffer.slice(0, at));
      lines.push(JSON.parse(buffer.slice(0, at)) as Line);
      buffer = buffer.slice(at + 1);
    }
  });
  const done = runRpcMode(
    runtime,
    { args: emptyArgs(), prompt: undefined, io: h.io },
    { stdin, stdout },
  );
  const waitFor = async (predicate: (line: Line) => boolean): Promise<void> => {
    const started = Date.now();
    while (!lines.some(predicate)) {
      if (Date.now() - started > 5000) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const send = (command: object): void => void stdin.write(`${JSON.stringify(command)}\n`);
  if (compact) {
    send({ id: "caps", type: "set_client_capabilities", capabilities: ["compact_events"] });
    await waitFor((l) => l["id"] === "caps");
  }
  send({ id: "1", type: "prompt", message: "go" });
  await waitFor((l) => l["type"] === "agent_settled");
  stdin.end();
  expect(await done).toBe(0);
  await runtime.dispose();
  return { raw, lines, bytes };
}

const withBlob = (raw: string[]): string[] =>
  raw
    .filter((line) => line.includes(MARKER))
    .map((line) => (JSON.parse(line) as Line)["type"] as string);

describe("RPC compact_events 字节", () => {
  it("未声明：含 1 MB 结果的事件恰 5 条；声明后恰 2 条，字节比 < 0.45", async () => {
    const full = await runRpc(false);
    expect(withBlob(full.raw).sort()).toEqual(
      ["entry_appended", "message_end", "message_start", "tool_execution_end", "turn_end"].sort(),
    );
    expect(full.lines[0]?.["capabilities"]).toContain("compact_events");
    h?.cleanup();
    h = undefined;

    const compact = await runRpc(true);
    expect(withBlob(compact.raw).sort()).toEqual(["message_end", "tool_execution_end"]);
    expect(full.bytes).toBeGreaterThan(5 * BLOB.length);
    expect(compact.bytes / full.bytes).toBeLessThan(0.45);

    const turnEnd = compact.lines.find(
      (l) => l["type"] === "turn_end" && (l["toolResults"] as unknown[]).length > 0,
    );
    const [result] = turnEnd?.["toolResults"] as Line[];
    expect(result).toEqual({
      toolCallId: expect.any(String),
      toolName: "blob",
      isError: false,
      timestamp: expect.any(Number),
      contentOmitted: true,
    });
    const entry = compact.lines.find(
      (l) =>
        l["type"] === "entry_appended" &&
        ((l["entry"] as Line)["message"] as Line | undefined)?.["role"] === "toolResult",
    );
    expect((entry?.["entry"] as Line)["message"]).toMatchObject({
      content: "",
      contentOmitted: true,
    });
    const start = compact.lines.find(
      (l) => l["type"] === "message_start" && (l["message"] as Line)["role"] === "toolResult",
    );
    expect(start?.["message"]).toMatchObject({ content: "", contentOmitted: true });
    const end = compact.lines.find(
      (l) => l["type"] === "message_end" && (l["message"] as Line)["role"] === "toolResult",
    );
    expect((end?.["message"] as Line)["content"]).toHaveLength(BLOB.length);
  });

  it("stream-json 不受影响：含结果的事件仍是 5 条", async () => {
    h = harness();
    const argv = ["-p", "go", "--model", "fake/echo", "--output-format", "stream-json"];
    expect(await h.run(argv, { extraTools: [blobTool] })).toBe(0);
    const raw = h
      .stdout()
      .split("\n")
      .filter((line) => line !== "");
    expect(withBlob(raw)).toHaveLength(5);
    expect(h.stdout()).not.toContain("contentOmitted");
  });
});
