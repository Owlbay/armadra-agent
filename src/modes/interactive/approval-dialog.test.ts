import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionPreview, ApprovalDecision, ApprovalRequest } from "../../permissions/types.js";
import { Editor, MemoryTerminal, TUI, Text, plainTheme } from "../../tui.js";
import { ApprovalDialogBroker, approvalOutcomeText, describeRequest } from "./approval-dialog.js";

const theme = plainTheme();

function req(partial: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: "r1",
    toolName: "bash",
    input: { command: "rm -rf build\nmake" },
    reason: "mode",
    ...partial,
  };
}

let tui: TUI | undefined;
afterEach(() => tui?.stop());

function setup(columns = 80) {
  const terminal = new MemoryTerminal({ columns, rows: 24 });
  tui = new TUI(terminal);
  const editor = new Editor({ theme });
  tui.addChild(new Text("› 清理构建目录"));
  tui.addChild(editor);
  tui.start();
  tui.setFocus(editor);
  const events: string[] = [];
  const t = tui;
  const broker = new ApprovalDialogBroker({
    theme,
    cwd: "/w",
    permissionMode: () => "default",
    showOverlay: (c) => t.showOverlay(c, { anchor: "bottom" }),
    onOpen: () => {
      editor.disableSubmit = true;
      events.push("open");
    },
    onClose: () => {
      editor.disableSubmit = false;
      events.push("close");
    },
    report: (r, outcome) => events.push(approvalOutcomeText(r, outcome)),
  });
  const screen = (): string => {
    t.renderNow();
    return terminal.viewport().join("\n");
  };
  return { terminal, editor, broker, events, screen, tui: t };
}

describe("审批对话框", () => {
  for (const [key, decision] of [
    ["y", "allow"],
    ["Y", "allow"],
    ["n", "deny"],
    ["a", "allow_session"],
  ] as const) {
    it(`按 ${key} → ${decision}，对话框关闭、焦点回到编辑器`, async () => {
      const { terminal, editor, broker, events, screen, tui } = setup();
      const answer = broker.ask(req(), new AbortController().signal);
      expect(broker.isOpen).toBe(true);
      expect(editor.disableSubmit).toBe(true);
      const shown = screen();
      expect(shown).toContain("╭─ 审批");
      expect(shown).toContain("$ rm -rf build");
      expect(shown).toContain("权限模式 default 下需要确认");
      expect(shown).toContain("[y] 允许");
      terminal.sendInput(key);
      expect(await answer).toBe(decision as ApprovalDecision);
      expect(broker.isOpen).toBe(false);
      expect(tui.getFocus()).toBe(editor);
      expect(editor.disableSubmit).toBe(false);
      expect(screen()).not.toContain("审批");
      expect(events[0]).toBe("open");
      expect(events[1]).toBe("close");
    });
  }

  it("Esc 与 Ctrl+C 拒绝；其它键不作答", async () => {
    const { terminal, broker } = setup();
    let answer = broker.ask(req(), new AbortController().signal);
    terminal.sendInput("x");
    terminal.sendInput("\r");
    expect(broker.isOpen).toBe(true);
    terminal.sendInput("\x1b");
    terminal.flushInput();
    expect(await answer).toBe("deny");
    answer = broker.ask(req(), new AbortController().signal);
    terminal.sendInput("\x03");
    expect(await answer).toBe("deny");
  });

  it("v 展开完整输入（JSON），再按收起", async () => {
    const { terminal, broker, screen } = setup();
    const answer = broker.ask(req(), new AbortController().signal);
    terminal.sendInput("v");
    expect(screen()).toContain('"command": "rm -rf build\\nmake"');
    terminal.sendInput("v");
    expect(screen()).not.toContain('"command"');
    terminal.sendInput("y");
    await answer;
  });

  it("超时 / abort：对话框关闭，返回 undefined，留一行说明", async () => {
    const { broker, events, screen } = setup();
    const answer = broker.ask(req(), AbortSignal.timeout(20));
    expect(await answer).toBeUndefined();
    expect(broker.isOpen).toBe(false);
    expect(screen()).not.toContain("审批");
    expect(events).toContain("审批已取消（超时或中断）：bash");
    const aborted = new AbortController();
    aborted.abort();
    expect(await broker.ask(req(), aborted.signal)).toBeUndefined();
  });

  it("[task] 前缀与子任务标题；危险命令与 Hook 原因", async () => {
    const { terminal, broker, screen } = setup(40);
    const answer = broker.ask(
      req({ reason: "dangerous", context: { depth: 1 } }),
      new AbortController().signal,
    );
    const shown = screen();
    expect(shown).toContain("子任务审批");
    expect(shown).toContain("[task] bash  危险命令");
    expect(shown).toContain("这条命令可能有破坏性");
    terminal.sendInput("n");
    await answer;
    expect(
      describeRequest(req({ reason: "hook", hookReason: "生产目录需要确认" }), theme).at(-1),
    ).toBe("Hook：生产目录需要确认");
  });

  it("write 显示路径与行数；edit 显示每处 −/+ 摘要；其它工具一行摘要", () => {
    expect(
      describeRequest(
        req({ toolName: "write", input: { path: "/w/src/a.ts", content: "a\nb\nc\n" } }),
        theme,
        { cwd: "/w" },
      ),
    ).toEqual(["write  需要确认", `${join("src", "a.ts")}  写入 3 行`]);
    const edit = describeRequest(
      req({
        toolName: "edit",
        input: {
          path: "/w/x.ts",
          edits: [
            { oldText: "one\ntwo\nthree\nfour", newText: "1" },
            { oldText: "a", newText: "b" },
            { oldText: "c", newText: "d" },
          ],
        },
      }),
      theme,
      { cwd: "/w" },
    );
    expect(edit).toEqual([
      "edit  需要确认",
      "x.ts  3 处修改",
      "- one",
      "- two",
      "- three",
      "… 另 1 行（v 查看）",
      "+ 1",
      "- a",
      "+ b",
      "… 另 1 处",
    ]);
    expect(
      describeRequest(req({ toolName: "canvas_write", input: { name: "节点 A" } }), theme),
    ).toEqual(["canvas_write  需要确认", "节点 A"]);
  });

  it("结果说明文本", () => {
    const r = req({ context: { depth: 2 } });
    expect(approvalOutcomeText(r, "allow")).toBe("已允许 [task] bash");
    expect(approvalOutcomeText(r, "allow_session")).toContain("本会话同类不再询问");
    expect(approvalOutcomeText(r, "deny")).toBe("已拒绝 [task] bash");
  });
});

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "test",
  "fixtures",
);

/** 帧黄金（与 src/tui/tui-frames.test.ts 同格式）；更新：AMA_UPDATE_GOLDEN=1。 */
function golden(name: string, terminal: MemoryTerminal): void {
  const { row, col } = terminal.screen.cursor;
  const actual =
    [
      `# viewport ${terminal.columns}x${terminal.rows} cursor=${row},${col}`,
      ...terminal.viewport().map((l) => `|${l}`),
    ].join("\n") + "\n";
  const file = join(FIXTURES, "tui", `${name}.txt`);
  if (process.env["AMA_UPDATE_GOLDEN"] === "1" || (!existsSync(file) && !process.env["CI"])) {
    writeFileSync(file, actual);
  }
  expect(actual).toBe(readFileSync(file, "utf8"));
}

const RM_PREVIEW: ActionPreview = {
  kind: "bash",
  lines: [
    "删除 build/：目录，132 个文件，1.2 MB",
    "删除 dist/*.map：含通配符或变量，未展开，实际范围可能更大",
    "覆盖写入 out.log：文件，4.0 KB",
  ],
  severity: "danger",
  affected: [{ path: "build/", exists: true, files: 132, bytes: 1_258_291 }],
};

describe("审批对话框：执行前预览", () => {
  it("预览行在输入摘要之后、原因之前；other 类不重复显示；过长截断", () => {
    const shown = describeRequest(
      req({ input: { command: "rm -rf build dist/*.map > out.log" }, preview: RM_PREVIEW }),
      theme,
      { permissionMode: "default" },
    );
    expect(shown).toEqual([
      "bash  需要确认",
      "$ rm -rf build dist/*.map > out.log",
      ...RM_PREVIEW.lines,
      "权限模式 default 下需要确认",
    ]);
    const other = describeRequest(
      req({
        toolName: "canvas_write",
        input: { name: "节点 A" },
        preview: { kind: "other", lines: ["节点 A"], severity: "info" },
      }),
      theme,
    );
    expect(other).toEqual(["canvas_write  需要确认", "节点 A"]);
    const long: ActionPreview = {
      kind: "bash",
      lines: Array.from({ length: 14 }, (_, i) => `删除 f${i}：文件，1 B`),
      severity: "warn",
    };
    const clipped = describeRequest(req({ preview: long }), theme);
    expect(clipped).toContain("… 另 5 行");
    expect(clipped).not.toContain("删除 f9：文件，1 B");
  });

  it("danger 红、warn 黄（主题着色）", () => {
    const colored: typeof theme = Object.assign(Object.create(theme) as typeof theme, {
      fg: (c: string, t: string) => `<${c}>${t}`,
    });
    const line = (severity: ActionPreview["severity"]) =>
      describeRequest(
        req({ preview: { kind: "bash", lines: ["删除 a：文件，1 B"], severity } }),
        colored,
      ).find((l) => l.includes("删除 a"));
    expect(line("danger")).toBe("<error>删除 a：文件，1 B");
    expect(line("warn")).toBe("<warning>删除 a：文件，1 B");
    expect(line("info")).toBe("<dim>删除 a：文件，1 B");
  });

  for (const columns of [80, 40]) {
    it(`帧黄金：危险命令带预览 ${columns}x24`, async () => {
      const { terminal, broker, screen } = setup(columns);
      const answer = broker.ask(
        req({
          input: { command: "rm -rf build dist/*.map > out.log" },
          reason: "dangerous",
          preview: RM_PREVIEW,
        }),
        new AbortController().signal,
      );
      screen();
      golden(`approval-preview-${columns}x24`, terminal);
      terminal.sendInput("n");
      expect(await answer).toBe("deny");
    });
  }
});
