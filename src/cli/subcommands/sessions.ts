/**
 * `ama sessions list|show|prune`（设计 §1.2、§8）。[B5]
 *
 * 会话存储是 B2 的实现，经 RuntimeDeps.sessions 注入；这里只做参数、目录解析与输出格式。
 * - list [--all]：缺省只列当前目录的会话；`--all` 列全部。
 * - show <id>：头信息 + 条目类型统计 + 首条提示 + 用户消息编号（`--from <id>#<编号>` 复用）。
 * - search / export / trace：见 sessions-search.ts、sessions-export.ts、sessions-trace.ts（只读扫描，不经会话存储）。
 * - prune [--older-than <天>] [--dry-run]：缺省 30 天，移到 trash（不删除）；之后清理检查点备份
 *   （未被任何会话引用且超过 1 天的 blob，docs/rewind-plan.md §1.4）与超过 7 天的剪贴板图片
 *   （`<数据目录>/clipboard/`，W5-I），`--dry-run` 时只报告。
 */

import { join, resolve } from "node:path";
import { formatBytes, gcBlobs } from "../../checkpoints/gc.js";
import { expandHome, resolveDataDir } from "../../config/paths.js";
import { parseSubArgs, UsageError } from "../args.js";
import type { CliIo, RuntimeDeps } from "../deps.js";
import { ExitCode } from "../exit-codes.js";
import { numberUserMessages } from "../../session/reuse.js";
import { gcClipboardImages } from "../../tools/clipboard-image.js";
import { runSessionsExport } from "./sessions-export.js";
import { runSessionsSearch } from "./sessions-search.js";
import { runSessionsTrace } from "./sessions-trace.js";
import { msg } from "../../i18n/index.js";

/** 用法（随界面语言）。 */
export function sessionsUsage(): string {
  return msg().session.cli.usage;
}

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
  if (argv[0] === "trace") return runSessionsTrace(argv.slice(1), io); // [W6-T2]
  const { positionals, values, flags } = parseSubArgs(
    argv,
    ["session-dir", "older-than"],
    ["all", "dry-run"],
  );
  const action = positionals[0];
  if (flags.has("help") || action === undefined) {
    io.stdout(sessionsUsage());
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
        io.stdout(msg().session.cli.none);
        return ExitCode.Ok;
      }
      for (const item of items) {
        const name = item.name ?? oneLine(item.firstPrompt);
        io.stdout(
          msg().session.cli.listRow(
            item.id.slice(0, 8),
            shortTime(item.modifiedAt),
            item.messageCount,
            name,
          ),
        );
      }
      return ExitCode.Ok;
    }
    case "show": {
      const id = positionals[1];
      if (id === undefined) throw new UsageError(msg().session.cli.showNeedsId);
      if (sessions?.show === undefined) return notWired(io, "sessions show");
      const { item, entries } = await sessions.show(id, { sessionDir });
      const counts = new Map<string, number>();
      for (const entry of entries) counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
      io.stdout(
        msg().session.cli.show({
          id: item.id,
          file: item.file,
          cwd: item.cwd,
          name: item.name,
          created: shortTime(item.createdAt),
          modified: shortTime(item.modifiedAt),
          messages: item.messageCount,
          entries: [...counts].map(([type, n]) => `${type} ${n}`).join(" · "),
          firstPrompt: item.firstPrompt !== undefined ? oneLine(item.firstPrompt, 200) : undefined,
        }),
      );
      const users = numberUserMessages(entries);
      if (users.length > 0) {
        io.stdout(msg().session.cli.userMessages(item.id.slice(0, 8)));
        for (const user of users) {
          const tags = [
            ...(user.origin !== undefined ? [`[${user.origin}]`] : []),
            ...(user.images.length > 0 ? [msg().session.cli.images(user.images.length)] : []),
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
        throw new UsageError(msg().session.cli.olderThanInvalid(raw));
      }
      if (sessions?.prune === undefined) return notWired(io, "sessions prune");
      const dryRun = flags.has("dry-run");
      const { moved } = await sessions.prune({ sessionDir, olderThanDays, dryRun, ...scope });
      for (const file of moved) io.stdout(msg().session.cli.moved(dryRun, file));
      io.stdout(msg().session.cli.pruned(moved.length, dryRun));
      await pruneFileHistory(io, sessionDir, dryRun);
      await pruneClipboard(io, dryRun);
      return ExitCode.Ok;
    }
    default:
      throw new UsageError(msg().session.cli.unknownAction(action));
  }
}

/** 检查点备份 GC：扫描本次的会话目录、缺省会话目录与登记过的目录。失败只提示，不影响 prune。 */
async function pruneFileHistory(io: CliIo, sessionDir: string, dryRun: boolean): Promise<void> {
  const dataDir = resolveDataDir({ env: io.env });
  try {
    const result = await gcBlobs({
      dataDir,
      sessionRoots: [sessionDir, join(dataDir, "sessions")],
      dryRun,
    });
    if (result.removed.length === 0) return;
    io.stdout(
      msg().session.cli.fileHistoryPruned(
        dryRun,
        result.removed.length,
        formatBytes(result.removedBytes),
      ),
    );
  } catch (error) {
    io.stderr(
      msg().session.cli.fileHistorySkipped(error instanceof Error ? error.message : String(error)),
    );
  }
}

/** [W5-I] `<数据目录>/clipboard/` 超过 7 天的剪贴板图片。失败只提示。 */
async function pruneClipboard(io: CliIo, dryRun: boolean): Promise<void> {
  try {
    const removed = await gcClipboardImages(resolveDataDir({ env: io.env }), { dryRun });
    if (removed.length > 0) io.stdout(msg().session.cli.clipboardPruned(dryRun, removed.length));
  } catch (error) {
    io.stderr(
      msg().session.cli.clipboardSkipped(error instanceof Error ? error.message : String(error)),
    );
  }
}

function notWired(io: CliIo, what: string): number {
  io.stderr(msg().session.cli.notWired(what));
  return ExitCode.RuntimeError;
}
