/**
 * `ama memory list|show|edit|rm|path|enable|disable`（docs/wave6-plan.md §3.5）。[W6-M]
 *
 * - 作用域按用户级配置（`memory.scopes`，缺省 user + project）；项目作用域以 cwd 定位，需项目已受信任
 *   （trust.json 记录），否则跳过并提示。`memory.enabled` 为 false 时照样能看、能改（条目保留但不使用）。
 * - `list` / `show` / `path` 只读；`edit` 在 `$EDITOR` 里改副本，存回时同样查凭据与上限；`rm` 在终端里确认，
 *   非终端需 `--yes`。
 * - `enable` / `disable` 改用户级 `config.json` 的 `memory.enabled`（原子写 + `.bak`）。
 */

import { existsSync, readFileSync } from "node:fs";
import { loadConfigFile } from "../../config/load.js";
import { CONFIG_FILE, resolveConfigDir, resolveDataDir, userFile } from "../../config/paths.js";
import { findTrustEntry, readTrustFile } from "../../config/trust.js";
import type { AmaConfig } from "../../config/types.js";
import { writeConfigFile } from "../../config/write.js";
import { msg } from "../../i18n/index.js";
import { editMemory, type EditText } from "../../memory/edit.js";
import {
  logicalPath,
  projectRootOf,
  standaloneRoots,
  type MemoryScope,
} from "../../memory/paths.js";
import { findOne, listText, memoryErrorText, scopeSummaries } from "../../memory/report.js";
import { DEFAULT_MEMORY_LIMITS, MemoryStore } from "../../memory/store.js";
import { editExternally } from "../../modes/interactive/external-editor.js";
import { parseSubArgs, UsageError } from "../args.js";
import { confirmContinue } from "../choice-prompt.js";
import type { CliIo } from "../deps.js";
import { ExitCode } from "../exit-codes.js";

export interface MemoryCliDeps {
  /** 测试注入：代替真实编辑器。 */
  edit?: EditText;
  /** 测试注入：终端里的删除确认。 */
  confirm?(question: string): Promise<boolean>;
}

interface Context {
  store: MemoryStore;
  configPath: string;
  notes: string[];
}

function load(io: CliIo): Context {
  const configDir = resolveConfigDir({ env: io.env });
  const dataDir = resolveDataDir({ env: io.env });
  const configPath = userFile({ configDir }, CONFIG_FILE);
  const memory = loadConfigFile("config", configPath)?.value.memory ?? {};
  const scopes = memory.scopes ?? ["user", "project"];
  const notes: string[] = [];
  let projectRoot: string | undefined;
  if (scopes.includes("project")) {
    const trusted = findTrustEntry(readTrustFile(configDir).entries, io.cwd)?.trusted === true;
    if (trusted) projectRoot = projectRootOf(io.cwd);
    else notes.push(msg().memory.cli.untrusted(io.cwd));
  }
  if (memory.enabled !== true) notes.push(msg().memory.cli.disabledNote);
  const roots = standaloneRoots({ dataDir, projectRoot, user: scopes.includes("user") });
  const limits = {
    indexMaxBytes: memory.indexMaxBytes ?? DEFAULT_MEMORY_LIMITS.indexMaxBytes,
    fileMaxBytes: memory.fileMaxBytes ?? DEFAULT_MEMORY_LIMITS.fileMaxBytes,
    maxFiles: memory.maxFiles ?? DEFAULT_MEMORY_LIMITS.maxFiles,
  };
  const store = new MemoryStore(roots, limits, projectRoot === undefined ? {} : { projectRoot });
  return { store, configPath, notes };
}

function scopeFilter(store: MemoryStore, raw: string | undefined): MemoryScope[] {
  if (raw === undefined || raw === "all") return store.scopes();
  if (raw !== "user" && raw !== "project") throw new UsageError(msg().memory.cli.unknownScope(raw));
  return store.scopes().filter((s) => s === raw);
}

function setEnabled(io: CliIo, ctx: Context, enabled: boolean): number {
  const m = msg().memory.cli;
  let raw: Record<string, unknown> = {};
  if (existsSync(ctx.configPath)) {
    try {
      raw = JSON.parse(readFileSync(ctx.configPath, "utf8")) as Record<string, unknown>;
    } catch {
      io.stderr(`${m.configInvalid(ctx.configPath)}\n`);
      return ExitCode.Config;
    }
  }
  const memory =
    typeof raw["memory"] === "object" && raw["memory"] !== null
      ? (raw["memory"] as Record<string, unknown>)
      : {};
  writeConfigFile(ctx.configPath, { ...raw, memory: { ...memory, enabled } } as AmaConfig);
  io.stdout(`${enabled ? m.enabled(ctx.configPath) : m.disabled(ctx.configPath)}\n`);
  return ExitCode.Ok;
}

export async function runMemory(
  argv: readonly string[],
  io: CliIo,
  deps: MemoryCliDeps = {},
): Promise<number> {
  const m = msg().memory;
  const { positionals, values, flags } = parseSubArgs(argv, ["scope"], ["json", "yes"]);
  const [sub, ...rest] = positionals;
  if (flags.has("help") || sub === undefined) {
    io.stdout(m.cli.usage);
    return sub === undefined && !flags.has("help") ? ExitCode.Usage : ExitCode.Ok;
  }
  const ctx = load(io);
  const { store } = ctx;
  const name = rest.join(" ");
  const notes = (): void => {
    for (const note of ctx.notes) io.stderr(`${note}\n`);
  };
  try {
    switch (sub) {
      case "list": {
        const scopes = scopeFilter(store, values.get("scope"));
        if (flags.has("json")) {
          const out = scopeSummaries(store, scopes).map((s) => ({
            scope: s.scope,
            path: logicalPath(s.scope),
            dir: store.root(s.scope),
            indexBytes: s.indexBytes,
            omitted: s.omitted,
            entries: s.entries,
          }));
          io.stdout(`${JSON.stringify(out, null, 2)}\n`);
        } else io.stdout(`${listText(store, { scopes })}\n`);
        notes();
        return ExitCode.Ok;
      }
      case "path": {
        for (const scope of scopeFilter(store, values.get("scope")))
          io.stdout(`${scope}\t${store.root(scope) ?? ""}\n`);
        notes();
        return ExitCode.Ok;
      }
      case "show": {
        if (name === "") throw new UsageError(m.cli.needName(sub));
        const found = findOne(store, name);
        if (!found.ok) {
          io.stderr(`${found.message}\n`);
          return ExitCode.Usage;
        }
        io.stdout(`${(store.readRaw(found.entry) ?? "").trimEnd()}\n`);
        return ExitCode.Ok;
      }
      case "edit": {
        const scope = values.get("scope");
        const target =
          name !== "" ? name : scope === undefined ? undefined : scopeFilter(store, scope)[0];
        const edit: EditText =
          deps.edit ??
          ((text, file) =>
            editExternally(text, file, {
              env: io.env,
              suspend: () => undefined,
              resume: () => undefined,
            }));
        const outcome = await editMemory(store, target, edit);
        if (outcome.status === "not_found") {
          io.stderr(`${outcome.message}\n`);
          return ExitCode.Usage;
        }
        io.stdout(
          `${
            outcome.status === "saved"
              ? m.command.saved(outcome.path)
              : outcome.status === "cancelled"
                ? m.command.editCancelled
                : m.command.unchanged
          }\n`,
        );
        return ExitCode.Ok;
      }
      case "rm": {
        if (name === "") throw new UsageError(m.cli.needName(sub));
        const found = findOne(store, name);
        if (!found.ok) {
          io.stderr(`${found.message}\n`);
          return ExitCode.Usage;
        }
        const path = logicalPath(found.entry.scope, found.entry.file);
        if (!flags.has("yes")) {
          if (!io.stdinIsTTY && deps.confirm === undefined) {
            io.stderr(`${m.cli.needsYes}\n`);
            return ExitCode.Usage;
          }
          const question = m.cli.confirmRemove(path);
          const ok = await (deps.confirm ?? ((q) => confirmContinue({ question: q, env: io.env })))(
            question,
          );
          if (!ok) return ExitCode.Ok;
        }
        await store.remove(found.entry);
        io.stdout(`${m.command.deleted(path)}\n`);
        return ExitCode.Ok;
      }
      case "enable":
      case "disable":
        return setEnabled(io, ctx, sub === "enable");
      default:
        throw new UsageError(m.cli.usage.trimEnd());
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n`);
      return ExitCode.Usage;
    }
    io.stderr(`${memoryErrorText(error)}\n`);
    return ExitCode.RuntimeError;
  }
}
