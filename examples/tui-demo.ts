/**
 * TUI 组件库演示（B4 手测用）：编辑器 + 假流式 Markdown 消息 + 选择列表 + 审批覆盖层。
 *
 * 运行（先构建库，再用 Node 的类型剥离直接跑本文件）：
 *   pnpm build:lib
 *   node --experimental-strip-types examples/tui-demo.ts   # Node 22.6+；Node ≥ 23.6 可省略参数
 *
 * 操作：
 *   输入文字 Enter 提交 → 假助手流式回复（Esc 中断）
 *   /model  打开模型选择列表（center 覆盖层，可输入过滤）
 *   /approve  打开审批对话框（bottom 覆盖层；y / n / a / v）
 *   /quit 或空输入时 Ctrl+D 退出；Ctrl+C 清空输入，再按一次退出
 *   Shift+Enter / Ctrl+J 换行；粘贴超过 10 行会折叠为 [paste #N +M lines]
 */

import {
  Box,
  Container,
  Editor,
  Loader,
  Markdown,
  ProcessTerminal,
  SelectList,
  Spacer,
  TUI,
  Text,
  TruncatedText,
  createTheme,
  defaultKeybindings,
  matchesKey,
  type AutocompleteProvider,
  type OverlayHandle,
} from "../dist/tui.js";

const theme = createTheme(process.env["AMA_DEMO_THEME"] === "light" ? "light" : "dark");
const tui = new TUI(new ProcessTerminal());

const COMMANDS = [
  { value: "/model", label: "/model", description: "select a model" },
  { value: "/approve", label: "/approve", description: "show an approval dialog" },
  { value: "/clear", label: "/clear", description: "clear messages" },
  { value: "/quit", label: "/quit", description: "exit the demo" },
];

const completion: AutocompleteProvider = {
  getSuggestions({ textBeforeCursor }) {
    if (!/^\/\S*$/.test(textBeforeCursor)) return null;
    const items = COMMANDS.filter((c) => c.value.startsWith(textBeforeCursor));
    return { items, from: 0 };
  },
};

const REPLY = [
  "好的，我先读一下 `src/tui/tui.ts`，再说明**差分渲染**的规则：",
  "",
  "1. 首帧全量输出",
  "2. 宽度或高度变化时全量重画最后一屏",
  "3. 其余情况只重写首末变化行之间的区间",
  "   - 首变化行已滚出视口时，重画整个视口",
  "",
  "```ts",
  "for (let i = first; i <= last; i++) out.push(moveTo(i) + clearLine + lines[i]);",
  "```",
  "",
  "> 已滚出终端顶部的历史行留在回滚里，不再重绘。",
  "",
  "| 情况 | 写入 |",
  "|------|------|",
  "| 改一行 | 1 行 |",
  "| resize | 一屏 |",
].join("\n");

const header = new Text(
  theme.bold("ama tui demo") + theme.fg("dim", "  ·  /model  /approve  /quit  ·  Esc 中断"),
);
const messages = new Container();
const loader = new Loader(() => tui.requestRender(), { message: "Streaming", theme });
const status = new TruncatedText("");
const editor = new Editor({
  theme,
  autocomplete: completion,
  requestRender: () => tui.requestRender(),
  placeholder: "Ask anything",
  onSubmit: (text) => handleSubmit(text),
});

let mode = "default";
let streamTimer: ReturnType<typeof setInterval> | null = null;
let model = "fake/echo";
let ctrlCArmed = false;
let overlay: OverlayHandle | null = null;

function updateStatus(): void {
  const parts = [model, `mode:${mode}`, streamTimer ? "streaming" : "idle"];
  status.setText(theme.fg("dim", parts.join(" · ")));
}

tui.addChild(header);
tui.addChild(new Spacer());
tui.addChild(messages);
tui.addChild(editor);
tui.addChild(status);
updateStatus();

function addMessage(component: Text | Markdown): void {
  messages.addChild(component);
  messages.addChild(new Spacer());
}

function stopStream(note?: string): void {
  if (streamTimer) clearInterval(streamTimer);
  streamTimer = null;
  loader.stop();
  tui.removeChild(loader);
  if (note) addMessage(new Text(theme.fg("warning", note)));
  updateStatus();
  tui.requestRender();
}

function streamReply(): void {
  const md = new Markdown("", { theme });
  addMessage(md);
  tui.insertBefore(loader, editor);
  loader.start();
  let offset = 0;
  streamTimer = setInterval(() => {
    const step = 2 + Math.floor(Math.random() * 6);
    md.append(REPLY.slice(offset, offset + step));
    offset += step;
    if (offset >= REPLY.length) stopStream();
    tui.requestRender();
  }, 30);
  updateStatus();
}

function showModelPicker(): void {
  const list = new SelectList(
    [
      {
        value: "anthropic/sonnet",
        label: "claude-sonnet",
        group: "anthropic",
        description: "key ✓",
      },
      { value: "anthropic/haiku", label: "claude-haiku", group: "anthropic", description: "key ✓" },
      { value: "openai/gpt", label: "gpt-5", group: "openai", description: "no key" },
      { value: "fake/echo", label: "echo", group: "fake", description: "offline" },
    ],
    {
      theme,
      filterable: true,
      onSelect: (item) => {
        model = item.value;
        closeOverlay();
      },
      onCancel: () => closeOverlay(),
    },
  );
  list.selectValue(model);
  overlay = tui.showOverlay(new Box(list, { title: "Select model", theme }), { width: 44 });
}

class ApprovalDialog extends Container {
  focused = false;
  private expanded = false;
  private readonly detail: Text;

  constructor() {
    super();
    this.addChild(new Text(theme.fg("tool", "bash") + "  git push --force origin main"));
    this.addChild(new Text(theme.fg("warning", "reason: dangerous")));
    this.detail = new Text("");
    this.addChild(this.detail);
    this.addChild(new Spacer());
    this.addChild(new Text("[y] allow  [n] deny  [a] allow similar  [v] view input"));
  }

  handleInput(data: string): void {
    const decide = (decision: string): void => {
      closeOverlay();
      addMessage(new Text(theme.fg("dim", `approval: ${decision}`)));
    };
    if (data === "y") decide("allow");
    else if (data === "n" || matchesKey(data, "escape")) decide("deny");
    else if (data === "a") decide("allow similar (session)");
    else if (data === "v") {
      this.expanded = !this.expanded;
      this.detail.setText(
        this.expanded ? theme.fg("dim", '{ "command": "git push --force origin main" }') : "",
      );
    }
  }
}

function showApproval(): void {
  editor.disableSubmit = true;
  overlay = tui.showOverlay(new Box(new ApprovalDialog(), { title: "Approve tool call", theme }), {
    anchor: "bottom",
  });
}

function closeOverlay(): void {
  overlay?.hide();
  overlay = null;
  editor.disableSubmit = false;
  updateStatus();
  tui.requestRender();
}

function handleSubmit(text: string): void {
  const command = text.trim();
  if (command === "/quit") return exit();
  if (command === "/model") return showModelPicker();
  if (command === "/approve") return showApproval();
  if (command === "/clear") {
    messages.clear();
    return;
  }
  addMessage(new Text(theme.fg("user", "› ") + text));
  if (streamTimer) stopStream("(interrupted by new message)");
  streamReply();
}

function exit(): void {
  if (streamTimer) clearInterval(streamTimer);
  loader.stop();
  tui.stop();
  process.exit(0);
}

tui.addInputListener((data) => {
  if (overlay) return false;
  if (
    defaultKeybindings.matches(data, "app.interrupt") &&
    streamTimer &&
    !editor.isCompletionOpen
  ) {
    stopStream("(interrupted)");
    return true;
  }
  if (defaultKeybindings.matches(data, "app.permission.cycle")) {
    mode = mode === "default" ? "acceptEdits" : mode === "acceptEdits" ? "plan" : "default";
    updateStatus();
    return true;
  }
  if (defaultKeybindings.matches(data, "app.clear")) {
    if (ctrlCArmed || editor.isEmpty()) exit();
    editor.clear();
    ctrlCArmed = true;
    setTimeout(() => (ctrlCArmed = false), 1500).unref();
    return true;
  }
  if (defaultKeybindings.matches(data, "app.exit") && editor.isEmpty()) {
    exit();
    return true;
  }
  ctrlCArmed = false;
  return false;
});

process.on("SIGTERM", exit);
tui.start();
tui.setFocus(editor);
