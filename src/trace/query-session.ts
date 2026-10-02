/**
 * 运行中会话的轨迹查询：RPC `get_trace` 与 SDK `session.trace()`（docs/wave6-plan.md §2.6、D29）。[W6-T2]
 *
 * 构建器输入取自会话（`traceInputOf`）；运行中时叠一层 `{ running: true }`（没有结果的工具算 running 而不是
 * interrupted，不编造时长）；子会话读取按会话缓存（mtime + 大小没变就不重读）。
 */

import type { AgentSession } from "../agent/types.js";
import type { RpcGetTraceParams } from "../rpc.js";
import { queryTrace, type TraceQueryResult } from "./query.js";
import { childLoader, traceInputOf, type ChildLoader } from "./session.js";
import type { Trace, TraceOptions } from "./types.js";

const loaders = new WeakMap<AgentSession, ChildLoader>();

function loaderOf(session: AgentSession): ChildLoader {
  let loader = loaders.get(session);
  if (loader === undefined) {
    loader = childLoader();
    loaders.set(session, loader);
  }
  return loader;
}

/** RPC `get_trace`。参数不合法抛 `invalid_arguments`，任务不存在抛 `task_not_found`。 */
export function sessionTrace(session: AgentSession, params: RpcGetTraceParams): TraceQueryResult {
  return queryTrace(traceInputOf(session), params, {
    loadChild: loaderOf(session),
    live: { running: session.state.isStreaming },
  });
}

/** SDK `session.trace(options?)`：缺省全部回合；`turnLimit` 取尾部若干回合；`taskId` 取子轨迹。 */
export function sdkSessionTrace(session: AgentSession, options: TraceOptions = {}): Trace {
  const { branch, turnLimit, taskId, now } = options;
  return queryTrace(
    traceInputOf(session),
    {
      ...(branch !== undefined ? { branch } : {}),
      ...(turnLimit !== undefined ? { turnLimit } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
    },
    {
      loadChild: loaderOf(session),
      live: { running: session.state.isStreaming },
      unlimited: turnLimit === undefined,
      ...(now !== undefined ? { now } : {}),
    },
  ).trace;
}
