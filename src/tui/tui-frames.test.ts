/**
 * 帧黄金测试（设计 §15 TUI 行、§16.2 B4 验收）：MemoryTerminal 还原的屏幕与回滚对照
 * `test/fixtures/tui/*.txt`。更新黄金：`AMA_UPDATE_GOLDEN=1 pnpm vitest run src/tui/tui-frames.test.ts`。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { plainTheme } from "./theme.js";
import { MemoryTerminal } from "./terminal.js";
import { SYNC_BEGIN, SYNC_END, TUI } from "./tui.js";
import { Box } from "./components/box.js";
import { Container } from "./components/container.js";
import { Editor } from "./components/editor.js";
import { Loader } from "./components/loader.js";
import { Markdown } from "./components/markdown.js";
import { SelectList } from "./components/select-list.js";
import { Spacer } from "./components/spacer.js";
import { Text, TruncatedText } from "./components/text.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
  "tui",
);

function golden(name: string, actual: string): void {
  const file = join(FIXTURES, `${name}.txt`);
  if (process.env["AMA_UPDATE_GOLDEN"] === "1" || (!existsSync(file) && !process.env["CI"])) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, actual);
  }
  expect(actual).toBe(readFileSync(file, "utf8"));
}

function snapshot(terminal: MemoryTerminal, withTranscript = false): string {
  const { row, col } = terminal.screen.cursor;
  const out = [`# viewport ${terminal.columns}x${terminal.rows} cursor=${row},${col}`];
  out.push(...terminal.viewport().map((l) => `|${l}`));
  if (withTranscript) {
    out.push(`# scrollback ${terminal.screen.scrollback().length} lines`);
    out.push(...terminal.screen.scrollback().map((l) => `|${l}`));
  }
  return out.join("\n") + "\n";
}

const ASSISTANT = [
  "我先看一下 `src/tui/tui.ts` 的差分逻辑，然后**只改**必要的部分。",
  "",
  "1. 读文件",
  "2. 修改 `diff()`：首变化行在视口之上时全量重画",
  "3. 跑测试",
  "",
  "```ts",
  "if (first < viewportTop) fullViewport();",
  "```",
  "",
  "> 注意：已滚出终端顶部的历史行不再重绘。",
].join("\n");

function buildScene(terminal: MemoryTerminal) {
  const theme = plainTheme();
  const tui = new TUI(terminal);
  const chat = new Container();
  chat.addChild(new Text("ama v0.1.0 · fake/echo · Enter 提交 · Esc 中断"));
  chat.addChild(new Spacer());
  chat.addChild(new Text("› 帮我检查差分渲染在小终端里是否正确，宽字符 😀 也要对齐"));
  chat.addChild(new Spacer());
  chat.addChild(new Markdown(ASSISTANT, { theme }));
  chat.addChild(new Spacer());
  const loader = new Loader(() => undefined, { message: "Working", now: () => 0 });
  const editor = new Editor({ theme });
  editor.insertText("继续：再加一个 resize 的测试");
  const status = new TruncatedText(
    "fake/echo · think:medium · ↑12.3k ↓1.2k · ctx 34% · mode:default",
  );
  tui.addChild(chat);
  tui.addChild(loader);
  tui.addChild(editor);
  tui.addChild(status);
  tui.start();
  tui.setFocus(editor);
  tui.renderNow();
  return { tui, editor, theme };
}

describe("帧黄金", () => {
  for (const [columns, rows] of [
    [80, 24],
    [40, 24],
    [80, 10],
    [40, 10],
  ] as const) {
    it(`对话场景 ${columns}x${rows}`, () => {
      const terminal = new MemoryTerminal({ columns, rows });
      const { tui } = buildScene(terminal);
      golden(`chat-${columns}x${rows}`, snapshot(terminal, true));
      tui.stop();
    });
  }

  it("真实组件上的差分：编辑器里打一个字只重写编辑器那一行", () => {
    const terminal = new MemoryTerminal({ columns: 80, rows: 10 });
    const { tui } = buildScene(terminal);
    terminal.takeWrites();
    terminal.sendInput("!");
    tui.renderNow();
    const frame = terminal.takeWrites();
    expect(frame.startsWith(SYNC_BEGIN) && frame.endsWith(SYNC_END)).toBe(true);
    const text = frame.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b_[^\x07]*\x07|\r\n|\r/g, "\n");
    expect(text.split("\n").filter(Boolean)).toEqual(["继续：再加一个 resize 的测试!", " "]);
    expect(tui.stats.fullRedraws).toBe(1);
    tui.stop();
  });

  it("40x10 下 resize 到 80x10：全量重画最后一屏", () => {
    const terminal = new MemoryTerminal({ columns: 40, rows: 10 });
    const { tui } = buildScene(terminal);
    terminal.resize(80, 10);
    tui.renderNow();
    expect(tui.stats.fullRedraws).toBe(2);
    golden("chat-resize-40-to-80x10", snapshot(terminal));
    tui.stop();
  });

  for (const columns of [80, 40]) {
    it(`审批覆盖层（bottom）${columns}x24`, () => {
      const terminal = new MemoryTerminal({ columns, rows: 24 });
      const { tui, editor, theme } = buildScene(terminal);
      editor.disableSubmit = true;
      const body = new Container();
      body.addChild(new Text("bash  git push --force origin main"));
      body.addChild(new Text("reason: dangerous"));
      body.addChild(new Spacer());
      body.addChild(new Text("[y] allow  [n] deny  [a] allow similar  [v] view"));
      const handle = tui.showOverlay(new Box(body, { title: "Approve tool call", theme }), {
        anchor: "bottom",
      });
      tui.renderNow();
      golden(`approval-${columns}x24`, snapshot(terminal));
      handle.hide();
      tui.renderNow();
      expect(tui.getFocus()).toBe(editor);
      golden(`approval-hidden-${columns}x24`, snapshot(terminal));
      tui.stop();
    });
  }

  it("选择列表覆盖层（center）80x24", () => {
    const terminal = new MemoryTerminal({ columns: 80, rows: 24 });
    const { tui, theme } = buildScene(terminal);
    const list = new SelectList(
      [
        {
          value: "anthropic/claude",
          label: "claude-sonnet",
          group: "anthropic",
          description: "key ✓",
        },
        {
          value: "anthropic/haiku",
          label: "claude-haiku",
          group: "anthropic",
          description: "key ✓",
        },
        { value: "openai/gpt", label: "gpt-5", group: "openai", description: "no key" },
      ],
      { theme, filterable: true },
    );
    tui.showOverlay(new Box(list, { title: "Select model", theme }), { width: 40 });
    tui.renderNow();
    golden("select-80x24", snapshot(terminal));
    tui.stop();
  });
});
