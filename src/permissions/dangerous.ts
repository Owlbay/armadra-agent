/**
 * 危险命令表（设计 §7.2；v1 §7.1 的表 + `git branch -D`、`npm publish`、`docker system prune -a`、
 * `shutdown/reboot`）。[B3]
 *
 * 命中 → 管线第 ② 步 ask（无人值守 deny），allow 规则不能越过。识别按段进行：命令先按
 * `&&`、`||`、`;`、`|`、`&`、换行切段（引号内不切），每段剥掉前导的环境赋值与
 * `sudo / command / exec / nohup / time / env` 等前缀后看命令名；`sh -c '…'`、`eval …` 等包装里的
 * 命令递归识别，嵌套超过 {@link MAX_NESTING} 层按危险处理。整条命令另外做跨段检查
 * （`curl … | sh`、fork 炸弹）。每条规则都有正例与反例测试（dangerous.test.ts）。
 */

import { splitShellSegments } from "./rules.js";

export interface DangerousRule {
  id: string;
  description: string;
  /** 段级检查：`argv` 是剥掉前缀后的词，`segment` 是原段文本。 */
  segment?(argv: readonly string[], segment: string): boolean;
  /** 整条命令检查。 */
  whole?(command: string): boolean;
}

export interface DangerousMatch {
  id: string;
  description: string;
}

const WRAPPERS = new Set(["command", "exec", "nohup", "time", "env", "builtin", "nice", "xargs"]);

/**
 * 分词：按未加引号的空白切；单引号内原样，双引号内反斜杠只转义 `\`、`"`、`$`、反引号，引号外反斜杠转义下一个字符；
 * 相邻的引号段与普通字符拼成一个词（`'a'"b"c` → `abc`）。不做变量与通配展开。
 */
export function shellWords(segment: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] as string;
    if (/\s/.test(ch)) {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
      continue;
    }
    inWord = true;
    if (ch === "'") {
      const end = segment.indexOf("'", i + 1);
      const stop = end === -1 ? segment.length : end;
      cur += segment.slice(i + 1, stop);
      i = stop;
    } else if (ch === '"') {
      i++;
      while (i < segment.length && segment[i] !== '"') {
        const c = segment[i] as string;
        if (c === "\\" && i + 1 < segment.length && '\\"$`'.includes(segment[i + 1] as string)) {
          cur += segment[i + 1];
          i += 2;
        } else {
          cur += c;
          i++;
        }
      }
    } else if (ch === "\\" && i + 1 < segment.length) {
      cur += segment[++i];
    } else {
      cur += ch;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/** 剥前缀；`keepSudo` 为假时连 sudo 一并剥掉。 */
export function commandWords(segment: string, keepSudo = false): string[] {
  const words = shellWords(segment.replace(/^[({\s]+/, ""));
  let i = 0;
  while (i < words.length) {
    const w = words[i] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (WRAPPERS.has(w)) i++;
    else if (!keepSudo && (w === "sudo" || w === "doas")) {
      i++;
      while (i < words.length && (words[i] as string).startsWith("-")) i++;
    } else break;
  }
  return words.slice(i);
}

function base(word: string | undefined): string {
  return (word ?? "").split("/").pop() ?? "";
}

function flags(argv: readonly string[]): string {
  return argv
    .filter((a) => /^-[A-Za-z]/.test(a))
    .map((a) => a.slice(1))
    .join("");
}

function hasFlag(argv: readonly string[], short: string, long?: string): boolean {
  return argv.some(
    (a) => (/^-[A-Za-z]+$/.test(a) && a.includes(short)) || (long !== undefined && a === long),
  );
}

const RM_DANGEROUS_TARGETS =
  /^(\/|\/\*|~|~\/|~\/\*|\$HOME|\$HOME\/|\$HOME\/\*|\.|\.\/|\.\/\*|\*|\.\.|\.\.\/|\/\.\*)$/;

export const DANGEROUS_RULES: readonly DangerousRule[] = [
  {
    id: "rm-rf-root",
    description: "rm -rf on /, ~, ., .. or *",
    segment: (argv) => {
      if (base(argv[0]) !== "rm") return false;
      const f = flags(argv);
      const recursive = /[rR]/.test(f) || argv.includes("--recursive");
      const force = f.includes("f") || argv.includes("--force");
      return recursive && force && argv.slice(1).some((a) => RM_DANGEROUS_TARGETS.test(a));
    },
  },
  {
    id: "sudo",
    description: "privilege escalation with sudo",
    segment: (_argv, segment) => {
      const words = commandWords(segment, true);
      return base(words[0]) === "sudo" || base(words[0]) === "doas";
    },
  },
  { id: "su", description: "switching user with su", segment: (argv) => base(argv[0]) === "su" },
  {
    id: "dd",
    description: "raw disk copy with dd",
    segment: (argv) => base(argv[0]) === "dd",
  },
  {
    id: "mkfs",
    description: "creating a filesystem (mkfs)",
    segment: (argv) => /^mkfs(\.[a-z0-9]+)?$/.test(base(argv[0])),
  },
  {
    id: "write-block-device",
    description: "redirecting output to a block device",
    whole: (cmd) =>
      />\s*\/dev\/(sd[a-z]|hd[a-z]|nvme\d|disk\d|rdisk\d|mmcblk\d|xvd[a-z]|vd[a-z])/.test(cmd),
  },
  {
    id: "git-push-force",
    description: "git push --force",
    segment: (argv) =>
      base(argv[0]) === "git" &&
      argv[1] === "push" &&
      argv.some(
        (a) =>
          a === "--force" ||
          a.startsWith("--force-with-lease") ||
          a === "--force-if-includes" ||
          (/^-[A-Za-z]+$/.test(a) && a.includes("f")) ||
          /^\+/.test(a),
      ),
  },
  {
    id: "git-reset-hard",
    description: "git reset --hard",
    segment: (argv) => base(argv[0]) === "git" && argv[1] === "reset" && argv.includes("--hard"),
  },
  {
    id: "git-clean-force",
    description: "git clean -f (deletes untracked files)",
    segment: (argv) =>
      base(argv[0]) === "git" &&
      argv[1] === "clean" &&
      (hasFlag(argv, "f") || argv.includes("--force")),
  },
  {
    id: "git-branch-force-delete",
    description: "git branch -D",
    segment: (argv) =>
      base(argv[0]) === "git" &&
      argv[1] === "branch" &&
      (argv.some((a) => /^-[A-Za-z]*D[A-Za-z]*$/.test(a)) ||
        (argv.includes("--delete") && argv.includes("--force"))),
  },
  {
    id: "pipe-to-shell",
    description: "piping a download (curl / wget) into a shell",
    whole: (cmd) =>
      /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(env\s+)?(ba|z|da|k|fi)?sh\b/.test(cmd) ||
      /\b(ba|z)?sh\s+(-c\s+)?["']?\$\(\s*(curl|wget)\b/.test(cmd) ||
      /\b(ba|z)?sh\s+<\(\s*(curl|wget)\b/.test(cmd),
  },
  {
    id: "chmod-777-recursive",
    description: "chmod -R 777",
    segment: (argv) =>
      base(argv[0]) === "chmod" &&
      (hasFlag(argv, "R") || argv.includes("--recursive")) &&
      argv.some((a) => /^0?777$/.test(a) || a === "a+rwx"),
  },
  {
    id: "kill-all",
    description: "kill -9 -1 (kills every process you own)",
    segment: (argv) => base(argv[0]) === "kill" && argv.slice(1).includes("-1"),
  },
  {
    id: "fork-bomb",
    description: "fork bomb",
    whole: (cmd) => /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(cmd),
  },
  {
    id: "package-publish",
    description: "publishing a package (npm / pnpm / yarn publish)",
    segment: (argv) => ["npm", "pnpm", "yarn"].includes(base(argv[0])) && argv[1] === "publish",
  },
  {
    id: "docker-system-prune-all",
    description: "docker system prune -a",
    segment: (argv) =>
      base(argv[0]) === "docker" &&
      argv[1] === "system" &&
      argv[2] === "prune" &&
      (hasFlag(argv, "a") || argv.includes("--all")),
  },
  {
    id: "shutdown-reboot",
    description: "shutting down or rebooting the machine",
    segment: (argv) =>
      ["shutdown", "reboot", "halt", "poweroff"].includes(base(argv[0])) ||
      (base(argv[0]) === "systemctl" && ["poweroff", "reboot", "halt"].includes(argv[1] ?? "")) ||
      (base(argv[0]) === "init" && (argv[1] === "0" || argv[1] === "6")),
  },
];

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** 嵌套层数上限：`sh -c` / `eval` 等每包一层计一层，超过按危险处理。 */
export const MAX_NESTING = 3;

const TOO_DEEP: DangerousMatch = {
  id: "nested-too-deep",
  description: `shell command nested more than ${MAX_NESTING} levels deep`,
};

/** `sh -c 'cmd'` 的 cmd：选项簇里有 `c` 时取第一个非选项参数；`-o` / `+o` 吃掉下一个词。 */
function shellCommandString(argv: readonly string[]): string | undefined {
  let hasC = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") return hasC ? argv[i + 1] : undefined;
    if (a.startsWith("--")) continue;
    if (/^[-+][A-Za-z]+$/.test(a)) {
      if (a[0] === "-" && a.includes("c")) hasC = true;
      if (a.endsWith("o")) i++;
      continue;
    }
    return hasC ? a : undefined;
  }
  return undefined;
}

/**
 * 段内嵌套的命令文本（剥过前缀的 argv）：`sh / bash / zsh / dash / ksh -c '…'` 的字符串参数；
 * `eval` 其余词以空格拼接。
 */
export function nestedCommands(argv: readonly string[]): string[] {
  const name = base(argv[0]);
  if (SHELLS.has(name)) {
    const inner = shellCommandString(argv);
    return inner === undefined ? [] : [inner];
  }
  if (name === "eval") return argv.length > 1 ? [argv.slice(1).join(" ")] : [];
  return [];
}

/** 第一条命中的危险规则；无则 undefined。嵌套命令（{@link nestedCommands}）递归识别。 */
export function matchDangerous(command: string, depth = 0): DangerousMatch | undefined {
  for (const rule of DANGEROUS_RULES) {
    if (rule.whole?.(command)) return { id: rule.id, description: rule.description };
  }
  for (const segment of splitShellSegments(command)) {
    const argv = commandWords(segment);
    for (const rule of DANGEROUS_RULES) {
      if (rule.segment?.(argv, segment)) return { id: rule.id, description: rule.description };
    }
    for (const inner of nestedCommands(argv)) {
      if (depth >= MAX_NESTING) return TOO_DEEP;
      const hit = matchDangerous(inner, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}
