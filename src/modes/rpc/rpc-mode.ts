/**
 * RPC 模式（`ama --mode rpc`，设计 §13.2）：stdin 读命令、stdout 写响应与事件，每行一个 JSON。[B6]
 *
 * - 启动先发 `hello{protocolVersion, agent, version, capabilities}`，再发当前会话的 session_start。
 * - 命令并发处理（prompt 不阻塞后续命令），响应带回请求的 `id`；解析失败 → `command: "parse"`。
 * - 审批：客户端 `set_client_capabilities{capabilities:["approvals"]}` 之后才挂 UI broker；
 *   之前的 ask 无人作答 → deny。`permission_request` 带 `timeoutMs`，超时由会话 deny 并发
 *   `permission_resolved`。
 * - 宿主 `ui.notify` → `{type:"notification", level, message}` 一行（stderr 同时一份）。
 * - stdin 关闭：撤下审批（之后的 ask 无人作答 → deny）、等在途命令与已开始的运行结束、
 *   应答写完 → 退出 0（会话由 runCli dispose）。`printf '{…prompt…}' | ama --mode rpc` 因此能拿到
 *   完整回复；要中断先发 `abort`。SIGINT / SIGTERM：abort 后有序退出，退出码 130 / 143。
 */

import type { AgentSession } from "../../agent/types.js";
import { AgentSessionImpl } from "../../agent/session.js";
import { currentSession } from "../../cli/compose-session.js";
import type { ModeContext } from "../../cli/deps.js";
import { ExitCode } from "../../cli/exit-codes.js";
import type { Runtime } from "../../cli/runtime.js";
import { isAmaError } from "../../errors.js";
import { RPC_PROTOCOL_VERSION, type RpcCommandType, type RpcHello } from "../../rpc.js";
import { AMA_VERSION } from "../../version.js";
import { toJsonLine, toWireEvent } from "../print/json-event.js";
import { errorText, onTerminationSignals } from "../shared.js";
import { sessionAgents, taskRegistryView } from "../../agent/subagent-registry.js";
import { cachedAgentInfos } from "../../agents/external.js";
import { RpcApprovals, handlers, type RpcContext } from "./commands.js";
import { createLineReader, writeChunked } from "./jsonl.js";

export interface RpcModeOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

export const RPC_CAPABILITIES: RpcHello["capabilities"] = ["approvals", "images", "hooks"];

type Command = { id?: unknown; type?: unknown } & Record<string, unknown>;

export async function runRpcMode(
  runtime: Runtime,
  context: ModeContext,
  options: RpcModeOptions = {},
): Promise<number> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  let writing: Promise<void> = Promise.resolve();
  const write = (value: unknown): Promise<void> => {
    const line = `${toJsonLine(value)}\n`;
    writing = writing.then(() => writeChunked(stdout, line)).catch(() => undefined);
    return writing;
  };
  const subscribe = (s: AgentSession): (() => void) =>
    s.subscribe((event) => void write(toWireEvent(event)));
  let session = currentSession(runtime);
  let unsubscribe = subscribe(session);
  const approvals = new RpcApprovals();
  const ctx: RpcContext = {
    runtime,
    session: () => session,
    capabilities: new Set(),
    approvals,
    onSessionChanged(next) {
      unsubscribe();
      session = next;
      unsubscribe = subscribe(next);
    },
    onBackgroundError(error) {
      void write({ type: "notification", level: "error", message: errorText(error) });
    },
    // [W5-G] get_tasks / get_agents：当前会话的任务注册表与可用类型
    tasks: () => taskRegistryView(session.state.sessionId),
    // [W5-EG] 外部 Agent 的安装 / 版本要异步探测：会话建立时缓存、变化时刷新，未就绪时只列类型目录
    agents: () =>
      cachedAgentInfos(session.state.sessionId) ?? sessionAgents(session.state.sessionId),
  };
  runtime.notifier.set((message, level) => {
    void write({ type: "notification", level, message });
    context.io.stderr(`ama: [${level}] ${message}\n`);
  });
  const hello: RpcHello = {
    type: "hello",
    protocolVersion: RPC_PROTOCOL_VERSION,
    agent: "ama",
    version: AMA_VERSION,
    capabilities: [...RPC_CAPABILITIES],
  };
  void write(hello);
  if (session instanceof AgentSessionImpl) session.announceStart("startup");

  const respond = async (command: Command): Promise<void> => {
    const id = typeof command.id === "string" ? { id: command.id } : {};
    const type = command.type as RpcCommandType;
    const handler = (handlers as Record<string, (p: unknown, c: RpcContext) => Promise<unknown>>)[
      type
    ];
    if (handler === undefined) {
      await write({
        ...id,
        type: "response",
        command: type,
        success: false,
        error: `未知命令：${String(type)}`,
        code: "invalid_arguments",
      });
      return;
    }
    try {
      const data = await handler(command, ctx);
      await write({
        ...id,
        type: "response",
        command: type,
        success: true,
        ...(data !== undefined ? { data } : {}),
      });
    } catch (error) {
      await write({
        ...id,
        type: "response",
        command: type,
        success: false,
        error: errorText(error),
        ...(isAmaError(error) ? { code: error.code } : {}),
      });
    }
  };

  const inflight = new Set<Promise<void>>();
  const onLine = (line: string): void => {
    let command: Command;
    try {
      command = JSON.parse(line) as Command;
    } catch (error) {
      void write({
        type: "response",
        command: "parse",
        success: false,
        error: `JSON 解析失败：${errorText(error)}`,
      });
      return;
    }
    if (typeof command !== "object" || command === null || typeof command.type !== "string") {
      void write({ type: "response", command: "parse", success: false, error: "缺少 type" });
      return;
    }
    const task = respond(command).finally(() => inflight.delete(task));
    inflight.add(task);
  };

  return new Promise<number>((resolve) => {
    let finished = false;
    const finish = async (code: number, abort: boolean): Promise<void> => {
      if (finished) return;
      finished = true;
      reader.close();
      offSignals();
      (stdin as { pause?: () => void }).pause?.();
      runtime.approvals.setUiBroker(undefined);
      approvals.cancelAll();
      if (abort) await session.abort().catch(() => undefined);
      await Promise.allSettled([...inflight]);
      await session.waitForIdle().catch(() => undefined);
      unsubscribe();
      runtime.notifier.set(undefined);
      await writing;
      resolve(code);
    };
    // stdin 结束：不再有新命令，也没人能回答审批；已开始的运行跑完再退出（要中断先发 abort 或发信号）。
    const reader = createLineReader(stdin, onLine, () => void finish(ExitCode.Ok, false));
    const offSignals = onTerminationSignals((code) => {
      if (finished) void session.abort();
      else void finish(code, true);
    });
  });
}
