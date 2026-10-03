import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartupInfo } from "../../cli/startup-screen.js";
import { setLocale } from "../../i18n/index.js";
import {
  MemoryTerminal,
  TUI,
  Text,
  createTheme,
  plainTheme,
  stripAnsi,
  type Component,
  type Theme,
} from "../../tui.js";
import { StartupHeader, type StartupHeaderOptions } from "./startup-header.js";
import {
  FRAME_MS,
  LOGO_ASCII,
  LOGO_BLOCK,
  LogoAnimation,
  MIN_ANIMATION_ROWS,
  logoWidth,
  paintLogo,
  playStartupAnimation,
  shouldAnimate,
  sweepFrames,
  type AnimationGate,
} from "./startup-logo.js";
import { cleanupStarted, golden, start } from "./test-support.js";

const INFO: StartupInfo = {
  version: "0.1.0",
  model: "packy/qwen3.8-max@messages",
  thinking: "medium",
  cwd: "~/Projects/Rust/cc-switch-core",
  trusted: true,
  trustSource: "trust.json",
  permissionMode: "default",
  preset: "default",
  codemode: "on",
  contextFiles: [],
  skills: 0,
  prompts: 0,
  hooks: 0,
  warnings: 0,
};

const TRUECOLOR = { colors: 16_777_216 } as const;
const dark = (ascii = false): Theme => createTheme("dark", { caps: TRUECOLOR, ascii });

/** 样式序列换成可读的 `␛`，行尾空白去掉。 */
function visible(lines: readonly string[]): string {
  return lines.map((l) => l.replaceAll("\x1b", "␛").replace(/\s+$/, "")).join("\n") + "\n";
}

function header(theme: Theme, extra: Partial<StartupHeaderOptions> = {}): StartupHeader {
  return new StartupHeader(INFO, { theme, level: "normal", ...extra });
}

describe("字形", () => {
  it("两套字形都是 5 行、宽 ≤ 25，ASCII 版只用 _ / \\ | 与空格", () => {
    expect(LOGO_BLOCK).toHaveLength(5);
    expect(LOGO_ASCII).toHaveLength(5);
    expect(logoWidth(LOGO_BLOCK)).toBe(25);
    expect(logoWidth(LOGO_ASCII)).toBe(24);
    expect(LOGO_ASCII.join("")).toMatch(/^[ _/\\|]+$/);
    expect(LOGO_BLOCK.join("")).toMatch(/^[ █▀▄]+$/);
  });

  it("无色主题原样输出；有色主题定格按字母三段渐变、空格不着色", () => {
    expect(paintLogo(plainTheme())).toEqual(LOGO_BLOCK.map((r) => r.padEnd(25)));
    const out = paintLogo(dark());
    expect(out.map(stripAnsi)).toEqual(LOGO_BLOCK.map((r) => r.padEnd(25)));
    // accent #5fafff、user #87afff、tool #af87ff 各出现在对应字母上
    expect(out[2]).toContain("\x1b[38;2;95;175;255m███████");
    expect(out[2]).toContain("\x1b[38;2;135;175;255m");
    expect(out[2]).toContain("\x1b[38;2;175;135;255m███████");
    expect(out[3]).toMatch(/██\x1b\[39m\x1b\[22m {3}\x1b/);
  });

  it("扫描帧：扫过的列定格色、扫描头 text 粗体、未扫到的列 dim", () => {
    const frame = paintLogo(dark(), 10)[2]!;
    expect(frame).toContain("\x1b[38;2;228;228;228m"); // text
    expect(frame).toContain("\x1b[38;2;108;108;108m"); // dim
    expect(frame.startsWith("\x1b[1m\x1b[38;2;95;175;255m")).toBe(true);
  });
});

describe("启动头黄金", () => {
  afterEach(() => setLocale("zh"));
  for (const locale of ["zh", "en"] as const) {
    it(`${locale}：120 / 80 / 60 / 40 列 × 深色定格、ASCII、NO_COLOR、quiet、logo off`, () => {
      setLocale(locale);
      const variants: [string, () => StartupHeader][] = [
        ["dark", () => header(dark())],
        ["ascii", () => header(dark(true))],
        ["no-color", () => header(plainTheme())],
        ["quiet", () => new StartupHeader(INFO, { theme: plainTheme(), level: "header" })],
        ["logo-off", () => header(plainTheme(), { logo: "off" })],
      ];
      const parts: string[] = [];
      for (const [name, make] of variants) {
        for (const width of [120, 80, 60, 40]) {
          parts.push(`# ${name} ${width}\n` + visible(make().render(width)));
        }
      }
      golden(`startup-logo-${locale}`, parts.join(""));
    });
  }
});

describe("LogoAnimation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function recorder() {
    const sweeps: (number | undefined)[] = [];
    let renders = 0;
    const target = { setSweep: (s: number | undefined) => sweeps.push(s) };
    return { sweeps, target, render: () => renders++, renders: () => renders };
  }

  it("帧序列有限：0..frames-1 后定格，总时长 ≤ 1.2 s，之后不再动", () => {
    const r = recorder();
    const frames = sweepFrames(plainTheme());
    expect(frames * FRAME_MS).toBeLessThanOrEqual(1200);
    const done = vi.fn();
    const anim = new LogoAnimation(r.target, { frames, render: r.render, onDone: done });
    anim.start();
    expect(anim.running).toBe(true);
    vi.advanceTimersByTime(1200);
    expect(r.sweeps).toEqual([...Array.from({ length: frames }, (_, i) => i), undefined]);
    expect(anim.running).toBe(false);
    expect(done).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    anim.start();
    anim.finish();
    expect(r.sweeps).toHaveLength(frames + 1);
  });

  it("finish() 提前定格；canContinue 为 false 时下一帧前定格", () => {
    const r = recorder();
    const anim = new LogoAnimation(r.target, { frames: 28, render: r.render });
    anim.start();
    vi.advanceTimersByTime(FRAME_MS * 2);
    anim.finish();
    expect(r.sweeps).toEqual([0, 1, 2, undefined]);
    expect(vi.getTimerCount()).toBe(0);

    const r2 = recorder();
    let ok = true;
    const anim2 = new LogoAnimation(r2.target, {
      frames: 28,
      render: r2.render,
      canContinue: () => ok,
    });
    anim2.start();
    ok = false;
    vi.advanceTimersByTime(FRAME_MS);
    expect(r2.sweeps).toEqual([0, undefined]);
  });
});

describe("是否播放", () => {
  const base: AnimationGate = {
    animation: undefined,
    hasLogo: true,
    colors: 256,
    io: { stdoutIsTTY: true },
    host: false,
    prompt: undefined,
    env: {},
    rows: 24,
  };

  it("缺省播放；各种条件下不播放", () => {
    expect(shouldAnimate(base)).toBe(true);
    expect(shouldAnimate({ ...base, env: { CI: "" } })).toBe(true);
    expect(shouldAnimate({ ...base, prompt: "  " })).toBe(true);
    const off: Partial<AnimationGate>[] = [
      { animation: false },
      { hasLogo: false }, // ui.logo off / compact / quietStartup / 窄屏
      { colors: 0 }, // NO_COLOR / 无色终端
      { io: { stdoutIsTTY: false } },
      { host: true },
      { prompt: "hi" },
      { env: { CI: "true" } },
      { env: { CI: "1" } },
      { rows: MIN_ANIMATION_ROWS - 1 },
    ];
    for (const change of off) expect(shouldAnimate({ ...base, ...change })).toBe(false);
  });
});

describe("界面里播放", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const gate = { animation: undefined, host: false, prompt: undefined, env: {} };

  function mount(columns: number, rows: number, extra: Component[] = []) {
    const terminal = new MemoryTerminal({ columns, rows });
    const tui = new TUI(terminal);
    const head = header(dark());
    tui.addChild(head);
    for (const c of extra) tui.addChild(c);
    const typed: string[] = [];
    const input: Component = { render: () => [], invalidate: () => undefined };
    input.handleInput = (data: string) => typed.push(data);
    tui.addChild(input);
    tui.start();
    tui.setFocus(input);
    tui.renderNow();
    return { terminal, tui, head, typed };
  }

  it("80×24：动画帧原地改写，回滚区为空，结束于定格帧", () => {
    const { terminal, tui, head } = mount(80, 24);
    const settled = stripAnsi(head.render(80)[0]!);
    const anim = playStartupAnimation(tui, head, dark(), { ...gate, io: { stdoutIsTTY: true } });
    expect(anim?.running).toBe(true);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      tui.renderNow();
      seen.add(terminal.viewport()[2]!);
      vi.advanceTimersByTime(FRAME_MS);
    }
    tui.renderNow();
    expect(anim?.running).toBe(false);
    expect(terminal.screen.scrollback()).toEqual([]);
    expect(terminal.viewport()[0]!.replace(/\s+$/, "")).toBe(settled.replace(/\s+$/, ""));
    expect(head.render(80)).toEqual(header(dark()).render(80));
    tui.stop();
  });

  it("按任意键立即定格，按键照常交给获焦组件", () => {
    const { tui, head, typed } = mount(80, 24);
    const anim = playStartupAnimation(tui, head, dark(), { ...gate, io: { stdoutIsTTY: true } });
    vi.advanceTimersByTime(FRAME_MS * 3);
    tui.handleInput("a");
    expect(anim?.running).toBe(false);
    expect(typed).toEqual(["a"]);
    expect(head.render(80)).toEqual(header(dark()).render(80));
    tui.stop();
  });

  it("内容超出视口、终端太矮、无色或 ui.animation false：不播放，直接定格帧", () => {
    const tall = Array.from({ length: 30 }, (_, i) => new Text(`line ${i}`));
    const cases = [
      { m: mount(80, 24, tall), theme: dark(), animation: undefined },
      { m: mount(80, MIN_ANIMATION_ROWS - 1), theme: dark(), animation: undefined },
      { m: mount(80, 24), theme: plainTheme(), animation: undefined },
      { m: mount(80, 24), theme: dark(), animation: false },
      { m: mount(40, 24), theme: dark(), animation: undefined },
    ];
    for (const { m, theme, animation } of cases) {
      const anim = playStartupAnimation(m.tui, m.head, theme, {
        ...gate,
        animation,
        io: { stdoutIsTTY: true },
      });
      expect(anim).toBeUndefined();
      m.tui.stop();
    }
    expect(
      playStartupAnimation(mount(80, 24).tui, undefined, dark(), {
        ...gate,
        io: { stdoutIsTTY: true },
      }),
    ).toBeUndefined();
  });
});

describe("交互模式", () => {
  afterEach(cleanupStarted);

  it("normal 档播放动画；按键立即定格、字符进输入框，回滚区无残影", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    // 临时 HOME 的环境抄自 process.env：在 CI 上清掉 CI，否则按设计不播放
    const env = { CI: "" };
    const s = await start([], { quietStartup: "normal", theme: dark(), env, columns: 80 });
    const frames = () => timers.mock.calls.filter(([, ms]) => ms === FRAME_MS).length;
    expect(frames()).toBeGreaterThan(0);
    s.type("x");
    const after = frames();
    await new Promise((resolve) => setTimeout(resolve, FRAME_MS * 3));
    s.frame();
    expect(frames()).toBe(after);
    expect(s.handle.editor.getText()).toBe("x");
    expect(s.terminal.screen.scrollback()).toEqual([]);
    expect(s.terminal.viewport()[0]).toMatch(/^ ▄███▄ {2}██▄ {3}▄██ {2}▄███▄ {4}ama /);
    timers.mockRestore();
    s.handle.exit(0);
    await s.done;
  });

  it("header 档、无色主题与 CI 环境不播放", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    for (const options of [
      { quietStartup: "header" as const, theme: dark(), env: { CI: "" } },
      { quietStartup: "normal" as const, theme: plainTheme(), env: { CI: "" } },
      { quietStartup: "normal" as const, theme: dark(), env: { CI: "true" } },
    ]) {
      const s = await start([], options);
      s.handle.exit(0);
      await s.done;
      await cleanupStarted();
    }
    expect(timers.mock.calls.filter(([, ms]) => ms === FRAME_MS)).toEqual([]);
    timers.mockRestore();
  });
});
