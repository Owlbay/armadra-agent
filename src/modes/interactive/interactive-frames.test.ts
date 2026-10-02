/**
 * 终端界面视觉设计 v1 的整屏帧黄金（§5.3）：启动头、工具层级、提示、运行中动词、面板、ASCII。
 * 更新：`AMA_UPDATE_GOLDEN=1 pnpm vitest run src/modes/interactive src/tui`，逐个审阅 diff。
 */

import { afterEach, describe, it } from "vitest";
import { composeHarness } from "../../../test/helpers/compose-harness.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import { MemoryTerminal, TUI, plainTheme, type Component } from "../../tui.js";
import { MessageView } from "./message-view.js";
import { cleanupStarted, golden, snapshot, start, started } from "./test-support.js";
import { ToolTracker } from "./tool-view.js";

afterEach(cleanupStarted);

/** 建 harness 并把 HOME 指向临时根，让会话目录显示为 `~/work`（黄金与机器无关）。 */
function harnessWithTildeCwd(script: FakeResponse[]): void {
  const h = composeHarness(script, { stdinIsTTY: true, stdoutIsTTY: true });
  (h.io.env as Record<string, string>)["HOME"] = h.home.root;
  started.h = h;
}

describe("启动头", () => {
  for (const columns of [80, 40]) {
    it(`normal ${columns}x24：≥ 56 列画框，更窄去框去键列`, async () => {
      harnessWithTildeCwd([]);
      started.h!.home.write("work/AGENTS.md", "# rules\n");
      const s = await start([], {
        columns,
        keepHarness: true,
        quietStartup: "normal",
        argv: ["--trust"],
      });
      golden(`startup-normal-${columns}x24`, snapshot(s.terminal, "startup normal"));
      s.handle.exit(0);
      await s.done;
    });
  }

  it("header 80x24：一行头", async () => {
    const s = await start([], { quietStartup: "header" });
    golden("header-quiet-80x24", snapshot(s.terminal, "startup header"));
    s.handle.exit(0);
    await s.done;
  });
});

/** 把组件放进 MemoryTerminal 渲染一帧（含回滚）。 */
function screen(component: Component, columns: number, rows: number): string {
  const terminal = new MemoryTerminal({ columns, rows });
  const tui = new TUI(terminal);
  tui.addChild(component);
  tui.start();
  tui.renderNow();
  const { row, col } = terminal.screen.cursor;
  const out = [`# viewport ${columns}x${rows} cursor=${row},${col}`];
  out.push(...terminal.viewport().map((l) => `|${l}`));
  out.push(`# scrollback ${terminal.screen.scrollback().length} lines`);
  out.push(...terminal.screen.scrollback().map((l) => `|${l}`));
  tui.stop();
  return out.join("\n") + "\n";
}

const DIFF = [
  "--- a/src/tui/tui.ts",
  "+++ b/src/tui/tui.ts",
  "@@ -212,4 +212,7 @@",
  "   if (first === -1) return;",
  "-  if (first < this.viewportTop(height)) {",
  "+  if (first < this.viewportTop(height) || lines.length < prev.length) {",
  "+    // 内容变短也走全量，避免残影",
  "     fullViewport();",
  "   }",
].join("\n");

/** §3.5 的各类工具调用，一屏。 */
function toolsScene(): MessageView {
  const theme = plainTheme();
  let now = 0;
  const tracker = new ToolTracker({ theme, cwd: "/w", now: () => now, spinner: () => "⠋" });
  const view = new MessageView({ theme });
  const add = (id: string, name: string, args: unknown, parent?: string) => {
    const { view: v, topLevel } = tracker.start({
      toolCallId: id,
      toolName: name,
      args,
      ...(parent !== undefined ? { parentToolCallId: parent } : {}),
    });
    if (topLevel) view.addTool(v);
    return v;
  };
  view.addUser({ content: "检查差分渲染" });
  add("r", "read", { path: "/w/src/tui/tui.ts", offset: 1, limit: 120 });
  const numbered = Array.from(
    { length: 120 },
    (_, i) => `${String(i + 1).padStart(6)}\tline ${i + 1}`,
  );
  tracker.end(
    "r",
    { content: numbered.join("\n"), details: { firstLine: 1, lastLine: 120 } },
    false,
  );
  add("e", "edit", { path: "/w/src/tui/tui.ts", edits: [{}, {}] });
  tracker.end("e", { content: "Edited", details: { diff: DIFF, replacements: 2 } }, false);
  add("b1", "bash", { command: "pnpm vitest run src/tui" });
  tracker.update(
    "b1",
    " ✓ src/tui/ansi.test.ts (31)\n ✓ src/tui/theme.test.ts (12)\n ⠋ src/tui/tui.test.ts",
  );
  add("b2", "bash", { command: "git push --force origin main" });
  now = 300;
  tracker.end(
    "b2",
    {
      content: "fatal",
      isError: true,
      details: {
        output: "fatal: refusing to update checked out branch",
        exit_code: 128,
        totalLines: 1,
      },
    },
    true,
  );
  add("g", "grep", { pattern: "requestRender", path: "/w/src" });
  tracker.end(
    "g",
    {
      content: [
        "src/tui/tui.ts:180: requestRender(immediate = false): void {",
        "src/tui/components/loader.ts:52: this.requestRender();",
        "src/tui/components/editor.ts:311: this.options.requestRender();",
        "src/a.ts:1: x",
      ].join("\n"),
      details: { matches: 14, files: 6 },
    },
    false,
  );
  add("c", "codemode", { script: 'const files = await tools.glob("src/**/*.ts")' });
  add("c1", "glob", { pattern: "src/**/*.ts" }, "c");
  tracker.end("c1", { content: "a\nb", details: { count: 42 } }, false);
  add("c2", "read", { path: "/w/src/tui/tui.ts" }, "c");
  tracker.end("c2", { content: "x", details: { firstLine: 1, lastLine: 399 } }, false);
  tracker.end("c", { content: "42 files, 14 matches\ndone", details: { toolCalls: 2 } }, false);
  add("t", "task", { description: "检查 src/tui 的测试覆盖缺口" });
  return view;
}

describe("工具层级", () => {
  for (const columns of [80, 40]) {
    it(`read / edit diff / bash 运行中与失败 / grep / codemode 嵌套 / task ${columns}x50`, () => {
      golden(`tools-${columns}x50`, screen(toolsScene(), columns, 50));
    });
  }
});
