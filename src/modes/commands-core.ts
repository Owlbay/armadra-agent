/**
 * 斜杠命令语义层（line 模式与 B7 交互模式共用，不含渲染）。[B6]
 *
 * `runSlashCommand(line, ctx)`：
 * - 不是内置命令（含 `/skill:<name>` 与提示模板 `/<模板名>`）→ undefined，调用方把整行当提示发出，
 *   展开在会话的 expandPrompt 里做；
 * - 内置命令 → `CommandResult`：`handled`（可带一段给用户看的文本）、`prompt`（改发这段文本）、
 *   `pick`（需要界面弹选择器，参数缺省时）、`exit`。
 *
 * 会话切换（/new /resume /fork）经 `ctx.switchSession`，调用方据返回的新会话重新订阅事件。
 * `/rewind`（RW-C）：无参数列出回滚点，带参数执行（interactive/rewind-command.ts）；对话变了时
 * `handled` 带 `draft`（原消息）与 `reload`，界面据此回填输入框、重画消息区。
 * [W6-C0] `/config`、`/trace`、`/memory` 登记在表里，由各功能批次经 `CommandContext.extra`（line 模式）或
 * `CommandUi` 的面板钩子（交互模式，interactive/commands.ts）实现；没有实现时回「尚未提供」。
 */

import { AgentSessionImpl } from "../agent/session.js";
import type { AgentSession, RewindDraftText } from "../agent/types.js";
import { WARMING_MODES, type WarmingMode } from "../ai/cache/types.js";
import { THINKING_LEVELS } from "../ai/thinking.js";
import type { ModelThinkingLevel } from "../ai/types.js";
import type { SwitchRequest } from "../cli/compose-session.js";
import type { Runtime } from "../cli/runtime.js";
import { AmaError } from "../errors.js";
import {
  PERMISSION_MODE_ORDER,
  parsePermissionMode,
  permissionModeLabel,
} from "../permissions/modes.js";
import type { PermissionMode } from "../permissions/types.js";
import { pasteImage } from "./interactive/clipboard-paste.js";
import { planCommand } from "./interactive/plan-command.js";
import { rewindCommand } from "./interactive/rewind-command.js";
import {
  describeAgents,
  describeTaskOutput,
  describeTasks,
  stopTask,
} from "./interactive/tasks-report.js";
import { backgroundTasks, backgroundedText } from "./interactive/task-background.js";
import { describeCache, describeFingerprint, describeSession } from "./session-report.js";
import { describeContext } from "./context-report.js";
import { msg, type Catalog } from "../i18n/index.js";

export { describeSession } from "./session-report.js";

export type CommandResult =
  | {
      kind: "handled";
      message?: string;
      draft?: RewindDraftText;
      reload?: boolean;
      /** [W5-U] 命令开了一个新回合（`/plan approve`）：line 模式等它跑完再收下一行。 */
      wait?: boolean;
    }
  | { kind: "prompt"; text: string }
  | { kind: "pick"; what: "model" | "session" | "tree" | "permission" | "thinking" }
  | { kind: "exit" };

export interface CommandContext {
  readonly runtime: Runtime;
  /** 当前会话（切换后是新的那个）。 */
  session(): AgentSession;
  switchSession(request: SwitchRequest): Promise<AgentSession>;
  /**
   * `/permission <模式>` 切换前的确认（进入 Bypass 前问一次，见 permissions/bypass.ts）；返回 false
   * 保持原模式。没有时直接切换（管道、RPC 等无人值守入口）。
   */
  confirmPermissionMode?(mode: PermissionMode): boolean | Promise<boolean>;
  /**
   * [W6-C0] 第六波命令的处理器（命令名 → 处理器）：line 模式 `/config`（W6-S）、`/trace`（W6-T1）、
   * `/memory`（W6-M）等在这里挂；命中时先于内置分派。交互模式走 `CommandUi` 的面板钩子。
   */
  extra?: Readonly<Record<string, CommandHandler>>;
}

/** [W6-C0] `CommandContext.extra` 的处理器。 */
export type CommandHandler = (args: string, ctx: CommandContext) => Promise<CommandResult>;

/** [W6-C0] 各功能批次实现的第六波命令（没有处理器时回「尚未提供」）。 */
export const W6_COMMANDS = ["config", "trace", "memory"] as const;

export interface CommandInfo {
  name: string;
  args?: string;
  description: string;
}

type CommandKey = keyof Catalog["report"]["commands"];

/**
 * 说明与需要翻译的参数占位按界面语言取（getter，不在 import 时定死，docs/guides/i18n.md）；
 * `args` 是字符串时原样（不含要翻译的词），是 `{ key }` 时取目录里的占位。
 */
function command(name: string, key: CommandKey, args?: string | { key: CommandKey }): CommandInfo {
  const info = {
    name,
    get description(): string {
      return msg().report.commands[key];
    },
  } as CommandInfo;
  if (typeof args === "string") info.args = args;
  else if (args !== undefined)
    Object.defineProperty(info, "args", {
      enumerable: true,
      get: () => msg().report.commands[args.key],
    });
  return info;
}

export const BUILTIN_COMMANDS: readonly CommandInfo[] = [
  command("help", "help"),
  command("new", "new"),
  command("resume", "resume", "[id]"),
  command("fork", "fork", { key: "forkArgs" }),
  command("compact", "compact", { key: "compactArgs" }),
  command("rewind", "rewind", "[n] [both|conversation|code|summarize-from|summarize-up-to]"),
  command("model", "model", "[provider/id]"),
  command("thinking", "thinking", { key: "thinkingArgs" }),
  command("permission", "permission", { key: "permissionArgs" }),
  command("tools", "tools", { key: "toolsArgs" }),
  command("hooks", "hooks"),
  command("session", "session"),
  command("context", "context"),
  command("cache", "cache", "[warm off|streaming|idle | fingerprint]"),
  command("statusline", "statusline", "[full|compact]"),
  command("plan", "plan", { key: "planArgs" }),
  command("tasks", "tasks", "[id] | stop <id> | bg [id]"),
  command("agents", "agents"),
  command("paste", "paste"),
  command("interrupt", "interrupt", { key: "interruptArgs" }),
  command("exit", "exit"),
  // [W6-C0] 第六波（W6-S / W6-T1 / W6-M 实现）
  command("config", "config", "[key=value]"),
  command("trace", "trace", { key: "traceArgs" }),
  command("memory", "memory", { key: "memoryArgs" }),
];

const ALIASES: Readonly<Record<string, string>> = { quit: "exit", q: "exit", "?": "help" };

export function parseSlash(line: string): { name: string; args: string } | undefined {
  const m = /^\/([A-Za-z?][\w-]*)(?:\s+([\s\S]*))?$/.exec(line.trim());
  if (m === null) return undefined;
  const raw = (m[1] as string).toLowerCase();
  return { name: ALIASES[raw] ?? raw, args: (m[2] ?? "").trim() };
}

function helpText(): string {
  const lines = BUILTIN_COMMANDS.map(
    (c) => `/${c.name}${c.args !== undefined ? ` ${c.args}` : ""}  ${c.description}`,
  );
  const m = msg().report.commands;
  return [...lines, m.skillLine, m.templateLine].join("\n");
}

function toolNames(args: string): string[] {
  return args
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** `/cache`、`/cache warm <模式>`、`/cache fingerprint`。 */
function cacheCommand(session: AgentSession, args: string): string {
  const [sub, value, extra] = args.split(/\s+/).filter((s) => s !== "");
  if (sub === undefined) return describeCache(session);
  if (sub === "fingerprint" && value === undefined) return describeFingerprint(session);
  if (sub === "warm" && extra === undefined) {
    if (!(session instanceof AgentSessionImpl))
      throw new AmaError("invalid_arguments", msg().report.command.warmingUnsupported);
    if (value === undefined) return msg().report.command.warming(session.cache.mode());
    if (!(WARMING_MODES as readonly string[]).includes(value))
      throw new AmaError("invalid_arguments", msg().report.command.warmingInvalid(WARMING_MODES));
    session.cache.setWarming(value as WarmingMode);
    return msg().report.command.warmingSet(session.cache.mode());
  }
  throw new AmaError("invalid_arguments", msg().report.command.cacheUsage);
}

/** `/tasks`、`/tasks <id>`、`/tasks stop <id>`、`/tasks bg [id]`（[W7-C] 无 id = 全部前台任务）。 */
async function tasksCommand(session: AgentSession, args: string): Promise<string> {
  const sessionId = session.state.sessionId;
  const [first, second, extra] = args.split(/\s+/).filter((s) => s !== "");
  const now = Date.now();
  if (first === undefined) return describeTasks(sessionId, now);
  if (first === "bg" && extra === undefined)
    return backgroundedText(backgroundTasks(session, second));
  if (first === "stop" && second !== undefined && extra === undefined) {
    await stopTask(sessionId, second);
    return msg().report.command.taskStopped(second);
  }
  if (second === undefined) return describeTaskOutput(sessionId, first, now);
  throw new AmaError("invalid_arguments", msg().report.command.tasksUsage);
}

export async function runSlashCommand(
  line: string,
  ctx: CommandContext,
): Promise<CommandResult | undefined> {
  const parsed = parseSlash(line);
  if (parsed === undefined) return undefined;
  const { name, args } = parsed;
  const handler = ctx.extra?.[name];
  if (handler !== undefined) return handler(args, ctx);
  const session = ctx.session();
  switch (name) {
    case "help":
      return { kind: "handled", message: helpText() };
    case "exit":
      return { kind: "exit" };
    case "new": {
      const next = await ctx.switchSession({ kind: "new" });
      return {
        kind: "handled",
        message: msg().report.command.newSession(next.state.sessionId.slice(0, 8)),
      };
    }
    case "resume": {
      if (args === "") return { kind: "pick", what: "session" };
      const next = await ctx.switchSession({ kind: "resume", id: args });
      return {
        kind: "handled",
        message: msg().report.command.resumed(
          next.state.sessionId.slice(0, 8),
          next.messages.length,
        ),
      };
    }
    case "fork": {
      if (args === "") return { kind: "pick", what: "tree" };
      const next = await ctx.switchSession({ kind: "fork", entryId: args });
      return {
        kind: "handled",
        message: msg().report.command.forked(next.state.sessionId.slice(0, 8)),
      };
    }
    case "compact": {
      const result = await session.compact(args === "" ? undefined : args);
      return {
        kind: "handled",
        message: msg().report.command.compacted(result.tokensBefore, result.tokensAfter),
      };
    }
    case "model": {
      if (args === "") return { kind: "pick", what: "model" };
      await session.setModel(args);
      const model = session.state.model;
      return {
        kind: "handled",
        message: msg().report.command.model(`${model?.provider}/${model?.id}`),
      };
    }
    case "thinking": {
      if (args === "") return { kind: "pick", what: "thinking" };
      if (!(THINKING_LEVELS as readonly string[]).includes(args))
        throw new AmaError(
          "invalid_arguments",
          msg().report.command.thinkingInvalid(THINKING_LEVELS),
        );
      session.setThinkingLevel(args as ModelThinkingLevel);
      return { kind: "handled", message: msg().report.command.thinking(args) };
    }
    case "permission": {
      if (args === "") return { kind: "pick", what: "permission" };
      const mode = parsePermissionMode(args);
      if (mode === undefined) {
        throw new AmaError(
          "invalid_arguments",
          msg().report.command.permissionInvalid(PERMISSION_MODE_ORDER),
        );
      }
      const current = session.state.permissionMode;
      if (mode !== current && ctx.confirmPermissionMode !== undefined) {
        if (!(await ctx.confirmPermissionMode(mode))) {
          return {
            kind: "handled",
            message: msg().report.command.permissionCancelled(permissionModeLabel(current)),
          };
        }
      }
      session.setPermissionMode(mode);
      return {
        kind: "handled",
        message: msg().report.command.permission(permissionModeLabel(mode)),
      };
    }
    case "tools": {
      if (args !== "") session.setActiveTools(toolNames(args));
      const active = session.getTools().map((t) => t.name);
      const all = ctx.runtime.tools.list();
      const inactive = all.filter((n) => !active.includes(n));
      return {
        kind: "handled",
        message: msg().report.command.tools(active, inactive),
      };
    }
    case "hooks": {
      const hooks = ctx.runtime.hooks.list();
      if (hooks.length === 0) return { kind: "handled", message: msg().report.command.noHooks };
      return {
        kind: "handled",
        message: hooks
          .map(
            (h) =>
              `${h.source} ${h.event}${h.matcher !== undefined ? ` [${h.matcher}]` : ""} → ${h.command}`,
          )
          .join("\n"),
      };
    }
    case "session":
      return { kind: "handled", message: describeSession(session) };
    case "context":
      return { kind: "handled", message: describeContext(session) };
    case "cache":
      return { kind: "handled", message: cacheCommand(session, args) };
    case "rewind":
      return { kind: "handled", ...(await rewindCommand(session, args)) };
    case "plan":
      return planCommand(session, args, ctx);
    case "tasks":
      return { kind: "handled", message: await tasksCommand(session, args) };
    case "interrupt": {
      // 打断并立即发送：运行中中止当前回合、以「排队的插话 + 本条」开新回合；空闲时就是普通提示
      if (args === "") throw new AmaError("invalid_arguments", msg().report.command.interruptUsage);
      const { isStreaming, isCompacting } = session.state;
      if (!isStreaming && !isCompacting) return { kind: "prompt", text: args };
      void session.prompt(args, { interrupt: true }).catch(() => undefined);
      return { kind: "handled", message: msg().report.command.interruptSent(args) };
    }
    case "agents":
      return { kind: "handled", message: describeAgents(session.state.sessionId) };
    case "paste": {
      const pasted = await pasteImage(ctx.runtime.paths.dataDir);
      return pasted.ok
        ? {
            kind: "handled",
            message: msg().report.command.pasted(pasted.path),
            draft: { text: `${pasted.ref} ` },
          }
        : { kind: "handled", message: pasted.message };
    }
    case "statusline":
      // [W5-A] 交互界面在 commands-core 之前自己处理；line 模式没有底部信息行
      return { kind: "handled", message: msg().report.command.statuslineOnly };
    case "config":
    case "trace":
    case "memory":
      return { kind: "handled", message: msg().interactive.commands.unavailable(name) };
    default:
      return undefined;
  }
}
