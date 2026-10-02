import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { loadCheckpoints } from "../checkpoints/replay.js";
import { shadowRepoDir } from "../checkpoints/shadow-git.js";

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
  });
});
