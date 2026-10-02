/**
 * `ama --mode acp` 的进程入口（docs/wave5-plan.md §5.6）。[W5-E]
 *
 * - stdin / stdout 是 ACP（JSON-RPC 2.0 over NDJSON），不发 hello（ACP 由客户端 `initialize` 起头）；
 *   诊断与宿主通知写 stderr。
 * - 审批：挂 {@link AcpServer.broker} 为 UI broker，ama 的审批请求以 `session/request_permission`
 *   交给客户端。
 * - 退出语义同 rpc：stdin 关闭 → 撤下审批、等在途请求与已开始的运行结束 → 退出 0；
 *   SIGINT / SIGTERM → abort 后退出 130 / 143。
 */

import type { ModeContext } from "../../cli/deps.js";
import { ExitCode } from "../../cli/exit-codes.js";
import type { Runtime } from "../../cli/runtime.js";
import { onTerminationSignals } from "../shared.js";
import { AcpServer } from "./acp-server.js";

export interface AcpModeOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

export async function runAcpMode(
  runtime: Runtime,
  context: ModeContext,
  options: AcpModeOptions = {},
): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const server = new AcpServer(runtime, { input: stdin, output: stdout }, (message) =>
    context.io.stderr(`ama: ${message}\n`),
  );
  runtime.approvals.setUiBroker(server.broker);
  runtime.notifier.set((message, level) => context.io.stderr(`ama: [${level}] ${message}\n`));
  return new Promise<number>((resolve) => {
    let finished = false;
    const finish = async (code: number, abort: boolean): Promise<void> => {
      if (finished) return;
      finished = true;
      offSignals();
      (stdin as { pause?: () => void }).pause?.();
      runtime.approvals.setUiBroker(undefined);
      const session = server.session();
      if (abort) await session.abort().catch(() => undefined);
      await session.waitForIdle().catch(() => undefined);
      await server.peer.flush();
      server.peer.close();
      server.dispose();
      runtime.notifier.set(undefined);
      resolve(code);
    };
    void server.peer.closed.then(() => finish(ExitCode.Ok, false));
    const offSignals = onTerminationSignals((code) => {
      if (finished) void server.session().abort();
      else void finish(code, true);
    });
  });
}
