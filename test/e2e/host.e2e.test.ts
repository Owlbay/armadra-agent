/**
 * 宿主嵌入面（第三波 §2.4）：bundle 里加载 ESM 宿主适配器（变量说明符的动态 import 不被
 * esbuild 改写）；Armadra 以 `ELECTRON_RUN_AS_NODE=1` 启动同一可执行文件——CI 没有 Electron，
 * 用 `process.execPath` 带该变量模拟，codemode 沙箱子进程照常工作。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";
import { hasBundle, jsonLines, runAma } from "./spawn.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

const fixture = (path: string): string =>
  fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url));
const echoHost = fixture("host/echo-host.mjs");

describe.skipIf(!hasBundle)("e2e：宿主适配器与 Electron 方式启动（bundle 子进程）", () => {
  it("ESM 适配器：工具注册、host 节说明进系统提示、cache_miss 与 agent_settled 经 notify 报到 stderr", async () => {
    home = createTmpHome();
    home.write("work/README.md", "# demo\n");
    const script = home.write("work/script.json", {
      version: 1,
      responses: [
        {
          steps: [{ toolCall: { name: "host_echo", arguments: { text: "ping" } } }],
          usage: { input: 0, cacheWrite: 30_000, output: 5 },
        },
        {
          steps: [{ toolCall: { name: "read", arguments: { path: "README.md" } } }],
          usage: { input: 500, cacheRead: 30_000, output: 5 },
        },
        { text: "host round trip ok", usage: { input: 31_000, output: 5 } },
      ],
    });
    const record = home.path("record.jsonl");
    const r = await runAma(
      home,
      [
        "-p",
        "use the host",
        "--model",
        "fake/echo",
        "--host",
        echoHost,
        "--output-format",
        "stream-json",
      ],
      { env: { AMA_FAKE_SCRIPT: script, AMA_FAKE_RECORD: record } },
    );
    expect(r.code).toBe(0);
    const lines = jsonLines(r.stdout);
    const end = lines.find(
      (l) => l["type"] === "tool_execution_end" && l["toolName"] === "host_echo",
    ) as { isError: boolean; result: { content: unknown } } | undefined;
    expect(end?.isError).toBe(false);
    expect(JSON.stringify(end?.result.content)).toContain("host echo: ping");
    const first = JSON.parse(readFileSync(record, "utf8").split("\n")[0] ?? "{}") as {
      system: string;
      tools: { name: string }[];
    };
    expect(first.system).toContain("Echo host is attached.");
    expect(first.tools.map((t) => t.name)).toContain("host_echo");
    expect(r.stderr).toContain("echo-host cache_miss evicted 30500");
    expect(r.stderr).toContain("echo-host settled print");
  });

  it("ELECTRON_RUN_AS_NODE=1（process.execPath 模拟）：-p 与 codemode 沙箱照常工作", async () => {
    home = createTmpHome();
    home.write("home/.config/ama/config.json", { version: 1, permission: { allow: ["codemode"] } });
    home.write("work/README.md", "# demo\nline 2\nline 3\n");
    home.write("work/notes.md", "TODO one\nTODO two\n");
    const env = { ELECTRON_RUN_AS_NODE: "1" };
    const plain = await runAma(home, ["-p", "hi", "--model", "fake/echo"], { env });
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe("hi\n");
    const r = await runAma(
      home,
      ["-p", "summarize", "--model", "fake/echo", "--tools-preset", "codemode"],
      {
        env: { ...env, AMA_FAKE_SCRIPT: fixture("scripts/codemode-parallel.json") },
      },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Summary written from the codemode output.\n");
  });
});
