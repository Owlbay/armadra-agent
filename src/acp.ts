/**
 * `@armadra/agent/acp` 子路径（docs/wave5-plan.md §5.1，D14）。[W5-C0 / W5-E]
 *
 * 供 Armadra 等宿主复用 ama 的 ACP 协议栈（只维护一份）：
 * - 驱动契约（ACP 词汇）与 ACP v1 子集类型；
 * - NDJSON 分帧与 JSON-RPC 对等端；ACP 客户端 `AcpClient` 与驱动 `AcpDriver`；
 * - 假 ACP Agent（进程内 `runFakeAcpAgent`，或 `fakeAcpAgentPath()` 起子进程），用于黄金记录。
 */

import { fileURLToPath } from "node:url";

export type * from "./drivers/types.js";
export type * from "./drivers/acp/types.js"; // AcpToolKind 与驱动契约同一类型
export {
  ACP_META_KEY,
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  RPC_ERRORS,
} from "./drivers/acp/types.js";
export {
  WRITE_CHUNK_BYTES,
  createLineReader,
  writeChunked,
  type LineReader,
} from "./modes/rpc/jsonl.js";
export {
  JsonRpcPeer,
  RpcError,
  type IncomingRequestContext,
  type JsonRpcPeerOptions,
  type RpcId,
} from "./drivers/jsonrpc.js";
export {
  AcpClient,
  unattendedOutcome,
  type AcpClientHandlers,
  type AcpClientOptions,
} from "./drivers/acp/client.js";
export { AcpDriver } from "./drivers/acp/driver.js";
export { runFakeAcpAgent, type FakeAcpAgentOptions } from "./drivers/acp/testing/fake-agent.js";

/** 假 ACP Agent 的可执行入口（`node <path> [--minimal] [--config-options] [--config-only] [--auth-required]`）；只在已编译的包里存在。 */
export function fakeAcpAgentPath(): string {
  return fileURLToPath(new URL("./drivers/acp/testing/fake-agent-main.js", import.meta.url));
}
