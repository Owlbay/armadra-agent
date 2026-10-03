/**
 * Agent 栏可达性的帧黄金（docs/agents-concurrency-plan.md §1.4，W7-A）：前台 task 运行中，运行提示行带
 * `↓ Agent 栏`（窄屏放不下就整项丢掉），`↓` 进栏；输入框有字时 `↓` 给一行提示。zh 80 / 32 列与 en 80 列。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedCacheReporting } from "../../ai/cache/reporting.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import { setLocale } from "../../i18n/index.js";
import { cleanupStarted, golden, snapshot, start, type Started } from "./test-support.js";

afterEach(cleanupStarted);
afterEach(() => setLocale("zh"));
beforeEach(() => sharedCacheReporting.clear());

const DOWN = "\x1b[B";
const ESC = "\x1b";

async function waitFor(s: Started, check: (screen: string) => boolean, label: string) {
  const began = Date.now();
  for (;;) {
    s.frame();
    const screen = s.terminal.viewport().join("\n");
    if (check(screen)) return;
    if (Date.now() - began > 5000) throw new Error(`timeout: ${label}\n${screen}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 耗时、用量与光标随时序变。 */
function shot(s: Started, label: string): string {
  s.handle.tui.forceFullRedraw();
  s.frame();
  return snapshot(s.terminal, label)
    .replace(/ cursor=\d+,\d+/, "")
    .replace(/↑[\d.]+k? ↓[\d.]+k?/g, "↑<n> ↓<n>")
    .replace(/^\|(Manual|Plan|Bypass permissions|Full auto|Full-auto) .*$/m, "|<状态栏>")
    .replace(/^\|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/m, "|<spin>")
    .replace(/(task|运行中|running) \d+s/g, "$1 <t>")
    .replace(/ · \d+s · /g, " · <t> · ");
}

/** 父会话前台调 task（显式 background:false），子会话 1.5 s 后回报。 */
const SCRIPT: FakeResponse[] = [
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
  { delayMs: 1500, text: "entry is src/main.ts" },
  { text: "好的" },
];

async function running(columns: number, running: RegExp): Promise<Started> {
  const s = await start(SCRIPT, {
    columns,
    rows: 24,
    argv: ["--tools", "read,task", "--permission-mode", "full-auto"],
  });
  s.type("scan it\r");
  await waitFor(s, (x) => running.test(x), "task running");
  return s;
}

async function finish(s: Started): Promise<void> {
  await s.handle.session().waitForIdle();
  s.handle.exit(0);
  await s.done;
}

describe("运行提示行与 ↓ 进栏（前台 task 运行中）", () => {
  it("zh 80×24：提示行带 ↓ Agent 栏；有字时 ↓ 给提示；清空后 ↓ 进栏", async () => {
    const s = await running(80, /运行 task .*↓ Agent 栏/);
    expect(s.terminal.viewport().join("\n")).toMatch(
      /运行 task · \d+s · Esc 中断 · Ctrl\+B 转后台 · ↓ Agent 栏/,
    );
    golden("agent-run-80x24", shot(s, "前台 task 运行中"));
    s.type("ab");
    s.type(DOWN);
    await waitFor(s, (x) => x.includes("输入框有字"), "busy-input hint");
    golden("agent-run-busy-input-80x24", shot(s, "有字时按 ↓"));
    s.handle.editor.clear();
    s.type(DOWN);
    await waitFor(s, (x) => x.includes("Enter 打开"), "bar focused");
    s.terminal.sendInput(ESC);
    s.terminal.flushInput();
    await finish(s);
  });

  it("zh 32×24：放不下就整项丢掉（不截断半截），↓ 照样进栏", async () => {
    const s = await running(32, /运行 task[\s\S]*t1 explore · 运行中/);
    expect(s.terminal.viewport().join("\n")).toMatch(/运行 task · \d+s · Esc 中断\n/);
    golden("agent-run-32x24", shot(s, "前台 task 运行中"));
    s.type(DOWN);
    await waitFor(s, (x) => x.includes("Enter 打开"), "bar focused");
    s.terminal.sendInput(ESC);
    s.terminal.flushInput();
    await finish(s);
  });

  it("en 80×24", async () => {
    setLocale("en");
    const s = await running(80, /Running task .*↓ Agent bar/);
    golden("en/agent-run-80x24", shot(s, "foreground task running"));
    s.type("ab");
    s.type(DOWN);
    await waitFor(s, (x) => x.includes("Input is not empty"), "busy-input hint");
    golden("en/agent-run-busy-input-80x24", shot(s, "↓ with text"));
    await finish(s);
  });
});
