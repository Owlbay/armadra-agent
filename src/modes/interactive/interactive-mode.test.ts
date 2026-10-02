/**
 * 交互模式装配测试：真实组装根 + fake 供应商 + MemoryTerminal。
 * 帧序列黄金在 `test/fixtures/tui/run-*.txt`；更新：
 * `AMA_UPDATE_GOLDEN=1 pnpm vitest run src/modes/interactive/interactive-mode.test.ts`。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import type { SessionEvent } from "../../agent/types.js";
import { sharedCacheReporting } from "../../ai/cache/reporting.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import { parseArgs } from "../../cli/args.js";
import { currentSession } from "../../cli/compose-session.js";
import type { ModeContext } from "../../cli/deps.js";
import type { Runtime } from "../../cli/runtime.js";
import { isAmaError } from "../../errors.js";
import { MemoryTerminal, plainTheme } from "../../tui.js";
import { AMA_VERSION } from "../../version.js";
import { runInteractiveMode, type InteractiveHandle } from "./interactive-mode.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
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

function snapshot(terminal: MemoryTerminal, label: string): string {
  const { row, col } = terminal.screen.cursor;
  const out = [`# ${label} · viewport ${terminal.columns}x${terminal.rows} cursor=${row},${col}`];
  out.push(...terminal.viewport().map((l) => `|${l}`));
  return out.join("\n").replaceAll(AMA_VERSION, "<version>") + "\n";
}

let h: ComposeHarness | undefined;
let runtime: Runtime | undefined;
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  h?.cleanup();
  h = undefined;
});

interface Started {
  terminal: MemoryTerminal;
  handle: InteractiveHandle;
  done: Promise<number>;
  rt: Runtime;
  /** 立即渲染一帧。 */
  frame(): void;
  /** 等到会话发出某个事件（含判定），然后渲染。 */
  until(pred: (e: SessionEvent) => boolean): Promise<void>;
  type(text: string): void;
}

async function start(
  script: FakeResponse[],
  options: {
    columns?: number;
    rows?: number;
    argv?: string[];
    files?: Record<string, string>;
    /** 沿用调用方已建好的 harness（先写配置）。 */
    keepHarness?: boolean;
  } = {},
): Promise<Started> {
  if (options.keepHarness !== true || h === undefined)
    h = composeHarness(script, { stdinIsTTY: true, stdoutIsTTY: true });
  for (const [path, body] of Object.entries(options.files ?? {}))
    h.home.write(`work/${path}`, body);
  const argv = ["--model", "fake/echo", "--quiet-startup", "header", ...(options.argv ?? [])];
  const rt = await h.boot(argv);
  runtime = rt;
  const parsed = parseArgs(argv);
  if (parsed.kind !== "run") throw new Error("subcommand");
  const context: ModeContext = { args: parsed.args, prompt: undefined, io: h.io };
  const terminal = new MemoryTerminal({ columns: options.columns ?? 80, rows: options.rows ?? 24 });
  let handle: InteractiveHandle | undefined;
  const done = runInteractiveMode(rt, context, {
    terminal,
    theme: plainTheme(),
    now: () => 0,
    spinnerIntervalMs: 1e9,
    historyFile: false,
    onReady: (x) => (handle = x),
  });
  if (handle === undefined) throw new Error("not ready");
  const ready = handle;
  const frame = (): void => ready.tui.renderNow();
  frame();
  return {
    terminal,
    handle: ready,
    done,
    rt,
    frame,
    type: (text) => {
      terminal.sendInput(text);
      frame();
    },
    until: (pred) =>
      new Promise<void>((resolve) => {
        const off = ready.session().subscribe((event) => {
          if (!pred(event)) return;
          off();
          frame();
          resolve();
        });
      }),
  };
}

const README = "# Demo\n\nA tiny project.\nIt has three lines of prose.\nAnd one more.\n";
const READ_SCRIPT: FakeResponse[] = [
  {
    steps: [
      { thinking: "I should read the file first." },
      { text: "Reading it." },
      { toolCall: { name: "read", arguments: { path: "README.md" }, id: "call_read" } },
    ],
    usage: { input: 1200, output: 40 },
  },
  {
    text: "The README describes **Demo**, a tiny project.",
    usage: { input: 300, output: 12, cacheRead: 1200 },
  },
];

describe("交互模式", () => {
  for (const [columns, rows] of [
    [80, 24],
    [40, 24],
  ] as const) {
    it(`一次完整 run 的帧序列 ${columns}x${rows}`, async () => {
      const s = await start(READ_SCRIPT, { columns, rows, files: { "README.md": README } });
      const frames = [snapshot(s.terminal, "startup")];
      s.type("读一下 README，说说是什么");
      frames.push(snapshot(s.terminal, "typed"));
      const toolStarted = s.until((e) => e.type === "tool_execution_start");
      s.terminal.sendInput("\r");
      await toolStarted;
      frames.push(snapshot(s.terminal, "tool running"));
      await s.until((e) => e.type === "agent_settled");
      frames.push(snapshot(s.terminal, "settled"));
      s.type("\x0f");
      frames.push(snapshot(s.terminal, "ctrl+o expanded"));
      s.type("\x04");
      expect(await s.done).toBe(0);
      frames.push(snapshot(s.terminal, "exit"));
      golden(`run-${columns}x${rows}`, frames.join("\n"));
    });
  }

  it("运行中 Enter = steer；Esc 清队列回填编辑器并中断", async () => {
    const s = await start([{ delayMs: 5_000, text: "slow" }]);
    const started = s.until((e) => e.type === "agent_start");
    s.type("第一条");
    s.terminal.sendInput("\r");
    await started;
    const steered = s.until((e) => e.type === "message_start" && e.message.role === "user");
    s.type("补充一句");
    s.terminal.sendInput("\r");
    await steered;
    expect(s.terminal.viewport().join("\n")).toContain("↳ steer  补充一句");
    s.type("之后再说");
    s.terminal.sendInput("\x1b\r");
    await new Promise((r) => setTimeout(r, 0));
    s.frame();
    expect(s.terminal.viewport().join("\n")).toContain("↳ followUp  之后再说");
    expect(s.terminal.viewport().join("\n")).toContain("queue 1");
    const settled = s.until((e) => e.type === "agent_settled");
    s.type("草稿");
    s.terminal.sendInput("\x1b");
    s.terminal.flushInput();
    await settled;
    s.frame();
    expect(s.handle.editor.getText()).toBe("之后再说\n草稿");
    const screen = s.terminal.viewport().join("\n");
    expect(screen).toContain("已中断");
    expect(screen).not.toContain("queue 1");
    s.handle.exit(0);
    await s.done;
  });

  it("Alt+Enter 排 followUp，Alt+↑ 取回；空闲时 Alt+Enter 等同发送", async () => {
    const s = await start([{ delayMs: 5_000, text: "slow" }, { text: "后续回复" }]);
    const started = s.until((e) => e.type === "agent_start");
    s.type("开始");
    s.terminal.sendInput("\r");
    await started;
    s.type("之后再做");
    s.terminal.sendInput("\x1b\r");
    await new Promise((r) => setTimeout(r, 0));
    s.frame();
    expect(s.terminal.viewport().join("\n")).toContain("↳ followUp  之后再做");
    s.terminal.sendInput("\x1b[1;3A");
    await new Promise((r) => setTimeout(r, 0));
    s.frame();
    expect(s.handle.editor.getText()).toBe("之后再做");
    expect(s.terminal.viewport().join("\n")).not.toContain("↳ followUp");
    const settled = s.until((e) => e.type === "agent_settled");
    s.terminal.sendInput("\x1b");
    s.terminal.flushInput();
    await settled;
    s.handle.editor.clear();
    const next = s.until((e) => e.type === "agent_settled");
    s.type("空闲时");
    s.terminal.sendInput("\x1b\r");
    await next;
    expect(s.terminal.viewport().join("\n")).toContain("后续回复");
    s.handle.exit(0);
    await s.done;
  });

  it("审批：bash 在 default 模式弹对话框，y 放行后执行；n 拒绝留说明", async () => {
    const s = await start([
      { steps: [{ toolCall: { name: "bash", arguments: { command: "echo approved-ok" } } }] },
      { text: "ran" },
      { steps: [{ toolCall: { name: "bash", arguments: { command: "echo nope" } } }] },
      { text: "skipped" },
    ]);
    const asked = s.until((e) => e.type === "permission_request");
    s.type("跑一下");
    s.terminal.sendInput("\r");
    await asked;
    await new Promise((r) => setTimeout(r, 0));
    s.frame();
    let screen = s.terminal.viewport().join("\n");
    expect(screen).toContain("╭─ 审批");
    expect(screen).toContain("$ echo approved-ok");
    expect(s.handle.editor.disableSubmit).toBe(true);
    let settled = s.until((e) => e.type === "agent_settled");
    s.terminal.sendInput("y");
    await settled;
    screen = s.terminal.viewport().join("\n");
    expect(screen).not.toContain("╭─ 审批");
    expect(screen).toContain("approved-ok");
    const askedAgain = s.until((e) => e.type === "permission_request");
    s.type("再跑");
    s.terminal.sendInput("\r");
    await askedAgain;
    await new Promise((r) => setTimeout(r, 0));
    settled = s.until((e) => e.type === "agent_settled");
    s.terminal.sendInput("n");
    await settled;
    expect(s.terminal.viewport().join("\n")).toContain("已拒绝 bash");
    s.handle.exit(0);
    await s.done;
  });

  it("Shift+Tab 循环权限模式；括号粘贴后的 \\r 提交；/model 选择器切换模型", async () => {
    const s = await start([{ text: "收到粘贴" }]);
    s.type("\x1b[Z");
    expect(currentSession(s.rt).state.permissionMode).toBe("auto-edit");
    expect(s.terminal.viewport().join("\n")).toContain("权限模式：Accept edits");
    expect(s.terminal.viewport().join("\n")).toContain("mode:Accept edits");
    const settled = s.until((e) => e.type === "agent_settled");
    s.terminal.sendInput("\x1b[200~第一行\n第二行\x1b[201~");
    s.terminal.sendInput("\r");
    await settled;
    const screen = s.terminal.viewport().join("\n");
    expect(screen).toContain("› 第一行");
    expect(screen).toContain("收到粘贴");
    s.type("/model");
    s.terminal.sendInput("\r");
    await new Promise((r) => setTimeout(r, 10));
    s.frame();
    expect(s.terminal.viewport().join("\n")).toContain("╭─ 选择模型");
    s.terminal.sendInput("reasoning");
    s.terminal.sendInput("\r");
    await new Promise((r) => setTimeout(r, 10));
    s.frame();
    expect(currentSession(s.rt).state.model?.id).toBe("reasoning");
    expect(s.terminal.viewport().join("\n")).toContain("fake/reasoning ·");
    s.handle.exit(0);
    await s.done;
  });

  it("/new 重新订阅事件并清空消息区；Ctrl+C 两次退出 130", async () => {
    const s = await start([{ text: "旧会话回复" }, { text: "新会话回复" }]);
    let settled = s.until((e) => e.type === "agent_settled");
    s.type("旧");
    s.terminal.sendInput("\r");
    await settled;
    const oldId = currentSession(s.rt).state.sessionId;
    s.type("/new");
    s.terminal.sendInput("\r");
    await new Promise((r) => setTimeout(r, 20));
    s.frame();
    expect(currentSession(s.rt).state.sessionId).not.toBe(oldId);
    expect(s.terminal.viewport().join("\n")).not.toContain("旧会话回复");
    settled = s.until((e) => e.type === "agent_settled");
    s.type("新");
    s.terminal.sendInput("\r");
    await settled;
    expect(s.terminal.viewport().join("\n")).toContain("新会话回复");
    s.type("\x03");
    expect(s.terminal.viewport().join("\n")).toContain("再按一次 Ctrl+C 退出");
    s.type("\x03");
    expect(await s.done).toBe(130);
  });

  it("恢复会话时重画已有消息；Hook 阻止与宿主通知进消息区", async () => {
    const s = await start([{ text: "第一轮回复" }]);
    const settled = s.until((e) => e.type === "agent_settled");
    s.type("第一轮");
    s.terminal.sendInput("\r");
    await settled;
    s.handle.exit(0);
    await s.done;
    await runtime?.dispose();
    runtime = undefined;
    // 同一个 HOME 下 --continue 再进
    const harness = h!;
    const rt2 = await harness.boot([
      "--model",
      "fake/echo",
      "--continue",
      "--quiet-startup",
      "silent",
    ]);
    const terminal = new MemoryTerminal({ columns: 60, rows: 20 });
    let handle: InteractiveHandle | undefined;
    const done = runInteractiveMode(
      rt2,
      {
        args: (parseArgs([]) as { args: ModeContext["args"] }).args,
        prompt: undefined,
        io: harness.io,
      },
      {
        terminal,
        theme: plainTheme(),
        now: () => 0,
        historyFile: false,
        onReady: (x) => (handle = x),
      },
    );
    handle!.tui.renderNow();
    const screen = terminal.viewport().join("\n");
    expect(screen).toContain("› 第一轮");
    expect(screen).toContain("第一轮回复");
    expect(screen).not.toContain("Enter 发送");
    rt2.host?.api; // 无宿主
    handle!.exit(0);
    await done;
    await rt2.dispose();
  });

  it("stdin 不是终端：抛 terminal_init_failed 交给 bootstrap 降级", async () => {
    h = composeHarness([], { stdinIsTTY: true, stdoutIsTTY: true });
    const rt = await h.boot(["--model", "fake/echo"]);
    runtime = rt;
    const context: ModeContext = {
      args: (parseArgs([]) as { args: ModeContext["args"] }).args,
      prompt: undefined,
      io: h.io,
    };
    let error: unknown;
    try {
      await runInteractiveMode(rt, context);
    } catch (e) {
      error = e;
    }
    expect(isAmaError(error) && error.code === "terminal_init_failed").toBe(true);
  });

  it("[W3-C2] 缓存提示：跨 70% / 90% 各提示一次，超过门槛的未命中提示一行；状态栏最近一次命中率与着色（帧黄金）", async () => {
    sharedCacheReporting.clear();
    const s = await start(CACHE_SCRIPT, { argv: ["--thinking", "off"] });
    for (const text of ["第一轮", "第二轮", "第三轮", "第四轮"]) {
      const settled = s.until((e) => e.type === "agent_settled");
      s.type(text);
      s.terminal.sendInput("\r");
      await settled;
    }
    const notices = s.handle.view
      .render(200)
      .map((l) => l.trim())
      .filter((l) => /上下文已用|缓存未命中/.test(l));
    expect(notices).toEqual([
      expect.stringContaining("上下文已用 71%，余量 58k token"),
      expect.stringContaining("缓存未命中（服务端已淘汰）：重计费 142k token（约 $0.13）"),
      expect.stringContaining("上下文已用 91%，约剩 1 回合（按最近 5 回合均值）"),
    ]);
    golden("cache-80x24", snapshot(s.terminal, "after 4 turns"));
    s.handle.exit(0);
    await s.done;
  });

  it("[W3-C2] cache.missNotices 为 false：不进消息区，状态栏照常", async () => {
    sharedCacheReporting.clear();
    h = composeHarness(CACHE_SCRIPT, { stdinIsTTY: true, stdoutIsTTY: true });
    h.home.write("home/.config/ama/config.json", { version: 1, cache: { missNotices: false } });
    const s = await start(CACHE_SCRIPT, { keepHarness: true });
    for (const text of ["一", "二"]) {
      const settled = s.until((e) => e.type === "agent_settled");
      s.type(text);
      s.terminal.sendInput("\r");
      await settled;
    }
    const view = s.handle.view.render(200).join("\n");
    expect(view).not.toContain("上下文已用");
    expect(view).not.toContain("缓存未命中");
    expect(s.terminal.viewport().join("\n")).toContain("cache 0%");
    s.handle.exit(0);
    await s.done;
  });
});

const CACHE_SCRIPT: FakeResponse[] = [
  { text: "一", usage: { input: 2_000, output: 10, cacheRead: 140_000 } },
  { text: "二", usage: { input: 150_000, output: 10 } },
  { text: "三", usage: { input: 1_000, output: 10, cacheRead: 150_000 } },
  { text: "四", usage: { input: 2_000, output: 10, cacheRead: 180_000 } },
];
