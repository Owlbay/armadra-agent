/**
 * 权限规则（设计 §7.2、§5.2「通用安全」）。[B3]
 *
 * 语法：`tool` 或 `tool(pattern)`；`tool` 是工具名 glob（`canvas_*`、`*`）；pattern：
 * - bash：对命令文本做通配（`*` 任意字符含空格与 `/`，`?` 单字符），命令先折叠空白；
 * - 带 `path` 的工具（read / write / edit / ls / grep / glob 及宿主工具）：对路径做 glob（`**`）。
 *   相对模式匹配 cwd 内的相对路径；以 `**` 开头的模式也匹配绝对路径（例如 .ssh 目录规则命中 ~/.ssh 下的文件）；
 *   绝对模式（`/…`、`~/…`）匹配绝对路径。缺 path 的调用以 cwd 为路径。
 * - 其它工具带 pattern 的规则不匹配（无可比对的对象）。
 *
 * bash 复合命令：deny 规则命中整条或**任一**段即生效；allow 规则要求**每一**段都被某条 allow 覆盖，
 * 且命令里没有 `$(…)` / 反引号替换——否则 allow 不生效（回到「问」）。
 *
 * 来源约束（§7.2）：项目级只能收紧——allow 被忽略、mode 只能更严，均产生 warning。
 */

import { isAbsolute, relative, resolve } from "node:path";
import { AmaError } from "../errors.js";
import type { PermissionMode, Rule, RuleSource } from "./types.js";
import { PERMISSION_MODES_STRICT_FIRST } from "./types.js";
import { globBody } from "../tools/glob.js";
import { expandHome, resolvePath, toPosix } from "../tools/paths.js";
import { memoryRuleMatches } from "./memory-class.js";

/** 内置缺省 deny 表（用户可经 `builtinDeny` 选项移除）。 */
export const BUILTIN_DENY_RULES: readonly string[] = [
  "write(**/.git/**)",
  "edit(**/.git/**)",
  "read(**/.ssh/**)",
  "write(**/.ssh/**)",
  "edit(**/.ssh/**)",
];

const RULE_RE = /^([A-Za-z0-9_*?]+)(?:\((.*)\))?$/s;

export function parseRule(raw: string, effect: "allow" | "deny", source: RuleSource): Rule {
  const text = raw.trim();
  const m = RULE_RE.exec(text);
  if (!m || (m[2] !== undefined && m[2].trim() === "")) {
    throw new AmaError("invalid_arguments", `Invalid permission rule "${raw}"`);
  }
  const rule: Rule = { effect, tool: m[1] as string, source, raw: text };
  if (m[2] !== undefined) rule.pattern = m[2].trim();
  return rule;
}

export function wildcardToRegExp(pattern: string): RegExp {
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") out += "[\\s\\S]*";
    else if (ch === "?") out += "[\\s\\S]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function toolNameMatches(ruleTool: string, toolName: string): boolean {
  return ruleTool === toolName || wildcardToRegExp(ruleTool).test(toolName);
}

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * 按 `&&`、`||`、`;`、`|`、`&`、换行切分（引号内不切），每段 trim 后返回非空段。
 */
export function splitShellSegments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === "\\" && i + 1 < command.length) {
      cur += ch + command[++i];
    } else if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      // `>&2`、`2>&1`、`&>` 是重定向不是分隔。
      if (ch === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) {
        cur += ch;
        continue;
      }
      out.push(cur);
      cur = "";
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => normalizeCommand(s)).filter((s) => s !== "");
}

export function hasCommandSubstitution(command: string): boolean {
  return /\$\(|`|<\(|>\(/.test(command);
}

function pathGlob(pattern: string): RegExp {
  return new RegExp(`^${globBody(pattern, { braces: true })}$`);
}

/** 输入里的路径（绝对）；没有 path 字段的工具返回 undefined。 */
export function inputPath(toolName: string, input: unknown, cwd: string): string | undefined {
  const raw =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)["path"]
      : undefined;
  if (typeof raw === "string") {
    try {
      return resolvePath(raw, cwd);
    } catch {
      return undefined;
    }
  }
  if (["read", "write", "edit", "ls", "grep", "glob"].includes(toolName))
    return resolvePath(".", cwd);
  return undefined;
}

export function inputCommand(input: unknown): string | undefined {
  const raw =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)["command"]
      : undefined;
  return typeof raw === "string" ? raw : undefined;
}

export function pathMatches(pattern: string, absPath: string, cwd: string): boolean {
  const absPosix = toPosix(absPath);
  const expanded = expandHome(pattern);
  if (isAbsolute(expanded)) return pathGlob(toPosix(resolve(expanded))).test(absPosix);
  const regex = pathGlob(pattern.replace(/^\.\//, ""));
  const rel = relative(cwd, absPath);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (inside && regex.test(toPosix(rel))) return true;
  if (rel === "" && (pattern === "**" || pattern === "*" || pattern === ".")) return true;
  return pattern.startsWith("**") && regex.test(absPosix.replace(/^\/+/, ""));
}

/** 单条规则对一个（非复合）对象是否命中。 */
function matchesSubject(
  rule: Rule,
  toolName: string,
  input: unknown,
  cwd: string,
  command?: string,
): boolean {
  if (!toolNameMatches(rule.tool, toolName)) return false;
  if (rule.pattern === undefined) return true;
  if (toolName === "memory") return memoryRuleMatches(rule.pattern, input); // [W6-M] 逻辑路径 / 命令名
  if (command !== undefined) return wildcardToRegExp(rule.pattern).test(command);
  const abs = inputPath(toolName, input, cwd);
  return abs !== undefined && pathMatches(rule.pattern, abs, cwd);
}

/** 第一条命中的 deny 规则。 */
export function findDenyRule(
  rules: readonly Rule[],
  toolName: string,
  input: unknown,
  cwd: string,
): Rule | undefined {
  const command = toolName === "memory" ? undefined : inputCommand(input);
  for (const rule of rules) {
    if (rule.effect !== "deny") continue;
    if (command === undefined || rule.pattern === undefined) {
      if (matchesSubject(rule, toolName, input, cwd)) return rule;
      continue;
    }
    const subjects = [normalizeCommand(command), ...splitShellSegments(command)];
    if (subjects.some((s) => matchesSubject(rule, toolName, input, cwd, s))) return rule;
  }
  return undefined;
}

/** 覆盖本次调用的 allow 规则（复合命令返回第一段的覆盖者）；不覆盖返回 undefined。 */
export function findAllowRule(
  rules: readonly Rule[],
  toolName: string,
  input: unknown,
  cwd: string,
): Rule | undefined {
  const allows = rules.filter((r) => r.effect === "allow");
  const command = toolName === "memory" ? undefined : inputCommand(input);
  if (command === undefined) return allows.find((r) => matchesSubject(r, toolName, input, cwd));
  const unconditional = allows.find(
    (r) => r.pattern === undefined && toolNameMatches(r.tool, toolName),
  );
  if (unconditional) return unconditional;
  if (hasCommandSubstitution(command)) return undefined;
  const segments = splitShellSegments(command);
  if (segments.length === 0) return undefined;
  let first: Rule | undefined;
  for (const seg of segments) {
    const hit = allows.find((r) => matchesSubject(r, toolName, input, cwd, seg));
    if (!hit) return undefined;
    first ??= hit;
  }
  return first;
}

// ---------------------------------------------------------------------------
// 来源合并与收紧校验
// ---------------------------------------------------------------------------

/** a 是否比 b 更严（或相等）。 */
export function isAtLeastAsStrict(a: PermissionMode, b: PermissionMode): boolean {
  return PERMISSION_MODES_STRICT_FIRST.indexOf(a) <= PERMISSION_MODES_STRICT_FIRST.indexOf(b);
}

export interface PermissionLayer {
  source: RuleSource;
  mode?: PermissionMode;
  allow?: readonly string[];
  deny?: readonly string[];
}

export interface ResolvedPermissions {
  mode: PermissionMode;
  rules: Rule[];
  warnings: string[];
}

export interface ResolveOptions {
  /** 缺省 true = 启用全部内置 deny；false 全部移除；数组 = 要移除的那些原文。 */
  builtinDeny?: boolean | readonly string[];
  defaultMode?: PermissionMode;
}

/**
 * 按给定顺序（调用方排好：用户级 → profile → 项目级 → 命令行）合并。项目级只能收紧。
 * 不合法的规则文本记 warning 并跳过。
 */
export function resolvePermissionLayers(
  layers: readonly PermissionLayer[],
  options: ResolveOptions = {},
): ResolvedPermissions {
  const warnings: string[] = [];
  const rules: Rule[] = [];
  const removed = options.builtinDeny;
  if (removed !== false) {
    for (const raw of BUILTIN_DENY_RULES) {
      if (Array.isArray(removed) && removed.includes(raw)) continue;
      rules.push(parseRule(raw, "deny", "builtin"));
    }
  }
  let mode: PermissionMode = options.defaultMode ?? "default";
  const add = (raw: string, effect: "allow" | "deny", source: RuleSource) => {
    try {
      rules.push(parseRule(raw, effect, source));
    } catch (err) {
      warnings.push(`${source}: ${(err as Error).message}`);
    }
  };
  for (const layer of layers) {
    const restricted = layer.source === "project";
    if (layer.mode !== undefined) {
      if (!PERMISSION_MODES_STRICT_FIRST.includes(layer.mode)) {
        warnings.push(`${layer.source}: unknown permission mode "${String(layer.mode)}"`);
      } else if (restricted && (layer.mode === "auto" || layer.mode === "full-auto")) {
        warnings.push(`project config cannot set permission mode "${layer.mode}"; ignored`);
      } else if (restricted && !isAtLeastAsStrict(layer.mode, mode)) {
        warnings.push(
          `project config cannot relax permission mode from "${mode}" to "${layer.mode}"; ignored`,
        );
      } else {
        mode = layer.mode;
      }
    }
    for (const raw of layer.deny ?? []) add(raw, "deny", layer.source);
    for (const raw of layer.allow ?? []) {
      if (restricted) warnings.push(`project config cannot add allow rule "${raw}"; ignored`);
      else add(raw, "allow", layer.source);
    }
  }
  return { mode, rules, warnings };
}
