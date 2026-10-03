/**
 * 子 Agent 测试装配（W5-G）：B2 的会话 harness + 真 task / task_ctl 工具 + 任务注册表扩展。
 */

import type { ScriptCall, ScriptSource, ScriptStep } from "./scripted-api.js";
import type { SystemMessage } from "../../ai/types.js";
import { PermissionPipeline } from "../../permissions/pipeline.js";
import type { PermissionMode } from "../../permissions/types.js";
import type { ApprovalBroker } from "../../permissions/types.js";
import { createSubagentExtension } from "../../cli/compose-agents.js";
import { AgentCatalog } from "../../agents/catalog.js";
import type { AgentDefinition } from "../../agents/types.js";
import { createTaskTool } from "../../tools/task.js";
import { createTaskCtlTool } from "../../tools/task-ctl.js";
import type { ToolDefinition } from "../../tools/types.js";
import type { SubagentEnvironment } from "../subagent-registry.js";
import { readFileSync } from "node:fs";
import { SessionManager } from "../../session/manager.js";
import type { SessionEntry, SessionLine } from "../../session/types.js";
import { AgentSessionImpl } from "../session.js";
import type { SessionEvent } from "../types.js";
import { createScriptedApi } from "./scripted-api.js";
import { createHarness, userTexts, type Harness, type HarnessOptions } from "./harness.js";
import { fakeModel, stubRegistry } from "./stubs.js";
import { stubTool, waitOrAbort } from "./stubs.js";

/** 与 createHarness 相同，但会话管理器是重开的文件（resume）。 */
function reopen(file: string, options: HarnessOptions): Harness {
  const { script, dir: _dir, cwd: _cwd, delayMs, ...rest } = options;
  const model = rest.model ?? fakeModel();
  const scripted = createScriptedApi(script, delayMs === undefined ? {} : { delayMs });
  const manager = SessionManager.open(file);
  const session = new AgentSessionImpl({
    retry: { baseDelayMs: 1, maxDelayMs: 5 },
    abortGraceMs: 50,
    ...rest,
    model,
    sessionManager: manager,
    providers: stubRegistry([model], [scripted.api]),
  });
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  const fileLines = (): SessionLine[] =>
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionLine);
  return {
    session,
    manager,
    scripted,
    model,
    events,
    types: () => events.map((event) => event.type),
    fileLines,
    fileEntries: () => fileLines().filter((line): line is SessionEntry => line.type !== "session"),
  };
}

/** 轮询直到条件成立（后台任务与通知是异步的）。 */
export async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export { userTexts };

/** 子会话的请求：系统提示有 role 节。 */
export function isChild(call: ScriptCall): boolean {
  const first = call.context.messages[0] as SystemMessage | undefined;
  return first?.role === "system" && first.sections["role"] !== undefined;
}

/** 请求里第一条 user 文本（子会话 = 委派的 prompt）。 */
export function firstUser(call: ScriptCall): string {
  return userTexts(call.context)[0] ?? "";
}

export function lastIsToolResult(call: ScriptCall): boolean {
  return call.context.messages.at(-1)?.role === "toolResult";
}

export function agentDef(name: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name,
    description: `${name} agent`,
    permissionMode: "inherit",
    model: "inherit",
    maxTurns: 30,
    isolation: "none",
    runner: "ama",
    prompt: `${name} role`,
    source: "user",
    ...extra,
  };
}

export interface SubagentHarnessOptions extends Omit<HarnessOptions, "script"> {
  /** 重开已有的父会话文件（resume）；与 `dir` 二选一。 */
  file?: string;
  script: ScriptSource | ((call: ScriptCall) => ScriptStep);
  env?: Partial<SubagentEnvironment>;
  mode?: PermissionMode;
  extraTools?: ToolDefinition[];
  /** 记录 broker 收到的审批请求（只读类型不应有）。 */
  asked?: string[];
}

/** 并发计数的 sleep 工具（子会话调用它来量并发）。 */
export function sleepTool(counter: { running: number; peak: number }, ms = 30): ToolDefinition {
  return stubTool({
    name: "sleep",
    run: async (_input, ctx) => {
      counter.running++;
      counter.peak = Math.max(counter.peak, counter.running);
      await waitOrAbort(ms, ctx.signal);
      counter.running--;
      return { content: "slept" };
    },
  }) as ToolDefinition;
}

export function subagentHarness(options: SubagentHarnessOptions): Harness {
  const { env, mode = "full-auto", extraTools = [], asked, file, ...rest } = options;
  const environment: SubagentEnvironment = { catalog: new AgentCatalog(), ...env };
  const broker: ApprovalBroker = {
    ask: async (request) => {
      asked?.push(request.toolName);
      return "deny";
    },
  };
  const build = file === undefined ? createHarness : (o: HarnessOptions) => reopen(file, o);
  return build({
    tools: [
      createTaskTool() as ToolDefinition,
      createTaskCtlTool() as ToolDefinition,
      stubTool({ name: "read" }) as ToolDefinition,
      stubTool({ name: "write", permission: "write" }) as ToolDefinition,
      stubTool({
        name: "bash",
        permission: "execute",
        properties: { command: { type: "string" } },
      }) as ToolDefinition,
      ...extraTools,
    ],
    permission: new PermissionPipeline({ mode, rules: [], cwd: rest.cwd ?? "/work" }),
    brokers: [broker],
    extensions: [
      ({ core }) => (core.depth > 0 ? undefined : createSubagentExtension(core, environment)),
    ],
    ...rest,
  });
}

/** 父会话：先发一组工具调用，拿到结果后回 `parent done`。 */
export function parentTurn(
  call: ScriptCall,
  toolCalls: { name: string; args: Record<string, unknown> }[],
): ScriptStep {
  return lastIsToolResult(call) ? { text: "parent done" } : { toolCalls };
}
