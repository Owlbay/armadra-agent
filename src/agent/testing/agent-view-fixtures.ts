/**
 * Agent 栏 / 子 Agent 视图测试的假数据（W6-A）：TaskInfo、假注册表、子 Agent 事件。只被测试引用。
 */

import type { ExternalDisplayEvent, TaskLive } from "../../agents/task-record.js";
import type { TaskSource } from "../../modes/interactive/agent-bar.js";
import type { TaskInfo } from "../../tools/types.js";
import type { SessionEvent } from "../types.js";

export function info(taskId: string, extra: Partial<TaskInfo> = {}): TaskInfo {
  return {
    taskId,
    agent: "explore",
    runner: "ama",
    description: "",
    background: true,
    status: "running",
    startedAt: 0,
    ...extra,
  };
}

/** 假注册表：只读 TaskInfo 列表、排队集合与外部环形缓冲。 */
export function fakeRegistry(
  infos: TaskInfo[],
  options: {
    queued?: ReadonlySet<string>;
    recent?: ReadonlyMap<string, ExternalDisplayEvent[]>;
    extra?: (taskId: string) => Partial<TaskLive>;
    message?: TaskSource["message"];
  } = {},
): TaskSource {
  const get = (taskId: string): TaskInfo | undefined => infos.find((i) => i.taskId === taskId);
  return {
    list: () => infos,
    get,
    live: (taskId) => {
      const found = get(taskId);
      if (found === undefined) return undefined;
      return {
        info: found,
        queued: options.queued?.has(taskId) === true,
        recent: options.recent?.get(taskId) ?? [],
        pending: 0,
        ...options.extra?.(taskId),
      };
    },
    message: options.message ?? (async () => "queued"),
  };
}

export function start(taskId: string, agent = "explore", runner = "ama"): SessionEvent {
  return {
    type: "subagent_start",
    taskId,
    parentToolCallId: `c-${taskId}`,
    agent,
    runner,
    description: "",
    background: true,
    cwd: "/w",
  };
}
