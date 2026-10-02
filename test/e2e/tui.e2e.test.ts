/**
 * 交互模式 e2e（第三波 §2.4）：加载**构建产物** `dist/`（不是 src）在进程内跑交互模式，终端用
 * `MemoryTerminal`；一次完整 run 的帧序列与 B7 的帧黄金 `test/fixtures/tui/run-80x24.txt` 逐字节
 * 相同——说明发布产物与源码测试渲染一致。构建产物缺失时跳过（先 `pnpm build`）。
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";

type ApiModule = typeof import("../../src/ai/apis/api.js");
type FakeModule = typeof import("../../src/ai/fake/fake-provider.js");
type ArgsModule = typeof import("../../src/cli/args.js");
type BootstrapModule = typeof import("../../src/cli/bootstrap.js");
type ComposeModule = typeof import("../../src/cli/compose.js");
type InteractiveModule = typeof import("../../src/modes/interactive/interactive-mode.js");
type TuiModule = typeof import("../../src/tui.js");
type VersionModule = typeof import("../../src/version.js");
type Runtime = import("../../src/cli/runtime.js").Runtime;
type CliIo = import("../../src/cli/deps.js").CliIo;
type SessionEvent = import("../../src/agent/types.js").SessionEvent;
type MemoryTerminal = InstanceType<TuiModule["MemoryTerminal"]>;
type InteractiveHandle =
  import("../../src/modes/interactive/interactive-mode.js").InteractiveHandle;

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const hasDist = existsSync(`${DIST}modes/interactive/interactive-mode.js`);
const GOLDEN = fileURLToPath(new URL("../fixtures/tui/run-80x24.txt", import.meta.url));

/** 变量说明符：typecheck 不要求 dist 存在。 */
function load<T>(path: string): Promise<T> {
  const url = pathToFileURL(`${DIST}${path}`).href;
  return import(url) as Promise<T>;
}

let home: TmpHome | undefined;
let runtime: Runtime | undefined;
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  home?.cleanup();
  home = undefined;
});

describe.skipIf(!hasDist)("e2e：交互模式（dist 构建产物 + MemoryTerminal）", () => {
  it("一次完整 run 的帧序列与 run-80x24 帧黄金一致", async () => {
    const [api, fakeMod, args, boot, compose, interactive, tui, version] = await Promise.all([
      load<ApiModule>("ai/apis/api.js"),
      load<FakeModule>("ai/fake/fake-provider.js"),
      load<ArgsModule>("cli/args.js"),
      load<BootstrapModule>("cli/bootstrap.js"),
      load<ComposeModule>("cli/compose.js"),
      load<InteractiveModule>("modes/interactive/interactive-mode.js"),
      load<TuiModule>("tui.js"),
      load<VersionModule>("version.js"),
    ]);
    home = createTmpHome("ama-tui-e2e-");
    home.write(
      "work/README.md",
      "# Demo\n\nA tiny project.\nIt has three lines of prose.\nAnd one more.\n",
    );
    const fake = new fakeMod.FakeProvider([
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
    ]);
    const apis = api.createDefaultApiRegistry();
    apis.register(fake.api);
    const env = { ...home.env, AMA_NO_LOCAL_PROBE: "1" };
    const io: CliIo = {
      stdout: () => undefined,
      stderr: () => undefined,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env,
      cwd: home.cwd,
      readStdin: async () => "",
    };
    const argv = ["--model", "fake/echo", "--quiet-startup", "header"];
    const parsed = args.parseArgs(argv);
    if (parsed.kind !== "run") throw new Error("subcommand");
    const deps = compose.createRuntimeDeps({ apis, env, probeLocal: false, log: () => undefined });
    const rt = await boot.bootstrap(parsed.args, deps, io);
    runtime = rt;

    const terminal: MemoryTerminal = new tui.MemoryTerminal({ columns: 80, rows: 24 });
    let handle: InteractiveHandle | undefined;
    const done = interactive.runInteractiveMode(
      rt,
      { args: parsed.args, prompt: undefined, io },
      {
        terminal,
        theme: tui.plainTheme(),
        now: () => 0,
        spinnerIntervalMs: 1e9,
        historyFile: false,
        onReady: (x) => (handle = x),
      },
    );
    if (handle === undefined) throw new Error("not ready");
    const ready = handle;
    const frame = (): void => ready.tui.renderNow();
    const until = (pred: (e: SessionEvent) => boolean): Promise<void> =>
      new Promise((resolve) => {
        const off = ready.session().subscribe((event) => {
          if (!pred(event)) return;
          off();
          frame();
          resolve();
        });
      });
    const type = (text: string): void => {
      terminal.sendInput(text);
      frame();
    };
    const snapshot = (label: string): string => {
      const { row, col } = terminal.screen.cursor;
      const out = [
        `# ${label} · viewport ${terminal.columns}x${terminal.rows} cursor=${row},${col}`,
      ];
      out.push(...terminal.viewport().map((l) => `|${l}`));
      return out.join("\n").replaceAll(version.AMA_VERSION, "<version>") + "\n";
    };

    frame();
    const frames = [snapshot("startup")];
    type("读一下 README，说说是什么");
    frames.push(snapshot("typed"));
    const toolStarted = until((e) => e.type === "tool_execution_start");
    terminal.sendInput("\r");
    await toolStarted;
    frames.push(snapshot("tool running"));
    await until((e) => e.type === "agent_settled");
    frames.push(snapshot("settled"));
    type("\x0f");
    frames.push(snapshot("ctrl+o expanded"));
    type("\x04");
    expect(await done).toBe(0);
    frames.push(snapshot("exit"));
    expect(frames.join("\n")).toBe(readFileSync(GOLDEN, "utf8"));
  });
});
