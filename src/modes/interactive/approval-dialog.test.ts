import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDecision, ApprovalRequest } from "../../permissions/types.js";
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
    ).toEqual(["write  需要确认", "src/a.ts  写入 3 行"]);
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
