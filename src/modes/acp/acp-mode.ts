/**
 * `ama --mode acp` 的进程入口（docs/wave5-plan.md §5.6）。[W5-E]
 *
 * - stdin / stdout 是 ACP（JSON-RPC 2.0 over NDJSON），不发 hello（ACP 由客户端 `initialize` 起头）；
 *   诊断与宿主通知写 stderr。
 * - 连接（JSON-RPC 对等端 + 协商结果）由 `createAcpConnection` 建，服务端只处理消息。
 * - 审批：挂 {@link AcpServer.broker} 为 UI broker，ama 的审批请求以 `session/request_permission`
 *   交给客户端。
 * - 退出语义同 rpc：stdin 关闭 → 撤下审批、排队的提示回 cancelled、等已开始的运行结束、释放全部
 *   会话（前台会话由 Runtime.dispose 收尾）→ 退出 0；SIGINT / SIGTERM → abort 后退出 130 / 143。
 */

import type { ModeContext } from "../../cli/deps.js";
import { ExitCode } from "../../cli/exit-codes.js";
import type { Runtime } from "../../cli/runtime.js";
import { onTerminationSignals } from "../shared.js";
import { createAcpConnection, type AcpConnection } from "./acp-connection.js";
import { AcpServer, type Params } from "./acp-server.js";
import { RpcError } from "../../drivers/jsonrpc.js";
import { RPC_ERRORS } from "../../drivers/acp/types.js";

export interface AcpModeOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  /**
   * [ACP-A] 认证门交接：沿用门控建好的连接（可能已 `initialize`），不再新建；服务端建好后同步交给
   * `attach`，门控此后把请求与通知都转给它。
   */
  handover?: { connection: AcpConnection; attach(server: AcpServer): void };
}

export async function runAcpMode(
  runtime: Runtime,
  context: ModeContext,
  options: AcpModeOptions = {},
): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const log = (message: string): void => context.io.stderr(`ama: ${message}\n`);
  // 连接先建（handlers 转给服务端）；JsonRpcPeer 的读取是异步的，构造完服务端之前不会有消息到达。
  const target: { server?: AcpServer } = {};
  const connection =
    options.handover?.connection ??
    createAcpConnection({ input: stdin, output: stdout }, log, {
      onRequest: async (method, params, ctx) => {
        if (target.server === undefined) throw new RpcError(RPC_ERRORS.internalError, method);
        return target.server.handle(method, (params ?? {}) as Params, ctx);
      },
      onNotification: (method, params) => target.server?.handleNotification(method, params),
    });
  const server = new AcpServer(runtime, connection, log);
  target.server = server;
  options.handover?.attach(server);
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
      // 全部会话：排队的回 cancelled，等在跑的结束（信号时先 abort），兄弟会话依次 dispose
      await server.dispose(abort);
      await server.peer.flush();
      server.peer.close();
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
