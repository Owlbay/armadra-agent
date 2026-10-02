/**
 * 执行前预览（第三波 §2.2）：审批时列出「这一步会碰到什么」。[W3-B9a-2]
 *
 * - 只读：只用 `statSync / lstatSync / readdirSync / readFileSync`，不起子进程、不写盘；
 * - 有上限：目录递归计数每个目标最多 `maxEntries`（缺省 2000）项，整次预览共用一个时间预算
 *   （缺省 200 ms，预算循环里逐项检查），超出只给提示；超时 / 超限不降低严重度；
 * - bash：按段（含 `sh -c` / `eval` / `xargs` / `find -exec` 的嵌套命令）识别 `rm / rmdir / unlink`、
 *   `mv`、`git clean`、`git checkout -- <路径>`、`git reset --hard` 与 `>` / `>>` 重定向目标；
 *   通配符、变量与 `{}` 不展开，原样显示并提示范围可能更大；段首的 `cd <路径>` 改变后续段的基准；
 * - write：目标是否存在、现有行数 / 大小 → 新内容；覆盖本会话未 read 过的文件标 warn；
 * - edit：读原文用 `planEdits` 干跑，成功给每处 −n/+m 行与总变化，失败提前说明原因；
 *   超过 2 MiB 的文件只报大小，不读内容；
 * - 其它工具：一行参数摘要。
 *
 * `lines` 不含颜色；`affected[].path` 与行里的路径一样是显示路径（cwd 内相对、`/` 分隔）。
 */

import { lstatSync, readdirSync, readFileSync, statSync, type Dirent, type Stats } from "node:fs";
import { basename, join } from "node:path";
import { EditError, planEdits, type EditOp } from "../tools/edit.js";
import { normalizeToLF, splitBom } from "../tools/edit-fuzzy.js";
import { displayPath, resolvePath } from "../tools/paths.js";
import { collectNestedCommands, commandWords, matchDangerous, shellWords } from "./dangerous.js";
import { splitShellSegments } from "./rules.js";
import { msg } from "../i18n/index.js";
import type { PreviewNote, PreviewVerb } from "../i18n/messages/permissions.js";
import type { ActionPreview, ActionPreviewTarget, ApprovalRequest } from "./types.js";

export const PREVIEW_MAX_ENTRIES = 2000;
export const PREVIEW_BUDGET_MS = 200;
/** 超过它的文件不读内容，只报大小。 */
export const PREVIEW_MAX_READ_BYTES = 2 * 1024 * 1024;
/** 一次预览最多列出的目标数。 */
export const PREVIEW_MAX_TARGETS = 20;

export interface PreviewOptions {
  /** 相对路径的基准（会话 cwd）。 */
  cwd: string;
  maxEntries?: number;
  budgetMs?: number;
  now?: () => number;
}

type Severity = ActionPreview["severity"];
const RANK: Record<Severity, number> = { info: 0, warn: 1, danger: 2 };
const NULL_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "nul"]);
const UNEXPANDED = /[*?[\]{}$`]/;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function countLines(text: string): number {
  if (text === "") return 0;
  const n = normalizeToLF(text).split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

class Collector {
  readonly lines: string[] = [];
  readonly affected: ActionPreviewTarget[] = [];
  severity: Severity = "info";
  timedOut = false;
  private hidden = 0;
  private readonly deadline: number;
  readonly maxEntries: number;
  readonly now: () => number;
  /** 显示路径的基准（会话 cwd）。 */
  readonly root: string;
  /** 解析基准：随段首的 `cd` 与 `git -C` 变化。 */
  cwd: string;

  constructor(private readonly options: PreviewOptions) {
    this.root = options.cwd;
    this.cwd = options.cwd;
    this.now = options.now ?? Date.now;
    this.deadline = this.now() + (options.budgetMs ?? PREVIEW_BUDGET_MS);
    this.maxEntries = options.maxEntries ?? PREVIEW_MAX_ENTRIES;
  }

  raise(severity: Severity): void {
    if (RANK[severity] > RANK[this.severity]) this.severity = severity;
  }

  expired(): boolean {
    if (!this.timedOut && this.now() > this.deadline) this.timedOut = true;
    return this.timedOut;
  }

  /** 一个目标的一行；超出 {@link PREVIEW_MAX_TARGETS} 只计数。 */
  target(line: string, target?: ActionPreviewTarget): void {
    if (this.affected.length + this.hidden >= PREVIEW_MAX_TARGETS) {
      this.hidden++;
      return;
    }
    this.lines.push(line);
    if (target !== undefined) this.affected.push(target);
  }

  finish(kind: ActionPreview["kind"]): ActionPreview {
    if (this.hidden > 0) this.lines.push(msg().permissions.preview.moreHidden(this.hidden));
    if (this.timedOut) {
      this.lines.push(
        msg().permissions.preview.timedOut(this.options.budgetMs ?? PREVIEW_BUDGET_MS),
      );
      this.raise("warn");
    }
    const preview: ActionPreview = { kind, lines: this.lines, severity: this.severity };
    if (this.affected.length > 0) preview.affected = this.affected;
    return preview;
  }
}

function tryStat(path: string, follow = false): Stats | undefined {
  try {
    return (follow ? statSync : lstatSync)(path, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

/** 目录递归计数（不跟随符号链接）：文件数、字节数；超限 / 超时提前返回。 */
function tally(root: string, c: Collector): { files: number; bytes: number; capped: boolean } {
  const out = { files: 0, bytes: 0, capped: false };
  const stack = [root];
  let entries = 0;
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let list: Dirent[];
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of list) {
      if (c.expired()) return out;
      if (++entries > c.maxEntries) return { ...out, capped: true };
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        out.files++;
        out.bytes += tryStat(full)?.size ?? 0;
      }
    }
  }
  return out;
}

/** 统计一个路径：返回目标与「：」之后的说明。 */
function inspect(abs: string, c: Collector): { target: ActionPreviewTarget; text: string } {
  const m = msg().permissions.preview;
  const shown = displayPath(abs, c.root);
  const info = tryStat(abs);
  if (info === undefined) return { target: { path: shown, exists: false }, text: m.missing };
  if (info.isSymbolicLink()) return { target: { path: shown, exists: true }, text: m.symlink };
  if (!info.isDirectory()) {
    return {
      target: { path: shown, exists: true, bytes: info.size },
      text: m.file(formatBytes(info.size)),
    };
  }
  const t = tally(abs, c);
  const target: ActionPreviewTarget = { path: `${shown}/`, exists: true, files: t.files };
  if (t.capped) return { target, text: m.dirCapped(c.maxEntries) };
  target.bytes = t.bytes;
  return { target, text: m.dir(t.files, formatBytes(t.bytes), c.timedOut) };
}

/** 一个路径参数一行；含通配 / 变量的原样显示不展开。 */
function pathLine(verb: PreviewVerb, word: string, c: Collector, note?: PreviewNote): void {
  const m = msg().permissions.preview;
  if (UNEXPANDED.test(word)) {
    c.target(m.pathUnexpanded(verb, word));
    c.raise("warn");
    return;
  }
  const { target, text } = inspect(resolvePath(word, c.cwd), c);
  if (target.exists) c.raise("warn");
  c.target(m.pathTarget(verb, target.path, text, note), target);
}

/** 段里的 `>` / `>>` 重定向：返回目标与去掉重定向后的文本。 */
export function splitRedirects(segment: string): {
  rest: string;
  targets: { word: string; append: boolean }[];
} {
  const targets: { word: string; append: boolean }[] = [];
  let rest = "";
  let quote: string | undefined;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] as string;
    if (quote !== undefined) {
      rest += ch;
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) rest += segment[++i];
      else if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      rest += ch;
    } else if (ch === "\\" && i + 1 < segment.length) {
      rest += ch + segment[++i];
    } else if (ch !== ">" || segment[i + 1] === "(") {
      rest += ch;
    } else {
      rest = rest.replace(/(^|\s)(\d+|&)$/, "$1");
      let j = i + 1;
      const append = segment[j] === ">";
      if (append || segment[j] === "|") j++;
      const dup = segment[j] === "&";
      if (dup) j++;
      while (segment[j] === " " || segment[j] === "\t") j++;
      let end = j;
      let q: string | undefined;
      for (; end < segment.length; end++) {
        const e = segment[end] as string;
        if (q !== undefined) {
          if (e === q) q = undefined;
        } else if (e === "'" || e === '"') q = e;
        else if (/[\s;|&<>()]/.test(e)) break;
      }
      const word = shellWords(segment.slice(j, end))[0] ?? "";
      if (word !== "" && !(dup && /^(\d+|-)$/.test(word))) targets.push({ word, append });
      rest += " ";
      i = end - 1;
    }
  }
  return { rest, targets };
}

function operands(argv: readonly string[], valueFlags: readonly string[] = []): string[] {
  const out: string[] = [];
  let all = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (all || a === "-" || !a.startsWith("-")) out.push(a);
    else if (a === "--") all = true;
    else if (valueFlags.includes(a)) i++;
  }
  return out;
}

function previewSegment(segment: string, c: Collector): void {
  const { rest, targets } = splitRedirects(segment);
  for (const { word, append } of targets) {
    if (NULL_DEVICES.has(word.toLowerCase())) continue;
    pathLine(append ? "append" : "overwrite", word, c);
  }
  const argv = commandWords(rest);
  const name = basename(argv[0] ?? "");
  if (name === "cd" && argv.length === 2 && !UNEXPANDED.test(argv[1] as string)) {
    c.cwd = resolvePath(argv[1] as string, c.cwd);
    return;
  }
  if (name === "rm" || name === "rmdir" || name === "unlink") {
    const paths = operands(argv);
    if (paths.length === 0) c.target(msg().permissions.preview.rmUnknown(name));
    for (const p of paths) pathLine("delete", p, c);
  } else if (name === "mv") {
    const paths = operands(argv, ["-t", "-S", "--target-directory", "--suffix"]);
    const t = argv.indexOf("-t");
    const dest = t > 0 ? argv[t + 1] : paths.pop();
    for (const p of paths) pathLine("move", p, c);
    if (dest !== undefined && paths.length > 0) {
      const info = UNEXPANDED.test(dest) ? undefined : tryStat(resolvePath(dest, c.cwd));
      const note: PreviewNote = info?.isDirectory() ? "intoDir" : "overwritten";
      pathLine("moveTo", dest, c, info === undefined ? undefined : note);
    }
  } else if (name === "git") {
    previewGit(argv, c);
  }
}

const GIT_VALUE_OPTS = ["-C", "-c", "--git-dir", "--work-tree", "--namespace"];

function previewGit(argv: readonly string[], c: Collector): void {
  let i = 1;
  let base = c.cwd;
  while (i < argv.length && (argv[i] as string).startsWith("-")) {
    if (argv[i] === "-C" && argv[i + 1] !== undefined)
      base = resolvePath(argv[i + 1] as string, base);
    i += GIT_VALUE_OPTS.includes(argv[i] as string) ? 2 : 1;
  }
  const sub = argv[i];
  const args = argv.slice(i);
  const saved = c.cwd;
  c.cwd = base;
  try {
    if (
      sub === "clean" &&
      !args.some((a) => a === "-n" || a === "--dry-run" || /^-[a-z]*n/.test(a))
    ) {
      const paths = operands(args, ["-e", "--exclude"]);
      for (const p of paths.length > 0 ? paths : ["."]) {
        pathLine("gitClean", p, c, "gitCleanTracked");
      }
      // 与危险规则无关地标红：`git -C 目录 clean -f` 之类危险表认不出的写法也算
      if (args.some((a) => a === "--force" || /^-[A-Za-z]*f/.test(a))) c.raise("danger");
    } else if (sub === "checkout" && args.includes("--")) {
      for (const p of args.slice(args.indexOf("--") + 1)) pathLine("discard", p, c);
    } else if (sub === "reset" && args.includes("--hard")) {
      c.lines.push(msg().permissions.preview.gitResetHard);
      c.raise("danger");
    }
  } finally {
    c.cwd = saved;
  }
}

function previewBash(command: string, c: Collector, dangerous: boolean): void {
  const hit = matchDangerous(command);
  if (hit !== undefined) c.lines.push(msg().permissions.preview.dangerous(hit.description));
  if (hit !== undefined || dangerous) c.raise("danger");
  const nested = collectNestedCommands(command);
  const start = c.cwd;
  for (const text of [command, ...nested.commands]) {
    c.cwd = start;
    for (const segment of splitShellSegments(text)) {
      if (c.timedOut) break;
      previewSegment(segment, c);
    }
  }
  c.cwd = start;
  if (nested.tooDeep) {
    c.lines.push(msg().permissions.preview.tooDeep);
    c.raise("warn");
  }
}

function readSmall(abs: string, info: Stats): string | undefined {
  return info.size > PREVIEW_MAX_READ_BYTES ? undefined : readFileSync(abs, "utf8");
}

function unread(abs: string, request: ApprovalRequest, c: Collector, tool: string): void {
  const readFiles = request.context?.readFiles;
  if (readFiles === undefined || readFiles.has(abs)) return;
  c.lines.push(msg().permissions.preview.unread(tool));
  c.raise("warn");
}

function previewWrite(
  input: Record<string, unknown>,
  request: ApprovalRequest,
  c: Collector,
): void {
  const abs = resolvePath(String(input["path"] ?? ""), c.cwd);
  const content = typeof input["content"] === "string" ? input["content"] : "";
  const m = msg().permissions.preview;
  const next = m.size(countLines(content), formatBytes(Buffer.byteLength(content, "utf8")));
  const shown = displayPath(abs, c.root);
  const info = tryStat(abs, true);
  if (info === undefined) {
    c.target(m.writeNew(shown, next), { path: shown, exists: false });
    return;
  }
  if (info.isDirectory()) {
    c.target(m.writeIsDir(shown), { path: `${shown}/`, exists: true });
    c.raise("warn");
    return;
  }
  const old = readSmall(abs, info);
  const before =
    old === undefined ? formatBytes(info.size) : m.size(countLines(old), formatBytes(info.size));
  c.target(m.writeOverwrite(shown, before, next), { path: shown, exists: true, bytes: info.size });
  unread(abs, request, c, "write");
}

function editFailure(message: string): string {
  const m = msg().permissions.preview;
  const many = /^(\S+) matches (\d+) times/.exec(message);
  if (many) return m.editNotUnique(many[1] as string, many[2] as string);
  const missing = /^Could not find (\S+)/.exec(message);
  if (missing) return m.editNotFound(missing[1] as string);
  if (message.includes("overlap")) return m.editOverlap;
  if (message.includes("no change")) return m.editNoChange;
  return message;
}

function previewEdit(input: Record<string, unknown>, request: ApprovalRequest, c: Collector): void {
  const m = msg().permissions.preview;
  const abs = resolvePath(String(input["path"] ?? ""), c.cwd);
  const shown = displayPath(abs, c.root);
  const info = tryStat(abs, true);
  if (info === undefined || !info.isFile()) {
    c.target(m.editMissing(shown), { path: shown, exists: info !== undefined });
    c.raise("warn");
    return;
  }
  const target = { path: shown, exists: true, bytes: info.size };
  const raw = readSmall(abs, info);
  if (raw === undefined) {
    c.target(m.editTooLarge(shown, formatBytes(info.size)), target);
    unread(abs, request, c, "edit");
    return;
  }
  const content = normalizeToLF(splitBom(raw).text);
  const edits = Array.isArray(input["edits"]) ? (input["edits"] as EditOp[]) : [];
  try {
    const plan = planEdits(content, edits, input["replaceAll"] === true);
    c.target(m.editPlan(shown, plan.replacements, plan.fuzzy === true), target);
    edits.slice(0, 5).forEach((e, i) => {
      c.lines.push(m.editOp(i + 1, countLines(e.oldText), countLines(e.newText)));
    });
    if (edits.length > 5) c.lines.push(m.editMore(edits.length - 5));
    c.lines.push(m.editTotal(countLines(content), countLines(plan.result)));
  } catch (err) {
    if (!(err instanceof EditError)) throw err;
    c.target(m.editDryRunFailed(shown, editFailure(err.message)), target);
    c.raise("warn");
  }
  unread(abs, request, c, "edit");
}

const SUMMARY_KEYS = ["path", "command", "pattern", "description", "query", "url", "name"];

/** 审批请求的执行前预览；纯读，不抛错（内部错误返回空预览）。 */
export function previewAction(request: ApprovalRequest, options: PreviewOptions): ActionPreview {
  const c = new Collector(options);
  const input =
    typeof request.input === "object" && request.input !== null
      ? (request.input as Record<string, unknown>)
      : {};
  const kind: ActionPreview["kind"] =
    request.toolName === "bash" || request.toolName === "write" || request.toolName === "edit"
      ? request.toolName
      : "other";
  try {
    if (kind === "bash" && typeof input["command"] === "string") {
      previewBash(input["command"], c, request.reason === "dangerous");
    } else if (kind === "write" && typeof input["path"] === "string") {
      previewWrite(input, request, c);
    } else if (kind === "edit" && typeof input["path"] === "string") {
      previewEdit(input, request, c);
    } else if (kind === "other") {
      const key = SUMMARY_KEYS.find((k) => typeof input[k] === "string" && input[k] !== "");
      if (key !== undefined)
        c.lines.push(
          String(input[key])
            .replace(/\s*\n\s*/g, " ⏎ ")
            .slice(0, 120),
        );
    }
  } catch (err) {
    c.lines.push(
      msg().permissions.preview.failed(err instanceof Error ? err.message : String(err)),
    );
  }
  return c.finish(kind);
}

/** 对话框 / 行式界面里显示的预览行（`other` 已由输入摘要覆盖，不重复显示）。 */
export function previewDisplayLines(preview: ActionPreview | undefined, max = 10): string[] {
  if (preview === undefined || preview.kind === "other") return [];
  if (preview.lines.length <= max) return preview.lines;
  return [
    ...preview.lines.slice(0, max - 1),
    msg().permissions.preview.moreLines(preview.lines.length - max + 1),
  ];
}
