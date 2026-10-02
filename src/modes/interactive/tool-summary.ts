/**
 * 工具调用的文字摘要（终端界面视觉设计 v1 §3.5）：标题行的参数摘要、`⎿` 后的一行结果摘要、
 * 统一 diff 解析与输出清洗。纯函数，ToolView 负责排版与着色之外的状态。
 *
 * 结果摘要（完成后）：
 * - read `读取 N 行`（图片 `图片 mime`、空文件 `空文件`）；edit `N 处修改 · +a −b`；write `新建 / 覆盖 · N 行`；
 * - bash `退出 c · 耗时 · N 行`（超时 `超时 · 耗时`、中断 `已中断 · 耗时`）；
 * - grep `N 处匹配 · M 个文件`；glob `N 个文件`；codemode `N 个内层调用 · 脚本输出 M 行`；
 * - task `完成 · 耗时 · ↑in ↓out`；其它 `N 行输出`；失败（非 bash）取错误首行。
 */

import { msg } from "../../i18n/index.js";
import { isAbsolute, relative } from "node:path";
import type { ToolResult } from "../../tools/types.js";
import { stripAnsi, type Theme } from "../../tui.js";
import { formatTokens } from "./status-bar.js";

/** 工具输出 → 可安全显示的行。 */
export function cleanLines(text: string): string[] {
  const clean = stripAnsi(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const lines = clean.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

export function flat(text: string, max = 120): string {
  const one = text.replace(/\s*\n\s*/g, " ⏎ ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function displayPath(path: string, cwd: string | undefined): string {
  if (cwd === undefined || !isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel === "" ? "." : rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

/** 标题行里的参数摘要。 */
export function toolSummary(name: string, args: unknown, cwd?: string): string {
  if (typeof args !== "object" || args === null) return "";
  const a = args as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof a[key] === "string" && a[key] !== "" ? (a[key] as string) : undefined;
  const path = str("path") ?? str("file_path");
  switch (name) {
    case "bash":
      return flat(str("command") ?? "");
    case "read": {
      if (path === undefined) return "";
      const offset = typeof a["offset"] === "number" ? a["offset"] : undefined;
      const limit = typeof a["limit"] === "number" ? a["limit"] : undefined;
      const range =
        offset !== undefined || limit !== undefined
          ? `:${offset ?? 1}${limit !== undefined ? `+${limit}` : ""}`
          : "";
      return displayPath(path, cwd) + range;
    }
    case "grep":
    case "glob": {
      const pattern = str("pattern") ?? "";
      return path !== undefined ? `${flat(pattern)} in ${displayPath(path, cwd)}` : flat(pattern);
    }
    case "task":
      return flat(str("description") ?? str("prompt") ?? "");
    default:
      if (path !== undefined) return displayPath(path, cwd);
      for (const key of [
        "command",
        "pattern",
        "description",
        "query",
        "url",
        "name",
        "code",
        "script",
      ]) {
        const value = str(key);
        if (value !== undefined) return flat(value);
      }
      return "";
  }
}

/** 完成耗时：< 10s 一位小数（`2.1s`），< 60s 整秒，再长 `1m05s`。 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const total = Math.floor(s);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

export interface DiffRow {
  kind: "hunk" | "add" | "del" | "ctx";
  /** 原行（含 `+` / `-` / ` ` 前缀）。 */
  text: string;
  /** 行号：删除行取旧号，其余取新号；hunk 行没有。 */
  num?: number;
}

/** 统一 diff → 行（去掉 `---` / `+++` 文件头），带行号。 */
export function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of cleanLines(diff)) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) rows.push({ kind: "add", text: line, num: newNo++ });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line, num: oldNo++ });
    else if (line.startsWith("@@")) rows.push({ kind: "hunk", text: line });
    else {
      rows.push({ kind: "ctx", text: line, num: newNo });
      oldNo++;
      newNo++;
    }
  }
  return rows;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function diffOf(result: ToolResult | undefined): string | undefined {
  const diff = record(result?.details)["diff"];
  return typeof diff === "string" && diff !== "" ? diff : undefined;
}

/** bash 完成后的正文：优先 `details.output`（不含退出码等附注）。 */
export function bashOutput(result: ToolResult): string | undefined {
  const output = record(result.details)["output"];
  return typeof output === "string" ? output : undefined;
}

export interface SummaryInput {
  name: string;
  args: unknown;
  result: ToolResult;
  isError: boolean;
  /** 结果正文（已清洗）。 */
  lines: readonly string[];
  /** 完成耗时（ms）；重放的历史调用没有，bash 取 `details.wall_time_seconds`。 */
  elapsedMs: number | undefined;
  /** 已显示的内层调用数（codemode 没有 details 时用）。 */
  nestedCount?: number;
}

/** 完成后的一行结果摘要（已着色，不含 `⎿`）。 */
export function resultSummary(input: SummaryInput, theme: Theme): string {
  const { name, result, isError, lines } = input;
  const m = msg().interactive.view.tool;
  const details = record(result.details);
  const muted = (s: string): string => theme.fg("muted", s);
  const sep = theme.fg("dim", " · ");
  const wall = num(details["wall_time_seconds"]);
  const elapsed = input.elapsedMs ?? (wall !== undefined ? wall * 1000 : 0);
  const duration = formatDuration(elapsed);
  const count = lines.length;
  if (name === "bash") {
    const code = num(details["exit_code"]) ?? (isError ? 1 : 0);
    const total = num(details["totalLines"]) ?? count;
    const head =
      details["aborted"] === true
        ? m.interrupted
        : details["timedOut"] === true
          ? m.timedOut
          : m.exit(code);
    const parts = [head, duration, ...(total > 0 ? [m.lines(total)] : [])];
    const text = parts.join(" · ");
    return isError || code !== 0 ? theme.fg("error", text) : parts.map(muted).join(sep);
  }
  if (isError) return theme.fg("error", `${theme.glyphs.fail} ${lines[0] ?? m.failed}`);
  switch (name) {
    case "read": {
      const mime = details["mimeType"];
      if (typeof mime === "string") return muted(m.image(mime));
      const first = num(details["firstLine"]);
      const last = num(details["lastLine"]);
      if (num(details["totalLines"]) === 0) return muted(m.emptyFile);
      const n = first !== undefined && last !== undefined ? last - first + 1 : count;
      return muted(m.read(n));
    }
    case "edit": {
      const rows = parseDiff(diffOf(result) ?? "");
      const add = rows.filter((r) => r.kind === "add").length;
      const del = rows.filter((r) => r.kind === "del").length;
      const edits = record(input.args)["edits"];
      const n = num(details["replacements"]) ?? (Array.isArray(edits) ? edits.length : 1);
      return (
        muted(m.edits(n)) +
        sep +
        theme.fg("success", `+${add}`) +
        " " +
        theme.fg("error", `−${del}`)
      );
    }
    case "write": {
      const content = record(input.args)["content"];
      const n = typeof content === "string" ? cleanLines(content).length : 0;
      return muted(m.write(details["created"] === true, n));
    }
    case "grep": {
      const matches = num(details["matches"]);
      if (matches === 0) return muted(m.noMatch);
      if (matches === undefined) return muted(m.lines(count));
      return muted(m.matches(matches, num(details["files"])));
    }
    case "glob": {
      const n = num(details["count"]);
      return muted(n === 0 ? m.noMatch : m.files(n ?? count));
    }
    case "codemode": {
      const calls = num(details["toolCalls"]) ?? input.nestedCount ?? 0;
      return muted(m.codemode(calls, count));
    }
    case "task": {
      const usage = record(details["usage"]);
      const input_ = num(usage["input"]);
      const output = num(usage["output"]);
      const tokens =
        input_ !== undefined && output !== undefined
          ? [
              `${theme.glyphs.arrowUp}${formatTokens(input_)} ${theme.glyphs.arrowDown}${formatTokens(output)}`,
            ]
          : [];
      return muted([m.done, duration, ...tokens].join(" · "));
    }
    default:
      return muted(count === 0 ? m.done : m.outputLines(count));
  }
}
