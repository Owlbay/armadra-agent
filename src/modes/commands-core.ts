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
 */

import { AgentSessionImpl } from "../agent/session.js";
import type { AgentSession } from "../agent/types.js";
import { WARMING_MODES, type WarmingMode } from "../ai/cache/types.js";
import { THINKING_LEVELS } from "../ai/thinking.js";
import type { ModelThinkingLevel } from "../ai/types.js";
import type { SwitchRequest } from "../cli/compose-session.js";
import type { Runtime } from "../cli/runtime.js";
import { AmaError } from "../errors.js";
import { PERMISSION_MODES_STRICT_FIRST, type PermissionMode } from "../permissions/types.js";
import { describeCache, describeFingerprint, describeSession } from "./session-report.js";

export { describeSession } from "./session-report.js";

export type CommandResult =
  | { kind: "handled"; message?: string }
  | { kind: "prompt"; text: string }
  | { kind: "pick"; what: "model" | "session" | "tree" | "permission" | "thinking" }
  | { kind: "exit" };

export interface CommandContext {
  readonly runtime: Runtime;
  /** 当前会话（切换后是新的那个）。 */
  session(): AgentSession;
  switchSession(request: SwitchRequest): Promise<AgentSession>;
}

export interface CommandInfo {
  name: string;
  args?: string;
  description: string;
}

export const BUILTIN_COMMANDS: readonly CommandInfo[] = [
  { name: "help", description: "列出命令" },
  { name: "new", description: "新建会话" },
  { name: "resume", args: "[id]", description: "恢复会话（无 id 时选择）" },
  { name: "fork", args: "[条目 id]", description: "从某条目分叉出新会话" },
  { name: "compact", args: "[说明]", description: "压缩上下文" },
  { name: "model", args: "[provider/id]", description: "切换模型" },
  {
    name: "thinking",
    args: "[级别]",
    description: "思考级别 off | minimal | low | medium | high | xhigh",
  },
  {
    name: "permission",
    args: "[模式]",
    description: "权限模式 plan | default | auto-edit | full-auto",
  },
  { name: "tools", args: "[名字…]", description: "列出 / 设置活动工具" },
  { name: "hooks", description: "列出已加载的 Hook" },
  { name: "session", description: "会话信息、用量与缓存" },
  {
    name: "cache",
    args: "[warm off|streaming|idle | fingerprint]",
    description: "缓存统计；切换本会话保温；打印前缀指纹",
  },
  { name: "exit", description: "退出" },
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
  return [...lines, "/skill:<名字> [参数]  使用 Skill", "/<模板名> [参数]  展开提示模板"].join(
    "\n",
  );
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
      throw new AmaError("invalid_arguments", "当前会话不支持切换保温");
    if (value === undefined) return `保温：${session.cache.mode()}`;
    if (!(WARMING_MODES as readonly string[]).includes(value))
      throw new AmaError("invalid_arguments", `保温模式应为 ${WARMING_MODES.join(" | ")}`);
    session.cache.setWarming(value as WarmingMode);
    return `保温：${session.cache.mode()}（本会话）`;
  }
  throw new AmaError("invalid_arguments", "用法：/cache [warm off|streaming|idle | fingerprint]");
}

export async function runSlashCommand(
  line: string,
  ctx: CommandContext,
): Promise<CommandResult | undefined> {
  const parsed = parseSlash(line);
  if (parsed === undefined) return undefined;
  const { name, args } = parsed;
  const session = ctx.session();
  switch (name) {
    case "help":
      return { kind: "handled", message: helpText() };
    case "exit":
      return { kind: "exit" };
    case "new": {
      const next = await ctx.switchSession({ kind: "new" });
      return { kind: "handled", message: `已新建会话 ${next.state.sessionId.slice(0, 8)}` };
    }
    case "resume": {
      if (args === "") return { kind: "pick", what: "session" };
      const next = await ctx.switchSession({ kind: "resume", id: args });
      return {
        kind: "handled",
        message: `已恢复会话 ${next.state.sessionId.slice(0, 8)}（${next.messages.length} 条消息）`,
      };
    }
    case "fork": {
      if (args === "") return { kind: "pick", what: "tree" };
      const next = await ctx.switchSession({ kind: "fork", entryId: args });
      return { kind: "handled", message: `已分叉到新会话 ${next.state.sessionId.slice(0, 8)}` };
    }
    case "compact": {
      const result = await session.compact(args === "" ? undefined : args);
      const after = result.tokensAfter !== undefined ? ` → ${result.tokensAfter}` : "";
      return { kind: "handled", message: `已压缩：${result.tokensBefore}${after} token` };
    }
    case "model": {
      if (args === "") return { kind: "pick", what: "model" };
      await session.setModel(args);
      const model = session.state.model;
      return { kind: "handled", message: `模型：${model?.provider}/${model?.id}` };
    }
    case "thinking": {
      if (args === "") return { kind: "pick", what: "thinking" };
      if (!(THINKING_LEVELS as readonly string[]).includes(args))
        throw new AmaError("invalid_arguments", `思考级别应为 ${THINKING_LEVELS.join(" | ")}`);
      session.setThinkingLevel(args as ModelThinkingLevel);
      return { kind: "handled", message: `思考级别：${args}` };
    }
    case "permission": {
      if (args === "") return { kind: "pick", what: "permission" };
      if (!(PERMISSION_MODES_STRICT_FIRST as readonly string[]).includes(args)) {
        throw new AmaError(
          "invalid_arguments",
          `权限模式应为 ${PERMISSION_MODES_STRICT_FIRST.join(" | ")}`,
        );
      }
      session.setPermissionMode(args as PermissionMode);
      return { kind: "handled", message: `权限模式：${args}` };
    }
    case "tools": {
      if (args !== "") session.setActiveTools(toolNames(args));
      const active = session.getTools().map((t) => t.name);
      const all = ctx.runtime.tools.list();
      const inactive = all.filter((n) => !active.includes(n));
      return {
        kind: "handled",
        message: `活动：${active.join(", ") || "（无）"}${inactive.length > 0 ? `\n可用：${inactive.join(", ")}` : ""}`,
      };
    }
    case "hooks": {
      const hooks = ctx.runtime.hooks.list();
      if (hooks.length === 0) return { kind: "handled", message: "没有已加载的 Hook" };
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
    case "cache":
      return { kind: "handled", message: cacheCommand(session, args) };
    default:
      return undefined;
  }
}
