/**
 * 前台任务转后台的交互集成与帧黄金（docs/agents-concurrency-plan.md §2.4、§2.8、§4 C 项，W7-C）：
 * - 前台 task 运行中 `Ctrl+B` → 工具行后台样式、底部提示；主回合立即继续，可以发新消息并得到回复；后台
 *   完成后通知回合；
 * - Agent 栏内 `b` 转后台、`x` 双击停止；
 * - Esc 只中断前台（后台任务继续，完成后照常通知）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedCacheReporting } from "../../ai/cache/reporting.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import { setLocale } from "../../i18n/index.js";
import {
  cleanupStarted,
  golden,
  start,
  timedShot as shot,
  waitScreen as waitFor,
  type Started,
} from "./test-support.js";

afterEach(cleanupStarted);
afterEach(() => setLocale("zh"));
beforeEach(() => sharedCacheReporting.clear());

const CTRL_B = "\x02";
const DOWN = "\x1b[B";
const ESC = "\x1b";

/** 父会话前台调 task；子会话 `childMs` 后回报；父会话转后台后回复，再答一条用户消息，最后是通知回合。 */
function script(childMs: number, afterBackground: FakeResponse = { text: "好的，先做别的" }) {
  const responses: FakeResponse[] = [
    {
      steps: [
        {
          toolCall: {
            name: "task",
            arguments: {
              prompt: "find the entry file",
              description: "scan",
              agent: "explore",
              background: false,
            },
          },
        },
      ],
    },
    { delayMs: childMs, text: "entry is src/main.ts" },
    afterBackground,
    { text: "收到新消息" },
    { text: "后台结果已读" },
  ];
  return responses;
}

async function running(s: Started, pattern: RegExp): Promise<void> {
  s.type("scan it\r");
  await waitFor(s, (x) => pattern.test(x), "task running");
}

async function finish(s: Started): Promise<void> {
  await s.handle.session().waitForIdle();
  s.handle.exit(0);
  await s.done;
}

const ARGV = ["--tools", "read,task", "--permission-mode", "full-auto"];

describe("Ctrl+B：前台 task 转后台", () => {
  it("zh 80×24：工具行后台样式、主回合继续、新消息有回复、后台完成后通知回合", async () => {
    const s = await start(script(1500), { columns: 80, rows: 24, argv: ARGV });
    await running(s, /运行 task .*Ctrl\+B 转后台/);
    s.type(CTRL_B);
    await waitFor(s, (x) => x.includes("好的，先做别的"), "parent continued");
    await s.handle.session().waitForIdle();
    expect(s.terminal.viewport().join("\n")).toContain("已转后台：t1，完成后会通知");
    golden("run-background-80x24", shot(s, "Ctrl+B 之后"));
    const screen = s.terminal.viewport().join("\n");
    expect(screen).toMatch(/⎿ 已转后台 · /);
    expect(screen).toMatch(/↳ t1 explore · 运行中/);
    expect(screen).not.toContain("Moved to the background");
    // 后台任务还在跑：主会话空闲，可以发新消息
    await s.handle.session().waitForIdle();
    s.type("还有别的吗\r");
    await waitFor(s, (x) => x.includes("收到新消息"), "reply to new message");
    expect(s.terminal.viewport().join("\n")).toMatch(/t1 explore · 运行中/);
    await waitFor(s, (x) => x.includes("后台结果已读"), "notification turn", 10_000);
    expect(s.terminal.transcript().join("\n")).toContain("子 Agent 通知  t1 explore 完成");
    await finish(s);
  });

  it("en 80×24", async () => {
    setLocale("en");
    const s = await start(script(1500, { text: "ok, moving on" }), {
      columns: 80,
      rows: 24,
      argv: ARGV,
    });
    await running(s, /Running task .*Ctrl\+B to background/);
    golden("en/run-foreground-task-80x24", shot(s, "foreground task running"));
    s.type(CTRL_B);
    await waitFor(s, (x) => x.includes("ok, moving on"), "parent continued");
    await s.handle.session().waitForIdle();
    golden("en/run-background-80x24", shot(s, "after Ctrl+B"));
    expect(s.terminal.viewport().join("\n")).toContain("Moved to the background: t1");
    await finish(s);
  });

  it("没有前台任务时 Ctrl+B 落回编辑器（光标左移）", async () => {
    const s = await start([{ text: "hi" }], { argv: ARGV });
    s.type("ab");
    s.type(CTRL_B);
    s.type("X");
    expect(s.handle.editor.getText()).toBe("aXb");
    s.handle.exit(0);
    await s.done;
  });
});

describe("Agent 栏内 b / x", () => {
  it("zh 80×24：b 转后台选中的任务；x 第一次提示、再按停止", async () => {
    const s = await start(script(4000), { columns: 80, rows: 24, argv: ARGV });
    await running(s, /运行 task .*↓ Agent 栏/);
    s.type(DOWN);
    await waitFor(s, (x) => x.includes("b 转后台 · x 停止"), "bar focused");
    golden("agent-bar-focused-run-80x24", shot(s, "前台任务运行中进栏"));
    s.type("b");
    await waitFor(s, (x) => x.includes("好的，先做别的"), "parent continued");
    await s.handle.session().waitForIdle();
    expect(s.terminal.viewport().join("\n")).toContain("已转后台：t1");
    // 再按 b：已经在后台
    s.type("b");
    await waitFor(s, (x) => x.includes("t1 不是运行中的前台任务"), "not foreground");
    s.type("x");
    await waitFor(s, (x) => x.includes("再按 x 停止 t1"), "stop armed");
    golden("agent-bar-stop-armed-80x24", shot(s, "栏内第一次 x"));
    s.type("x");
    await waitFor(s, (x) => /t1 explore · 已停止/.test(x), "stopped");
    expect(s.handle.editor.getText()).toBe("");
    s.terminal.sendInput(ESC);
    s.terminal.flushInput();
    await finish(s);
  });
});

describe("Esc 只中断前台", () => {
  it("转后台后主回合运行中 Esc：中断主回合，后台任务继续并照常通知", async () => {
    const s = await start(script(1200, { delayMs: 5000, text: "不会出现" }), {
      columns: 80,
      rows: 24,
      argv: ARGV,
    });
    await running(s, /运行 task/);
    s.type(CTRL_B);
    await waitFor(s, (x) => x.includes("已转后台 · "), "backgrounded");
    s.type(ESC);
    await waitFor(s, (x) => x.includes("后台任务 t1 仍在运行，Esc 不影响"), "interrupt hint");
    await waitFor(s, (x) => x.includes("子 Agent 通知  t1 explore 完成"), "notification", 10_000);
    expect(s.terminal.transcript().join("\n")).not.toContain("不会出现");
    await finish(s);
  });
});
