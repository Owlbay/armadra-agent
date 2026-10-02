/**
 * 交互模式单元测试共用的小工具（只被 *.test.ts 引用）。[B7]
 *
 * 帧测试的启动器：真实组装根 + fake 供应商 + MemoryTerminal（`start` / `golden` / `snapshot`），
 * 黄金在 `test/fixtures/tui/`；更新：`AMA_UPDATE_GOLDEN=1 pnpm vitest run src/modes/interactive src/tui`。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strictEqual } from "node:assert/strict";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import type { SessionEvent } from "../../agent/types.js";
import type { AssistantContentBlock, AssistantMessage, Usage } from "../../ai/types.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import { parseArgs } from "../../cli/args.js";
import type { ModeContext } from "../../cli/deps.js";
import type { Runtime } from "../../cli/runtime.js";
import type { ClipboardDeps } from "../../tools/clipboard-image.js";
import { MemoryTerminal, plainTheme, stripAnsi, type Component, type Theme } from "../../tui.js";
import { AMA_VERSION } from "../../version.js";
import { runInteractiveMode, type InteractiveHandle } from "./interactive-mode.js";

export function usage(partial: Partial<Usage> = {}): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...partial };
}

export function assistant(
  content: AssistantContentBlock[],
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "fake",
    provider: "fake",
    model: "echo",
    usage: usage(),
    stopReason: "stop",
    timestamp: 0,
    ...extra,
  };
}

/** 组件按宽度渲染、去样式、去行尾空白。 */
export function lines(component: Component, width = 60): string[] {
  return component.render(width).map((l) => stripAnsi(l).replace(/\s+$/, ""));
}

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "tui",
);

export function golden(name: string, actual: string): void {
  const file = join(FIXTURES, `${name}.txt`);
  if (process.env["AMA_UPDATE_GOLDEN"] === "1" || (!existsSync(file) && !process.env["CI"])) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, actual);
  }
  // 不 import vitest（零依赖守卫只放过 *.test.ts）；node:assert 的差异输出同样逐行
  strictEqual(actual, readFileSync(file, "utf8"));
}

export function snapshot(terminal: MemoryTerminal, label: string): string {
  const { row, col } = terminal.screen.cursor;
  const out = [`# ${label} · viewport ${terminal.columns}x${terminal.rows} cursor=${row},${col}`];
  out.push(...terminal.viewport().map((l) => `|${l}`));
  return (
    out
      .join("\n")
      .replaceAll(AMA_VERSION, "<version>")
      // 会话 id 每次不同（退出摘要、/session 面板）
      .replace(/(会话 |--resume )[0-9A-Za-z_-]{8}/g, "$1<id>") + "\n"
  );
}

/** 当前用例的 harness 与运行时（afterEach 里 `cleanupStarted()`）。 */
export const started: { h: ComposeHarness | undefined; runtime: Runtime | undefined } = {
  h: undefined,
  runtime: undefined,
};

export async function cleanupStarted(): Promise<void> {
  await started.runtime?.dispose();
  started.runtime = undefined;
  started.h?.cleanup();
  started.h = undefined;
}

export interface Started {
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

export async function start(
  script: FakeResponse[],
  options: {
    columns?: number;
    rows?: number;
    argv?: string[];
    files?: Record<string, string>;
    /** 沿用调用方已建好的 harness（先写配置）。 */
    keepHarness?: boolean;
    /** 启动头档位，缺省 header。 */
    quietStartup?: "normal" | "header" | "silent";
    theme?: Theme;
    /** 追加到临时 HOME 环境上的变量。 */
    env?: Record<string, string>;
    /** 底部布局，缺省 compact。 */
    statusLine?: "full" | "compact";
    /** 剪贴板读取的注入（W5-U；缺省不允许调系统命令）。 */
    clipboard?: ClipboardDeps;
  } = {},
): Promise<Started> {
  if (options.keepHarness !== true || started.h === undefined)
    started.h = composeHarness(script, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
  const h = started.h;
  for (const [path, body] of Object.entries(options.files ?? {}))
    h.home.write(`work/${path}`, body);
  const quiet = options.quietStartup ?? "header";
  const argv = ["--model", "fake/echo", "--quiet-startup", quiet, ...(options.argv ?? [])];
  const rt = await h.boot(argv);
  started.runtime = rt;
  const parsed = parseArgs(argv);
  if (parsed.kind !== "run") throw new Error("subcommand");
  const context: ModeContext = { args: parsed.args, prompt: undefined, io: h.io };
  const terminal = new MemoryTerminal({ columns: options.columns ?? 80, rows: options.rows ?? 24 });
  let handle: InteractiveHandle | undefined;
  const done = runInteractiveMode(rt, context, {
    terminal,
    theme: options.theme ?? plainTheme(),
    now: () => 0,
    spinnerIntervalMs: 1e9,
    // 速率行的数值随真实时钟变；既有帧黄金固定单行布局，full 布局见 status-line / interactive-statusline 测试
    statusLine: options.statusLine ?? "compact",
    historyFile: false,
    // 测试从不读真实剪贴板：缺省给一个「没有剪贴板命令」的执行器
    clipboard: options.clipboard ?? {
      run: async () => ({ code: null, stdout: Buffer.alloc(0), stderr: "", missing: true }),
    },
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
