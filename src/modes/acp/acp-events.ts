/**
 * `ama --mode acp`：ama 的会话事件 → ACP `session/update`（docs/wave5-plan.md §5.6、docs/acp-plan.md §2.3）。
 *
 * | ama                                       | ACP                                                              |
 * | ----------------------------------------- | ---------------------------------------------------------------- |
 * | message_update text_delta                 | agent_message_chunk                                              |
 * | message_update thinking_delta             | agent_thought_chunk                                              |
 * | message_update toolcall_end               | tool_call（pending，带 name、rawInput 与 locations）             |
 * | tool_execution_start（带 parent）         | tool_call（pending，title 带 codemode 前缀，`_meta.ama.parentToolCallId`） |
 * | tool_execution_start                      | tool_call_update（in_progress）                                  |
 * | permission_request（toolCallId 已公布）   | tool_call_update（pending）                                      |
 * | permission_resolved（allow / allow_session）| tool_call_update（in_progress）                                |
 * | tool_execution_end                        | tool_call_update（completed / failed，`[diff?, text]`，locations[].line） |
 * | todo_updated                              | plan                                                             |
 * | message_end（助手）/ turn_end             | usage_update（上下文用量、窗口、会话累计美元；与上次同值不发）   |
 * | permission_mode_changed                   | current_mode_update + config_option_update                       |
 * | model_changed                             | config_option_update + usage_update（窗口可能变了，不去重）      |
 * | thinking_level_changed                    | config_option_update                                             |
 *
 * new / load（回放之后）/ resume 的答复发出后，{@link AcpEventMapper.announce} 另发一条 `usage_update`，
 * 客户端不用等第一轮结束就能显示用量。模型窗口未知时不发：schema 里 `size` 必填，不编造窗口。
 *
 * 工具结果只回前 4 KB 文本（完整结果在 ama 会话里）；diff 只在实时事件里有（`fileChange` 不落盘）。
 * `session/load` 回放同一套映射（用户消息 → user_message_chunk，工具结果带文本、无 diff）。
 */

import type { ContentBlock } from "../../ai/types.js";
import type { AgentMessage } from "../../session/types.js";
import type { AgentSession, SessionEvent } from "../../agent/types.js";
import {
  ACP_META_KEY,
  type AcpAmaMeta,
  type AcpAvailableCommand,
  type AcpContentBlock,
  type AcpPlanEntry,
  type AcpSessionConfigOption,
  type AcpSessionUpdate,
} from "../../drivers/acp/types.js";
import { PERMISSION_MODES_STRICT_FIRST } from "../../permissions/types.js";
import { PERMISSION_MODE_INFO, permissionModeLabel } from "../../permissions/modes.js";
import { resultContent, resultText, toolKind, toolLocations, toolTitle } from "./acp-tool-text.js";

export { TOOL_OUTPUT_LIMIT, toolKind, toolLocations, toolTitle } from "./acp-tool-text.js";

export function permissionModes(currentModeId: string) {
  return {
    currentModeId,
    availableModes: PERMISSION_MODES_STRICT_FIRST.map((id) => ({
      id,
      name: permissionModeLabel(id),
      description: PERMISSION_MODE_INFO[id].description,
    })),
  };
}

/** 一个会话的事件映射器（记住已公布的工具调用，供权限请求关联 toolCallId 与状态）。 */
export class AcpEventMapper {
  /** 模型已发出、尚未执行完的工具调用（按工具名 + 参数匹配的后备）。 */
  private readonly pendingCalls: { id: string; name: string; args: string }[] = [];
  /** 已经以 `tool_call` 公布、尚未结束的调用：id → title（含 codemode 内层）。 */
  private readonly published = new Map<string, string>();
  /** 挂起的权限请求：requestId → 已公布的 toolCallId。 */
  private readonly permissionCalls = new Map<string, string>();
  /**
   * ama 的工具调用 id → 线上 toolCallId。ACP 要求 id 在会话内唯一，上游给的 id 却可能在后续回合重复
   * （假模型、个别兼容接口的兜底 id）；重复时加 `#n` 后缀，之后的开始 / 结束 / 审批都按最近一次映射。
   */
  private readonly wireIds = new Map<string, string>();
  private readonly usedWireIds = new Set<string>();
  /** 上次 `session_info_update` 带出的标题。 */
  private lastTitle: string | null = null;
  /** 上次 `usage_update` 的内容（同值不重发）。 */
  private lastUsage: string | undefined;

  constructor(
    private readonly cwd: string,
    private readonly emit: (update: AcpSessionUpdate) => void,
    private readonly session: () => AgentSession,
    /** 会话的配置项与命令表（{@link announce} 与配置变化时取；[ACP-D] 填实际内容）。 */
    protected readonly extras: () => {
      configOptions: AcpSessionConfigOption[];
      commands: AcpAvailableCommand[];
    } = () => ({ configOptions: [], commands: [] }),
  ) {}

  /**
   * 会话 new / load / resume 的响应发出后由服务端调：`available_commands_update`、`config_option_update`
   * 与 `usage_update`（客户端可能刚重建线程，用量不去重，照发一次）。
   */
  announce(): void {
    const { configOptions, commands } = this.extras();
    this.emit({ sessionUpdate: "available_commands_update", availableCommands: commands });
    this.emit({ sessionUpdate: "config_option_update", configOptions });
    this.emitUsage(true);
  }

  /** 回合结束后由服务端调：`session_info_update`（标题与上次不同才带 title）。 */
  emitSessionInfo(title: string | null, updatedAt: string): void {
    const changed = title !== this.lastTitle;
    this.lastTitle = title;
    this.emit({ sessionUpdate: "session_info_update", ...(changed ? { title } : {}), updatedAt });
  }

  /** 权限请求对应的工具调用 id（按工具名与参数匹配最近一个；有 `context.toolCallId` 时不需要）。 */
  toolCallIdFor(toolName: string, input: unknown): string | undefined {
    const args = JSON.stringify(input ?? null);
    for (let i = this.pendingCalls.length - 1; i >= 0; i--) {
      const call = this.pendingCalls[i]!;
      if (call.name === toolName && call.args === args) return call.id;
    }
    return undefined;
  }

  /** 已公布且未结束的工具调用的标题（codemode 内层带前缀）；未公布返回 undefined。 */
  titleFor(toolCallId: string): string | undefined {
    return this.published.get(this.wireId(toolCallId));
  }

  /** ama 的工具调用 id 在线上用的 toolCallId（没公布过的原样返回）。 */
  wireId(toolCallId: string): string {
    return this.wireIds.get(toolCallId) ?? toolCallId;
  }

  private claimWireId(toolCallId: string): string {
    let wire = toolCallId;
    for (let n = 2; this.usedWireIds.has(wire); n++) wire = `${toolCallId}#${n}`;
    this.usedWireIds.add(wire);
    this.wireIds.set(toolCallId, wire);
    return wire;
  }

  onEvent(event: SessionEvent): void {
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta")
          this.emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: e.delta },
          });
        else if (e.type === "thinking_delta")
          this.emit({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: e.delta },
          });
        else if (e.type === "toolcall_end") {
          const call = e.toolCall;
          const wire = this.claimWireId(call.id);
          this.pendingCalls.push({
            id: wire,
            name: call.name,
            args: JSON.stringify(call.arguments),
          });
          this.published.set(wire, this.emitToolCall(wire, call.name, call.arguments));
        }
        return;
      }
      case "tool_execution_start": {
        let wire: string;
        if (event.parentToolCallId !== undefined) {
          wire = this.claimWireId(event.toolCallId);
          const title = this.emitToolCall(
            wire,
            event.toolName,
            event.args,
            this.wireId(event.parentToolCallId),
          );
          this.published.set(wire, title);
        } else wire = this.wireId(event.toolCallId);
        this.status(wire, "in_progress");
        return;
      }
      case "tool_execution_end": {
        const wire = this.wireId(event.toolCallId);
        const at = this.pendingCalls.findIndex((c) => c.id === wire);
        if (at >= 0) this.pendingCalls.splice(at, 1);
        this.published.delete(wire);
        const { content, locations } = resultContent(event.result);
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: wire,
          status: event.isError ? "failed" : "completed",
          content,
          ...(locations !== undefined ? { locations } : {}),
        });
        return;
      }
      case "permission_request": {
        // 只认本会话已公布的调用：子 Agent / 外部 Agent 的请求（depth、origin）的 id 不在本会话的列表里
        const context = event.context;
        if (context?.toolCallId === undefined) return;
        if ((context.depth ?? 0) > 0 || context.origin !== undefined) return;
        const id = this.wireId(context.toolCallId);
        if (!this.published.has(id)) return;
        this.permissionCalls.set(event.requestId, id);
        this.status(id, "pending");
        return;
      }
      case "permission_resolved": {
        const id = this.permissionCalls.get(event.requestId);
        if (id === undefined) return;
        this.permissionCalls.delete(event.requestId);
        // 拒绝时由随后的 tool_execution_end（failed）收口
        if (event.decision !== "deny" && this.published.has(id)) this.status(id, "in_progress");
        return;
      }
      case "todo_updated":
        this.emit({
          sessionUpdate: "plan",
          entries: event.items.map((item): AcpPlanEntry => ({
            content: item.text,
            priority: "medium",
            status: item.status === "done" ? "completed" : item.status,
          })),
        });
        return;
      case "message_end":
        // 多工具轮里每条助手消息都更新一次用量，不等整轮结束
        if ("role" in event.message && event.message.role === "assistant") this.emitUsage();
        return;
      case "turn_end":
        this.emitUsage();
        return;
      case "permission_mode_changed":
        // 只认 configOptions 的客户端（Zed）看 mode 配置项，只认 modes 的看 current_mode_update
        this.emit({ sessionUpdate: "current_mode_update", currentModeId: event.mode });
        this.emit({
          sessionUpdate: "config_option_update",
          configOptions: this.extras().configOptions,
        });
        return;
      case "model_changed":
      case "thinking_level_changed":
        this.emit({
          sessionUpdate: "config_option_update",
          configOptions: this.extras().configOptions,
        });
        if (event.type === "model_changed") this.emitUsage(true); // 换模型照发（窗口可能变了）
        return;
      default:
        return;
    }
  }

  /**
   * 发一条 `usage_update`：上下文用量、窗口与会话累计美元。窗口未知时不发（`size` 必填）；
   * 与上次内容相同时不发，`force` 时照发。
   */
  emitUsage(force = false): void {
    const stats = this.session().getStats();
    if (stats.contextWindow === undefined) return;
    const update: AcpSessionUpdate = {
      sessionUpdate: "usage_update",
      used: stats.contextTokens ?? 0,
      size: stats.contextWindow,
      ...(stats.cost !== undefined ? { cost: { amount: stats.cost, currency: "USD" } } : {}),
    };
    const key = JSON.stringify(update);
    if (!force && key === this.lastUsage) return;
    this.lastUsage = key;
    this.emit(update);
  }

  /** `session/load`：按消息回放历史（工具结果带前 4 KB 文本；diff 不落盘，回放没有）。 */
  replay(messages: readonly AgentMessage[]): void {
    // 回放从头编号（客户端会重建整条线程）；有调用在跑时沿用现有映射，免得和实时更新对不上
    if (this.published.size === 0) {
      this.wireIds.clear();
      this.usedWireIds.clear();
    }
    for (const message of messages) {
      if (!("role" in message)) continue;
      if (message.role === "user") {
        for (const block of contentOf(message.content))
          this.emit({ sessionUpdate: "user_message_chunk", content: block });
      } else if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "text")
            this.emit({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: block.text },
            });
          else if (block.type === "thinking" && block.redacted !== true)
            this.emit({
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: block.thinking },
            });
          else if (block.type === "toolCall")
            this.emitToolCall(this.claimWireId(block.id), block.name, block.arguments);
        }
      } else if (message.role === "toolResult") {
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: this.wireId(message.toolCallId),
          status: message.isError ? "failed" : "completed",
          content: [
            { type: "content", content: { type: "text", text: resultText(message.content) } },
          ],
        });
      }
    }
  }

  private status(toolCallId: string, status: "pending" | "in_progress"): void {
    this.emit({ sessionUpdate: "tool_call_update", toolCallId, status });
  }

  /** 公布一次工具调用（pending）；`parentToolCallId` 给了即 codemode 内层调用。返回 title。 */
  private emitToolCall(id: string, name: string, args: unknown, parentToolCallId?: string): string {
    const locations = toolLocations(args, this.cwd);
    const title = toolTitle(name, args, parentToolCallId !== undefined);
    const meta: AcpAmaMeta | undefined =
      parentToolCallId !== undefined ? { parentToolCallId } : undefined;
    this.emit({
      sessionUpdate: "tool_call",
      toolCallId: id,
      name,
      title,
      kind: toolKind(name),
      status: "pending",
      rawInput: args,
      ...(locations !== undefined ? { locations } : {}),
      ...(meta !== undefined ? { _meta: { [ACP_META_KEY]: meta } } : {}),
    });
    return title;
  }
}

function contentOf(content: string | readonly ContentBlock[]): AcpContentBlock[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  const out: AcpContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") out.push({ type: "text", text: block.text });
    else if (block.type === "image") {
      out.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  return out;
}
