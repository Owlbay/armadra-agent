/**
 * [W5-Z] 子 Agent（docs/agents.md「子 Agent」）bundle 级：`-p` 前台 task（explore 类型）结果回到父；
 * RPC 后台 task 立即返回，完成后以 `<task-notification>` 开新回合。fake 供应商在进程内共用一份脚本，
 * 后台用例里父与子并发取用，所以那几条回复都是不带工具调用的纯文本，先后不影响断言。
 */

import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";
import { hasBundle, jsonLines, runAma, spawnRpc, type Line } from "./spawn.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

describe.skipIf(!hasBundle)("e2e：子 Agent（bundle 子进程）", () => {
  it("-p 前台 task(agent=explore)：子会话的报告作为工具结果回到父，事件成对", async () => {
    home = createTmpHome();
    const script = home.write("script.json", {
      version: 1,
      responses: [
        {
          steps: [
            {
              toolCall: {
                name: "task",
                arguments: { prompt: "find the entry file", agent: "explore", description: "scan" },
              },
            },
          ],
        },
        { text: "child report: src/index.ts" },
        { text: "parent done" },
      ],
    });
    const r = await runAma(
      home,
      [
        "-p",
        "delegate",
        "--model",
        "fake/echo",
        "--tools",
        "read,task",
        "--permission-mode",
        "full-auto",
        "--output-format",
        "stream-json",
      ],
      { env: { AMA_FAKE_SCRIPT: script } },
    );
    expect(r.code).toBe(0);
    const events = jsonLines(r.stdout);
    expect(events.find((e) => e["type"] === "subagent_start")).toMatchObject({
      taskId: "t1",
      agent: "explore",
      runner: "ama",
      background: false,
    });
    expect(events.find((e) => e["type"] === "subagent_end")).toMatchObject({
      taskId: "t1",
      status: "completed",
    });
    const end = events.find((e) => e["type"] === "tool_execution_end" && e["toolName"] === "task");
    expect(JSON.stringify(end)).toContain("child report: src/index.ts");
    const last = events.filter((e) => e["type"] === "message_end").at(-1);
    expect(JSON.stringify(last)).toContain("parent done");
  });

  it("RPC 后台 task：立即返回 taskId，子任务完成后父会话收到 task-notification 并开新回合", async () => {
    home = createTmpHome();
    const script = home.write("script.json", {
      version: 1,
      responses: [
        {
          steps: [
            {
              toolCall: {
                name: "task",
                arguments: { prompt: "count files", description: "bg", background: true },
              },
            },
          ],
        },
        { text: "reply A" },
        { text: "reply B" },
        { text: "reply C" },
      ],
      whenExhausted: "repeat-last",
    });
    const rpc = spawnRpc(
      home,
      ["--model", "fake/echo", "--tools", "read,task", "--permission-mode", "full-auto"],
      { AMA_FAKE_SCRIPT: script },
    );
    try {
      rpc.send({ id: "1", type: "prompt", message: "start background work" });
      const started = await rpc.waitFor((l) => l["type"] === "subagent_start");
      expect(started).toMatchObject({ taskId: "t1", background: true });
      const taskEnd = await rpc.waitFor(
        (l) => l["type"] === "tool_execution_end" && l["toolName"] === "task",
      );
      expect(JSON.stringify(taskEnd)).toContain("t1");
      await rpc.waitFor((l) => l["type"] === "subagent_end");
      const isNotification = (l: Line): boolean =>
        l["type"] === "message_end" &&
        JSON.stringify(l["message"]).includes("<task-notification") &&
        (l["message"] as { role?: string }).role === "user";
      await rpc.waitFor(isNotification, 0, 15_000);
      // 通知以 user 消息投递（父空闲时开新回合，父正忙时并入本次运行收尾），之后必有一次 settle，
      // 且通知后的助手回复来自脚本。
      const at = rpc.lines.findIndex(isNotification);
      await rpc.waitFor((l) => l["type"] === "agent_settled", at);
      const after = rpc.lines.slice(at);
      expect(
        after.some(
          (l) =>
            l["type"] === "message_end" &&
            (l["message"] as { role?: string }).role === "assistant" &&
            /reply [ABC]/.test(JSON.stringify(l["message"])),
        ),
      ).toBe(true);
    } finally {
      expect(await rpc.close()).toBe(0);
    }
  });
});
