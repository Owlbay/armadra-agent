import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";
import { BUNDLE, hasBundle, runAma } from "./spawn.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

const script = fileURLToPath(
  new URL("../fixtures/scripts/codemode-parallel.json", import.meta.url),
);

type Line = Record<string, unknown>;

function setup(): TmpHome {
  const h = createTmpHome();
  // codemode 本身是 execute 类：允许它，内层调用仍逐个经过管线（只读工具免审批）。
  h.write("home/.config/ama/config.json", { version: 1, permission: { allow: ["codemode"] } });
  h.write("work/README.md", "# demo\nline 2\nline 3\n");
  h.write("work/notes.md", "TODO one\nTODO two\n");
  return h;
}

describe.skipIf(!hasBundle)("e2e：codemode（bundle 子进程）", () => {
  it("bundle 带第二入口 ama-sandbox.cjs", () => {
    expect(existsSync(join(dirname(BUNDLE), "ama-sandbox.cjs"))).toBe(true);
  });

  it("-p --tools-preset codemode：一次 codemode 调用并行三个工具，工具结果只含脚本输出", async () => {
    home = setup();
    const r = await runAma(
      home,
      [
        "-p",
        "summarize",
        "--model",
        "fake/echo",
        "--tools-preset",
        "codemode",
        "--output-format",
        "stream-json",
      ],
      { env: { AMA_FAKE_SCRIPT: script } },
    );
    expect(r.code).toBe(0);
    const lines = r.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Line);
    const ends = lines.filter((l) => l["type"] === "tool_execution_end");
    const outer = ends.find((l) => l["toolName"] === "codemode");
    const content = (outer?.["result"] as { content: string }).content;
    expect(content).toMatch(
      /^Script completed in \d+\.\d\ds\n\nREADME lines: 3\nTODO hits: 2\nmarkdown files: 2$/,
    );
    const nested = ends.filter((l) => l["parentToolCallId"] === outer?.["toolCallId"]);
    expect(nested.map((l) => l["toolName"]).sort()).toEqual(["glob", "grep", "read"]);
    const results = lines.filter(
      (l) =>
        l["type"] === "message_end" && (l["message"] as { role: string }).role === "toolResult",
    );
    expect(results).toHaveLength(1);
  });

  it("-p 文本输出：只有最终助手文本", async () => {
    home = setup();
    const r = await runAma(
      home,
      ["-p", "summarize", "--model", "fake/echo", "--tools-preset", "codemode"],
      {
        env: { AMA_FAKE_SCRIPT: script },
      },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Summary written from the codemode output.\n");
  });
});
