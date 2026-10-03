/**
 * 后台任务审批停靠的交互帧（docs/agents-concurrency-plan.md §2.7，W7-C）：主会话忙时后台任务的审批不弹，
 * 停靠在 Agent 栏（「等待审批」+ 运行提示行「↓ 处理审批」），主会话空闲且空输入时自动弹出；有草稿时继续停靠，
 * 清空后弹出；栏里 Enter 打开该任务的视图即弹出。主会话自己的审批（task 调用）照旧立即弹出。
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
const CTRL_C = "\x03";
const DOWN = "\x1b[B";

/**
 * 父会话前台调 task（主会话自己的审批，立即弹出）；转后台后父会话慢慢回复（`parentMs`，期间主会话忙）；
 * 子会话 `childMs` 后要写文件（后台任务的审批）；写完回报，最后是通知回合。
 */
function script(childMs: number, parentMs: number, reply: string): FakeResponse[] {
  return [
    {
      steps: [
        {
          toolCall: {
            name: "task",
            arguments: {
              prompt: "write a note",
              description: "note",
              agent: "general",
              background: false,
            },
          },
        },
      ],
    },
    {
      delayMs: childMs,
      steps: [{ toolCall: { name: "write", arguments: { path: "note.txt", content: "hi\n" } } }],
    },
    { delayMs: parentMs, text: reply },
    { text: "写好了" },
    { text: "收到通知" },
  ];
}

const ARGV = ["--tools", "read,task,write", "--permission-mode", "default"];

/** 发消息、批准主会话的 task 调用、Ctrl+B 转后台，等子会话的审批停靠。 */
async function docked(s: Started, label: RegExp): Promise<void> {
  s.type("write it\r");
  await waitFor(s, (x) => x.includes("3. 拒绝") || x.includes("3. Deny"), "task approval");
  s.type("y");
  await waitFor(s, (x) => /Ctrl\+B/.test(x), "task running");
  s.type(CTRL_B);
  await waitFor(s, (x) => label.test(x), "docked");
}

describe("后台任务审批停靠", () => {
  it("zh 80×24：忙时停靠在栏里，主会话空闲且空输入时自动弹出", async () => {
    const s = await start(script(300, 1500, "父会话回复"), { argv: ARGV });
    await docked(s, /等待审批/);
    expect(s.handle.tui.hasOverlay).toBe(false);
    const screen = s.terminal.viewport().join("\n");
    expect(screen).toMatch(/⏺ t1 general · 等待审批/);
    expect(screen).toMatch(/↓ 处理审批/);
    golden("approval-docked-80x24", shot(s, "主会话忙：后台任务的审批停靠"));
    // 父会话回复完、空闲后自动弹出（弹框会盖住回复）
    await waitFor(s, () => s.handle.tui.hasOverlay, "auto popup");
    expect(s.handle.session().state.isStreaming).toBe(false);
    await waitFor(s, (x) => x.includes("[task:general]"), "dialog");
    golden("approval-docked-popup-80x24", shot(s, "主会话空闲：自动弹出"));
    s.type("y");
    await waitFor(s, (x) => x.includes("收到通知"), "notification turn", 10_000);
    await s.handle.session().waitForIdle();
    s.handle.exit(0);
    await s.done;
  });

  it("有草稿时继续停靠，清空后弹出", async () => {
    const s = await start(script(300, 600, "父会话回复"), { argv: ARGV });
    await docked(s, /等待审批/);
    s.type("草稿");
    await waitFor(s, (x) => x.includes("父会话回复"), "parent reply");
    await s.handle.session().waitForIdle();
    await new Promise((r) => setTimeout(r, 400));
    expect(s.handle.tui.hasOverlay).toBe(false);
    expect(s.terminal.viewport().join("\n")).toMatch(/t1 general · 等待审批/);
    s.type(CTRL_C);
    await waitFor(s, () => s.handle.tui.hasOverlay, "popup after clearing");
    s.type("n");
    await waitFor(s, (x) => x.includes("已拒绝 [task:general] write"), "denied");
    await s.handle.session().waitForIdle();
    s.handle.exit(0);
    await s.done;
  });

  it("栏里 Enter 打开该任务的视图：立即弹出（盖在视图上）", async () => {
    const s = await start(script(300, 3000, "父会话回复"), { argv: ARGV });
    await docked(s, /等待审批/);
    s.type(DOWN);
    await waitFor(s, (x) => x.includes("Enter 打开"), "bar focused");
    s.type("\r");
    await waitFor(s, (x) => x.includes("[task:general]"), "popup in view");
    expect(s.handle.session().state.isStreaming).toBe(true);
    s.type("y");
    s.handle.exit(0);
    await s.done;
  });

  it("en 80×24：停靠帧", async () => {
    setLocale("en");
    const s = await start(script(300, 1500, "parent reply"), { argv: ARGV });
    await docked(s, /needs approval/);
    expect(s.terminal.viewport().join("\n")).toMatch(/↓ handle approval/);
    golden("en/approval-docked-80x24", shot(s, "main busy: background approval docked"));
    s.handle.exit(0);
    await s.done;
  });
});
