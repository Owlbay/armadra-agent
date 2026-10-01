import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";
import { hasBundle, runAma } from "./spawn.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

const script = fileURLToPath(new URL("../fixtures/scripts/tool-then-text.json", import.meta.url));

describe.skipIf(!hasBundle)("e2e：ama -p（bundle 子进程）", () => {
  it("fake/echo：stdout 只有助手文本，退出 0", async () => {
    home = createTmpHome();
    const r = await runAma(home, ["-p", "hi", "--model", "fake/echo"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hi\n");
    expect(r.stderr).not.toContain("未捕获");
  });

  it("脚本化工具调用：read 工具执行后给出最终文本；会话落盘", async () => {
    home = createTmpHome();
    home.write("work/README.md", "# demo\n");
    const r = await runAma(home, ["-p", "summarize", "--model", "fake/echo"], {
      env: { AMA_FAKE_SCRIPT: script },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("The README describes the project.\n");
    const list = await runAma(home, ["sessions", "list"]);
    expect(list.stdout).toMatch(/\d+ 条 {2}summarize/);
  });

  it("stream-json 与 stdin 管道拼接；未知模型退出 4", async () => {
    home = createTmpHome();
    const r = await runAma(
      home,
      ["-p", "q", "--model", "fake/echo", "--output-format", "stream-json"],
      {
        input: "from stdin",
      },
    );
    expect(r.code).toBe(0);
    const events = r.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; prompt?: string });
    expect(events.find((e) => e.type === "before_agent_start")?.prompt).toBe("q\n\nfrom stdin");
    expect(events.at(-1)?.type).toBe("agent_settled");
    const missing = await runAma(home, ["-p", "x", "--model", "fake/none"]);
    expect(missing.code).toBe(4);
  });

  it("零配置：只设 ANTHROPIC_API_KEY 时 config show / doctor 选中 anthropic", async () => {
    home = createTmpHome();
    const env = { ANTHROPIC_API_KEY: "sk-ant-e2e-fake" };
    const show = await runAma(home, ["config", "show"], { env });
    expect(show.code).toBe(0);
    expect(show.stdout).toMatch(
      /模型：anthropic\/\S+ {2}零配置：anthropic 有 key（env ANTHROPIC_API_KEY）/,
    );
    const doctor = await runAma(home, ["doctor"], { env });
    expect(doctor.stdout).toMatch(/将使用的模型：anthropic\//);
    expect(doctor.stdout + show.stdout).not.toContain("sk-ant-e2e-fake");
  });
});
