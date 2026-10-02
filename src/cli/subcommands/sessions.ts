/**
 * `ama sessions list|show|prune`（设计 §1.2、§8）。[B5]
 *
 * 会话存储是 B2 的实现，经 RuntimeDeps.sessions 注入；这里只做参数、目录解析与输出格式。
 * - list [--all]：缺省只列当前目录的会话；`--all` 列全部。
 * - show <id>：头信息 + 条目类型统计 + 首条提示 + 用户消息编号（`--from <id>#<编号>` 复用）。
 * - search / export：见 sessions-search.ts、sessions-export.ts（只读扫描，不经会话存储）。
 * - prune [--older-than <天>] [--dry-run]：缺省 30 天，移到 trash（不删除）。
 */

import { resolve } from "node:path";
import { expandHome, resolveDataDir } from "../../config/paths.js";
import { parseSubArgs, UsageError } from "../args.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { ExitCode } from "../exit-codes.js";
import { numberUserMessages } from "../../session/reuse.js";
import { runSessionsExport } from "./sessions-export.js";
import { runSessionsSearch } from "./sessions-search.js";

export const SESSIONS_USAGE = `用法：ama sessions list [--all] [--session-dir <目录>]
      ama sessions show <id> [--session-dir <目录>]
      ama sessions prune [--older-than <天>] [--dry-run] [--all] [--session-dir <目录>]
      ama sessions search <关键词|/正则/> [--all] [--role user|assistant|tool] [--since 7d] [--limit N]
      ama sessions export <id> [--format md|json|jsonl] [--output <文件>] [--branch leaf|all]
`;

function shortTime(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$|Z$/, "");
}

function oneLine(text: string | undefined, max = 60): string {
  if (text === undefined) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export async function runSessions(
  argv: readonly string[],
  io: CliIo,
  deps: Pick<RuntimeDeps, "sessions"> | undefined,
): Promise<number> {
  if (argv[0] === "search") return runSessionsSearch(argv.slice(1), io);
  if (argv[0] === "export") return runSessionsExport(argv.slice(1), io);
  const { positionals, values, flags } = parseSubArgs(
    argv,
    ["session-dir", "older-than"],
    ["all", "dry-run"],
  );
  const action = positionals[0];
  if (flags.has("help") || action === undefined) {
    io.stdout(SESSIONS_USAGE);
    return flags.has("help") ? ExitCode.Ok : ExitCode.Usage;
  }
  const dirFlag = values.get("session-dir");
  const sessionDir =
    dirFlag !== undefined
      ? resolve(io.cwd, expandHome(dirFlag, { env: io.env }))
      : resolve(resolveDataDir({ env: io.env }), "sessions");
  const sessions = deps?.sessions;
  const scope = flags.has("all") ? {} : { cwd: io.cwd };
  switch (action) {
    case "list": {
      if (sessions?.list === undefined) return notWired(io, "sessions list");
      const items = await sessions.list({ sessionDir, ...scope });
      if (items.length === 0) {
        io.stdout("没有会话\n");
        return ExitCode.Ok;
      }
      for (const item of items) {
        const name = item.name ?? oneLine(item.firstPrompt);
        io.stdout(
          `${item.id.slice(0, 8)}  ${shortTime(item.modifiedAt)}  ${String(item.messageCount).padStart(4)} 条  ${name}\n`,
        );
      }
      return ExitCode.Ok;
    }
    case "show": {
      const id = positionals[1];
      if (id === undefined) throw new UsageError("ama sessions show 需要 <id>");
      if (sessions?.show === undefined) return notWired(io, "sessions show");
      const { item, entries } = await sessions.show(id, { sessionDir });
      const counts = new Map<string, number>();
      for (const entry of entries) counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
      io.stdout(
        [
          `id：${item.id}`,
          `文件：${item.file}`,
          `目录：${item.cwd}`,
          ...(item.name !== undefined ? [`名称：${item.name}`] : []),
          `创建：${shortTime(item.createdAt)} · 修改：${shortTime(item.modifiedAt)}`,
          `消息：${item.messageCount}`,
          `条目：${[...counts].map(([type, n]) => `${type} ${n}`).join(" · ")}`,
          ...(item.firstPrompt !== undefined
            ? [`首条提示：${oneLine(item.firstPrompt, 200)}`]
            : []),
        ].join("\n") + "\n",
      );
      const users = numberUserMessages(entries);
      if (users.length > 0) {
        io.stdout(`用户消息（ama --from ${item.id.slice(0, 8)}#<编号> 复用）：\n`);
        for (const user of users) {
          const tags = [
            ...(user.origin !== undefined ? [`[${user.origin}]`] : []),
            ...(user.images.length > 0 ? [`[图片 ${user.images.length}]`] : []),
          ];
          io.stdout(
            `  #${String(user.n).padEnd(3)} ${shortTime(user.timestamp)}  ${[...tags, oneLine(user.text, 100)].join(" ")}\n`,
          );
        }
      }
      return ExitCode.Ok;
    }
    case "prune": {
      const raw = values.get("older-than") ?? "30";
      const olderThanDays = Number(raw);
      if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
        throw new UsageError(`--older-than 应为非负天数（收到 ${raw}）`);
      }
      if (sessions?.prune === undefined) return notWired(io, "sessions prune");
      const dryRun = flags.has("dry-run");
      const { moved } = await sessions.prune({ sessionDir, olderThanDays, dryRun, ...scope });
      for (const file of moved) io.stdout(`${dryRun ? "将移到 trash" : "已移到 trash"}：${file}\n`);
      io.stdout(`${moved.length} 个会话${dryRun ? "（演练，未改动）" : ""}\n`);
      return ExitCode.Ok;
    }
    default:
      throw new UsageError(`未知的 sessions 子命令：${action}`);
  }
}

function notWired(io: CliIo, what: string): number {
  io.stderr(`ama: ${what} 尚未装配（会话存储由集成批次注入）\n`);
  return ExitCode.RuntimeError;
}
