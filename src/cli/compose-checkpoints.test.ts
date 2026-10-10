import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import type { CheckpointBackendSettings } from "../checkpoints/backend.js";
import { loadCheckpoints } from "../checkpoints/replay.js";
import { shadowRepoDir } from "../checkpoints/shadow-git.js";

// 冻结影子快照的计时：3 秒上限按真实时间判，CI 负载高时第一回合会判 too_slow 降级，第二个检查点
// 就没有影子提交（#121 / #190）；超时降级本身由 shadow-git.test.ts 用注入时钟覆盖
vi.mock("../checkpoints/backend.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../checkpoints/backend.js")>();
  return {
    ...real,
    createCheckpointBackendFactory: (settings: CheckpointBackendSettings) =>
      real.createCheckpointBackendFactory({
        ...settings,
        shadow: { now: () => 0, ...settings.shadow },
      }),
  };
});

let h: ComposeHarness;
afterEach(() => {
  vi.unstubAllEnvs();
  h?.cleanup();
});

const bashCall = (command: string) => ({
  steps: [{ toolCall: { name: "bash", arguments: { command } } }],
});

describe("组装根：checkpoints.mode shadow-git", () => {
  it("bash 的改动经影子 git 回滚（仅代码）", async () => {
    vi.stubEnv("AMA_CHECKPOINTS", "shadow-git");
    h = composeHarness([
      bashCall("echo changed > a.txt && echo new > b.txt"),
      { text: "done" },
      { text: "ok" },
    ]);
    const a = join(h.home.cwd, "a.txt");
    writeFileSync(a, "original\n");
    const runtime = await h.boot(["--model", "fake/echo"]);
    runtime.approvals.setUiBroker({ ask: async () => "allow" });
    await runtime.session.prompt("first");
    expect(readFileSync(a, "utf8").trim()).toBe("changed");
    await runtime.session.prompt("second");

    const checkpoints = loadCheckpoints(runtime.session.entries);
    expect([...checkpoints.byUserEntry.values()].every((c) => c.shadowCommit !== undefined)).toBe(
      true,
    );
    expect(existsSync(join(shadowRepoDir(h.home.dataDir, h.home.cwd), "HEAD"))).toBe(true);

    const first = runtime.session.rewindPoints()[0]!;
    const result = await runtime.session.rewind({ entryId: first.entryId, mode: "code" });
    expect(result.code?.restored).toEqual(["a.txt"]);
    expect(result.code?.deleted).toEqual(["b.txt"]);
    expect(readFileSync(a, "utf8")).toBe("original\n");
    expect(existsSync(join(h.home.cwd, "b.txt"))).toBe(false);
    await runtime.dispose();
  }, 60_000);
});
