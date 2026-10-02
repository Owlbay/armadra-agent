/**
 * `ama sessions search <关键词|/正则/>`：跨会话全文检索（只读）。[W4-D]
 *
 * - 范围：缺省当前目录的会话，`--all` 全部；`--role user|assistant|tool`（可逗号分隔多个）；
 *   `--since 7d|today|YYYY-MM-DD`；`--limit N`（缺省 20）；`--json` 每条命中一行 JSON。
 * - 输出一行一条：会话 id 前 8 位、条目时间、项目、角色与编号（user 是 `#n`，可直接给 `--from <id>#n`；
 *   其它角色是条目序号 `@k`）、命中片段。stdout 是 TTY 且没设 NO_COLOR 时用 ANSI 高亮，否则纯文本。
 */

import { join, resolve } from "node:path";
import { expandHome, resolveDataDir } from "../../config/paths.js";
import { sessionFilesInScope } from "../../session/scan.js";
import {
  compileQuery,
  searchSessions,
  type SearchHit,
  type SearchRole,
} from "../../session/search.js";
import { parseSubArgs, UsageError } from "../args.js";
import type { CliIo } from "../deps.js";
import { ExitCode } from "../exit-codes.js";
import { parseDaySpec } from "./stats.js";

export const SESSIONS_SEARCH_USAGE = `用法：ama sessions search <关键词|/正则/标志> [--all] [--role user|assistant|tool]
                            [--since 7d|today|YYYY-MM-DD] [--limit N] [--json] [--session-dir <目录>]
`;

const ROLES: readonly SearchRole[] = ["user", "assistant", "tool"];

function highlight(text: string, ranges: ReadonlyArray<[number, number]>, color: boolean): string {
  if (!color || ranges.length === 0) return text;
  let out = "";
  let at = 0;
  for (const [a, b] of ranges) {
    if (a < at) continue;
    out += text.slice(at, a) + `\x1b[1;33m${text.slice(a, b)}\x1b[0m`;
    at = b;
  }
  return out + text.slice(at);
}

function shortTime(iso: string): string {
  return iso
    .replace("T", " ")
    .replace(/\.\d+Z$|Z$/, "")
    .slice(0, 16);
}

export function renderHit(hit: SearchHit, color: boolean): string {
  const ref = hit.userN !== undefined ? `#${hit.userN}` : `@${hit.entryIndex}`;
  const dim = (s: string): string => (color ? `\x1b[2m${s}\x1b[0m` : s);
  return `${hit.sessionId.slice(0, 8)}${ref.padEnd(4)}  ${dim(shortTime(hit.timestamp))}  ${dim(hit.cwd)}  ${hit.role.padEnd(9)}  ${highlight(hit.snippet, hit.ranges, color)}\n`;
}

export async function runSessionsSearch(argv: readonly string[], io: CliIo): Promise<number> {
  const { positionals, values, flags } = parseSubArgs(
    argv,
    ["role", "since", "limit", "session-dir"],
    ["all", "json"],
  );
  if (flags.has("help")) {
    io.stdout(SESSIONS_SEARCH_USAGE);
    return ExitCode.Ok;
  }
  const pattern = positionals.join(" ");
  if (pattern.trim() === "") throw new UsageError("ama sessions search 需要关键词或 /正则/");
  let query;
  try {
    query = compileQuery(pattern);
  } catch (error) {
    throw new UsageError(`正则无效：${(error as Error).message}`);
  }
  let roles: Set<SearchRole> | undefined;
  const roleRaw = values.get("role");
  if (roleRaw !== undefined) {
    roles = new Set();
    for (const role of roleRaw.split(",").map((r) => r.trim())) {
      if (!(ROLES as readonly string[]).includes(role)) {
        throw new UsageError(`--role 的取值应为 ${ROLES.join(" | ")}（收到 ${role}）`);
      }
      roles.add(role as SearchRole);
    }
  }
  const limit = Number(values.get("limit") ?? "20");
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError("--limit 应为正整数");
  const sinceRaw = values.get("since");
  const sinceIso =
    sinceRaw === undefined
      ? undefined
      : new Date(`${parseDaySpec("since", sinceRaw)}T00:00:00`).toISOString();
  const dirFlag = values.get("session-dir");
  const root =
    dirFlag !== undefined
      ? resolve(io.cwd, expandHome(dirFlag, { env: io.env }))
      : join(resolveDataDir({ env: io.env }), "sessions");
  const files = sessionFilesInScope(root, flags.has("all") ? undefined : io.cwd);
  const { hits, truncated } = searchSessions(files, query, {
    limit,
    ...(roles !== undefined ? { roles } : {}),
    ...(sinceIso !== undefined ? { sinceIso } : {}),
  });
  if (flags.has("json")) {
    for (const hit of hits) io.stdout(`${JSON.stringify(hit)}\n`);
    return ExitCode.Ok;
  }
  if (hits.length === 0) {
    io.stdout(flags.has("all") ? "没有命中\n" : "没有命中（只搜了当前目录的会话，--all 搜全部）\n");
    return ExitCode.Ok;
  }
  const color = io.stdoutIsTTY && (io.env["NO_COLOR"] ?? "") === "";
  for (const hit of hits) io.stdout(renderHit(hit, color));
  if (truncated) io.stdout(`（已到 --limit ${limit}，可能还有更多）\n`);
  return ExitCode.Ok;
}
