/**
 * `ama --mode acp` 的认证门（docs/acp-plan.md §2.2、D3、D4）。[ACP-A]
 *
 * bootstrap 因没有可用模型（退出码 4）失败时不退出，改为在同一条 stdio 上应答 ACP：
 * - `initialize` → 正常握手；客户端声明 `clientCapabilities.auth.terminal` 时给两条 terminal 型
 *   认证方法（`ama auth login chatgpt` / `ama auth set`，启动时的 `--auth-file` / profile 的
 *   `authFile` 一并带上，R4），否则 `authMethods: []`。
 * - `authenticate` → -32602（terminal 方法规定不经 authenticate）。
 * - 会话方法 → 距上次失败 ≥ 1 s 则重试整段 bootstrap（并发请求共用同一次重试）：成功则把同一条
 *   连接交给 `runAcpMode`（服务端处理本次与之后的全部请求，客户端不必重新 initialize）；仍无模型
 *   → -32000（message = 无模型引导，`data.authMethods` = 已给方法的 id）；其它启动错误 → -32603。
 * - 其它方法 → -32601；交接前的通知忽略。
 * - stdin 关闭：已交接则走 ACP 模式的退出（0）；否则直接退出 0。SIGINT / SIGTERM → 130 / 143。
 *
 * stdout 由 runCli 在第一次 bootstrap 之前接管（宿主 / Hook 的 console.log 改写到 stderr）。
 */

import { resolve } from "node:path";
import type { ParsedArgs } from "../../cli/args.js";
import { bootstrap } from "../../cli/bootstrap.js";
import type { CliIo, RuntimeDeps } from "../../cli/deps.js";
import { ExitCode } from "../../cli/exit-codes.js";
import type { Runtime } from "../../cli/runtime.js";
import { loadProfile } from "../../config/profile.js";
import { StartupError } from "../../errors.js";
import { RpcError } from "../../drivers/jsonrpc.js";
import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  RPC_ERRORS,
  type AcpAuthMethod,
  type AcpClientCapabilities,
  type AcpInitializeResult,
} from "../../drivers/acp/types.js";
import { formatModelRef } from "../../ai/providers/channels.js";
import { msg } from "../../i18n/index.js";
import { AMA_VERSION } from "../../version.js";
import { onTerminationSignals } from "../shared.js";
import { clientCapabilitiesOf, createAcpConnection } from "./acp-connection.js";
import { runAcpMode } from "./acp-mode.js";
import { ACP_AGENT_CAPABILITIES, type AcpServer, type Params } from "./acp-server.js";

/** 两次 bootstrap 重试的最小间隔。 */
export const AUTH_RETRY_INTERVAL_MS = 1000;

/** 会触发重试的方法（交接后由服务端处理）。 */
const SESSION_METHODS: ReadonlySet<string> = new Set([
  ACP_METHODS.sessionNew,
  ACP_METHODS.sessionLoad,
  ACP_METHODS.sessionResume,
  ACP_METHODS.sessionList,
  ACP_METHODS.sessionClose,
  ACP_METHODS.sessionPrompt,
  ACP_METHODS.sessionSetMode,
  ACP_METHODS.sessionSetConfigOption,
]);

/**
 * terminal 型认证方法（D4）：客户端以启动 Agent 的同一条命令加这些 `args` 在终端里起子进程。
 * `authFile`：启动时的 `--auth-file` 或 profile 的 `authFile`（绝对路径），让登录写到同一个文件。
 */
export function terminalAuthMethods(authFile?: string): AcpAuthMethod[] {
  const m = msg().acp.auth;
  const extra = authFile !== undefined ? ["--auth-file", authFile] : [];
  return [
    {
      type: "terminal",
      id: "chatgpt",
      name: m.chatgptName,
      description: m.chatgptDescription,
      args: ["auth", "login", "chatgpt", ...extra],
    },
    {
      type: "terminal",
      id: "api-key",
      name: m.apiKeyName,
      description: m.apiKeyDescription,
      args: ["auth", "set", ...extra],
    },
  ];
}

/** 登录应写入的 auth 文件：`--auth-file`（相对启动目录）> profile 的 `authFile`；都没有 → 缺省位置。 */
export function gateAuthFile(args: ParsedArgs, cwd: string): string | undefined {
  if (args.authFile !== undefined) return resolve(cwd, args.authFile);
  if (args.profile === undefined) return undefined;
  try {
    return loadProfile(args.profile, cwd).authFile;
  } catch {
    return undefined; // bootstrap 已读过 profile；这里失败只是不带 --auth-file
  }
}

export interface AcpAuthGateOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  /** 重试间隔（测试缩短）；缺省 {@link AUTH_RETRY_INTERVAL_MS}。 */
  retryIntervalMs?: number;
  now?: () => number;
}

function isNoModel(error: unknown): error is StartupError {
  return error instanceof StartupError && error.exitCode === ExitCode.NoModel;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runAcpAuthGate(
  args: ParsedArgs,
  deps: RuntimeDeps,
  io: CliIo,
  /** bootstrap 第一次失败的错误（NoModel）。 */
  cause: unknown,
  options: AcpAuthGateOptions = {},
): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const now = options.now ?? Date.now;
  const interval = options.retryIntervalMs ?? AUTH_RETRY_INTERVAL_MS;
  const log = (message: string): void => io.stderr(`ama: ${message}\n`);
  const authFile = gateAuthFile(args, io.cwd);
  log(msg().acp.auth.waiting(messageOf(cause)));

  let lastError: unknown = cause;
  let lastFailure = now();
  let attempt: Promise<Runtime | undefined> | undefined;
  /** 交接后的服务端（attach 时同步填入）。 */
  const target: { server?: AcpServer } = {};
  const serverOf = (): AcpServer | undefined => target.server;
  let served: Promise<number> | undefined;
  let runtime: Runtime | undefined;

  const offeredMethods = (caps: AcpClientCapabilities): AcpAuthMethod[] =>
    caps.auth?.terminal === true ? terminalAuthMethods(authFile) : [];

  /** 重试 bootstrap（节流；并发请求共用一次）；成功返回 Runtime 并已交接。 */
  const retry = (): Promise<Runtime | undefined> => {
    if (attempt !== undefined) return attempt;
    if (now() - lastFailure < interval) return Promise.resolve(undefined);
    attempt = bootstrap(args, deps, io).then(
      (ready) => {
        handover(ready);
        return ready;
      },
      (error: unknown) => {
        lastError = error;
        lastFailure = now();
        attempt = undefined;
        if (!isNoModel(error)) log(messageOf(error));
        return undefined;
      },
    );
    return attempt;
  };

  const connection = createAcpConnection({ input: stdin, output: stdout }, log, {
    onRequest: async (method, raw, ctx) => {
      const params = (raw ?? {}) as Params;
      if (target.server !== undefined) return target.server.handle(method, params, ctx);
      if (method === ACP_METHODS.initialize) return initialize(params);
      if (method === ACP_METHODS.authenticate)
        throw new RpcError(RPC_ERRORS.invalidParams, msg().acp.auth.notAgentMethod);
      if (!SESSION_METHODS.has(method))
        throw new RpcError(RPC_ERRORS.methodNotFound, `method not found: ${method}`);
      const handed = (await retry()) !== undefined ? serverOf() : undefined;
      if (handed !== undefined) return handed.handle(method, params, ctx);
      if (!isNoModel(lastError)) throw new RpcError(RPC_ERRORS.internalError, messageOf(lastError));
      throw new RpcError(RPC_ERRORS.authRequired, messageOf(lastError), {
        authMethods: offeredMethods(connection.clientCapabilities).map((m) => m.id),
      });
    },
    onNotification: (method, params) => target.server?.handleNotification(method, params),
  });

  function initialize(params: Params): AcpInitializeResult {
    if (typeof params["protocolVersion"] !== "number")
      throw new RpcError(RPC_ERRORS.invalidParams, msg().acp.core.missingProtocolVersion);
    const caps = clientCapabilitiesOf(params);
    connection.markInitialized(caps);
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: ACP_AGENT_CAPABILITIES,
      authMethods: offeredMethods(caps),
      agentInfo: { name: "ama", title: "ama", version: AMA_VERSION },
    };
  }

  // 退出：交接前 stdin 关闭 → 0、信号 → 130 / 143；交接后等 ACP 模式退出
  let settled = false;
  let finish: (code: number) => void = () => undefined;
  const exit = new Promise<number>((done) => (finish = done));
  const offSignals = onTerminationSignals((code) => {
    if (target.server === undefined) {
      settled = true;
      finish(code);
    }
  });
  void connection.peer.closed.then(async () => {
    await attempt; // 收尾中的重试：落定后交接了就交给 ACP 模式退出
    if (served === undefined) {
      settled = true;
      finish(ExitCode.Ok);
    }
  });

  function handover(ready: Runtime): void {
    if (settled) {
      void ready.dispose("exit").catch(() => undefined);
      return;
    }
    runtime = ready;
    offSignals();
    for (const w of ready.warnings) io.stderr(msg().cli.bootstrap.warning(w));
    log(
      msg().acp.auth.ready(formatModelRef({ provider: ready.model.provider, id: ready.model.id })),
    );
    served = runAcpMode(
      ready,
      { args, prompt: undefined, io },
      { stdin, stdout, handover: { connection, attach: (s) => void (target.server = s) } },
    );
    void served.then(finish, () => finish(ExitCode.RuntimeError));
  }

  const code = await exit;
  offSignals();
  if (served === undefined) {
    (stdin as { pause?: () => void }).pause?.();
    await connection.peer.flush();
    connection.peer.close();
  }
  await runtime?.dispose("exit").catch(() => undefined);
  return code;
}
