/**
 * 手写参数解析（设计 §11.1 第 2 步、§12.10、§13）。[B5]
 *
 * - 支持 `--opt value` 与 `--opt=value`；`--` 之后全部作为提示文本；可重复的参数累加。
 * - 位置参数 `-`：`-p` 一直等 stdin 到 EOF（有提示参数时也不设首字节超时）。
 * - 子命令只在第一个参数是 `auth / sessions / models / providers / doctor / config / init` 时识别，
 *   其余参数原样交给子命令。
 * - 互斥：`-p` 与 `--mode rpc / acp`；`--continue` / `--resume` / `--session-id` / `--fork` 两两互斥；
 *   `--trust` 与 `--no-trust`；`--api-key` 需要 `--model`；`--output-format` 需要 `-p`。
 * - `--resume [id]`：下一个参数形如会话 id（无空白、不以 `-` 开头）才被当作 id；
 *   否则仍作为提示文本。显式写法 `--resume=<id>`。
 * - `--provider` 不带 `--model` 不在这里报错，由 bootstrap 第 11 步报（退出码 2）。
 * - [W6-C0] `--lang zh|en` 也可写在子命令名之前（`ama --lang en doctor`）；`--memory` / `--no-memory`。
 */

import { AmaError } from "../errors.js";
import type { ModelThinkingLevel } from "../ai/types.js";
import { PERMISSION_MODES_STRICT_FIRST, type PermissionMode } from "../permissions/types.js";
import { canonicalPreset, type CodemodeMode, type ToolsPreset } from "../config/types.js";
import { CODEMODE_MODES } from "../config/types.js";
import { LOCALES, msg, type Locale } from "../i18n/index.js";

export const SUBCOMMANDS = [
  "auth",
  "sessions",
  "models",
  "providers",
  "doctor",
  "config",
  "init",
  "stats",
  // [W6-C0] W6-M 实现（cli/subcommands/memory.ts）；之前 main.ts 报「尚未提供」
  "memory",
] as const;
export type SubcommandName = (typeof SUBCOMMANDS)[number];

export type OutputFormat = "text" | "json" | "stream-json";
export type QuietStartup = "normal" | "header" | "silent";

export interface ParsedArgs {
  help: boolean;
  version: boolean;
  profile?: string;
  host?: string;
  instructions: string[];
  skillDirs: string[];
  authFile?: string;
  permissionMode?: PermissionMode;
  allow: string[];
  deny: string[];
  model?: string;
  provider?: string;
  apiKey?: string;
  thinking?: ModelThinkingLevel;
  continue: boolean;
  /** `--resume` 出现即为 true；`resumeId` 为可选 id。 */
  resume: boolean;
  resumeId?: string;
  sessionId?: string;
  fork?: string;
  sessionDir?: string;
  print: boolean;
  outputFormat?: OutputFormat;
  /** `--mode rpc`；[W5-C0] `--mode acp`（ACP 服务端，W5-E 实现前报「尚未实现」）。 */
  mode?: "rpc" | "acp";
  noTui: boolean;
  tuiMode?: "regular";
  quietStartup?: QuietStartup;
  /** `--trust` → true、`--no-trust` → false。 */
  trust?: boolean;
  tools?: string[];
  excludeTools?: string[];
  /** `--tools-preset`：覆盖 config `tools.preset`。 */
  toolsPreset?: ToolsPreset;
  /** `--codemode`：覆盖 config `codemode.mode`。 */
  codemode?: CodemodeMode;
  /** `--no-session`：会话只在内存里，不写会话文件。 */
  noSession: boolean;
  /** `--system-prompt <文本|@文件>`：缺省追加进系统提示的 rules 节。 */
  systemPrompt?: string;
  /** `--system-prompt-mode`：append（缺省）| replace（替换开头的 preamble）。 */
  systemPromptMode?: "append" | "replace";
  /** `--max-turns N`（只用于 -p）：一次运行最多 N 轮（模型请求 + 工具执行算一轮）。 */
  maxTurns?: number;
  /** [W5-C0] `--max-cost USD`：一次运行的美元上限（W5-H2 实现前只透传并提示未生效）。 */
  maxCostUsd?: number;
  /** [W5-C0] `--agent-dir <目录>`（可重复）：子 Agent 定义目录（W5-G 实现前只透传）。 */
  agentDirs?: string[];
  /** 位置参数 `-`（只用于 -p）：一直等 stdin 到 EOF，不设首字节超时。 */
  stdin: boolean;
  /** `--no-stdin`（只用于 -p）：不读 stdin。 */
  noStdin: boolean;
  /** `--image <文件>`（可重复，只用于 -p）：随首条提示发送的图片。 */
  images: string[];
  /** `--from <会话 id>[#编号]`：用旧会话的一条用户消息作为提示（cli/from-prompt.ts）。 */
  from?: string;
  /** 位置参数拼成的提示（空格连接）。 */
  prompt?: string;
  /** 原始位置参数。 */
  positionals: string[];
  /** [W6-C0] `--lang zh|en`：界面语言（`AMA_LANG` 优先，docs/guides/i18n.md）。 */
  lang?: Locale;
  /** [W6-C0] `--memory` → true、`--no-memory` → false：覆盖 `memory.enabled`（W6-M）。 */
  memory?: boolean;
}

export type ParseResult =
  | { kind: "run"; args: ParsedArgs }
  | { kind: "subcommand"; name: SubcommandName; argv: string[]; lang?: Locale };

export class UsageError extends AmaError {
  constructor(message: string) {
    super("invalid_arguments", message, { exitCode: 2 });
    this.name = "UsageError";
  }
}

const PERMISSION_MODES: readonly PermissionMode[] = PERMISSION_MODES_STRICT_FIRST;
const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
const OUTPUT_FORMATS: readonly OutputFormat[] = ["text", "json", "stream-json"];
const QUIET_LEVELS: readonly QuietStartup[] = ["normal", "header", "silent"];
/** 帮助与报错按常用顺序列出（校验集合同 TOOLS_PRESET_INPUTS；`codemode` 是 `codemode-only` 的别名）。 */
const PRESET_CHOICES = ["default", "minimal", "codemode-only", "coordinator", "codemode"] as const;
const SESSION_ID_LIKE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export { helpText } from "./help-text.js";

type ValueOption =
  | "profile"
  | "host"
  | "instructions"
  | "skill-dir"
  | "auth-file"
  | "permission-mode"
  | "allow"
  | "deny"
  | "model"
  | "provider"
  | "api-key"
  | "thinking"
  | "session-id"
  | "fork"
  | "session-dir"
  | "output-format"
  | "mode"
  | "tui-mode"
  | "quiet-startup"
  | "tools"
  | "exclude-tools"
  | "tools-preset"
  | "codemode"
  | "image"
  | "max-turns"
  | "max-cost"
  | "agent-dir"
  | "system-prompt"
  | "system-prompt-mode"
  | "from"
  | "lang";

const VALUE_OPTIONS: ReadonlySet<string> = new Set<ValueOption>([
  "profile",
  "host",
  "instructions",
  "skill-dir",
  "auth-file",
  "permission-mode",
  "allow",
  "deny",
  "model",
  "provider",
  "api-key",
  "thinking",
  "session-id",
  "fork",
  "session-dir",
  "output-format",
  "mode",
  "tui-mode",
  "quiet-startup",
  "tools",
  "exclude-tools",
  "tools-preset",
  "codemode",
  "image",
  "max-turns",
  "max-cost",
  "agent-dir",
  "system-prompt",
  "system-prompt-mode",
  "from",
  "lang",
]);

const FLAG_ALIASES: Readonly<Record<string, string>> = {
  "-h": "help",
  "-v": "version",
  "-p": "print",
  "-c": "continue",
  "-r": "resume",
};

function choice<T extends string>(option: string, value: string, choices: readonly T[]): T {
  if ((choices as readonly string[]).includes(value)) return value as T;
  throw new UsageError(msg().cli.args.invalidChoice(option, choices, value));
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function emptyArgs(): ParsedArgs {
  return {
    help: false,
    version: false,
    instructions: [],
    skillDirs: [],
    allow: [],
    deny: [],
    images: [],
    continue: false,
    resume: false,
    print: false,
    noTui: false,
    noSession: false,
    stdin: false,
    noStdin: false,
    positionals: [],
  };
}

function applyValue(args: ParsedArgs, option: ValueOption, value: string): void {
  if (value === "") throw new UsageError(msg().cli.args.emptyValue(option));
  switch (option) {
    case "profile":
      args.profile = value;
      break;
    case "host":
      args.host = value;
      break;
    case "instructions":
      args.instructions.push(value);
      break;
    case "skill-dir":
      args.skillDirs.push(value);
      break;
    case "auth-file":
      args.authFile = value;
      break;
    case "permission-mode":
      args.permissionMode = choice(option, value, PERMISSION_MODES);
      break;
    case "allow":
      args.allow.push(value);
      break;
    case "deny":
      args.deny.push(value);
      break;
    case "model":
      args.model = value;
      break;
    case "provider":
      args.provider = value;
      break;
    case "api-key":
      args.apiKey = value;
      break;
    case "thinking":
      args.thinking = choice(option, value, THINKING_LEVELS);
      break;
    case "session-id":
      args.sessionId = value;
      break;
    case "fork":
      args.fork = value;
      break;
    case "session-dir":
      args.sessionDir = value;
      break;
    case "output-format":
      args.outputFormat = choice(option, value, OUTPUT_FORMATS);
      break;
    case "mode":
      args.mode = choice(option, value, ["rpc", "acp"] as const);
      break;
    case "tui-mode":
      if (value === "fullscreen") throw new UsageError(msg().cli.args.fullscreenUnsupported);
      args.tuiMode = choice(option, value, ["regular"] as const);
      break;
    case "quiet-startup":
      args.quietStartup = choice(option, value, QUIET_LEVELS);
      break;
    case "tools":
      args.tools = [...(args.tools ?? []), ...list(value)];
      break;
    case "exclude-tools":
      args.excludeTools = [...(args.excludeTools ?? []), ...list(value)];
      break;
    case "tools-preset":
      args.toolsPreset = canonicalPreset(choice(option, value, PRESET_CHOICES));
      break;
    case "codemode":
      args.codemode = choice(option, value, CODEMODE_MODES);
      break;
    case "image":
      args.images.push(value);
      break;
    case "system-prompt":
      args.systemPrompt = value;
      break;
    case "system-prompt-mode":
      args.systemPromptMode = choice(option, value, ["append", "replace"] as const);
      break;
    case "max-turns": {
      const turns = Number(value);
      if (!Number.isInteger(turns) || turns < 1)
        throw new UsageError(msg().cli.args.maxTurnsPositive(value));
      args.maxTurns = turns;
      break;
    }
    case "max-cost": {
      const usd = Number(value);
      if (!Number.isFinite(usd) || usd <= 0)
        throw new UsageError(msg().cli.args.maxCostPositive(value));
      args.maxCostUsd = usd;
      break;
    }
    case "agent-dir":
      (args.agentDirs ??= []).push(value);
      break;
    case "from":
      args.from = value;
      break;
    case "lang":
      args.lang = choice(option, value, LOCALES);
      break;
  }
}

function applyFlag(args: ParsedArgs, name: string): boolean {
  switch (name) {
    case "help":
      args.help = true;
      return true;
    case "version":
      args.version = true;
      return true;
    case "print":
      args.print = true;
      return true;
    case "continue":
      args.continue = true;
      return true;
    case "no-tui":
      args.noTui = true;
      return true;
    case "no-session":
      args.noSession = true;
      return true;
    case "no-stdin":
      args.noStdin = true;
      return true;
    case "trust":
    case "no-trust": {
      const value = name === "trust";
      if (args.trust !== undefined && args.trust !== value) {
        throw new UsageError(msg().cli.args.flagConflict("--trust", "--no-trust"));
      }
      args.trust = value;
      return true;
    }
    case "memory":
    case "no-memory": {
      const value = name === "memory";
      if (args.memory !== undefined && args.memory !== value)
        throw new UsageError(msg().cli.args.flagConflict("--memory", "--no-memory"));
      args.memory = value;
      return true;
    }
    default:
      return false;
  }
}

function validate(args: ParsedArgs): void {
  const m = msg().cli.args;
  if (args.print && args.mode !== undefined) throw new UsageError(m.printWithMode(args.mode));
  const sessionFlags = [
    args.continue ? "--continue" : undefined,
    args.resume ? "--resume" : undefined,
    args.sessionId !== undefined ? "--session-id" : undefined,
    args.fork !== undefined ? "--fork" : undefined,
  ].filter((f): f is string => f !== undefined);
  if (sessionFlags.length > 1) throw new UsageError(m.flagsConflict(sessionFlags));
  if (args.noSession && sessionFlags.length > 0) {
    throw new UsageError(m.flagConflict("--no-session", sessionFlags[0] ?? ""));
  }
  if (args.apiKey !== undefined && args.model === undefined) {
    throw new UsageError(m.apiKeyNeedsModel);
  }
  if (args.outputFormat !== undefined && !args.print) {
    throw new UsageError(m.printOnly("--output-format"));
  }
  if (args.systemPromptMode !== undefined && args.systemPrompt === undefined) {
    throw new UsageError(m.systemPromptModeNeedsPrompt);
  }
  if (args.maxTurns !== undefined && !args.print) {
    throw new UsageError(m.printOnly("--max-turns"));
  }
  if (args.noStdin && !args.print) throw new UsageError(m.printOnly("--no-stdin"));
  if (args.noStdin && args.stdin) throw new UsageError(m.noStdinWithDash);
  if (args.stdin && !args.print) {
    throw new UsageError(m.dashPrintOnly);
  }
  if (args.images.length > 0 && !args.print) {
    throw new UsageError(m.imagePrintOnly);
  }
}

/**
 * ACP terminal 型认证方法的入口（docs/reference/acp.md「无模型时」）：客户端把方法的 `args` **追加**到配置好的
 * Agent 启动命令后面（规范原文 append），实际得到 `ama --mode acp … --acp-terminal-auth <id>`。
 * 见到这个标志就不再按启动参数解析，转成对应的 `auth` 子命令；同一条命令里的 `--auth-file`、`--lang` 一并带上。
 */
export const ACP_TERMINAL_AUTH_FLAG = "--acp-terminal-auth";

const ACP_TERMINAL_AUTH_ARGV: Record<string, readonly string[]> = {
  chatgpt: ["login", "chatgpt"],
  "api-key": ["set"],
};

function acpTerminalAuth(argv: readonly string[]): ParseResult | undefined {
  let id: string | undefined;
  let lang: Locale | undefined;
  let authFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--") break;
    if (token === ACP_TERMINAL_AUTH_FLAG) id = argv[++i] ?? "";
    else if (token.startsWith(`${ACP_TERMINAL_AUTH_FLAG}=`))
      id = token.slice(ACP_TERMINAL_AUTH_FLAG.length + 1);
    else if (token === "--auth-file") authFile = argv[++i];
    else if (token.startsWith("--auth-file=")) authFile = token.slice("--auth-file=".length);
    else if (token === "--lang" && argv[i + 1] !== undefined)
      lang = choice("lang", argv[++i] as string, LOCALES);
    else if (token.startsWith("--lang=")) lang = choice("lang", token.slice(7), LOCALES);
  }
  if (id === undefined) return undefined;
  const sub = ACP_TERMINAL_AUTH_ARGV[id];
  if (sub === undefined) throw new UsageError(msg().cli.args.unknownTerminalAuth(id));
  return {
    kind: "subcommand",
    name: "auth",
    argv: [...sub, ...(authFile !== undefined ? ["--auth-file", authFile] : [])],
    ...(lang !== undefined ? { lang } : {}),
  };
}

/** 解析 argv（不含 node 与脚本路径）；用法错误抛 UsageError（退出码 2）。 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const lead = leadingLang(argv);
  const terminalAuth = acpTerminalAuth(argv);
  if (terminalAuth !== undefined) return terminalAuth;
  const first = argv[lead.next];
  if (first !== undefined && (SUBCOMMANDS as readonly string[]).includes(first)) {
    return {
      kind: "subcommand",
      name: first as SubcommandName,
      argv: argv.slice(lead.next + 1),
      ...(lead.lang !== undefined ? { lang: lead.lang } : {}),
    };
  }
  const args = emptyArgs();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token === "--") {
      args.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token === "-") {
      args.stdin = true;
      continue;
    }
    if (!token.startsWith("-")) {
      args.positionals.push(token);
      continue;
    }
    let name: string;
    let inline: string | undefined;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      inline = eq === -1 ? undefined : token.slice(eq + 1);
    } else {
      const alias = FLAG_ALIASES[token];
      if (alias === undefined) throw new UsageError(msg().cli.args.unknownOption(token));
      name = alias;
    }
    if (name === "resume") {
      args.resume = true;
      const next = argv[i + 1];
      if (inline !== undefined) {
        if (inline === "") throw new UsageError(msg().cli.args.emptyResumeId);
        args.resumeId = inline;
      } else if (next !== undefined && SESSION_ID_LIKE.test(next)) {
        args.resumeId = next;
        i++;
      }
      continue;
    }
    if (VALUE_OPTIONS.has(name)) {
      let value = inline;
      if (value === undefined) {
        value = argv[i + 1];
        if (value === undefined) throw new UsageError(msg().cli.args.needsValue(name));
        i++;
      }
      applyValue(args, name as ValueOption, value);
      continue;
    }
    if (inline !== undefined) throw new UsageError(msg().cli.args.noValue(name));
    if (!applyFlag(args, name)) throw new UsageError(msg().cli.args.unknownOption(token));
  }
  if (args.positionals.length > 0) args.prompt = args.positionals.join(" ");
  if (!args.help && !args.version) validate(args);
  return { kind: "run", args };
}

/** [W6-C0] 子命令名之前的 `--lang X` / `--lang=X`（可重复，后者为准）。 */
function leadingLang(argv: readonly string[]): { lang?: Locale; next: number } {
  let lang: Locale | undefined;
  let i = 0;
  for (;;) {
    const token = argv[i];
    if (token === "--lang" && argv[i + 1] !== undefined) {
      const value = argv[i + 1] as string;
      lang = choice("lang", value, LOCALES);
      i += 2;
    } else if (token?.startsWith("--lang=") === true) {
      lang = choice("lang", token.slice("--lang=".length), LOCALES);
      i += 1;
    } else break;
  }
  // 后面不是子命令时整段交回普通解析（--lang 照常进 ParsedArgs）
  const next = argv[i];
  if (next === undefined || !(SUBCOMMANDS as readonly string[]).includes(next)) return { next: 0 };
  return lang === undefined ? { next: i } : { lang, next: i };
}

/** 子命令内部的小解析器：`--name value` / `--name=value` / 位置参数。 */
export function parseSubArgs(
  argv: readonly string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[] = [],
): { positionals: string[]; values: Map<string, string>; flags: Set<string> } {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      if (token === "-h") flags.add("help");
      else positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (name === "help") {
      flags.add("help");
      continue;
    }
    if (valueOptions.includes(name)) {
      const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
      if (value === undefined || value === "")
        throw new UsageError(msg().cli.args.needsValue(name));
      values.set(name, value);
    } else if (flagOptions.includes(name) && eq === -1) {
      flags.add(name);
    } else {
      throw new UsageError(msg().cli.args.unknownOption(token));
    }
  }
  return { positionals, values, flags };
}
