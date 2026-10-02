import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, SessionEvent } from "../../agent/types.js";
import { Editor, MemoryTerminal, TUI, plainTheme } from "../../tui.js";
import { AgentUi } from "./agent-ui.js";
import { NO_CLIPBOARD_IMAGE, NO_CLIPBOARD_TOOL, imageRef, pasteImage } from "./clipboard-paste.js";
import { editExternally, editorCommand } from "./external-editor.js";
import { SubagentTracker } from "./subagent-view.js";
import { ToolTracker } from "./tool-view.js";

const theme = plainTheme();
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ama-u-"));
  dirs.push(dir);
  return dir;
}

function setup() {
  const logged: string[] = [];
  const notices: string[] = [];
  const options: { log?: (level: string, message: string) => void } = {
    log: (level, message) => void logged.push(`${level} ${message}`),
  };
  const session = {
    state: { sessionId: "s-ui", permissionMode: "default", isStreaming: false },
    options,
  } as unknown as AgentSession;
  const subagents = new SubagentTracker(() => 0);
  const tools = new ToolTracker({ theme, subagent: (id) => subagents.forToolCall(id) });
  const tui = new TUI(new MemoryTerminal({ columns: 80, rows: 10 }));
  const editor = new Editor({ theme });
  const ui = new AgentUi({
    theme,
    tui,
    editor,
    tools: () => tools,
    subagents,
    session: () => session,
    dataDir: tmp(),
    env: {},
    now: () => 0,
    notice: (level, text) => void notices.push(`${level} ${text}`),
    panel: () => undefined,
    pick: async () => undefined,
    hint: () => undefined,
    render: () => undefined,
    switchSession: async () => session,
    prompt: () => undefined,
    dialog: { theme, showOverlay: () => ({ hide() {}, focus() {}, visible: true }) },
    displayPath: (p) => p,
    clipboard: {
      run: async () => ({ code: null, stdout: Buffer.alloc(0), stderr: "", missing: true }),
    },
  });
  return { ui, session, options, logged, notices, tools, editor };
}

describe("AgentUi", () => {
  it("外部 Agent 的 notice（任务日志）转到消息区，其余日志照常；detach 还原", () => {
    const s = setup();
    s.ui.attach(s.session);
    s.options.log?.("warn", "[task t2] 预算用尽，已停止");
    s.options.log?.("warn", "something else");
    s.options.log?.("debug", "[task t2] debug detail");
    expect(s.notices).toEqual(["warn [task · t2] 预算用尽，已停止"]);
    expect(s.logged).toEqual(["warn something else", "debug [task t2] debug detail"]);
    s.ui.detach();
    s.options.log?.("info", "[task t2] after");
    expect(s.logged.at(-1)).toBe("info [task t2] after");
  });

  it("子 Agent 事件刷新 task 工具行；后台任务结束提示；harness 事件提示", () => {
    const s = setup();
    s.tools.start({ toolCallId: "c1", toolName: "task", args: { description: "x" } });
    const start: SessionEvent = {
      type: "subagent_start",
      taskId: "t1",
      parentToolCallId: "c1",
      agent: "explore",
      runner: "ama",
      description: "x",
      background: true,
      cwd: "/w",
    };
    expect(s.ui.onEvent(start)).toBe(true);
    expect(s.ui.onEvent({ type: "subagent_end", taskId: "t1", status: "failed" })).toBe(true);
    expect(s.notices).toEqual(["warn 后台任务 t1（explore）失败 · /tasks 查看输出"]);
    expect(s.ui.onEvent({ type: "limit_reached", kind: "turns", value: 3, limit: 3 })).toBe(true);
    expect(s.notices.at(-1)).toContain("已到回合上限（3 回合）");
    expect(s.ui.onEvent({ type: "agent_start" } as SessionEvent)).toBe(false);
  });

  it("Ctrl+V：没有剪贴板命令时一行提示，输入框不变", async () => {
    const s = setup();
    s.editor.setText("看图");
    await s.ui.paste();
    expect(s.notices).toEqual([`info ${NO_CLIPBOARD_TOOL}`]);
    expect(s.editor.getText()).toBe("看图");
  });
});

describe("剪贴板粘贴", () => {
  it("没有工具 / 没有图 / 有图", async () => {
    const dir = tmp();
    expect(
      await pasteImage(dir, {
        platform: "linux",
        env: {},
        run: async () => ({ code: null, stdout: Buffer.alloc(0), stderr: "", missing: true }),
      }),
    ).toEqual({ ok: false, message: NO_CLIPBOARD_TOOL });
    expect(
      await pasteImage(dir, {
        platform: "linux",
        env: {},
        run: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: "" }),
      }),
    ).toEqual({ ok: false, message: NO_CLIPBOARD_IMAGE });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const ok = await pasteImage(dir, {
      platform: "linux",
      env: {},
      run: async () => ({ code: 0, stdout: png, stderr: "" }),
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.ref).toBe(`@${ok.path}`);
    expect(imageRef("/a b/c.png")).toBe('@"/a b/c.png"');
  });
});

describe("外部编辑器", () => {
  it("$VISUAL → $EDITOR → vi / notepad", () => {
    expect(editorCommand({ VISUAL: "code --wait", EDITOR: "nano" })).toBe("code --wait");
    expect(editorCommand({ EDITOR: "nano" })).toBe("nano");
    expect(editorCommand({}, "linux")).toBe("vi");
    expect(editorCommand({}, "win32")).toBe("notepad");
  });

  it("挂起界面、读回改后的文本、恢复；非零退出返回 undefined", async () => {
    const steps: string[] = [];
    const deps = {
      env: { EDITOR: "fake-editor" },
      suspend: () => void steps.push("suspend"),
      resume: () => void steps.push("resume"),
    };
    const { writeFileSync, readFileSync } = await import("node:fs");
    const edited = await editExternally("原文", "plan.md", {
      ...deps,
      run: (command, file) => {
        steps.push(command);
        expect(readFileSync(file, "utf8")).toBe("原文");
        writeFileSync(file, "改后");
        return 0;
      },
    });
    expect(edited).toBe("改后");
    expect(steps).toEqual(["suspend", "fake-editor", "resume"]);
    expect(await editExternally("x", "f.md", { ...deps, run: () => 1 })).toBeUndefined();
  });
});
