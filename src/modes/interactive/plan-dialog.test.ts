import { afterEach, describe, expect, it } from "vitest";
import type { PlanData } from "../../agent/types.js";
import { Editor, MemoryTerminal, TUI, Text, plainTheme } from "../../tui.js";
import { openPlanDialog, type PlanChoice, type PlanDialogHost } from "./plan-dialog.js";
import { golden } from "./test-support.js";

const PLAN: PlanData = {
  id: "p1",
  version: 1,
  status: "proposed",
  markdown: [
    "# 状态栏显示回退模型",
    "",
    "## 步骤",
    "- [ ] S1 读 status-bar.ts 与 status-area.ts",
    "- [ ] S2 model_fallback 时记下主模型与回退模型 [depends: S1]",
    "- [ ] S3 帧黄金与文档",
  ].join("\n"),
  steps: [
    { id: "S1", text: "读 status-bar.ts 与 status-area.ts" },
    { id: "S2", text: "model_fallback 时记下主模型与回退模型", dependsOn: ["S1"] },
    { id: "S3", text: "帧黄金与文档" },
  ],
  sourceEntryId: "e1",
  filePath: "~/.local/share/ama/plans/3f2a9c1e-v1.md",
};

let tui: TUI | undefined;
afterEach(() => tui?.stop());

function setup(
  columns = 80,
  options: { ascii?: boolean; edit?: PlanDialogHost["editExternal"] } = {},
) {
  const terminal = new MemoryTerminal({ columns, rows: 24 });
  tui = new TUI(terminal);
  const editor = new Editor({ theme: plainTheme() });
  tui.addChild(new Text("› 规划一下状态栏的回退显示"));
  tui.addChild(editor);
  tui.start();
  tui.setFocus(editor);
  const t = tui;
  const theme = plainTheme({ ascii: options.ascii === true });
  const events: string[] = [];
  const host: PlanDialogHost = {
    theme,
    showOverlay: (c) => t.showOverlay(c, { anchor: "bottom" }),
    render: () => t.requestRender(),
    onOpen: () => events.push("open"),
    onClose: () => events.push("close"),
    ...(options.edit !== undefined ? { editExternal: options.edit } : {}),
  };
  let result: PlanChoice | undefined;
  const done = openPlanDialog(host, { plan: PLAN, preMode: "default" }).then((c) => {
    result = c;
    return c;
  });
  const screen = (label: string): string => {
    t.renderNow();
    const { row, col } = terminal.screen.cursor;
    return (
      [
        `# ${label} · viewport ${columns}x24 cursor=${row},${col}`,
        ...terminal.viewport().map((l) => `|${l}`),
      ].join("\n") + "\n"
    );
  };
  const type = (data: string): void => {
    terminal.sendInput(data);
    // 单独的 Esc 要等转义超时才确定：立即冲刷
    if (data === "\x1b") terminal.flushInput();
    t.renderNow();
  };
  return { terminal, screen, type, done, events, result: () => result };
}

describe("计划审批框", () => {
  for (const columns of [80, 40]) {
    it(`四选项 ${columns}x24`, () => {
      const s = setup(columns);
      const shot = s.screen("plan dialog");
      golden(`plan-dialog-${columns}x24`, shot);
      expect(shot).toContain("计划待审批");
      expect(shot).toContain("1. 批准并执行");
      expect(shot).toContain("4. 放弃，退出 Plan 模式");
      s.type("\x1b");
    });
  }

  it("ASCII：选中行与箭头用 ASCII 字形", () => {
    const s = setup(80, { ascii: true });
    const shot = s.screen("plan dialog ascii");
    golden("plan-dialog-ascii-80x24", shot);
    expect(shot).toContain("> 1. 批准并执行");
    expect(shot).toContain("^v 选择");
    expect(shot).not.toMatch(/[›↑↓╭]/);
    s.type("\x1b");
  });

  it("1 → 执行模式子选择；Esc 返回；3 选 Auto", async () => {
    const s = setup();
    s.type("1");
    const shot = s.screen("plan dialog mode");
    golden("plan-dialog-mode-80x24", shot);
    expect(shot).toContain("1. 回到进入前的模式（Manual）");
    expect(shot).toContain("2. Accept edits");
    s.type("\x1b");
    expect(s.screen("back")).toContain("1. 批准并执行");
    s.type("\x1b[B"); // ↓ 到 2
    s.type("\r");
    s.type("3");
    expect(await s.done).toEqual({ decision: "approve_fresh", mode: "auto" });
    expect(s.events).toEqual(["open", "close"]);
  });

  it("批准缺省回到进入前的模式", async () => {
    const s = setup();
    s.type("\r");
    s.type("\r");
    expect(await s.done).toEqual({ decision: "approve", mode: "default" });
  });

  it("3 继续修改：行内写意见，Enter 发送", async () => {
    const s = setup();
    s.type("3");
    s.type("步骤");
    s.type("\x1b[200~拆细一点\x1b[201~");
    s.type("x");
    s.type("\x7f");
    const shot = s.screen("plan dialog revise");
    golden("plan-dialog-revise-80x24", shot);
    expect(shot).toContain("› 步骤拆细一点");
    s.type("\r");
    expect(await s.done).toEqual({ decision: "revise", feedback: "步骤拆细一点" });
  });

  it("空意见按 Enter 不发送；Esc 回到选项", async () => {
    const s = setup();
    s.type("3");
    s.type("\r");
    expect(s.result()).toBeUndefined();
    s.type("\x1b");
    expect(s.screen("back")).toContain("› 3. 继续修改…");
    s.type("4");
    expect(await s.done).toEqual({ decision: "reject", exit: true });
  });

  it("Esc：放弃但留在 Plan", async () => {
    const s = setup();
    s.type("\x1b");
    expect(await s.done).toEqual({ decision: "reject", exit: false });
  });

  it("e：外部编辑器改计划，批准时带修改后的全文", async () => {
    const edited = PLAN.markdown.replace("帧黄金与文档", "帧黄金、文档与 CHANGELOG");
    const seen: string[] = [];
    const s = setup(80, {
      edit: async (text, kind) => {
        seen.push(kind);
        expect(text).toBe(PLAN.markdown);
        return edited;
      },
    });
    s.type("e");
    await new Promise((r) => setTimeout(r, 0));
    const shot = s.screen("plan dialog edited");
    golden("plan-dialog-edited-80x24", shot);
    expect(shot).toContain("已在编辑器里修改");
    s.type("1");
    s.type("2");
    expect(await s.done).toEqual({
      decision: "approve",
      mode: "auto-edit",
      editedMarkdown: edited,
    });
    expect(seen).toEqual(["plan"]);
  });

  it("继续修改里 Ctrl+E 用外部编辑器写意见", async () => {
    const s = setup(80, {
      edit: async (_text, kind) => (kind === "feedback" ? "先补测试\n" : undefined),
    });
    s.type("3");
    s.type("\x05");
    expect(await s.done).toEqual({ decision: "revise", feedback: "先补测试" });
  });

  it("外部编辑器取消：计划不变", async () => {
    const s = setup(80, { edit: async () => undefined });
    s.type("e");
    await new Promise((r) => setTimeout(r, 0));
    expect(s.screen("x")).not.toContain("已在编辑器里修改");
    s.type("\r");
    s.type("\r");
    expect(await s.done).toEqual({ decision: "approve", mode: "default" });
  });
});
