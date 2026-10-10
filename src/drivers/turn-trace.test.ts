/**
 * [W6-C0] 外部 Agent 回合骨架（docs/history/wave6-plan.md §2.2 `external_turn`）：ProcessRunner 每回合发 `turn_trace`
 * （不含工具标题 / 命令行 / 路径），工具事件带 id 与时刻；任务注册表据此写父会话的 `ama.trace`。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { SubagentEvent, SubagentRunRequest } from "../tools/types.js";
import { applyRunnerEvent, type ProgressSink, type TaskRecord } from "../agents/task-record.js";
import type { TraceExternalTurnData } from "../trace/types.js";
import { AcpDriver } from "./acp/driver.js";
import { runFakeAcpAgent } from "./acp/testing/fake-agent.js";
import { DriverPool } from "./pool.js";
import { createProcessRunner } from "./runner.js";
import { memoryTransport, spawnRecorder } from "./test-support.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("external_turn 骨架", () => {
  it("ProcessRunner：tool 事件带 id / at，回合结束发 turn_trace（只有种类与状态）", async () => {
    const rec = spawnRecorder(() => memoryTransport((i, o) => runFakeAcpAgent(i, o)));
    const driver = new AcpDriver(
      "acp:fake",
      { kind: "acp", program: "fake", args: [] },
      { spawn: rec.spawn, cancelGraceMs: 50 },
    );
    let t = 100;
    const runner = createProcessRunner(driver, {
      approve: async () => "allow",
      pool: new DriverPool(3),
      env: { PATH: "/bin" },
      trusted: () => true,
      now: () => (t += 10),
    });
    const events: SubagentEvent[] = [];
    const req: SubagentRunRequest = {
      prompt: "[permission] write",
      cwd: "/work",
      mode: "default",
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    };
    const handle = await runner.start(req);
    cleanups.push(() => handle.stop());
    await handle.wait();
    const tools = events.filter((e) => e.type === "tool");
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.type === "tool" && tool.id).toBeTypeOf("string");
      expect(tool.type === "tool" && tool.at).toBeTypeOf("number");
    }
    const traces = events.filter((e) => e.type === "turn_trace");
    expect(traces).toHaveLength(1);
    const trace = traces[0]!.type === "turn_trace" ? traces[0]!.trace : undefined;
    expect(trace).toMatchObject({
      sessionId: "fake-1",
      turn: 1,
      stopReason: "end_turn",
      toolCount: 1,
      filesTouched: 1,
      tools: [{ kind: "edit", status: "completed" }],
    });
    expect(trace!.endedAt).toBeGreaterThan(trace!.startedAt);
    // 不含标题、路径
    expect(JSON.stringify(trace)).not.toContain("note.txt");
    expect(JSON.stringify(trace)).not.toContain("Write");
  });

  it("任务注册表把 turn_trace 交给 sink.appendTrace（带 taskId 与 agent）", () => {
    const appended: TraceExternalTurnData[] = [];
    const sink: ProgressSink = {
      emit: () => undefined,
      log: () => undefined,
      now: () => 0,
      appendTrace: (data) => appended.push(data),
    };
    const record = { info: { taskId: "t2", agent: "codex" } } as unknown as TaskRecord;
    applyRunnerEvent(
      record,
      {
        type: "turn_trace",
        trace: {
          sessionId: "s1",
          turn: 3,
          startedAt: 1,
          endedAt: 2,
          stopReason: "end_turn",
          tools: [],
          toolCount: 0,
          filesTouched: 0,
        },
      },
      sink,
    );
    expect(appended).toEqual([
      {
        kind: "external_turn",
        taskId: "t2",
        agent: "codex",
        sessionId: "s1",
        turn: 3,
        startedAt: 1,
        endedAt: 2,
        stopReason: "end_turn",
        tools: [],
        toolCount: 0,
        filesTouched: 0,
      },
    ]);
  });
});
