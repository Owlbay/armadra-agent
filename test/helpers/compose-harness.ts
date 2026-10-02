/**
 * 组装根测试装配：临时 HOME + 真实 `createRuntimeDeps()` + 进程内 FakeProvider（记录每次请求）。
 * B6 的 compose / 模式 / SDK 测试共用。
 */

import { createDefaultApiRegistry } from "../../src/ai/apis/api.js";
import { FakeProvider } from "../../src/ai/fake/fake-provider.js";
import type { FakeResponse } from "../../src/ai/fake/fake-script.js";
import { parseArgs } from "../../src/cli/args.js";
import { bootstrap, runCli } from "../../src/cli/bootstrap.js";
import { createRuntimeDeps, type ComposeOptions } from "../../src/cli/compose.js";
import type { CliIo, RuntimeDeps } from "../../src/cli/deps.js";
import type { Runtime } from "../../src/cli/runtime.js";
import { createTmpHome, type TmpHome } from "./tmp-home.js";

export interface ComposeHarness {
  home: TmpHome;
  fake: FakeProvider;
  io: CliIo;
  out: string[];
  err: string[];
  /** 本次装配用的 deps（最近一次 boot / run）。 */
  deps(): RuntimeDeps;
  boot(argv: string[], options?: ComposeOptions): Promise<Runtime>;
  run(argv: string[], options?: ComposeOptions): Promise<number>;
  stdout(): string;
  stderr(): string;
  cleanup(): void;
}

export function composeHarness(
  script?: FakeResponse[],
  ioOverrides: Partial<CliIo> = {},
): ComposeHarness {
  const home = createTmpHome("ama-compose-");
  const fake = new FakeProvider(script);
  const out: string[] = [];
  const err: string[] = [];
  const env = { ...home.env, AMA_NO_LOCAL_PROBE: "1" };
  const io: CliIo = {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    env,
    cwd: home.cwd,
    readStdin: async () => "",
    ...ioOverrides,
  };
  let last: RuntimeDeps | undefined;
  const make = (options: ComposeOptions = {}): RuntimeDeps => {
    const apis = createDefaultApiRegistry();
    apis.register(fake.api);
    last = createRuntimeDeps({ apis, env, probeLocal: false, log: () => undefined, ...options });
    return last;
  };
  return {
    home,
    fake,
    io,
    out,
    err,
    deps: () => last ?? make(),
    async boot(argv, options) {
      const parsed = parseArgs(argv);
      if (parsed.kind !== "run") throw new Error("subcommand");
      return bootstrap(parsed.args, make(options), io);
    },
    run: (argv, options) => runCli(argv, make(options), io),
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    cleanup: () => home.cleanup(),
  };
}

/** 记录宿主总线事件的 CJS 适配器（写进临时目录，返回 `--host` 路径与读取函数）。 */
export function recordingHost(
  home: TmpHome,
  key = "__amaHostEvents",
): {
  path: string;
  events(): { name: string; event: unknown }[];
} {
  const names = [
    "session_start",
    "before_agent_start",
    "agent_start",
    "turn_start",
    "turn_end",
    "tool_call",
    "tool_result",
    "agent_end",
    "agent_before_settle",
    "agent_settled",
    "session_compact",
    "model_select",
    "tool_approval_requested",
    "tool_approval_resolved",
    "hook_executed",
    "session_shutdown",
  ];
  const path = home.write(
    `work/host-${key}.cjs`,
    `module.exports = { hostApi: 1, create(api) {
  const log = (globalThis[${JSON.stringify(key)}] = []);
  globalThis[${JSON.stringify(key + "Api")}] = api;
  for (const name of ${JSON.stringify(names)}) api.events.on(name, (event) => { log.push({ name, event }); });
  return { id: "recording" };
} };`,
  );
  return {
    path,
    events: () => ((globalThis as Record<string, unknown>)[key] ?? []) as never,
  };
}
