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
import { createHarness, userTexts, type Harness, type HarnessOptions } from "./harness.js";
import { stubTool, waitOrAbort } from "./stubs.js";

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
    background: false,
    runner: "ama",
    prompt: `${name} role`,
    source: "user",
    ...extra,
  };
}

export interface SubagentHarnessOptions extends Omit<HarnessOptions, "script"> {
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
  const { env, mode = "full-auto", extraTools = [], asked, ...rest } = options;
  const environment: SubagentEnvironment = { catalog: new AgentCatalog(), ...env };
  const broker: ApprovalBroker = {
    ask: async (request) => {
      asked?.push(request.toolName);
      return "deny";
    },
  };
  return createHarness({
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
