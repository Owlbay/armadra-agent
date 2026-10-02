/**
 * ama 驱动 ama（零费用端到端，docs/wave5-plan.md §5.6–§5.7）：父侧 ProcessRunner + AcpDriver，
 * 子侧是真实组装的 ama（`--mode acp` 服务端 + 脚本化 fake 供应商），中间只有内存管道。
 * 子 ama 的 bash 要审批 → ACP session/request_permission → 父侧 askHuman → approve（模拟人）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import type { FakeResponse } from "../ai/fake/fake-script.js";
import { emptyArgs } from "../cli/args.js";
import { runAcpMode } from "../modes/acp/acp-mode.js";
import type { ApprovalRequest } from "../permissions/types.js";
import type { SubagentEvent } from "../tools/types.js";
import { AcpDriver } from "./acp/driver.js";
import { catalogEntry } from "./catalog.js";
import { DriverPool } from "./pool.js";
import { createProcessRunner } from "./runner.js";
import { memoryTransport, spawnRecorder } from "./test-support.js";

let child: ComposeHarness;
afterEach(() => child?.cleanup());

async function amaChild(script: FakeResponse[]) {
  child = composeHarness(script);
  const runtime = await child.boot(["--mode", "rpc", "--model", "fake/echo"]);
  const rec = spawnRecorder(() =>
    memoryTransport(async (input, output) => {
      await runAcpMode(
        runtime,
        { args: emptyArgs(), prompt: undefined, io: child.io },
        { stdin: input, stdout: output },
      );
      await runtime.dispose();
    }),
  );
  const candidate = catalogEntry("ama")!.candidates[0]!;
  const driver = new AcpDriver("acp:ama", candidate, { spawn: rec.spawn, cancelGraceMs: 100 });
  return { runtime, rec, driver };
}

describe("ama 驱动 ama（ACP，fake 供应商）", () => {
  it("两轮往返 + 一次审批：子 ama 的 bash 经父侧交人允许后执行", async () => {
    const { runtime, driver } = await amaChild([
      { text: "first reply", usage: { input: 10, output: 3 } },
      { steps: [{ toolCall: { name: "bash", arguments: { command: "echo from-child" } } }] },
      { text: "ran it", usage: { input: 20, output: 4 } },
    ]);
    const asked: ApprovalRequest[] = [];
    const runner = createProcessRunner(driver, {
      approve: async (req) => {
        asked.push(req);
        return "allow";
      },
      pool: new DriverPool(),
      env: {},
      trusted: () => true,
      parentMode: () => "default",
    });
    const events: SubagentEvent[] = [];
    const handle = await runner.start({
      prompt: "hello child",
      cwd: runtime.paths.cwd,
      mode: "default",
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });
    const first = await handle.wait();
    expect(first).toMatchObject({ status: "completed", text: "first reply" });
    expect(handle.id).toBe(runtime.session.state.sessionId);

    await handle.send("run something");
    const second = await handle.wait();
    expect(second.status).toBe("completed");
    expect(second.text).toContain("ran it");
    expect(second.text).toContain("bash: echo from-child");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.context?.origin).toMatchObject({
      agent: "acp:ama",
      sessionId: runtime.session.state.sessionId,
      toolCall: { title: "bash: echo from-child", kind: "execute" },
    });
    // 子 ama 真的执行了命令（工具结果在它自己的会话里）
    const toolResult = runtime.session.messages.find((m) => "role" in m && m.role === "toolResult");
    expect(JSON.stringify(toolResult)).toContain("from-child");
    expect(events.filter((e) => e.type === "turn")).toHaveLength(2);
    await handle.stop();
  });

  it("父侧无人值守：子 ama 的审批被拒绝，命令不执行", async () => {
    const { runtime, driver } = await amaChild([
      { steps: [{ toolCall: { name: "bash", arguments: { command: "echo nope" } } }] },
      { text: "denied, stopping" },
    ]);
    const runner = createProcessRunner(driver, {
      approve: async () => "allow",
      pool: new DriverPool(),
      env: {},
      trusted: () => true,
      unattended: true,
    });
    const handle = await runner.start({
      prompt: "try",
      cwd: runtime.paths.cwd,
      mode: "default",
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    const result = await handle.wait();
    expect(result.text).toContain("denied, stopping");
    const toolResult = runtime.session.messages.find((m) => "role" in m && m.role === "toolResult");
    expect(JSON.stringify(toolResult)).not.toContain('"nope\\n"');
    expect(JSON.stringify(toolResult)).toContain("denied");
    await handle.stop();
  });

  it("父 stop：子 ama 的回合被 session/cancel 中断", async () => {
    const { runtime, driver } = await amaChild([{ delayMs: 10_000, text: "late" }]);
    const runner = createProcessRunner(driver, {
      approve: async () => "deny",
      pool: new DriverPool(),
      env: {},
      trusted: () => true,
    });
    const handle = await runner.start({
      prompt: "slow",
      cwd: runtime.paths.cwd,
      mode: "default",
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 50));
    await handle.stop();
    const result = await handle.wait();
    expect(result.status).toBe("aborted");
  });
});
