/**
 * `ama --mode acp` 的认证门（docs/acp-plan.md §2.2、D3、D4）。[ACP-C0 建 stub，ACP-A 实现]
 *
 * 目标行为：bootstrap 因没有可用模型（退出码 4）失败时不退出，只应答 `initialize`（按客户端的
 * `auth.terminal` 给 terminal 型认证方法），会话方法先重试 bootstrap，成功则把同一条连接交给
 * `AcpServer`，失败回 -32000。
 *
 * C0 的 stub 保持现状：报错并以原退出码退出。
 */

import type { ParsedArgs } from "../../cli/args.js";
import { reportError } from "../../cli/bootstrap.js";
import type { CliIo, RuntimeDeps } from "../../cli/deps.js";

export async function runAcpAuthGate(
  _args: ParsedArgs,
  _deps: RuntimeDeps,
  io: CliIo,
  /** bootstrap 第一次失败的错误（NoModel）。 */
  cause: unknown,
): Promise<number> {
  return reportError(cause, io);
}
