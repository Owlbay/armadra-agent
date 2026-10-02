/**
 * `codemode` 工具（设计 §5.5）：模型写一段 JavaScript，脚本里经 `tools.*` 编排多次工具调用，只有
 * 脚本输出回到模型。[B10]
 *
 * - 权限类：网络隔离时 `read`，否则 `execute`；`sequential`；脚本里的每次 `tools.*` 经 `ToolContext.tools.executeTool`
 *   走完整门禁（schema → PreToolUse → 权限管线 → 审批 → 执行 → PostToolUse），Hook 输入带
 *   `viaCodemode: true` 与父 toolCallId，事件带 `parentToolCallId`（agent/tool-runner.ts）；
 * - 返回值：`bash` 解析为 `{ output, truncated, fullOutputPath?, exitCode, wallTimeMs }`（非零退出码
 *   也解析），其它工具解析为 `structured` 或文本；失败、被拒、参数非法 → 以 Error reject；
 * - 结果：`Script completed` / `Script failed` + 用时 + 输出；超过 `max_output_tokens`（以及会话的
 *   单条结果上限）保留首尾，全文写 `<outputDir>/<toolCallId>.txt`；失败时保留已产出输出；
 * - store 只在脚本成功时提交（store.ts）；
 * - 描述（含工具声明）在第一次读取时确定并冻结：同一会话内字节稳定（设计 §9.1），之后注册的宿主
 *   工具仍可在脚本里调用（`ALL_TOOLS` / `describeTool` 是执行时的清单）。
 * - 描述分两种（`buildCodemodeDescription` 的 `layout`）：`only` 模式按预算内联全部工具声明；`on`
 *   模式不重复已直接暴露给模型的工具（它们的 schema 已在工具表里），只用一行列出名字，「仅脚本可
 *   调用」的工具也只列名字（`describeTool(name)` 取签名），把 on 模式的前缀增量压在约 400 token。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AmaConfig } from "../config/types.js";
import type { BashStructured } from "../tools/bash.js";
import { codemodeCallableFilter, resolveCodemodeMode } from "../tools/presets.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../tools/types.js";
import {
  codemodeAvailability,
  detectSandboxCapability,
  sandboxCapabilityFor,
  strictNeedsOsSandbox,
  type SandboxCapability,
} from "./capability.js";
import {
  BASH_RESULT_DECLARATION,
  DEFAULT_INLINE_BUDGET,
  buildDeclarationBlock,
  toolDeclaration,
  type DeclarableTool,
} from "./declarations.js";
import { runSandbox, type SandboxRunResult } from "./host-side.js";
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
  /** 模型也能直接调用（在活动集里）；`on` 模式的描述只列名字。 */
  direct?: boolean;
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
  /** `only` 模式：其它工具不直接暴露，系统提示的工具行与规则写明只能在脚本里调用。 */
  exclusive?: boolean;
  /** 描述的写法：缺省 `only`（按预算内联声明）；`on` 只列名字（见 `buildCodemodeDescription`）。 */
  layout?: DescriptionLayout;
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

/** 描述里的示例脚本（6 行）：并发两个 read、过滤、return。 */
export const CODEMODE_EXAMPLE: readonly string[] = [
  "const [a, b] = await Promise.all([",
  '  tools.read({ path: "src/a.ts" }),',
  '  tools.read({ path: "src/b.ts" }),',
  "]);",
  'const hits = (a + "\\n" + b).split("\\n").filter((line) => line.includes("TODO"));',
  'return hits.join("\\n");',
];

const SCRIPT_ONLY_GLOBALS =
  /\b(require|process|fetch|setTimeout|setInterval|setImmediate) is not defined/;

/**
 * 脚本失败原因后补一句正确写法：用了 require / import / process 等，或把工具名当函数直接调用
 * （实测模型常见的两种错误）。其它错误原样返回。
 */
export function scriptErrorHint(error: string, toolNames: readonly string[]): string {
  if (
    /Cannot use import statement|dynamic import callback/.test(error) ||
    SCRIPT_ONLY_GLOBALS.test(error)
  ) {
    return `${error}\nOnly tools.<name>(args) is available in codemode scripts (no require, import, process, fetch or timers).`;
  }
  const called = /ReferenceError: ([A-Za-z_$][\w$]*) is not defined/.exec(error)?.[1];
  if (called !== undefined && toolNames.includes(called)) {
    return `${error}\nCall tools as tools.${called}({...}), not ${called}(...).`;
  }
  return error;
}

export type DescriptionLayout = "only" | "on";

/**
 * `on` 模式的描述：规则压成三行 + 示例；已直接暴露的工具只列名字（参数同直接调用），仅脚本可调用的
 * 工具也只列名字。不内联任何声明，字节只依赖工具名与沙箱能力。
 */
function buildOnDescription(tools: readonly CallableTool[], capability: SandboxCapability): string {
  const names = (list: readonly CallableTool[]): string =>
    list
      .map(({ tool }) => tool.name)
      .sort()
      .join(", ");
  const direct = tools.filter((t) => t.direct === true);
  const scriptOnly = tools.filter((t) => t.direct !== true);
  const lines = [
    "Run a JavaScript script that calls tools; only its output comes back to you. Use it to batch many tool calls (Promise.all), filter or summarize large results, or loop, in one step.",
    "Input: raw JavaScript (not JSON, no code fence), the body of an async function (top-level await and return work). Only tools.<name>(args) exists: no require, import, process, fetch or timers.",
    "Example:",
    ...CODEMODE_EXAMPLE,
    "tools.<name>(args) returns a Promise that rejects when the call fails or is denied (Promise.allSettled keeps the rest); text(v) / console.log(...) append output; return v is text(v); store(key, v) / load(key) keep small JSON values across scripts; describeTool(name) returns a signature. At most 8 calls run at once, each through the normal permissions.",
  ];
  if (!capability.strict) lines.push(`Sandbox: ${capability.reason}.`);
  if (direct.length > 0) {
    const bash = direct.some(({ tool }) => tool.name === "bash");
    lines.push(
      `Your direct tools are callable here too, same arguments: ${names(direct)}${bash ? " (tools.bash resolves to BashResult; the others to text)" : ""}.`,
    );
    if (bash) lines.push(BASH_RESULT_DECLARATION);
  }
  if (scriptOnly.length > 0) lines.push(`Callable only from scripts: ${names(scriptOnly)}.`);
  return lines.join("\n");
}

export function buildCodemodeDescription(
  tools: readonly CallableTool[],
  inlineBudget: number,
  capability: SandboxCapability,
  layout: DescriptionLayout = "only",
): string {
  if (layout === "on") return buildOnDescription(tools, capability);
  const lines = [
    "Run a JavaScript script that calls tools; only the script's output comes back to you. Use it to batch many tool calls (Promise.all), filter or summarize large results, or loop, in one step.",
    "Only tools.<name>(args) is available. There is no require, import, process, fetch or timers; do not call tools directly as functions.",
    'The input is raw JavaScript (not JSON, no code fence), run as the body of an async function: top-level await and return work. Optional first line: // @options: {"max_output_tokens": 10000, "timeout_ms": 300000}',
    "Example:",
    ...CODEMODE_EXAMPLE,
    "Globals: tools.<name>(args) returns a Promise and rejects with an Error when the call fails or is denied (use Promise.allSettled to keep the rest); text(v) and console.log(...) append output (non-strings as JSON); return v is text(v); store(key, v) / load(key) keep small JSON values across scripts (saved only when the script succeeds); ALL_TOOLS lists callable tools; describeTool(name) returns a declaration. At most 8 tool calls run at once; codemode cannot call itself. Every call goes through the normal hooks, permissions and approvals.",
  ];
  if (!capability.strict) {
    lines.push(`Sandbox: ${capability.reason}.`);
  }
  const block = buildDeclarationBlock(
    tools.map(({ tool, textResult }) => ({ tool, textResult })),
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

/** `only` 模式的系统提示规则（实测模型仍会先直接调用 read / edit / bash）。 */
export const CODEMODE_ONLY_GUIDELINE =
  "read, edit, write, bash and the other tools are not callable directly here: every tool call goes inside a codemode script as tools.<name>(args); batch related calls in one script.";

export function createCodemodeTool(options: CodemodeToolOptions): ToolDefinition<CodemodeInput> {
  const capability = options.capability ?? detectSandboxCapability();
  const inlineBudget = options.inlineBudget ?? DEFAULT_INLINE_BUDGET;
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  let frozenDescription: string | undefined;

  const tool: ToolDefinition<CodemodeInput> = {
    name: CODEMODE_TOOL_NAME,
    label: "Codemode",
    get description(): string {
      frozenDescription ??= buildCodemodeDescription(
        options.listTools(),
        inlineBudget,
        capability,
        options.layout,
      );
      return frozenDescription;
    },
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "Raw JavaScript (async function body)" },
      },
      required: ["script"],
    },
    // 网络隔离（Node ≥ 25，或 OS 沙箱）时脚本只能经 tools.* 做事，每次内层调用各自过权限：codemode
    // 本身按 read 类（default 模式免审批）；不隔离网络时脚本逃出 vm 就能联网，仍按 execute。
    permission: capability.strict ? "read" : "execute",
    executionMode: "sequential",
    promptSnippet:
      options.exclusive === true
        ? "codemode: your only tool; run a JavaScript script that calls the other tools as tools.<name>(args); only its output returns"
        : "codemode: run a JavaScript script that calls tools; only its output returns",
    ...(options.exclusive === true ? { promptGuidelines: [CODEMODE_ONLY_GUIDELINE] } : {}),
    async execute(input, ctx) {
      let scriptOptions;
      try {
        scriptOptions = parseOptionsLine(input.script);
      } catch (error) {
        return { content: (error as Error).message, isError: true };
      }
      const tools: ToolDecl[] = options.listTools().map(({ tool: t, textResult }) => ({
        name: t.name,
        declaration: toolDeclaration(t, textResult ? {} : { textResult: false }),
      }));
      // 只有清单里的工具可调（coordinator 预设的清单只含活动集）；脚本拼出别的名字也不放行。
      const callable = new Set(tools.map((t) => t.name));
      let tail = "";
      const run = await runSandbox({
        script: input.script,
        options: scriptOptions,
        tools,
        store: readStore(ctx.session),
        signal: ctx.signal,
        os: capability.os,
        requireOsSandbox: strictNeedsOsSandbox(capability),
        ...(options.entry !== undefined ? { entry: options.entry } : {}),
        ...(options.nodePath !== undefined ? { nodePath: options.nodePath } : {}),
        callTool: async (name, args, signal) => {
          if (!callable.has(name)) throw new Error(`Tool ${name} is not available in codemode`);
          return toScriptValue(name, await ctx.tools.executeTool(name, args, { signal }));
        },
        onOutput: (text) => {
          tail = `${tail}${tail === "" ? "" : "\n"}${text}`.slice(-TAIL_CHARS);
          ctx.onUpdate(tail);
        },
      });
      if (run.error !== undefined) {
        run.error = scriptErrorHint(
          run.error,
          tools.map((t) => t.name),
        );
      }
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
  config: Pick<AmaConfig, "tools" | "codemode" | "sandbox">;
  registry: {
    list(): readonly string[];
    get(name: string): ToolDefinition | undefined;
  } & {
    sourceOf?(name: string): string | undefined;
    /** 活动集（coordinator 预设下脚本只能调这些）。 */
    active?(): readonly { name: string }[];
  };
  warn(message: string): void;
}

/**
 * codemode 工具工厂：生效模式（显式 `codemode.mode`，否则跟随预设，见 tools/presets.ts）为 off →
 * 不注册；`requireStrict` 而运行时不隔离网络 → 不注册并 warning（预设随之回退到 default）。
 * `coordinator` 预设下脚本可调用的工具限于活动集（不含 codemode 本身）。
 */
export function codemodeToolFactory(
  overrides: Partial<Pick<CodemodeToolOptions, "capability" | "entry" | "nodePath">> = {},
): (ctx: CodemodeFactoryContext) => ToolDefinition | undefined {
  return (ctx) => {
    const capability = overrides.capability ?? sandboxCapabilityFor(ctx.config);
    const mode = resolveCodemodeMode(ctx.config, capability.strict).mode;
    if (mode === "off") return undefined;
    const availability = codemodeAvailability(ctx.config.codemode?.requireStrict, capability);
    if (!availability.available) {
      ctx.warn(availability.warning);
      return undefined;
    }
    const registry = ctx.registry;
    const onlyActive = codemodeCallableFilter(ctx.config) === "active";
    const allowed = (name: string): boolean =>
      !onlyActive || (registry.active?.() ?? []).some((tool) => tool.name === name);
    const direct = (): Set<string> =>
      new Set(mode === "on" ? (registry.active?.() ?? []).map((tool) => tool.name) : []);
    const options: CodemodeToolOptions = {
      capability: availability.capability,
      exclusive: mode === "only",
      layout: mode === "on" ? "on" : "only",
      listTools: () => {
        const active = direct();
        return registry
          .list()
          .filter((name) => name !== CODEMODE_TOOL_NAME && allowed(name))
          .map((name) => registry.get(name))
          .filter((t): t is ToolDefinition => t !== undefined)
          .map((t) => ({
            tool: t,
            textResult: (registry.sourceOf?.(t.name) ?? "builtin") === "builtin",
            ...(active.has(t.name) ? { direct: true } : {}),
          }));
      },
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
