/**
 * `codemode` 工具（设计 §5.5）：模型写一段 JavaScript，脚本里经 `tools.*` 编排多次工具调用，只有
 * 脚本输出回到模型。[B10]
 *
 * - 权限类 `execute`、`sequential`；脚本里的每次 `tools.*` 经 `ToolContext.tools.executeTool`
 *   走完整门禁（schema → PreToolUse → 权限管线 → 审批 → 执行 → PostToolUse），Hook 输入带
 *   `viaCodemode: true` 与父 toolCallId，事件带 `parentToolCallId`（agent/tool-runner.ts）；
 * - 返回值：`bash` 解析为 `{ output, truncated, fullOutputPath?, exitCode, wallTimeMs }`（非零退出码
 *   也解析），其它工具解析为 `structured` 或文本；失败、被拒、参数非法 → 以 Error reject；
 * - 结果：`Script completed` / `Script failed` + 用时 + 输出；超过 `max_output_tokens`（以及会话的
 *   单条结果上限）保留首尾，全文写 `<outputDir>/<toolCallId>.txt`；失败时保留已产出输出；
 * - store 只在脚本成功时提交（store.ts）；
 * - 描述（含工具声明）在第一次读取时确定并冻结：同一会话内字节稳定（设计 §9.1），之后注册的宿主
 *   工具仍可在脚本里调用（`ALL_TOOLS` / `describeTool` 是执行时的清单）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashStructured } from "../tools/bash.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../tools/types.js";
import {
  codemodeAvailability,
  detectSandboxCapability,
  type SandboxCapability,
} from "./capability.js";
import {
  DEFAULT_INLINE_BUDGET,
  buildDeclarationBlock,
  toolDeclaration,
  type DeclarableTool,
} from "./declarations.js";
import { runSandbox, type SandboxRunResult } from "./host-side.js";
import { codemodeHint } from "./modes.js";
import { parseOptionsLine, type ToolDecl } from "./protocol.js";
import { commitStore, readStore } from "./store.js";

export const CODEMODE_TOOL_NAME = "codemode";
/** 与 agent/tool-runner.ts 的 DEFAULT_MAX_TOOL_RESULT_CHARS 一致（codemode 与 tools 同层，不 import agent）。 */
const DEFAULT_MAX_TOOL_RESULT_CHARS = 30_000;

export interface CodemodeInput {
  script: string;
}

export interface CallableTool {
  tool: DeclarableTool;
  /** 内置工具（非 bash）解析为文本；宿主 / SDK 工具可能返回结构化值。 */
  textResult: boolean;
}

export interface CodemodeToolOptions {
  /** 脚本里可调用的工具（不含 codemode 本身）；描述冻结时与每次执行时各调用一次。 */
  listTools(): CallableTool[];
  /** 描述里内联声明的预算（估算 token），缺省 3000。 */
  inlineBudget?: number;
  /** 缺省 detectSandboxCapability()。 */
  capability?: SandboxCapability;
  /** 会话的单条工具结果上限（runner 会再截一次；这里先按它收紧，避免二次截断丢掉尾部）。 */
  maxResultChars?: number;
  /** 子进程入口（测试 / 嵌入方覆盖）。 */
  entry?: string;
  nodePath?: string;
}

export interface CodemodeDetails {
  ok: boolean;
  elapsedMs: number;
  toolCalls: number;
  timedOut: boolean;
  aborted: boolean;
  strict: boolean;
  fullOutputPath?: string;
  error?: string;
}

/** 脚本里拿到的 bash 结果。 */
export interface ScriptBashResult {
  output: string;
  truncated: boolean;
  fullOutputPath?: string;
  exitCode: number;
  wallTimeMs: number;
}

function textOf(content: ToolResult["content"]): string {
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function isBashStructured(value: unknown): value is BashStructured {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as BashStructured).output === "string" &&
    typeof (value as BashStructured).exit_code === "number"
  );
}

/** 内层工具结果 → 脚本拿到的值；失败抛 Error。 */
export function toScriptValue(name: string, result: ToolResult): unknown {
  if (name === "bash" && isBashStructured(result.structured)) {
    const s = result.structured;
    const value: ScriptBashResult = {
      output: s.output,
      truncated: s.truncated,
      exitCode: s.exit_code,
      wallTimeMs: Math.round(s.wall_time_seconds * 1000),
    };
    if (s.full_output_path !== undefined) value.fullOutputPath = s.full_output_path;
    return value;
  }
  if (result.isError === true) throw new Error(textOf(result.content) || `Tool ${name} failed`);
  return result.structured !== undefined ? result.structured : textOf(result.content);
}

/** on 模式下其它工具描述末尾的提示不进声明。 */
function declarable(tool: DeclarableTool): DeclarableTool {
  const suffix = `\n${codemodeHint(tool.name)}`;
  if (!tool.description.endsWith(suffix)) return tool;
  return { ...tool, description: tool.description.slice(0, -suffix.length) };
}

export function buildCodemodeDescription(
  tools: readonly CallableTool[],
  inlineBudget: number,
  capability: SandboxCapability,
): string {
  const lines = [
    "Run a JavaScript script that calls tools; only the script's output comes back to you. Use it to batch many tool calls (Promise.all), filter or summarize large results, or loop, in one step.",
    'The input is raw JavaScript (not JSON, no code fence), run as the body of an async function: top-level await and return work. Optional first line: // @options: {"max_output_tokens": 10000, "timeout_ms": 300000}',
    "Globals: tools.<name>(args) returns a Promise and rejects with an Error when the call fails or is denied (use Promise.allSettled to keep the rest); text(v) and console.log(...) append output (non-strings as JSON); return v is text(v); store(key, v) / load(key) keep small JSON values across scripts (saved only when the script succeeds); ALL_TOOLS lists callable tools; describeTool(name) returns a declaration. No require, process, fetch or timers. At most 8 tool calls run at once; codemode cannot call itself. Every call goes through the normal hooks, permissions and approvals.",
  ];
  if (!capability.strict) {
    lines.push(`Sandbox: ${capability.reason}.`);
  }
  const block = buildDeclarationBlock(
    tools.map(({ tool, textResult }) => ({ tool: declarable(tool), textResult })),
    inlineBudget,
  );
  if (block.text !== "") lines.push(block.text);
  return lines.join("\n");
}

/** 结果文本：状态行 + 输出（超限保留首尾）+ 失败原因。 */
export function formatCodemodeResult(
  run: Pick<SandboxRunResult, "ok" | "error" | "outputs" | "elapsedMs" | "droppedChars">,
  limitChars: number,
  saveFull: (text: string) => string | undefined,
): { text: string; fullOutputPath?: string } {
  const seconds = (run.elapsedMs / 1000).toFixed(2);
  const header = `${run.ok ? "Script completed" : "Script failed"} in ${seconds}s`;
  let output = run.outputs.join("\n");
  if (run.droppedChars > 0) {
    output += `\n[${run.droppedChars} more characters of output were discarded]`;
  }
  let fullOutputPath: string | undefined;
  if (output.length > limitChars) {
    fullOutputPath = saveFull(output);
    const half = Math.max(1, Math.floor(limitChars / 2));
    const omitted = output.length - half * 2;
    const where = fullOutputPath === undefined ? "" : `; full output: ${fullOutputPath}`;
    output = `${output.slice(0, half)}\n[... ${omitted} characters omitted${where} ...]\n${output.slice(-half)}`;
  }
  const parts = [header, output === "" ? "(no output)" : output];
  if (!run.ok && run.error !== undefined) parts.push(`Script error: ${run.error}`);
  const result: { text: string; fullOutputPath?: string } = { text: parts.join("\n\n") };
  if (fullOutputPath !== undefined) result.fullOutputPath = fullOutputPath;
  return result;
}

function saveFullOutput(ctx: ToolContext, text: string): string | undefined {
  try {
    const dir = ctx.outputDir ?? join(tmpdir(), "ama-codemode");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${ctx.toolCallId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
    writeFileSync(file, text, "utf8");
    return file;
  } catch {
    return undefined;
  }
}

const TAIL_CHARS = 4000;

export function createCodemodeTool(options: CodemodeToolOptions): ToolDefinition<CodemodeInput> {
  const capability = options.capability ?? detectSandboxCapability();
  const inlineBudget = options.inlineBudget ?? DEFAULT_INLINE_BUDGET;
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  let frozenDescription: string | undefined;

  const tool: ToolDefinition<CodemodeInput> = {
    name: CODEMODE_TOOL_NAME,
    label: "Codemode",
    get description(): string {
      frozenDescription ??= buildCodemodeDescription(options.listTools(), inlineBudget, capability);
      return frozenDescription;
    },
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "Raw JavaScript (async function body)" },
      },
      required: ["script"],
    },
    permission: "execute",
    executionMode: "sequential",
    promptSnippet: "codemode: run a JavaScript script that calls tools; only its output returns",
    async execute(input, ctx) {
      let scriptOptions;
      try {
        scriptOptions = parseOptionsLine(input.script);
      } catch (error) {
        return { content: (error as Error).message, isError: true };
      }
      const tools: ToolDecl[] = options.listTools().map(({ tool: t, textResult }) => ({
        name: t.name,
        declaration: toolDeclaration(declarable(t), textResult ? {} : { textResult: false }),
      }));
      let tail = "";
      const run = await runSandbox({
        script: input.script,
        options: scriptOptions,
        tools,
        store: readStore(ctx.session),
        signal: ctx.signal,
        ...(options.entry !== undefined ? { entry: options.entry } : {}),
        ...(options.nodePath !== undefined ? { nodePath: options.nodePath } : {}),
        callTool: async (name, args, signal) =>
          toScriptValue(name, await ctx.tools.executeTool(name, args, { signal })),
        onOutput: (text) => {
          tail = `${tail}${tail === "" ? "" : "\n"}${text}`.slice(-TAIL_CHARS);
          ctx.onUpdate(tail);
        },
      });
      if (run.ok && run.store !== undefined) {
        const problem = commitStore(ctx.session, run.store);
        if (problem !== undefined) {
          run.ok = false;
          run.error = `store was not saved: ${problem}`;
        }
      }
      const limitChars = Math.max(
        1000,
        Math.min(scriptOptions.maxOutputTokens * 4, maxResultChars - 500),
      );
      const formatted = formatCodemodeResult(run, limitChars, (text) => saveFullOutput(ctx, text));
      const details: CodemodeDetails = {
        ok: run.ok,
        elapsedMs: run.elapsedMs,
        toolCalls: run.toolCalls,
        timedOut: run.timedOut,
        aborted: run.aborted,
        strict: capability.strict,
      };
      if (formatted.fullOutputPath !== undefined) details.fullOutputPath = formatted.fullOutputPath;
      if (run.error !== undefined) details.error = run.error;
      return { content: formatted.text, isError: !run.ok, details };
    },
    renderCall(input, width) {
      const lines = input.script.split("\n");
      const shown = lines.slice(0, 6).map((line) => line.slice(0, Math.max(10, width)));
      if (lines.length > shown.length) shown.push(`… ${lines.length - shown.length} more lines`);
      return shown;
    },
    renderResult(result, width, expanded) {
      const lines = textOf(result.content).split("\n");
      const clip = (line: string) => line.slice(0, Math.max(10, width));
      if (expanded || lines.length <= 8) return lines.map(clip);
      return [clip(lines[0] ?? ""), `… ${lines.length - 6} lines`, ...lines.slice(-5).map(clip)];
    },
  };
  return tool;
}

/** 组装根用：从 ToolFactoryContext 的形状取所需（避免 codemode → cli 的依赖）。 */
export interface CodemodeFactoryContext {
  config: {
    codemode?: { mode?: "off" | "on" | "only"; inlineBudget?: number; requireStrict?: boolean };
    tools?: { preset?: string; maxToolResultChars?: number };
  };
  registry: {
    list(): readonly string[];
    get(name: string): ToolDefinition | undefined;
  } & { sourceOf?(name: string): string | undefined };
  warn(message: string): void;
}

/**
 * codemode 工具工厂：`codemode.mode` 生效值为 off → 不注册；`requireStrict` 而运行时不隔离网络
 * → 不注册并 warning（预设随之回退到 default）。
 */
export function codemodeToolFactory(
  overrides: Partial<Pick<CodemodeToolOptions, "capability" | "entry" | "nodePath">> = {},
): (ctx: CodemodeFactoryContext) => ToolDefinition | undefined {
  return (ctx) => {
    const explicit = ctx.config.codemode?.mode;
    const mode = explicit ?? (ctx.config.tools?.preset === "codemode" ? "only" : "off");
    if (mode === "off") return undefined;
    const availability = codemodeAvailability(
      ctx.config.codemode?.requireStrict,
      overrides.capability ?? detectSandboxCapability(),
    );
    if (!availability.available) {
      ctx.warn(availability.warning);
      return undefined;
    }
    const registry = ctx.registry;
    const options: CodemodeToolOptions = {
      capability: availability.capability,
      listTools: () =>
        registry
          .list()
          .filter((name) => name !== CODEMODE_TOOL_NAME)
          .map((name) => registry.get(name))
          .filter((t): t is ToolDefinition => t !== undefined)
          .map((t) => ({
            tool: t,
            textResult: (registry.sourceOf?.(t.name) ?? "builtin") === "builtin",
          })),
    };
    const budget = ctx.config.codemode?.inlineBudget;
    if (budget !== undefined) options.inlineBudget = budget;
    const maxChars = ctx.config.tools?.maxToolResultChars;
    if (maxChars !== undefined) options.maxResultChars = maxChars;
    if (overrides.entry !== undefined) options.entry = overrides.entry;
    if (overrides.nodePath !== undefined) options.nodePath = overrides.nodePath;
    return createCodemodeTool(options) as ToolDefinition;
  };
}
