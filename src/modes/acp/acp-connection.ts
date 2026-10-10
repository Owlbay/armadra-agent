/**
 * `ama --mode acp` 的连接：JSON-RPC 对等端 + `initialize` 协商结果（docs/history/acp-plan.md §1.6）。[ACP-C0]
 *
 * 认证门（无模型时的握手，acp-auth-gate.ts）与服务端（acp-server.ts）共用同一条连接：门控在
 * bootstrap 成功后把它交给 `AcpServer`，客户端不必重新 `initialize`。对等端开着协议级取消
 * （`$/cancel_request`）：本端撤回挂起的请求会通知客户端，客户端撤回的请求 abort `ctx.signal`。
 */

import {
  JsonRpcPeer,
  type IncomingRequestContext,
  type JsonRpcPeerOptions,
} from "../../drivers/jsonrpc.js";
import type { AcpClientCapabilities } from "../../drivers/acp/types.js";
import { msg } from "../../i18n/index.js";

export interface AcpConnectionHandlers {
  onRequest(method: string, params: unknown, ctx: IncomingRequestContext): Promise<unknown>;
  onNotification(method: string, params: unknown): void;
}

export interface AcpConnection {
  /** `cancelRequests: true`。 */
  readonly peer: JsonRpcPeer;
  /** 客户端在 `initialize` 里声明的能力；之前为空对象。 */
  clientCapabilities: AcpClientCapabilities;
  /** 已处理过 `initialize`。 */
  readonly initialized: boolean;
  /** 记录 `initialize` 的协商结果（门控与服务端谁先处理谁记）。 */
  markInitialized(capabilities: AcpClientCapabilities): void;
}

export function createAcpConnection(
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
  log: (message: string) => void,
  handlers: AcpConnectionHandlers,
): AcpConnection {
  let initialized = false;
  const options: JsonRpcPeerOptions = {
    input: streams.input,
    output: streams.output,
    cancelRequests: true,
    onRequest: (method, params, ctx) => handlers.onRequest(method, params, ctx),
    onNotification: (method, params) => handlers.onNotification(method, params),
    onProtocolError: (_line, reason) => log(msg().acp.core.unparsable(reason)),
  };
  const connection: AcpConnection = {
    peer: new JsonRpcPeer(options),
    clientCapabilities: {},
    get initialized() {
      return initialized;
    },
    markInitialized(capabilities) {
      connection.clientCapabilities = capabilities;
      initialized = true;
    },
  };
  return connection;
}

/** `initialize` 参数里的客户端能力（缺省或不是对象 → 空对象；不校验子字段）。 */
export function clientCapabilitiesOf(params: Record<string, unknown>): AcpClientCapabilities {
  const value = params["clientCapabilities"];
  return value !== null && typeof value === "object" ? (value as AcpClientCapabilities) : {};
}
