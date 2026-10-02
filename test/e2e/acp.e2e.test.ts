/**
 * [W5-Z] ACP（docs/acp.md、docs/agents.md「在 task 里使用」）bundle 级：ama 驱动 ama。
 * 父 `ama -p` 调 `task(agent="acp:ama")`，ama 按目录表在 PATH 上找 `ama` 并以 `--mode acp` 启动。
 * PATH 前面放一个 `ama` 垫片（POSIX sh / Windows .cmd）转到同一个 bundle，并给子 ama 自己的 fake 脚本
 * 与模型——父起子进程时剥离 `AMA_*`（docs/agents.md「环境与账户」），所以这些只能由垫片设置；
 * 配置与数据目录也由垫片指回临时 HOME（Windows 的 LOCALAPPDATA 不在临时 HOME 里）。
 */

import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";
import { BUNDLE, hasBundle, jsonLines, runAma } from "./spawn.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

/** 在 `<root>/bin` 写 `ama` 垫片，返回 bin 目录。 */
function writeShim(h: TmpHome, childScript: string): string {
  const node = process.execPath;
  if (process.platform === "win32") {
    h.write(
      "bin/ama.cmd",
      [
        "@echo off",
        `set "AMA_FAKE_SCRIPT=${childScript}"`,
        `set "AMA_NO_LOCAL_PROBE=1"`,
        `set "AMA_CONFIG_DIR=${h.configDir}"`,
        `set "AMA_DATA_DIR=${h.dataDir}"`,
        `"${node}" "${BUNDLE}" --model fake/echo %*`,
        "",
      ].join("\r\n"),
    );
  } else {
    const path = h.write(
      "bin/ama",
      [
        "#!/bin/sh",
        `export AMA_FAKE_SCRIPT='${childScript}' AMA_NO_LOCAL_PROBE=1`,
        `export AMA_CONFIG_DIR='${h.configDir}' AMA_DATA_DIR='${h.dataDir}'`,
        `exec '${node}' '${BUNDLE}' --model fake/echo "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(path, 0o755);
  }
  return h.path("bin");
}

describe.skipIf(!hasBundle)("e2e：ACP（bundle 子进程，ama 驱动 ama）", () => {
  it("-p 里 task(agent=acp:ama)：子 ama 以 --mode acp 运行，结果回到父，两边会话都落盘", async () => {
    home = createTmpHome();
    const childScript = home.write("child.json", {
      version: 1,
      responses: [{ text: "child ama says hi", usage: { input: 20, output: 4 } }],
    });
    const parentScript = home.write("parent.json", {
      version: 1,
      responses: [
        {
          steps: [
            {
              toolCall: {
                name: "task",
                arguments: { prompt: "say hi", agent: "acp:ama", description: "child" },
              },
            },
          ],
        },
        { text: "parent done" },
      ],
    });
    const bin = writeShim(home, childScript);
    const PATH = [bin, process.env["PATH"] ?? process.env["Path"] ?? ""].join(delimiter);
    const r = await runAma(
      home,
      [
        "-p",
        "delegate",
        "--model",
        "fake/echo",
        "--tools",
        "read,task",
        "--trust",
        "--permission-mode",
        "full-auto",
        "--output-format",
        "stream-json",
      ],
      { env: { AMA_FAKE_SCRIPT: parentScript, PATH, Path: PATH }, timeoutMs: 30_000 },
    );
    expect(r.code, r.stderr).toBe(0);
    const events = jsonLines(r.stdout);
    const end = events.find((e) => e["type"] === "tool_execution_end" && e["toolName"] === "task");
    // 失败时把 task 的结果与 stderr 带进断言信息（Windows 上排查 .cmd 垫片用）。
    expect(JSON.stringify(end), `${JSON.stringify(end)}\n${r.stderr}`).toContain(
      "child ama says hi",
    );
    expect(events.find((e) => e["type"] === "subagent_start")).toMatchObject({
      taskId: "t1",
      runner: "acp:ama",
    });
    expect(events.find((e) => e["type"] === "subagent_end")).toMatchObject({ status: "completed" });
    const last = events.filter((e) => e["type"] === "message_end").at(-1);
    expect(JSON.stringify(last)).toContain("parent done");

    // 父会话记下外部会话（续聊用）；子 ama 自己的会话也在同一数据目录。
    const sessions = join(home.dataDir, "sessions");
    const files = existsSync(sessions)
      ? readdirSync(sessions, { recursive: true })
          .map(String)
          .filter((f) => f.endsWith(".jsonl"))
      : [];
    const bodies = files.map((f) => readFileSync(join(sessions, f), "utf8"));
    expect(bodies.some((b) => b.includes("ama.agent-session"))).toBe(true);
    expect(
      bodies.some((b) => b.includes("child ama says hi") && !b.includes("ama.agent-session")),
    ).toBe(true);
  });
});
