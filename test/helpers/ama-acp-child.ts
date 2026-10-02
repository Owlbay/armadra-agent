/**
 * 外部 Agent 联调用的「子 ama」（W5-EG）：真实组装的 ama（`--mode acp` + fake 供应商，cwd 与父相同），
 * 经内存管道作为 `task(agent="acp:ama")` 的对端；每次 spawn 在同一个运行时上跑一遍 `runAcpMode`
 * （续聊重开时 `session/resume` 接回同一会话）。装好后设置 `externalTesting.driverDeps`，
 * 调用方 afterEach 里 `cleanup()`。
 */

import { emptyArgs } from "../../src/cli/args.js";
import type { Runtime } from "../../src/cli/runtime.js";
import type { FakeResponse } from "../../src/ai/fake/fake-script.js";
import { externalTesting } from "../../src/agents/external.js";
import { ProgramProbe } from "../../src/drivers/probe.js";
import {
  memoryTransport,
  spawnRecorder,
  type MemoryTransport,
} from "../../src/drivers/test-support.js";
import { runAcpMode } from "../../src/modes/acp/acp-mode.js";
import { composeHarness, type ComposeHarness } from "./compose-harness.js";

export interface AmaAcpChild {
  harness: ComposeHarness;
  runtime: Runtime;
  spawns: MemoryTransport[];
  /** 两个方向的线上消息（JSON 行）。 */
  wire(): string;
  cleanup(): Promise<void>;
}

export async function amaAcpChild(cwd: string, script: FakeResponse[]): Promise<AmaAcpChild> {
  const harness = composeHarness(script, { cwd });
  const runtime = await harness.boot(["--mode", "acp", "--model", "fake/echo"]);
  const spawns: MemoryTransport[] = [];
  const rec = spawnRecorder(() => {
    const t = memoryTransport((input, output) =>
      runAcpMode(
        runtime,
        { args: emptyArgs(), prompt: undefined, io: harness.io },
        { stdin: input, stdout: output },
      ),
    );
    spawns.push(t);
    return t;
  });
  externalTesting.driverDeps = {
    spawn: rec.spawn,
    // 「已安装」不看本机 PATH
    probe: new ProgramProbe({
      env: { PATH: "/fake" },
      isFile: () => true,
      runVersion: async () => "0.5.0",
    }),
    cancelGraceMs: 200,
  };
  return {
    harness,
    runtime,
    spawns,
    wire: () => spawns.flatMap((s) => s.wire.map((w) => JSON.stringify(w.msg))).join("\n"),
    async cleanup() {
      delete externalTesting.driverDeps;
      await runtime.dispose().catch(() => undefined);
      harness.cleanup();
    },
  };
}
