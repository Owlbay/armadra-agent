import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { parseArgs, UsageError } from "./args.js";
import { switchSession } from "./compose-session.js";

let h: ComposeHarness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

/** 会话目录下的全部 .jsonl（按 cwd 分的子目录也算）。 */
function sessionFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) =>
    f.endsWith(".jsonl"),
  );
}

describe("--no-session", () => {
  it("-p 不写会话文件；json 结果没有 sessionFile", async () => {
    h = composeHarness([{ text: "ok" }]);
    const sessions = join(h.home.dataDir, "sessions");
    expect(
      await h.run(["-p", "hi", "--model", "fake/echo", "--no-session", "--output-format", "json"]),
    ).toBe(0);
    const result = JSON.parse(h.stdout()) as Record<string, unknown>;
    expect(result["sessionId"]).toEqual(expect.any(String));
    expect(result["sessionFile"]).toBeUndefined();
    expect(sessionFiles(sessions)).toEqual([]);
    h.cleanup();
    h = composeHarness([{ text: "ok" }]);
    expect(await h.run(["-p", "hi", "--model", "fake/echo"])).toBe(0);
    expect(sessionFiles(join(h.home.dataDir, "sessions"))).toHaveLength(1);
  });

  it("/new 切出的新会话同样只在内存里", async () => {
    h = composeHarness([{ text: "a" }, { text: "b" }]);
    const runtime = await h.boot(["--model", "fake/echo", "--no-session"]);
    await runtime.session.prompt("one");
    const next = await switchSession(runtime, { kind: "new" });
    await next.prompt("two");
    expect(next.state.sessionFile).toBeUndefined();
    expect(sessionFiles(join(h.home.dataDir, "sessions"))).toEqual([]);
    await runtime.dispose();
  });

  it("与 --continue / --resume / --session-id / --fork 互斥", () => {
    for (const extra of [
      ["--continue"],
      ["--resume", "abc"],
      ["--session-id", "x"],
      ["--fork", "y"],
    ])
      expect(() => parseArgs(["--no-session", ...extra])).toThrow(UsageError);
  });
});
