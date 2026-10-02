/**
 * JSON-RPC 2.0 over NDJSON 的对等端（docs/wave5-plan.md §5.1）。[W5-E]
 *
 * ACP 客户端 / 服务端与 Codex app-server 驱动共用：
 * - 分帧复用 `modes/rpc/jsonl.ts`（只按 `\n` 切行、64 KiB 分片写、背压等 drain），写入串行；
 * - 双向：本端可发请求 / 通知，也处理对端的请求（`onRequest` 抛 {@link RpcError} 即回错误）与通知；
 * - `jsonrpcField: false` 时不写 `"jsonrpc":"2.0"`（Codex app-server 的线上形状），读取两种都认；
 * - 连接关闭（输入流结束）时所有挂起的请求以 `connection_closed` 失败。
 */

import { createLineReader, writeChunked, type LineReader } from "../modes/rpc/jsonl.js";
import { RPC_ERRORS } from "./acp/types.js";

export type RpcId = string | number;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface IncomingRequestContext {
  readonly id: RpcId;
  /** 连接关闭时 abort。 */
  readonly signal: AbortSignal;
}

export interface JsonRpcPeerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** 缺省 true。 */
  jsonrpcField?: boolean;
  onRequest?(method: string, params: unknown, ctx: IncomingRequestContext): Promise<unknown>;
  onNotification?(method: string, params: unknown): void;
  /** 输入流结束（对端退出或关管道）。 */
  onClose?(): void;
  /** 无法解析的行（不影响连接）。 */
  onProtocolError?(line: string, reason: string): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  method: string;
}

type Message = {
  jsonrpc?: string;
  id?: RpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export class JsonRpcPeer {
  private readonly pending = new Map<RpcId, Pending>();
  private readonly reader: LineReader;
  private readonly lifetime = new AbortController();
  private nextId = 1;
  private writing: Promise<void> = Promise.resolve();
  private isClosed = false;
  private resolveClosed!: () => void;
  /** 输入流结束或 `close()` 后 resolve。 */
  readonly closed: Promise<void> = new Promise((resolve) => (this.resolveClosed = resolve));

  constructor(private readonly options: JsonRpcPeerOptions) {
    // 对端先退出时写入会 EPIPE / write after end：交给 closed 处理，不变成未捕获异常
    options.output.on("error", () => undefined);
    this.reader = createLineReader(
      options.input,
      (line) => this.onLine(line),
      () => this.shutdown(),
    );
  }

  get isOpen(): boolean {
    return !this.isClosed;
  }

  /** 发请求；`signal` abort 时本端不再等（不通知对端，协议级取消由调用方另发）。 */
  request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.isClosed) return Promise.reject(closedError(method));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(id);
        reject(new RpcError(RPC_ERRORS.internalError, `${method}: aborted`));
      };
      if (signal?.aborted === true) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      void this.send({ id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (this.isClosed) return Promise.resolve();
    return this.send({ method, ...(params !== undefined ? { params } : {}) });
  }

  /** 停止读取并让挂起请求失败；不关闭底层流（由调用方决定）。 */
  close(): void {
    this.reader.close();
    this.shutdown();
  }

  /** 等所有已排队的写入完成。 */
  flush(): Promise<void> {
    return this.writing;
  }

  private shutdown(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.lifetime.abort();
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      pending.reject(closedError(pending.method));
    }
    this.options.onClose?.();
    this.resolveClosed();
  }

  private send(message: Record<string, unknown>): Promise<void> {
    const body = this.options.jsonrpcField === false ? message : { jsonrpc: "2.0", ...message };
    const line = `${JSON.stringify(body)}\n`;
    const output = this.options.output as NodeJS.WritableStream & {
      writableEnded?: boolean;
      destroyed?: boolean;
    };
    this.writing = this.writing
      .then(() =>
        output.writableEnded === true || output.destroyed === true
          ? undefined
          : writeChunked(output, line),
      )
      .catch(() => undefined);
    return this.writing;
  }

  private onLine(line: string): void {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      this.options.onProtocolError?.(line, "invalid JSON");
      return;
    }
    if (typeof message !== "object" || message === null) {
      this.options.onProtocolError?.(line, "not an object");
      return;
    }
    if (typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) {
        void this.handleRequest(message.id, message.method, message.params);
      } else {
        try {
          this.options.onNotification?.(message.method, message.params);
        } catch (error) {
          this.options.onProtocolError?.(line, `notification handler: ${String(error)}`);
        }
      }
      return;
    }
    if (message.id === undefined || message.id === null) {
      this.options.onProtocolError?.(line, "response without id");
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      const err = message.error;
      pending.reject(
        new RpcError(
          typeof err.code === "number" ? err.code : RPC_ERRORS.internalError,
          typeof err.message === "string" ? err.message : "error",
          err.data,
        ),
      );
    } else {
      pending.resolve(message.result ?? null);
    }
  }

  private async handleRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    const handler = this.options.onRequest;
    if (handler === undefined) {
      await this.send({
        id,
        error: { code: RPC_ERRORS.methodNotFound, message: `method not found: ${method}` },
      });
      return;
    }
    try {
      const result = await handler(method, params, { id, signal: this.lifetime.signal });
      await this.send({ id, result: result ?? null });
    } catch (error) {
      const rpc =
        error instanceof RpcError
          ? error
          : new RpcError(
              RPC_ERRORS.internalError,
              error instanceof Error ? error.message : String(error),
            );
      await this.send({
        id,
        error: {
          code: rpc.code,
          message: rpc.message,
          ...(rpc.data !== undefined ? { data: rpc.data } : {}),
        },
      });
    }
  }
}

function closedError(method: string): RpcError {
  return new RpcError(RPC_ERRORS.internalError, `${method}: connection closed`, {
    reason: "connection_closed",
  });
}
