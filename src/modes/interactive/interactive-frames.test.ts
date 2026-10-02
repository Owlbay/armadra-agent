/**
 * 终端界面视觉设计 v1 的整屏帧黄金（§5.3）：启动头、工具层级、提示、运行中动词、面板、ASCII。
 * 更新：`AMA_UPDATE_GOLDEN=1 pnpm vitest run src/modes/interactive src/tui`，逐个审阅 diff。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeHarness } from "../../../test/helpers/compose-harness.js";
import type { SessionEvent } from "../../agent/types.js";
import { sharedCacheReporting } from "../../ai/cache/reporting.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import { MemoryTerminal, TUI, plainTheme, type Component } from "../../tui.js";
import { AMA_VERSION } from "../../version.js";
import { MessageView } from "./message-view.js";
import { cleanupStarted, golden, snapshot, start, started } from "./test-support.js";
import { ToolTracker } from "./tool-view.js";

afterEach(cleanupStarted);
// 端点的缓存报告状态是进程级的：每个用例从零开始，帧与运行顺序无关
beforeEach(() => sharedCacheReporting.clear());

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
        argv: ["--trust", "--codemode", "off"],
      });
      // Windows 上目录显示为 ~\work
      const shot = snapshot(s.terminal, "startup normal").replaceAll("~\\work", "~/work");
      golden(`startup-normal-${columns}x24`, shot);
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
  // 路径用相对写法：绝对路径经 relative() 在 Windows 上会变成反斜杠
  const tracker = new ToolTracker({ theme, now: () => now, spinner: () => "⠋" });
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
  add("r", "read", { path: "src/tui/tui.ts", offset: 1, limit: 120 });
  const numbered = Array.from(
    { length: 120 },
    (_, i) => `${String(i + 1).padStart(6)}\tline ${i + 1}`,
  );
  tracker.end(
    "r",
    { content: numbered.join("\n"), details: { firstLine: 1, lastLine: 120 } },
    false,
  );
  add("e", "edit", { path: "src/tui/tui.ts", edits: [{}, {}] });
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
  add("g", "grep", { pattern: "requestRender", path: "src" });
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
  add("c2", "read", { path: "src/tui/tui.ts" }, "c");
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

describe("运行中动词", () => {
  it("思考中 → 回复中 → 等待确认 → 运行 bash 80x24", async () => {
    const s = await start([
      {
        steps: [
          { thinking: "先看看目录结构。" },
          { delayMs: 30 },
          { text: "我先列一下文件。".repeat(4) },
          { delayMs: 30 },
          { toolCall: { name: "bash", arguments: { command: "echo verbs-ok" }, id: "call_b" } },
        ],
        // 用量写死：缺省按请求大小估算，系统提示含平台信息，各机器不同
        usage: { input: 900, output: 17 },
      },
      { text: "好了。", usage: { input: 1200, output: 1 } },
    ]);
    const frames: string[] = [];
    const isUpdate = (kind: "thinking" | "text") => (e: SessionEvent) =>
      e.type === "message_update" &&
      e.message.role === "assistant" &&
      e.message.content.at(-1)?.type === kind;
    const thinking = s.until(isUpdate("thinking"));
    s.type("列一下文件");
    s.terminal.sendInput("\r");
    await thinking;
    frames.push(snapshot(s.terminal, "思考中"));
    await s.until(isUpdate("text"));
    frames.push(snapshot(s.terminal, "回复中"));
    await s.until((e) => e.type === "permission_request");
    await new Promise((r) => setTimeout(r, 0));
    s.frame();
    frames.push(snapshot(s.terminal, "等待确认"));
    // tool_execution_start 在审批之前；放行后 bash 子进程还在跑，下一轮事件循环即是「运行 bash」
    s.terminal.sendInput("y");
    await new Promise((r) => setTimeout(r, 0));
    s.frame();
    frames.push(snapshot(s.terminal, "运行 bash"));
    await s.until((e) => e.type === "agent_settled");
    frames.push(snapshot(s.terminal, "settled"));
    golden("loader-verbs-80x24", frames.join("\n"));
    s.handle.exit(0);
    await s.done;
  });
});

describe("面板", () => {
  it("/session 卡片 80x24", async () => {
    harnessWithTildeCwd([
      { text: "好的。", usage: { input: 3_400, output: 940, cacheRead: 11_800, cacheWrite: 620 } },
    ]);
    const s = await start([], { keepHarness: true, quietStartup: "silent" });
    const settled = s.until((e) => e.type === "agent_settled");
    s.type("你好");
    s.terminal.sendInput("\r");
    await settled;
    s.type("/session");
    s.terminal.sendInput("\r");
    await new Promise((r) => setTimeout(r, 10));
    s.frame();
    const state = s.handle.session().state;
    let shot = snapshot(s.terminal, "/session");
    shot = shot.replaceAll(state.sessionId.slice(0, 8), "<id>");
    const file = state.sessionFile ?? "";
    const shown = file.replace(started.h!.home.root, "~");
    shot = shot.replace(/~\S*\.jsonl|~\S*…/, "<file>");
    expect(shown.endsWith(".jsonl")).toBe(true);
    golden("panel-session-80x24", shot);
    s.handle.exit(0);
    await s.done;
  });
});

describe("提示", () => {
  it("错误 / 重试 / 压缩卡 / 缓存未命中 / 上下文 / Hook 阻止 80x24", () => {
    const view = new MessageView({ theme: plainTheme() });
    view.addNotice("error", "模型调用失败：401 invalid x-api-key（anthropic）");
    view.addRetry(1, 3, 2000, "429 rate_limit_error");
    view.addCompaction({
      summary:
        "用户要求检查差分渲染与 resize 行为；已修改 diff() 并补测试\n第二行\n第三行\n第四行\n第五行",
      tokensBefore: 128_000,
      tokensAfter: 24_000,
    });
    view.addNotice("warn", "缓存未命中（空闲 7 分钟后）：重计费 38.2k token（约 $0.11）");
    view.addNotice("warn", "上下文已用 72%，约剩 9 回合（按最近 5 回合均值）");
    view.addHookBlocked("pre-tool-use 拒绝了 bash（禁止 force push）");
    view.addNotice("info", "已拒绝 bash");
    golden("notices-80x24", screen(view, 80, 24));
  });
});

const ASCII_SCRIPT: FakeResponse[] = [
  {
    steps: [
      { thinking: "I should read the file first." },
      { text: "Reading it." },
      { toolCall: { name: "read", arguments: { path: "README.md" }, id: "call_read" } },
    ],
    usage: { input: 1200, output: 40 },
  },
  { text: "The README describes **Demo**.", usage: { input: 300, output: 12, cacheRead: 1200 } },
];

describe("ASCII 模式", () => {
  it("AMA_ASCII=1 整条 run 序列 80x24", async () => {
    const s = await start(ASCII_SCRIPT, {
      theme: plainTheme({ ascii: true }),
      files: { "README.md": "# Demo\n\nA tiny project.\nMore.\nAnd more.\n" },
    });
    const frames = [snapshot(s.terminal, "startup")];
    const toolStarted = s.until((e) => e.type === "tool_execution_start");
    s.type("读一下 README");
    s.terminal.sendInput("\r");
    await toolStarted;
    frames.push(snapshot(s.terminal, "tool running"));
    await s.until((e) => e.type === "agent_settled");
    frames.push(snapshot(s.terminal, "settled"));
    s.type("\x04");
    expect(await s.done).toBe(0);
    frames.push(snapshot(s.terminal, "exit"));
    golden("ascii-run-80x24", frames.join("\n"));
  });
});

describe("ui.compact", () => {
  it("块间不空行、启动头无框", async () => {
    harnessWithTildeCwd([{ text: "好的。" }]);
    started.h!.home.write("home/.config/ama/config.json", { version: 1, ui: { compact: true } });
    const s = await start([], { keepHarness: true, quietStartup: "normal" });
    const settled = s.until((e) => e.type === "agent_settled");
    s.type("你好");
    s.terminal.sendInput("\r");
    await settled;
    const screenText = s.terminal.viewport();
    expect(screenText[0]).toBe("✻ ama " + AMA_VERSION);
    const at = screenText.indexOf("› 你好");
    expect(screenText[at + 1]).toBe("好的。");
    s.handle.exit(0);
    await s.done;
  });
});
