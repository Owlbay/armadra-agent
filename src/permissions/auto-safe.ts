/**
 * auto 模式下 bash 的规则层与静态判定（§7.4，docs/permissions.md）。
 *
 * 规则层（命中即询问，不调模型）——外层与每层嵌套命令（`sh -c`、`eval`、`xargs`、`find -exec`，
 * 见 dangerous.ts）的每一段都查：
 * - 网络命令（{@link networkReason}）：curl / wget / ssh / git push|pull|fetch|clone / npm install / npx …
 * - 删除与回退（{@link destructiveReason}）：rm -r|-f、find -delete、git clean / restore / checkout -- …
 * - 写入目标：重定向（`>`、`>>`、`&>`）、tee、cp / mv / mkdir / touch / ln / chmod 等的目标在项目外或受保护；
 * - 参数里出现机密路径（`cat .env`、`< ~/.ssh/id_rsa`、`--env-file=.env`）。
 *
 * 静态判定（全部满足即放行）：每一段都命中安全名单（{@link AUTO_SAFE_COMMANDS} + 用户追加），整条命令
 * 没有命令替换、参数没有变量展开 `$X`、没有可能匹配点文件的通配、没有超深嵌套。
 *
 * 分段与分词复用 rules.ts / dangerous.ts（引号内不切、剥环境赋值与 env / nohup / time 等前缀）。
 */

import { splitShellSegments, hasCommandSubstitution, wildcardToRegExp } from "./rules.js";
import { collectNestedCommands, commandWords, gitArgv, shellWords } from "./dangerous.js";
import { secretPathReason, writeProtectionReason } from "./protected.js";
import { homedir } from "node:os";
import { resolvePath } from "../tools/paths.js";

// ---------------------------------------------------------------------------
// 安全名单
// ---------------------------------------------------------------------------

export interface SafeCommandSpec {
  /** 词前缀：`["git", "status"]` 命中 `git status -s`。git 的全局选项只允许 `-C <dir>` 与 `--no-pager`。 */
  words: readonly string[];
  /** 前缀之后任一参数命中即不安全。 */
  forbid?: RegExp;
  /** 前缀之后必须出现的参数。 */
  require?: string;
}

const s = (text: string, extra: Omit<SafeCommandSpec, "words"> = {}): SafeCommandSpec => ({
  words: text.split(" "),
  ...extra,
});

const pm = (tools: readonly string[], scripts: readonly string[]): SafeCommandSpec[] =>
  tools.flatMap((tool) => scripts.map((script) => s(`${tool} ${script}`)));

/** 初始安全名单（每条在 auto-safe.test.ts 有正反例）。 */
export const AUTO_SAFE_COMMANDS: readonly SafeCommandSpec[] = [
  ...[
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "grep",
    "egrep",
    "fgrep",
    "pwd",
    "echo",
    "printf",
    "which",
    "printenv",
    "true",
    "false",
    "cut",
    "tr",
    "diff",
    "basename",
    "dirname",
    "realpath",
    "stat",
    "file",
    "du",
    "df",
    "whoami",
    "uname",
    "cd",
    "pushd",
    "popd",
  ].map((name) => s(name)),
  s("rg", { forbid: /^--pre(=.*)?$/ }),
  s("sort", { forbid: /^(-o.*|--output.*)$/ }),
  s("date", { forbid: /^(-s.*|--set.*)$/ }),
  s("find", { forbid: /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/ }),
  ...["status", "rev-parse", "blame", "ls-files"].map((sub) => s(`git ${sub}`)),
  ...["diff", "log", "show"].map((sub) =>
    s(`git ${sub}`, { forbid: /^(--output(=.*)?|--ext-diff|--textconv)$/ }),
  ),
  s("git branch", {
    forbid:
      /^(-[A-Za-z]*[dDmMcCfuet][A-Za-z]*|--(delete|move|copy|force|set-upstream-to.*|unset-upstream|edit-description|track.*|no-track|create-reflog))$/,
  }),
  ...pm(["npm", "pnpm", "yarn"], ["test", "run test", "run lint", "run typecheck", "run build"]),
  ...pm(["pnpm", "yarn"], ["lint", "typecheck", "build"]),
  s("npm t"),
  s("node --test"),
  s("tsc", { require: "--noEmit" }),
  s("pnpm tsc", { require: "--noEmit" }),
  s("vitest run"),
  s("pnpm vitest run"),
  s("pnpm exec vitest run"),
  s("yarn vitest run"),
  s("pytest"),
  s("python -m pytest"),
  s("python3 -m pytest"),
  ...["test", "check", "build", "clippy"].map((sub) => s(`cargo ${sub}`)),
  ...["test", "build", "vet"].map((sub) => s(`go ${sub}`)),
  ...["test", "check", "lint", "build"].map((sub) => s(`make ${sub}`)),
];

/** git 子命令之前允许出现的全局选项（`-c` 可改 pager / diff 程序，不允许）。 */
function gitPrefixSafe(argv: readonly string[]): boolean {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-C") i++;
    else if (a === "--no-pager") continue;
    else return !a.startsWith("-");
  }
  return true;
}

function matchesSpec(argv: readonly string[], spec: SafeCommandSpec): boolean {
  let words = argv;
  if (spec.words[0] === "git") {
    if (!gitPrefixSafe(argv)) return false;
    words = gitArgv(argv) ?? argv;
  }
  if (words.length < spec.words.length) return false;
  if (!spec.words.every((w, i) => words[i] === w)) return false;
  const rest = words.slice(spec.words.length);
  if (spec.forbid !== undefined && rest.some((a) => spec.forbid!.test(a))) return false;
  return spec.require === undefined || rest.includes(spec.require);
}

/**
 * 用户追加的安全命令（`permission.autoSafeCommands`）：不含 `*` 按词前缀；含 `*` 按通配匹配整段
 * （剥过前缀、重定向之后的命令文本）。
 */
export function extraSafeMatches(argv: readonly string[], entry: string): boolean {
  const text = argv.join(" ");
  if (entry.includes("*")) return wildcardToRegExp(entry.trim().replace(/\s+/g, " ")).test(text);
  const words = shellWords(entry);
  return words.length > 0 && words.every((w, i) => argv[i] === w);
}

// ---------------------------------------------------------------------------
// 规则层：网络、删除类
// ---------------------------------------------------------------------------

function base(word: string | undefined): string {
  return (word ?? "").split("/").pop() ?? "";
}

const NETWORK_TOOLS = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ftp",
  "socat",
  "aria2c",
  "http",
  "https",
  "gh",
  "npx",
  "bunx",
  "pnpx",
]);
const GIT_NETWORK = new Set(["push", "pull", "fetch", "clone", "ls-remote"]);
const JS_NETWORK = new Set([
  "install",
  "i",
  "add",
  "ci",
  "update",
  "up",
  "upgrade",
  "publish",
  "dlx",
  "create",
  "login",
  "adduser",
]);
const PKG_INSTALL: Readonly<Record<string, ReadonlySet<string>>> = {
  pip: new Set(["install", "download"]),
  pip3: new Set(["install", "download"]),
  pipx: new Set(["install", "run"]),
  poetry: new Set(["install", "add", "update"]),
  uv: new Set(["add", "sync", "pip"]),
  cargo: new Set(["install", "publish", "update", "add"]),
  go: new Set(["get", "install"]),
  gem: new Set(["install", "push"]),
  brew: new Set(["install", "upgrade", "update", "tap"]),
  apt: new Set(["install", "update", "upgrade"]),
  "apt-get": new Set(["install", "update", "upgrade"]),
  yum: new Set(["install", "update"]),
  dnf: new Set(["install", "update"]),
  apk: new Set(["add", "update"]),
  pacman: new Set(["-S", "-Sy", "-Syu"]),
  docker: new Set(["pull", "push", "login"]),
  podman: new Set(["pull", "push", "login"]),
};

/** 网络命令：返回说明；不是返回 undefined。 */
export function networkReason(argv: readonly string[]): string | undefined {
  const name = base(argv[0]);
  if (NETWORK_TOOLS.has(name)) return `network command ${name}`;
  if (name === "git") {
    const g = gitArgv(argv) ?? argv;
    const sub = g[1] ?? "";
    if (GIT_NETWORK.has(sub)) return `network command git ${sub}`;
    if (sub === "submodule" && g.includes("update")) return "network command git submodule update";
    if (sub === "remote" && g[2] === "update") return "network command git remote update";
    return undefined;
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(name)) {
    if (name === "yarn" && argv.length === 1) return "package install (yarn)";
    const sub = argv[1] ?? "";
    if (JS_NETWORK.has(sub)) return `package manager network command ${name} ${sub}`;
    return undefined;
  }
  if (/^python3?$/.test(name) && argv[1] === "-m" && /^pip3?$/.test(argv[2] ?? "")) {
    return ["install", "download"].includes(argv[3] ?? "") ? "package install (pip)" : undefined;
  }
  const subs = PKG_INSTALL[name];
  if (subs !== undefined) {
    if (name === "go" && argv[1] === "mod" && argv[2] === "download")
      return "network command go mod download";
    if (subs.has(argv[1] ?? "")) return `network command ${name} ${argv[1]}`;
  }
  return undefined;
}

/** 删除与丢弃改动的命令：返回说明；不是返回 undefined。 */
export function destructiveReason(argv: readonly string[]): string | undefined {
  const name = base(argv[0]);
  const flags = argv.filter((a) => /^-[A-Za-z]+$/.test(a)).join("");
  if (name === "rm") {
    if (/[rRf]/.test(flags) || argv.includes("--recursive") || argv.includes("--force")) {
      return "recursive or forced rm";
    }
    return undefined;
  }
  if (name === "find" && argv.includes("-delete")) return "find -delete";
  if (name === "shred" || name === "truncate" || name === "srm")
    return `${name} destroys file data`;
  if (name === "git") {
    const g = gitArgv(argv) ?? argv;
    const sub = g[1] ?? "";
    if (sub === "clean") return "git clean";
    if (sub === "restore") return "git restore discards changes";
    if (
      sub === "checkout" &&
      g.slice(2).some((a) => a === "--" || a === "." || a === "-f" || a === "--force")
    ) {
      return "git checkout discarding changes";
    }
    if (sub === "stash" && (g[2] === "drop" || g[2] === "clear")) return `git stash ${g[2]}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 重定向与写入目标
// ---------------------------------------------------------------------------

export interface Redirects {
  /** 输出重定向目标（`>`、`>>`、`>|`、`&>`）。 */
  outputs: string[];
  /** 输入重定向来源（`<`）。 */
  inputs: string[];
  /** 去掉重定向之后的段文本。 */
  rest: string;
}

/** 从一段命令里取出重定向（引号内不算）；`2>&1`、`>&2` 是复制描述符，没有目标。 */
export function extractRedirects(segment: string): Redirects {
  const out: Redirects = { outputs: [], inputs: [], rest: "" };
  let rest = "";
  let quote: string | undefined;
  const readWord = (from: number): [string, number] => {
    let i = from;
    while (i < segment.length && /\s/.test(segment[i] as string)) i++;
    let word = "";
    let q: string | undefined;
    for (; i < segment.length; i++) {
      const ch = segment[i] as string;
      if (q !== undefined) {
        word += ch;
        if (ch === q) q = undefined;
        continue;
      }
      if (ch === "'" || ch === '"') {
        q = ch;
        word += ch;
      } else if (/\s/.test(ch) || ch === "<" || ch === ">") break;
      else word += ch;
    }
    return [shellWords(word)[0] ?? "", i];
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] as string;
    if (quote !== undefined) {
      rest += ch;
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) rest += segment[++i];
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      rest += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      rest += ch + segment[++i];
      continue;
    }
    if (ch === ">") {
      if (/\d$/.test(rest) && /(^|\s)\d$/.test(rest)) rest = rest.slice(0, -1);
      if (rest.endsWith("&")) rest = rest.slice(0, -1);
      let j = i + 1;
      if (segment[j] === ">" || segment[j] === "|") j++;
      if (segment[j] === "&") {
        // `>&2`、`>&-`：描述符复制或关闭
        j++;
        while (j < segment.length && /[\d-]/.test(segment[j] as string)) j++;
        i = j - 1;
        rest += " ";
        continue;
      }
      const [target, end] = readWord(j);
      if (target !== "") out.outputs.push(target);
      i = end - 1;
      rest += " ";
      continue;
    }
    if (ch === "<") {
      if (segment[i + 1] === "(") {
        rest += ch;
        continue;
      }
      if (/(^|\s)\d$/.test(rest)) rest = rest.slice(0, -1);
      let j = i + 1;
      let heredoc = false;
      if (segment[j] === "<") {
        heredoc = true;
        j++;
        if (segment[j] === "<" || segment[j] === "-") j++;
      }
      if (segment[j] === "&") {
        j++;
        while (j < segment.length && /[\d-]/.test(segment[j] as string)) j++;
        i = j - 1;
        rest += " ";
        continue;
      }
      const [source, end] = readWord(j);
      if (!heredoc && source !== "") out.inputs.push(source);
      i = end - 1;
      rest += " ";
      continue;
    }
    rest += ch;
  }
  out.rest = rest.trim().replace(/\s+/g, " ");
  return out;
}

const WRITE_ALL_ARGS = new Set([
  "mv",
  "mkdir",
  "touch",
  "rmdir",
  "rm",
  "chmod",
  "chown",
  "chgrp",
  "tee",
  "unlink",
]);
const WRITE_LAST_ARG = new Set(["cp", "ln", "install", "rsync"]);

/** 命令会写的路径（词法；flag 不算）。 */
function writeTargets(argv: readonly string[]): string[] {
  const name = base(argv[0]);
  const args = argv.slice(1).filter((a) => !a.startsWith("-"));
  if (WRITE_ALL_ARGS.has(name)) {
    return name === "chmod" || name === "chown" || name === "chgrp" ? args.slice(1) : args;
  }
  if (WRITE_LAST_ARG.has(name)) {
    const t = argv.indexOf("-t");
    if (t !== -1 && argv[t + 1] !== undefined) return [argv[t + 1] as string];
    return args.length > 1 ? [args[args.length - 1] as string] : [];
  }
  return [];
}

const GLOB = /[*?[]/;

/** 词里可能出现的路径（`--file=.env` 取等号后）。 */
function pathCandidates(word: string): string[] {
  const out = [word];
  const eq = word.indexOf("=");
  if (word.startsWith("-") && eq !== -1) out.push(word.slice(eq + 1));
  return out.filter((w) => w !== "" && !w.startsWith("-"));
}

function secretInWord(word: string, cwd: string): string | undefined {
  for (const candidate of pathCandidates(word)) {
    if (GLOB.test(candidate)) {
      const name = candidate.split("/").pop() ?? "";
      if (
        /^\.env/.test(name) ||
        /(^|\/)\.(ssh|aws|gnupg)(\/|$)/.test(candidate) ||
        /^id_/.test(name)
      ) {
        return `glob may match secret files (${candidate})`;
      }
      continue;
    }
    let abs: string;
    try {
      abs = resolvePath(candidate, cwd);
    } catch {
      continue;
    }
    const reason = secretPathReason(abs);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

function writeReason(target: string, cwd: string, projectRoot: string): string | undefined {
  if (target.includes("$")) return `write target with variable expansion (${target})`;
  let abs: string;
  try {
    abs = resolvePath(target, cwd);
  } catch {
    return `invalid write target ${target}`;
  }
  return writeProtectionReason(abs, projectRoot);
}

// ---------------------------------------------------------------------------
// 总入口
// ---------------------------------------------------------------------------

const CD = new Set(["cd", "pushd"]);

function cdTarget(argv: readonly string[], cwd: string): string {
  const target = argv.slice(1).find((a) => !a.startsWith("-"));
  try {
    return resolvePath(target ?? homedir(), cwd);
  } catch {
    return cwd;
  }
}

export interface BashAutoOptions {
  cwd: string;
  projectRoot: string;
  /** `permission.autoSafeCommands`。 */
  extraSafe?: readonly string[];
}

export interface BashAutoAnalysis {
  /** 规则层要询问的原因；undefined = 规则层不管。 */
  ask?: string;
  /** 静态判定放行。 */
  safe: boolean;
  /** 不安全（交给分类器）的原因，审计用。 */
  reason: string;
}

interface SegmentInfo {
  /** 剥掉环境赋值、包装命令与 sudo 之后的词（规则层用）。 */
  argv: string[];
  /** 保留 sudo / doas（静态判定用：提权命令不算安全）。 */
  withSudo: string[];
  redirects: Redirects;
}

function parseSegment(segment: string): SegmentInfo {
  const redirects = extractRedirects(segment);
  return {
    argv: commandWords(redirects.rest),
    withSudo: commandWords(redirects.rest, true),
    redirects,
  };
}

function ruleAsk(info: SegmentInfo, options: BashAutoOptions): string | undefined {
  const { argv, redirects } = info;
  const network = networkReason(argv);
  if (network !== undefined) return network;
  const destructive = destructiveReason(argv);
  if (destructive !== undefined) return destructive;
  for (const target of [...redirects.outputs, ...writeTargets(argv)]) {
    const reason = writeReason(target, options.cwd, options.projectRoot);
    if (reason !== undefined) return `${reason} (${target})`;
  }
  for (const word of [...argv.slice(1), ...redirects.inputs]) {
    const reason = secretInWord(word, options.cwd);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

function safeSegment(info: SegmentInfo, extra: readonly string[]): string | undefined {
  const argv = info.withSudo;
  if (argv.length === 0) return undefined;
  for (const word of argv) {
    if (word.includes("$")) return `variable expansion in ${word}`;
    if (GLOB.test(word) && /(^|\/)\.[^./]/.test(word)) return `glob over dotfiles (${word})`;
  }
  if (AUTO_SAFE_COMMANDS.some((spec) => matchesSpec(argv, spec))) return undefined;
  if (extra.some((entry) => extraSafeMatches(argv, entry))) return undefined;
  return `${base(argv[0])} is not in the auto safe list`;
}

/** auto 模式下一条 bash 命令的规则层与静态判定结论。 */
export function analyzeBashForAuto(command: string, options: BashAutoOptions): BashAutoAnalysis {
  const nested = collectNestedCommands(command);
  // 外层按顺序跟踪 `cd`：之后的相对路径按新的目录解析。嵌套命令按会话 cwd 解析。
  let cwd = options.cwd;
  for (const segment of splitShellSegments(command)) {
    const info = parseSegment(segment);
    const ask = ruleAsk(info, { ...options, cwd });
    if (ask !== undefined) return { ask, safe: false, reason: ask };
    if (CD.has(base(info.argv[0]))) cwd = cdTarget(info.argv, cwd);
  }
  for (const text of nested.commands) {
    for (const segment of splitShellSegments(text)) {
      const ask = ruleAsk(parseSegment(segment), options);
      if (ask !== undefined) return { ask, safe: false, reason: ask };
    }
  }
  if (hasCommandSubstitution(command)) {
    return { safe: false, reason: "command substitution" };
  }
  if (nested.tooDeep) return { safe: false, reason: "nested too deep" };
  const segments = splitShellSegments(command);
  if (segments.length === 0) return { safe: false, reason: "empty command" };
  for (const segment of segments) {
    const unsafe = safeSegment(parseSegment(segment), options.extraSafe ?? []);
    if (unsafe !== undefined) return { safe: false, reason: unsafe };
  }
  return { safe: true, reason: "every command is in the auto safe list" };
}
