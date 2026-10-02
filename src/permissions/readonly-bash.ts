/**
 * plan 模式与 allowlist 放行的只读 bash 子集 `READONLY_BASH`（docs/wave5-plan.md §6.2、D21）。[W5-F]
 *
 * 判定 = auto 的静态判定（`analyzeBashForAuto`：分词、嵌套展开、规则层的网络 / 删除 / 写入目标 /
 * 机密路径、命令替换、变量展开、点文件通配）**全部通过**，再加四条更窄的限制：
 * - 每段命令都命中 {@link READONLY_BASH}（比 auto 安全名单窄：去掉测试 / 构建运行器、`printenv`
 *   这类会把环境变量里的密钥打进上下文的命令）；
 * - 没有输出重定向（`/dev/null` 等设备除外）；
 * - 没有嵌套 shell（`sh -c`、`eval`、`xargs`、`find -exec`）与进程替换；
 * - 段首没有环境赋值或包装命令（`GIT_EXTERNAL_DIFF=… git diff`、`env …`、`nohup …`）。
 *
 * 机密路径（`cat .env`）由 auto 规则层判为「要询问」，这里因此不算只读；deny 规则仍先于模式判定。
 */

import { analyzeBashForAuto, extractRedirects } from "./auto-safe.js";
import { collectNestedCommands, commandWords, gitArgv, shellWords } from "./dangerous.js";
import { splitShellSegments } from "./rules.js";

export interface ReadonlySpec {
  /** 词前缀（`["git", "log"]`）；git 的全局选项只允许 `-C <dir>` 与 `--no-pager`。 */
  words: readonly string[];
  /** 前缀之后任一参数命中即不算只读。 */
  forbid?: RegExp;
}

const spec = (text: string, forbid?: RegExp): ReadonlySpec =>
  forbid === undefined ? { words: text.split(" ") } : { words: text.split(" "), forbid };

const GIT_OUTPUT = /^(--output(=.*)?|--ext-diff|--textconv|-O.*|--open-files-in-pager.*)$/;

/** 只读命令名单（每条在 readonly-bash.test.ts 有正反例）。 */
export const READONLY_BASH: readonly ReadonlySpec[] = [
  ...[
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "stat",
    "echo",
    "printf",
    "pwd",
    "which",
    "du",
    "tree",
    "basename",
    "dirname",
    "realpath",
    "true",
    "false",
    "cd",
  ].map((name) => spec(name, name === "tree" ? /^-o.*$/ : undefined)),
  spec("file", /^(-C|--compile)$/),
  ...["grep", "egrep", "fgrep"].map((name) => spec(name)),
  spec("rg", /^--pre(=.*)?$/),
  spec("fd", /^(-x|-X|--exec|--exec-batch)(=.*)?$/),
  spec("find", /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/),
  spec("jq", /^(-i|--in-place)$/),
  ...["status", "rev-parse", "blame", "ls-files"].map((sub) => spec(`git ${sub}`, GIT_OUTPUT)),
  ...["log", "show", "diff"].map((sub) => spec(`git ${sub}`, GIT_OUTPUT)),
  spec(
    "git branch",
    /^(-[A-Za-z]*[dDmMcCfuet][A-Za-z]*|--(delete|move|copy|force|set-upstream-to.*|unset-upstream|edit-description|track.*|no-track|create-reflog))$/,
  ),
];

/** auto 安全名单里没有、但属于只读子集的命令（交给 analyzeBashForAuto 当作追加项）。 */
const EXTRA_FOR_AUTO = ["tree", "jq", "fd"];

const DEVICE_TARGETS = /^(\/dev\/(null|stdout|stderr|tty)|NUL)$/i;

function base(word: string | undefined): string {
  return (word ?? "").split("/").pop() ?? "";
}

/** git 子命令之前只允许 `-C <dir>` 与 `--no-pager`（`-c` 可改 pager / diff 程序）。 */
function gitPrefixSafe(argv: readonly string[]): boolean {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-C") i++;
    else if (a === "--no-pager") continue;
    else return !a.startsWith("-");
  }
  return true;
}

function matches(argv: readonly string[], entry: ReadonlySpec): boolean {
  let words = argv;
  if (entry.words[0] === "git") {
    if (base(argv[0]) !== "git" || !gitPrefixSafe(argv)) return false;
    words = ["git", ...(gitArgv(argv) ?? argv).slice(1)];
  } else if (argv[0] !== entry.words[0]) return false;
  if (words.length < entry.words.length) return false;
  if (!entry.words.every((w, i) => words[i] === w)) return false;
  const rest = words.slice(entry.words.length);
  return entry.forbid === undefined || !rest.some((a) => entry.forbid!.test(a));
}

export interface ReadonlyBashOptions {
  /** 相对路径（机密路径、写入目标）的解析基准；缺省 `process.cwd()`。 */
  cwd?: string;
  projectRoot?: string;
}

/** 不是只读的原因；只读返回 undefined。 */
export function readonlyBashReason(
  command: string,
  options: ReadonlyBashOptions = {},
): string | undefined {
  const cwd = options.cwd ?? process.cwd();
  const nested = collectNestedCommands(command);
  if (nested.commands.length > 0 || nested.tooDeep) return "nested shell command";
  const auto = analyzeBashForAuto(command, {
    cwd,
    projectRoot: options.projectRoot ?? cwd,
    extraSafe: EXTRA_FOR_AUTO,
  });
  if (!auto.safe) return auto.ask ?? auto.reason;
  for (const segment of splitShellSegments(command)) {
    const redirects = extractRedirects(segment);
    const target = redirects.outputs.find((t) => !DEVICE_TARGETS.test(t));
    if (target !== undefined) return `output redirection (${target})`;
    const raw = shellWords(redirects.rest.replace(/^[({\s]+/, ""));
    const argv = commandWords(redirects.rest, true);
    if (argv.length === 0) return "empty command";
    if (raw[0] !== argv[0]) return `environment assignment or wrapper before ${argv[0]}`;
    if (!READONLY_BASH.some((entry) => matches(argv, entry)))
      return `${base(argv[0])} is not in the read-only list`;
  }
  return undefined;
}

/** 每段命令都在 {@link READONLY_BASH} 且无重定向 / 命令替换 / 嵌套 shell。 */
export function isReadonlyBash(command: string, options: ReadonlyBashOptions = {}): boolean {
  return readonlyBashReason(command, options) === undefined;
}
