/**
 * [W7-B2] `-p` 与后台子 Agent（docs/agents-concurrency-plan.md §2.6、§6 Q5）：缺省前台；后台任务（显式、
 * `subagents.background: always` 或 `autoBackgroundAfterMs` 到时转后台）在主回合结束后被等待，通知回合跑完
 * 才输出；到达预算不等。fake 供应商在进程内父子共用一份脚本，用例按请求先后编排。
 */

import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

const BASE = ["--model", "fake/echo", "--tools", "read,task", "--permission-mode", "full-auto"];

function taskCall(extra: Record<string, unknown> = {}): FakeResponse {
  return {
    steps: [
      {
        toolCall: {
          name: "task",
          arguments: { prompt: "count files", agent: "explore", description: "bg", ...extra },
        },
      },
    ],
  };
}

function config(subagents: Record<string, unknown>): void {
  h.home.write("home/.config/ama/config.json", JSON.stringify({ version: 1, subagents }));
}

function result(): Record<string, unknown> {
  return JSON.parse(h.stdout().trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

function events(): Record<string, unknown>[] {
  return h
    .stdout()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("-p 与后台子 Agent", () => {
  it("缺省（auto）在 -p 下前台：task 等结果，不提示等待", async () => {
    h = composeHarness([taskCall(), { text: "child report" }, { text: "parent done" }]);
    expect(await h.run(["-p", "go", ...BASE, "--output-format", "stream-json"])).toBe(0);
    expect(events().find((e) => e["type"] === "subagent_start")).toMatchObject({
      background: false,
    });
    expect(h.stderr()).not.toContain("后台任务");
  });

  it("autoBackgroundAfterMs 到时转后台：-p 等任务结束并跑完通知回合，最终文本取通知回合；json 带 tasks", async () => {
    h = composeHarness([
      taskCall(),
      { delayMs: 400, text: "child report" }, // 子会话（父阻塞在前台 task 上）
      { text: "parent continues" }, // 转后台后父继续
      { text: "final after notification" }, // 通知回合
    ]);
    config({ autoBackgroundAfterMs: 50 });
    expect(await h.run(["-p", "go", ...BASE, "--output-format", "json"])).toBe(0);
    const out = result();
    expect(out["text"]).toBe("final after notification");
    expect(out["tasks"]).toEqual({ total: 1, running: 0, byStatus: { completed: 1 } });
    expect(h.stderr()).toContain("等待 1 个后台任务及其通知回合结束");
    const text = JSON.stringify(out["entries"]);
    expect(text).toContain("moved to the background");
    expect(text).toContain("<task-notification");
  });

  it("subagents.background: always 在 -p 下也后台；text 输出最后一条助手回复", async () => {
    h = composeHarness([taskCall(), { text: "same" }, { text: "same" }, { text: "same" }]);
    config({ background: "always" });
    expect(await h.run(["-p", "go", ...BASE])).toBe(0);
    expect(h.stdout()).toBe("same\n");
    expect(h.fake.calls.filter((c) => (c.options.purpose ?? "turn") === "turn")).toHaveLength(4);
  });

  it("到达预算不再等待：显式 background:true 后 --max-turns 到限 → 退出 8，不提示等待", async () => {
    h = composeHarness([
      taskCall({ background: true }),
      { delayMs: 200, text: "child report" },
      taskCall({ background: true }),
      { text: "never" },
    ]);
    expect(await h.run(["-p", "go", ...BASE, "--max-turns", "1"])).toBe(8);
    expect(h.stderr()).not.toContain("后台任务");
  });
});
