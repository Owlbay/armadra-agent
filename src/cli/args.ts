/**
 * 手写参数解析（设计 §11.1 第 2 步、§12.10、§13）。[B5]
 *
 * - 支持 `--opt value` 与 `--opt=value`；`--` 之后全部作为提示文本；可重复的参数累加。
 * - 位置参数 `-`：`-p` 显式读 stdin（有提示参数时也拼接）。
 * - 子命令只在第一个参数是 `auth / sessions / models / providers / doctor / config / init` 时识别，
 *   其余参数原样交给子命令。
 * - 互斥：`-p` 与 `--mode rpc`；`--continue` / `--resume` / `--session-id` / `--fork` 两两互斥；
 *   `--trust` 与 `--no-trust`；`--api-key` 需要 `--model`；`--output-format` 需要 `-p`。
 * - `--resume [id]`：下一个参数形如会话 id（无空白、不以 `-` 开头）才被当作 id；
 *   否则仍作为提示文本。显式写法 `--resume=<id>`。
 * - `--provider` 不带 `--model` 不在这里报错，由 bootstrap 第 11 步报（退出码 2）。
 */

import { AmaError } from "../errors.js";
import type { ModelThinkingLevel } from "../ai/types.js";
import { PERMISSION_MODES_STRICT_FIRST, type PermissionMode } from "../permissions/types.js";
import type { CodemodeMode, ToolsPreset } from "../config/types.js";
import { CODEMODE_MODES } from "../config/types.js";

export const SUBCOMMANDS = [
  "auth",
  "sessions",
  "models",
  "providers",
  "doctor",
  "config",
  "init",
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
  /** `--mode rpc`。 */
  mode?: "rpc";
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
  /** 位置参数 `-`（只用于 -p）：显式读 stdin，有提示参数时也拼接。 */
  stdin: boolean;
  /** `--image <文件>`（可重复，只用于 -p）：随首条提示发送的图片。 */
  images: string[];
  /** 位置参数拼成的提示（空格连接）。 */
  prompt?: string;
  /** 原始位置参数。 */
  positionals: string[];
}

export type ParseResult =
  { kind: "run"; args: ParsedArgs } | { kind: "subcommand"; name: SubcommandName; argv: string[] };

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
/** 帮助与报错按常用顺序列出（校验集合同 TOOLS_PRESETS_STRICT_FIRST）。 */
const PRESET_CHOICES: readonly ToolsPreset[] = ["default", "minimal", "codemode", "coordinator"];
const SESSION_ID_LIKE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const HELP_TEXT = `用法：ama [选项] [提示]
      ama <子命令> …

模式
  （缺省）                     终端界面；stdin / stdout 非 TTY 或 TERM=dumb 时自动降级为行式
  --no-tui                     行式界面（readline + 括号粘贴）
  -p, --print                  非交互：执行提示后退出。提示取自参数；没有提示参数时读 stdin，
                               有提示参数时只有加 - 才拼接 stdin（如 cat 文件 | ama -p 总结 -）
  --output-format <格式>       -p 的输出：text（缺省）| json | stream-json
  --image <文件>               -p 随提示发送图片（可重复；png / jpg / gif / webp，单张 ≤ 5 MB）；
                               交互界面里写 @图片路径 或粘贴图片路径
  --mode rpc                   stdio JSONL 协议（供嵌入）
  --tui-mode <模式>            显示模式，第一期只有 regular（主屏）
  --quiet-startup <档>         启动画面：normal | header | silent

模型
  --model <provider/id>        模型（可配合 --provider 只写 id；@渠道 指定渠道，如 packy/kimi-k2.5@messages）
  --provider <id>              供应商（必须同时给 --model）
  --api-key <key>              只用于本次启动的 key（需要 --model；优先用 ama auth set）
  --thinking <级别>            off | minimal | low | medium | high | xhigh

会话
  -c, --continue               继续本目录最近的会话
  -r, --resume [id]            恢复会话（交互模式无 id 时弹选择器）
  --session-id <id>            使用指定 id 的会话（不存在则新建）
  --fork <id>                  从指定会话分叉出新会话
  --session-dir <目录>         会话目录（缺省 ~/.local/share/ama/sessions）

权限与信任
  --permission-mode <模式>     default | auto-edit | plan | auto | full-auto | allowlist
                               （auto 由 ama 判断每一步；allowlist 只放行 allow 规则命中的，适合 CI）
  --allow <规则>               追加允许规则，可重复（如 "bash(git status*)"）
  --deny <规则>                追加拒绝规则，可重复（如 "write(**/.env*)"）
  --trust / --no-trust         信任 / 不信任当前项目（项目级 Hook、Skill、提示模板）

资源
  --profile <文件>             宿主 profile.json（字段等价于对应参数，命令行优先）
  --host <模块>                宿主适配器模块（CJS / ESM）
  --instructions <文件>        追加指令文件，可重复
  --skill-dir <目录>           追加 Skill 目录，可重复
  --auth-file <文件>           auth.json 位置（缺省 ~/.config/ama/auth.json）
  --tools <a,b,…>              只启用这些工具
  --exclude-tools <a,b,…>      禁用这些工具
  --tools-preset <名>          工具预设：default（缺省）| minimal | codemode | coordinator
  --codemode <模式>            codemode 调用方式：off | on | only

子命令
  ama auth set <provider>      从 stdin 读取 key 写入 auth.json（0600）
  ama auth list                列出已保存 key 的供应商（不显示 key）
  ama auth remove <provider>   删除已保存的 key
  ama sessions list|show|prune 会话管理
  ama models list [--provider <id>]  列出模型（含来源与 key 状态）
  ama models check <provider/id>     发一次最小请求检查可用性
  ama models discover <provider> [--probe] [--write] [--limit N]
                               从中转 /v1/models 列出模型，探测协议并写入配置
  ama models refresh-catalog   强制刷新 models.dev 模型元数据缓存
  ama providers add <id> --base-url <url> [--key-env VAR] [--probe] [--channel n=api@url] [--yes]
                               一键接入：列模型、补 models.dev 元数据、探测渠道、写入配置
  ama providers list|channels <id>|remove <id>|refresh <id>
                               供应商 → 渠道 → 模型；删除；重拉模型列表
  ama models cache-probe <provider/id> [--tokens N] [--gap-ms MS] [--yes] [--json]
                               判断端点是否报告缓存命中
  ama doctor                   配置层级、信任、key 来源、Hook、终端能力
  ama config show [--json]     生效配置与每项来源、将使用的模型
  ama config path              配置目录、数据目录与各文件路径
  ama config edit              用 $VISUAL / $EDITOR 打开 config.json
  ama init [--force]           建配置目录（0700）与 config.json、config.schema.json；已有的不覆盖

其它
  -h, --help                   输出本帮助
  -v, --version                输出版本

退出码：0 正常 · 1 运行期错误 · 2 用法错误 · 3 配置错误 · 4 无可用模型或 key ·
        5 会话错误 · 6 宿主 / Hook 启动失败 · 78 宿主 API 版本不匹配 · 130 SIGINT · 143 SIGTERM
`;

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
  | "image";

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
  throw new UsageError(`--${option} 的取值应为 ${choices.join(" | ")}（收到 ${value}）`);
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
    stdin: false,
    positionals: [],
  };
}

function applyValue(args: ParsedArgs, option: ValueOption, value: string): void {
  if (value === "") throw new UsageError(`--${option} 的值不能为空`);
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
      args.mode = choice(option, value, ["rpc"] as const);
      break;
    case "tui-mode":
      if (value === "fullscreen")
        throw new UsageError("--tui-mode fullscreen 尚未支持（第一期只有 regular）");
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
      args.toolsPreset = choice(option, value, PRESET_CHOICES);
      break;
    case "codemode":
      args.codemode = choice(option, value, CODEMODE_MODES);
      break;
    case "image":
      args.images.push(value);
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
    case "trust":
    case "no-trust": {
      const value = name === "trust";
      if (args.trust !== undefined && args.trust !== value) {
        throw new UsageError("--trust 与 --no-trust 不能同时使用");
      }
      args.trust = value;
      return true;
    }
    default:
      return false;
  }
}

function validate(args: ParsedArgs): void {
  if (args.print && args.mode === "rpc") throw new UsageError("-p 与 --mode rpc 不能同时使用");
  const sessionFlags = [
    args.continue ? "--continue" : undefined,
    args.resume ? "--resume" : undefined,
    args.sessionId !== undefined ? "--session-id" : undefined,
    args.fork !== undefined ? "--fork" : undefined,
  ].filter((f): f is string => f !== undefined);
  if (sessionFlags.length > 1) throw new UsageError(`${sessionFlags.join(" 与 ")} 不能同时使用`);
  if (args.apiKey !== undefined && args.model === undefined) {
    throw new UsageError("--api-key 需要同时给出 --model");
  }
  if (args.outputFormat !== undefined && !args.print) {
    throw new UsageError("--output-format 只用于 -p / --print");
  }
  if (args.stdin && !args.print) {
    throw new UsageError("位置参数 - （从 stdin 读提示）只用于 -p / --print");
  }
  if (args.images.length > 0 && !args.print) {
    throw new UsageError("--image 只用于 -p / --print（交互界面里写 @图片路径）");
  }
}

/** 解析 argv（不含 node 与脚本路径）；用法错误抛 UsageError（退出码 2）。 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const first = argv[0];
  if (first !== undefined && (SUBCOMMANDS as readonly string[]).includes(first)) {
    return { kind: "subcommand", name: first as SubcommandName, argv: argv.slice(1) };
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
      if (alias === undefined) throw new UsageError(`未知选项：${token}`);
      name = alias;
    }
    if (name === "resume") {
      args.resume = true;
      const next = argv[i + 1];
      if (inline !== undefined) {
        if (inline === "") throw new UsageError("--resume= 的 id 不能为空");
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
        if (value === undefined) throw new UsageError(`--${name} 需要一个值`);
        i++;
      }
      applyValue(args, name as ValueOption, value);
      continue;
    }
    if (inline !== undefined) throw new UsageError(`--${name} 不接受值`);
    if (!applyFlag(args, name)) throw new UsageError(`未知选项：${token}`);
  }
  if (args.positionals.length > 0) args.prompt = args.positionals.join(" ");
  if (!args.help && !args.version) validate(args);
  return { kind: "run", args };
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
      if (value === undefined || value === "") throw new UsageError(`--${name} 需要一个值`);
      values.set(name, value);
    } else if (flagOptions.includes(name) && eq === -1) {
      flags.add(name);
    } else {
      throw new UsageError(`未知选项：${token}`);
    }
  }
  return { positionals, values, flags };
}
