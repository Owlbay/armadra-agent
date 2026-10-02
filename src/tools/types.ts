/**
 * 工具契约（设计 §5.1）。[B0] 契约文件，实现归 B3；也从 `./host` 再导出。
 *
 * 补全与偏差：
 * - `ToolContext.readFiles` 是只读集合，但 read 工具要「成功后加入」——增加 `markRead(path)`。
 * - bash 要注入 `AMA_PROVIDER / AMA_MODEL / AMA_THINKING`（§5.2），增加 `model` 与 `thinkingLevel`。
 * - 截断全文落 `<sessionDir>/outputs/<toolCallId>.txt`（§4.4），增加 `outputDir`
 *   （内存会话为 undefined，实现自行落到临时目录）。
 * - todo 工具要写 / 读 `custom` 条目，增加 `session.appendCustom / lastCustom`。
 * - task 工具要开子会话，但 B3 不得 import B2 的实现——增加 `spawnSubagent`，由
 *   AgentSession（B2）在构造 ToolContext 时提供；子 Agent（depth ≥ 1）里为 undefined。
 * - `defineTool()` 是恒等函数，只为推断 `I`；放在契约文件里供 SDK 再导出。
 * - `ToolRegistryApi` 是 Runtime 需要的最小接口，B3 的 `ToolRegistry` 实现它。
 * - （W3-C0）`SubagentResult.cache` 可选：子会话的命中率与重计费 token。
 */

import type { ContentBlock, JsonSchema, ModelRef, ModelThinkingLevel, Usage } from "../ai/types.js";
import type { CheckpointHooks } from "../checkpoints/types.js";

export type { JsonSchema } from "../ai/types.js";

/** 权限管线的粗分类（§7）。 */
export type ToolPermission = "read" | "write" | "execute";
export type ToolExecutionMode = "sequential" | "parallel";

export interface ToolAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
}

export interface ToolDefinition<I = unknown> {
  /** `^[a-z][a-z0-9_]{1,63}$`；宿主工具建议前缀（canvas_*）。 */
  readonly name: string;
  /** TUI 标题。 */
  readonly label?: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly permission: ToolPermission;
  /** 缺省：read → parallel；write / execute → sequential。 */
  readonly executionMode?: ToolExecutionMode;
  readonly annotations?: ToolAnnotations;
  /** 系统提示 tools 节一行。 */
  readonly promptSnippet?: string;
  /** 系统提示 rules 节。 */
  readonly promptGuidelines?: readonly string[];
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
  /** TUI 可选自定义渲染。 */
  renderCall?(input: I, width: number): string[];
  renderResult?(result: ToolResult, width: number, expanded: boolean): string[];
}

export interface ToolResult {
  content: string | ContentBlock[];
  isError?: boolean;
  /** 落盘，不进上下文。 */
  details?: unknown;
  structured?: unknown;
  /** 整批工具结果都为 true 才提前结束 run。 */
  terminate?: boolean;
}

export interface SubagentRequest {
  prompt: string;
  description?: string;
  /** 缺省 = 父活动集去掉 task。 */
  tools?: string[];
  /** `provider/model-id`；缺省继承父。 */
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  /** 缺省 30。 */
  maxTurns?: number;
  /** 父 toolCallId（写入子会话的 custom{ama.task}）。 */
  parentToolCallId: string;
  signal: AbortSignal;
  onUpdate?(partial: string): void;
}

export interface SubagentResult {
  /** 子会话最后一条助手文本。 */
  text: string;
  sessionFile?: string;
  usage: Usage;
  stopReason: string;
  isError: boolean;
  /**
   * [W3-C0] 子会话自己的缓存统计（第三波 §1.9），供 task 结果 details 与 `/session` 的
   * 「子任务」行；子会话未接缓存控制器时缺省。
   */
  cache?: { hitRate?: number; reBilledTokens: number };
}

export interface ToolContext {
  readonly toolCallId: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly signal: AbortSignal;
  /** task 深度：主会话 0，子 Agent 1。 */
  readonly depth: number;
  readonly model?: ModelRef;
  readonly thinkingLevel?: ModelThinkingLevel;
  /** 截断全文的落盘目录（`<sessionDir>/outputs`）；内存会话为 undefined。 */
  readonly outputDir?: string;
  onUpdate(partial: string): void;
  /** 本会话已 read 的绝对路径（write / edit 先读后写检查）。 */
  readonly readFiles: ReadonlySet<string>;
  markRead(absolutePath: string): void;
  /**
   * 嵌套调用其它工具（codemode 脚本、task），受同一管线；按全部未禁用工具查找（不限于活动集），
   * 发带 `parentToolCallId` 的 tool_execution_* 事件。`signal`：与 ctx.signal 合并，用于提前取消
   * 这一次嵌套调用（codemode 脚本结束时取消仍在跑的调用）。
   */
  readonly tools: {
    executeTool(
      name: string,
      input: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<ToolResult>;
  };
  readonly session: {
    /** 追加 custom 条目（不进上下文）。 */
    appendCustom(customType: string, data: unknown): void;
    /** 活动分支上最近一条该类型 custom 条目的 data。 */
    lastCustom(customType: string): unknown;
  };
  /** 检查点（docs/rewind-plan.md §2）：edit / write 写文件前后调用；未启用时为 undefined。 */
  readonly checkpoint?: CheckpointHooks;
  /** 仅 depth 0 且 task 可用时存在。 */
  readonly spawnSubagent?: (request: SubagentRequest) => Promise<SubagentResult>;
  log(level: "debug" | "info" | "warn", message: string): void;
}

export type ToolSource = "builtin" | "host" | "sdk";

export interface ToolRegistryApi {
  /** 同名已存在则抛 AmaError{code:"tool_exists"}。 */
  register(tool: ToolDefinition, source: ToolSource): void;
  disable(name: string): void;
  get(name: string): ToolDefinition | undefined;
  /** 已注册且未禁用的名字，按名排序。 */
  list(): readonly string[];
  /** 当前活动集（发给模型的工具），按名排序。 */
  active(): readonly ToolDefinition[];
  setActive(names: readonly string[]): void;
}

/** 恒等函数，帮助推断输入类型。 */
export function defineTool<I>(tool: ToolDefinition<I>): ToolDefinition<I> {
  return tool;
}
