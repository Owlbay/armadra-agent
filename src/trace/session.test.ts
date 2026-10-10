/**
 * 轨迹与会话的胶水（docs/history/wave6-plan.md §2.4）：line 模式 `/trace`、live 叠加、子会话读取缓存。[W6-T1]
 */

import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import type { AgentSession } from "../agent/types.js";
import { emptyArgs } from "../cli/args.js";
import { runLineMode } from "../modes/interactive/line/line-mode.js";
import { FIXTURES } from "./test-support.js";
import { childLoader, LiveTracker } from "./session.js";

let h: ComposeHarness | undefined;
afterEach(() => h?.cleanup());

describe("line 模式 /trace", () => {
  it("一次对话后 /trace 打印整表；/trace t9 提示没有任务", async () => {
    h = composeHarness([
      { steps: [{ toolCall: { name: "read", arguments: { path: "README.md" } } }] },
      { text: "读完了" },
    ]);
    const runtime = await h.boot(["--model", "fake/echo"]);
    const stdin = new PassThrough();
    const done = runLineMode(
      runtime,
      { args: emptyArgs(), prompt: undefined, io: h.io },
      { stdin },
    );
    stdin.end("看看 README\n/trace\n/trace t9\n");
    expect(await done).toBe(0);
    const out = h.stdout();
    expect(out).toContain("轨迹 · 1 回合 · 2 请求 · 1 次工具");
    expect(out).toMatch(/^#1 看看 README {2}\d/m);
    expect(out).toMatch(/^ {4}✗ read README\.md {2}/m);
    expect(out).not.toContain("≈");
    expect(out).toContain("本会话没有任务 t9（见 /tasks）");
    await runtime.dispose();
  });
});

describe("LiveTracker", () => {
  it("请求与工具起止 → 叠加层；agent_end 清空", () => {
    let t = 100;
    let streaming = true;
    const session = {
      state: {
        get isStreaming() {
          return streaming;
        },
      },
    } as unknown as AgentSession;
    const live = new LiveTracker(
      () => session,
      () => (t += 10),
    );
    const assistant = {
      role: "assistant",
      content: [],
      provider: "p",
      model: "m",
      timestamp: 50,
    } as never;
    expect(live.onEvent({ type: "message_start", message: assistant })).toBe(true);
    live.onEvent({
      type: "message_update",
      message: assistant,
      assistantEventKind: "text_delta",
    } as never);
    live.onEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} });
    live.onEvent({
      type: "tool_execution_start",
      toolCallId: "c1_n",
      toolName: "read",
      args: {},
      parentToolCallId: "c1",
    });
    expect(live.overlay()).toEqual({
      running: true,
      request: { requestAt: 50, firstTokenAt: 110, provider: "p", model: "m" },
      tools: [
        { id: "c1", name: "bash", startedAt: 120 },
        { id: "c1_n", name: "read", startedAt: 130, parentId: "c1" },
      ],
    });
    live.onEvent({ type: "message_end", message: assistant });
    live.onEvent({ type: "agent_end", stopReason: "stop", willRetry: false });
    streaming = false;
    expect(live.overlay()).toEqual({ running: false });
    expect(live.onEvent({ type: "before_agent_start", prompt: "x" })).toBe(false);
  });
});

describe("childLoader", () => {
  it("文件没变不重读；变了重读；不存在返回 undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "ama-trace-"));
    try {
      const file = join(dir, "child.jsonl");
      writeFileSync(file, "x");
      let reads = 0;
      const load = childLoader(() => {
        reads++;
        return { header: { id: String(reads) } as never, entries: [] };
      });
      expect(load(file)?.header.id).toBe("1");
      expect(load(file)?.header.id).toBe("1");
      writeFileSync(file, "xyz");
      expect(load(file)?.header.id).toBe("2");
      expect(load(join(dir, "gone.jsonl"))).toBeUndefined();
      expect(reads).toBe(2);
      expect(load.inputs()).toHaveLength(1);
      // 缺省读取器能读真实会话文件
      expect(childLoader()(join(FIXTURES, "subagent-child.jsonl"))?.header.id).toBe("sess-child");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
