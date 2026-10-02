/**
 * TUI 组件库演示（B4 手测用）：编辑器 + 假流式 Markdown 消息 + 选择列表 + 编号审批覆盖层 + 左竖条卡片。
 *
 * 运行（先构建库，再用 Node 的类型剥离直接跑本文件）：
 *   pnpm build:lib
 *   node --experimental-strip-types examples/tui-demo.ts   # Node 22.6+；Node ≥ 23.6 可省略参数
 *
 * 操作：
 *   输入文字 Enter 提交 → 假助手流式回复（Esc 中断）
 *   /model  打开模型选择列表（center 覆盖层，可输入过滤）
 *   /approve  打开审批对话框（bottom 覆盖层，红框；1–3 / ↑↓ Enter / y / a / n）
 *   /card   在消息区加一张左竖条卡片（Card + KeyValue + Meter）
 *   /quit 或空输入时 Ctrl+D 退出；Ctrl+C 清空输入，再按一次退出
 *   Shift+Enter / Ctrl+J 换行；粘贴超过 10 行会折叠为 [粘贴 #N · M 行]
 *   AMA_ASCII=1 看 ASCII 字形；AMA_DEMO_THEME=light 看浅色主题
 */

import {
  Box,
  Card,
  Container,
  KeyValue,
  Meter,
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
  { value: "/card", label: "/card", description: "add a card panel" },
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
  theme.fg("accent", theme.glyphs.thinking) +
    " " +
    theme.bold("ama tui demo") +
    theme.fg("dim", "  ·  /model  /approve  /card  /quit  ·  Esc 中断"),
);
const messages = new Container();
const loader = new Loader(() => tui.requestRender(), { theme });
const status = new TruncatedText("");
const editor = new Editor({
  theme,
  autocomplete: completion,
  requestRender: () => tui.requestRender(),
  placeholder: "输入消息，/ 命令，Shift+Enter 换行",
  onSubmit: (text) => handleSubmit(text),
});

let mode = "default";
let streamTimer: ReturnType<typeof setInterval> | null = null;
let model = "fake/echo";
let ctrlCArmed = false;
let overlay: OverlayHandle | null = null;

function updateStatus(): void {
  const parts = [mode, model, streamTimer ? "streaming" : "idle"];
  status.setText(theme.fg("dim", parts.join(" · ")));
}

tui.addChild(header);
tui.addChild(new Spacer());
tui.addChild(messages);
tui.addChild(editor);
tui.addChild(status);
updateStatus();

function addMessage(component: Text | Markdown | Card): void {
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
  loader.setVerb("思考中", ["Esc 中断"]);
  loader.start();
  let offset = 0;
  streamTimer = setInterval(() => {
    const step = 2 + Math.floor(Math.random() * 6);
    md.append(REPLY.slice(offset, offset + step));
    offset += step;
    loader.setVerb("回复中", [`↓≈${Math.ceil(offset / 4)}`, "Esc 中断"]);
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

function showApproval(): void {
  editor.disableSubmit = true;
  const decide = (decision: string): void => {
    closeOverlay();
    addMessage(new Text(theme.fg("dim", `审批：${decision}`)));
  };
  const options = new SelectList(
    [
      { value: "允许", label: "1. 允许", badge: "y", badgeColor: "dim" },
      { value: "本会话允许同类", label: "2. 本会话允许同类", badge: "a", badgeColor: "dim" },
      { value: "拒绝", label: "3. 拒绝", badge: "n Esc", badgeColor: "dim" },
    ],
    {
      theme,
      footer: "↑↓ 选择 · Enter 确认",
      onSelect: (item) => decide(item.value),
      onCancel: () => decide("拒绝"),
    },
  );
  options.setSelectedIndex(2);
  const body = new Container();
  body.addChild(
    new Text(theme.bold(theme.fg("tool", "bash")) + "  " + theme.fg("error", "危险命令")),
  );
  body.addChild(new Text(theme.fg("code", "$ git push --force origin main")));
  body.addChild(new Spacer());
  body.addChild(options);
  const dialog = Object.assign(body, {
    focused: false,
    handleInput(data: string): void {
      const key = data.toLowerCase();
      if (key === "y" || data === "1") decide("允许");
      else if (key === "a" || data === "2") decide("本会话允许同类");
      else if (key === "n" || data === "3" || matchesKey(data, "escape")) decide("拒绝");
      else options.handleInput(data);
    },
  });
  overlay = tui.showOverlay(new Box(dialog, { title: "危险命令", theme, borderColor: "error" }), {
    anchor: "bottom",
  });
}

function addCard(): void {
  const meter = new Meter(0.34, { theme }).render(30)[0] ?? "";
  const rows = new KeyValue(
    [
      { key: "模型", value: theme.fg("accent", model) + theme.fg("dim", " · ") + "思考 medium" },
      { key: "用量", value: "输入 3.4k · 输出 9.4k · $0.42" },
      { key: "上下文", value: `${meter} · 68k / 200k` },
    ],
    { theme },
  );
  addMessage(new Card(rows, { theme, title: "会话 3f2a9c1e", subtitle: "demo" }));
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
  if (command === "/card") return addCard();
  if (command === "/clear") {
    messages.clear();
    return;
  }
  addMessage(new Text(theme.fg("user", theme.bold(theme.glyphs.prompt)) + " " + text));
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
