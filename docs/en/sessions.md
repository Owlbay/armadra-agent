# Session stats, search, reuse, export and checkpoints

English · [简体中文](../sessions.md)

> Translated from the Chinese [docs/sessions.md](../sessions.md) as of commit `ee89edb`. When the two differ, the Chinese
> version is authoritative. Sample command output below is illustrative; exact wording follows the interface language.

These commands only read the session directory (`<data dir>/sessions`, changeable with `--session-dir`; the file format is in [session-format.md](../session-format.md), Chinese): no locks, no repair of half-written lines, no file changes, so sessions that are still running can be read too. By default the scope is the sessions of the **current directory**; `--all` covers everything.

## Stats: `ama stats`

```
ama stats [--since 7d|30d|today|YYYY-MM-DD] [--until …]
          [--by day|week|month|provider|channel|model|project]
          [--project <dir> | --all] [--top N] [--json] [--no-cache]
```

```
$ ama stats --by model
All time · project /home/me/proj · 2 sessions
Requests       9 (chat 7 · permission_classify 1 · cache_warm 1)
Turns          3 · average 23.3s
Tokens         input 8.7k · output 1.7k · cache read 74.3k · cache write 0
Cache hit rate 89.5% (endpoints reporting cache 2/2; others are left out of the denominator)
Cost           $0.0398 (3 more requests have no price and are not counted)
Errors / retries 0 / 0

                         sessions  requests  turns  input  output  cache read  cache write  hit rate     cost
anthropic/claude-sonnet-4-5     1         6      2   4.1k     731       72.3k            0     94.6%  $0.0398
packy/deepseek-v4-flash         1         3      1   4.6k     980          2k            0     30.8%        —

Top 5 tool calls
  read  3
  edit  2
  …
```

- `--since` / `--until`: `7d` is the last 7 days including today, `today` is today, dates are local dates; both ends are inclusive.
- `--by project` without `--project` covers all projects. `--json` prints the same data (plus `files`: the number of scanned / cache-hit / invalid files).

### How the numbers are computed

| Item             | How                                                                                                                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requests         | One per model request: assistant messages in turns count as "chat"; `usage` entries are split by `kind` (`cache_warm` warming, `permission_classify` auto classification…); usage carried by `compaction` / `branch_summary` counts under the kind of the same name. A retried failed attempt also counts as a request |
| Turns            | A non-`steer` user message starts a turn that lasts until the next one; it counts only with at least one assistant message. Duration = time the last assistant message was written − time the user message was written                                                                    |
| Tokens           | `input` excludes the cached part (as in the session layer); cache reads / writes are listed separately                                                                                                                                                                                   |
| Cache hit rate   | cacheRead / (input + cacheRead + cacheWrite), only over endpoints that **report cache usage**: a `provider/model@channel` counts once any non-zero cache read or write appears for it in the scanned range; other endpoints are left out of the denominator (consistent with the session layer's three states, so relays that do not report cache usage never drag the hit rate to 0) |
| Cost             | Only requests carrying `usage.cost` (the model has a price) are summed; the number of unpriced requests is reported separately, and when nothing is priced only tokens are shown                                                                                                         |
| Tool calls       | Tool call blocks in assistant messages, counted by name; calls inside codemode scripts are not expanded                                                                                                                                                                                  |
| Errors / retries | Assistant messages with `stopReason: "error"`; `context_edit{reason:"retry"}` (failed attempts removed by automatic retry)                                                                                                                                                               |
| Channel          | The `channel` of the latest `model_change` with the same provider / model as the request                                                                                                                                                                                                 |

`task` sub-sessions are separate files and count under their own cwd.

### Performance and index

- Scanning is line by line; lines irrelevant to stats such as `toolResult`, `custom` and `label` are skipped by the leading `{"type":…,"message":{"role":…` without parsing (in lines written by ama, type is always the first key; lines written by other programs fall back to a full parse).
- A per-file summary is cached in `<data dir>/stats-index.json`, invalidated by file mtime and size; a time-zone change invalidates the whole index; a full scan also drops files that no longer exist. `--no-cache` neither reads nor writes it.
- Measured (local machine, `src/session/stats-perf.test.ts`): 1000 sessions, 67 MB (12 turns, 24 tool calls and 2 KB tool results each), about 160 ms cold and about 15 ms with the index.

## Search: `ama sessions search`

```
ama sessions search <keyword|/regex/flags> [--all] [--role user|assistant|tool] [--since 7d] [--limit N] [--json]
```

```
$ ama sessions search parser
3f9a1c2e#1    2026-09-29 01:00  /home/me/proj  user       fix the parser crash on empty input
3f9a1c2e@4    2026-09-29 01:00  /home/me/proj  tool       src/parser.ts:42: if (input.length === 0)
```

- Keywords are case-insensitive; `/…/` is a JavaScript regular expression (write flags as usual, e.g. `/todo|fixme/i`).
- User text, assistant text, tool calls (`name argument-JSON`) and tool results are searched; thinking, system and custom entries are not. `--role` accepts several comma-separated values.
- Each line: the first 8 characters of the session id + a number (`#n` for user messages, usable directly with `--from`; otherwise the entry index `@k`, i.e. the k-th entry in the file), time, project, role, snippet. When stdout is a terminal and `NO_COLOR` is unset, matches are highlighted; otherwise plain text. `--json` prints one line per match.
- Newest sessions first; `--limit` defaults to 20. When the keyword contains no quotes or backslashes, raw lines are pre-filtered and non-matching lines are not parsed.

## Reuse: `sessions show` numbers and `--from`

`ama sessions show <id>` lists the user messages at the end, numbered in file order (including steers, queued `followUp` messages and host injections, with origin and image count marked):

```
User messages (reuse with ama --from 3f9a1c2e#<number>):
  #1   2026-09-29 01:00:06  fix the parser crash on empty input
  #2   2026-09-29 01:00:44  also make the error message clearer
```

`--from <id>[#number]` uses that message as the new prompt (the last one when no number is given). It starts a new session, and you may switch models:

```sh
ama -p --from 3f9a1c2e#1 --model packy/deepseek-v4-flash      # ask the same question with another model
ama -p --from 3f9a1c2e "only change the tests, not the code"   # a positional argument is appended after the original (blank line between)
ama --from 3f9a1c2e#2                                          # interactive UI: sent right away as the initial prompt
```

- With `-p`, images in the original message are sent too (written to a temp directory, validated like `--image`, exit 2 when the model does not accept images; deleted after the run). Interactive / line mode carry only the text and print one line on stderr when images are present.
- A number out of range or malformed → exit 2; a missing session → exit 5. Not supported with `--mode rpc`.

## Export: `ama sessions export`

```
ama sessions export <id> [--format md|json|jsonl] [--output <file>] [--branch leaf|all]
```

| Format         | Contents                                                                                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `md` (default) | For people: user messages (numbered), assistant text, tool calls (argument JSON cut to 500 characters) and results (cut to 2000 characters), compaction / branch summaries, model switches, and a usage table at the end; thinking and system are omitted, images become placeholders |
| `json`         | `{ format: "ama.session-export", version: 1, session, branch, leafId, userMessages, usage, entries }`, where `entries` are the original entries                                                                                                                |
| `jsonl`        | A header + the selected entries, in the same shape as session files, so ama can read it back (without the `leaf` line)                                                                                                                                         |

- `--branch leaf` (default) is the branch from the root to the current leaf (matching the current position in `/tree`); `all` is every entry in the file.
- `--output` writes a file (permission 0600); otherwise stdout.
- **Redaction**: before export, key / token-shaped strings are replaced with `[REDACTED]`: `sk-…`, `sk-ant-…`, `ghp_…`, `github_pat_…`, `xox?-…`, `AIza…`, `AKIA…`, `npm_…`, JWTs, `Bearer` / `Basic` credentials, PEM private key blocks, and values directly after `apiKey` / `secret` / `token` / `password` / `authorization` followed by `:` or `=`; in json / jsonl, string values under secret-looking key names are masked whole. Image base64 is kept. Detection is by shape only and cannot guarantee completeness, so review before sharing.

## Checkpoints and file backups

Rolling back code (`/rewind`, design in [rewind-plan.md](../rewind-plan.md), Chinese) relies on checkpoints: at the start of each new turn, ama records the contents of the files changed by edit / write at that moment.

- **Storage**: backups are stored by content sha256 at `<data dir>/file-history/blobs/<first 2 chars>/<sha256>`, raw bytes, uncompressed; shared across sessions and checkpoints, so identical content is stored once. Session files only hold two kinds of `custom` entries, `ama.checkpoint` / `ama.checkpoint-track` (hashes only, never in the context). When the session directory is not in the default location (`--session-dir`, the host profile's `sessionDir`), the directory is registered in `file-history/roots.json` and scanned during cleanup as well.
- **What is tracked**: edit / write (including codemode inner calls and task sub-sessions) back up a file before writing it the first time; afterwards each new turn re-snapshots the tracked files from the current disk contents, so bash or manual changes to those files also enter the next checkpoint. Other files created or changed by bash are not tracked.
- **Cleanup**: after `ama sessions prune` finishes, it scans checkpoint references in all session files (including those still recoverable in `.trash/`) and deletes backups that are unreferenced and older than 1 day; `--dry-run` only reports. The "Directories" section of `ama doctor` shows the backup count and size.
- **Config**: `checkpoints.mode` (`tools` default / `shadow-git` / `off`; the `AMA_CHECKPOINTS` environment variable overrides; see below for `shadow-git`), `checkpoints.maxFileBytes` (default 5 MiB), `checkpoints.keep` (default 100; older checkpoints are no longer listed as rewind points). The project-level `.ama/config.json` can only set `mode` to `off` and lower `maxFileBytes`.
- **Limitations**:
  - Files above `maxFileBytes`, symbolic links and non-regular files are not backed up, and rollback reports them as unrecoverable.
  - On restore, targets that are symbolic links, hard links (link count > 1) or non-regular files, or whose parent directory was moved / replaced by a link, are skipped with the reason listed; when a backup was already cleaned up, `backup_missing` is reported.
  - Conflict detection: a file whose current content is neither what ama last wrote nor what the latest checkpoint recorded is treated as a manual change outside the turn and skipped by default. "What ama last wrote" lives only in process memory; after resuming a session the latest checkpoint is the reference, so a file ama wrote in the previous turn with no checkpoint since then is treated as a conflict (overwriting is an option).
  - git state is left alone: only HEAD is recorded, and rollback shows a hint when HEAD has changed.
  - In-memory sessions (not written to disk) have no checkpoints.

### Shadow git mode (`checkpoints.mode: "shadow-git"`)

`tools` mode only sees files touched by edit / write; shadow git additionally snapshots the whole working directory into a separate git repository at every new turn, so additions, changes, deletions and renames made by bash or by hand can be rolled back too.

- **Repository**: `<data dir>/file-history/shadow/<first 16 chars of sha256(working dir)>/`, using `--git-dir` / `--work-tree` to point at the working directory, never touching your own repository's objects, index, refs or HEAD. Sessions in the same working directory share one shadow repository (each process uses its own index file); `ama sessions prune` does not clean shadow repositories, so delete the directory when no longer needed (afterwards those checkpoints restore from the `tools` records). `ama doctor` shows the number and size of shadow repositories on the file-history line.
- **Snapshots**: at the start of a new turn, `git add -A` + `write-tree` + `commit-tree` (parent: the previous shadow commit), with the commit id recorded as the checkpoint's `shadowCommit`. The shadow repository uses a fixed identity and empty global / system config (your signing, hooks, filters and templates are not read), `core.autocrlf=false` with line-ending conversion off, so raw disk bytes are stored; `gc.auto=0`.
- **Ignores**: `.gitignore` in the working directory applies; when the working directory is inside a git repository, paths your repository ignores (parent `.gitignore` files, `info/exclude`, the global ignore file) stay out of the shadow repository too; `.git` is always excluded.
- **Restore**: the current working directory is written as a tree and compared with the target commit, so only differing files are processed; conflict and safety checks are the same as in `tools` (symbolic links, hard links, non-regular files and directories on the path replaced by links are skipped). The "known" current content = what is in the latest shadow snapshot, what ama last wrote or what the latest checkpoint recorded; anything else counts as a change outside the turn and is skipped by default. Ignored files are left alone; files changed by edit / write but not in the shadow repository (outside the working directory, ignored) restore from the `tools` records. When the target checkpoint has no shadow commit (after a downgrade, or the shadow repository was deleted) the whole restore follows `tools`.
- **Guards**: in these cases the session downgrades to `tools` with a one-time notice: `git` is not on PATH; the working directory (ignored files excluded) has more than 20 000 files (checked before the first snapshot); a single snapshot takes longer than 3 seconds (that commit is kept). It is not enabled when the working directory is the home directory or the file-system root.
- **Limitations**:
  - bash changes in the latest turn enter a snapshot only when the next turn starts; rolling back before that, they cannot be told apart from manual changes and count as conflicts (overwriting is an option).
  - git only records the executable bit: restore only adjusts the executable bit and keeps other permission bits; symbolic links and submodules are not restored.
  - The shadow repository stores every non-ignored file, large files included (not limited by `maxFileBytes`; on restore, files above it are reported as unrecoverable); for large directories without `.gitignore`, `tools` is recommended.

## Rewind (within a session)

`/rewind`, RPC `rewind` and SDK `session.rewind()` return to before a user message (design in [rewind-plan.md](../rewind-plan.md), Chinese):

- Rewind points are the user messages on the active path that start new turns, oldest first; steers, queued messages and messages continued by the Stop hook belong to the current turn and are not listed separately. Rewinding while running reports `busy`.
- Conversation rewind reuses the `/tree` leaf switch: the abandoned branch stays in the file and can be revisited from `/tree`; the model, thinking level and permission mode stay as they are and do not change with the rewind. The system prompt, tool table and messages before the target of the next request are byte-identical to before the rewind, so the prompt cache hits as usual.
- The "read" set is recomputed from successful read / write calls on the new path, minus files that were restored, deleted or differ from the target checkpoint; the model has to read those files again before editing them.
- For conversation-only or code-only rewinds, an `ama.rewind-note` is appended at the end before the next prompt to tell the model which files disagree with the conversation; nothing is appended for conversation + code.
- In-memory sessions and `checkpoints.mode: "off"` create no checkpoints, so only conversation rewinds are possible.
- When Esc interrupts a run before this turn produced any reply or tool call, the turn is withdrawn and the original message put back (`ui.restoreOnCancel`, default true).

## Request details (design, not implemented)

The plan is to append `custom{customType:"ama.request"}` entries to the session (never in the context), one per model request:

```json
{
  "type": "custom",
  "customType": "ama.request",
  "data": {
    "purpose": "turn",
    "provider": "packy",
    "model": "kimi-k2.5",
    "channel": "messages",
    "startedAt": "…",
    "firstByteMs": 820,
    "durationMs": 6400,
    "httpStatus": 200,
    "attempt": 1,
    "stopReason": "toolUse"
  }
}
```

Why it is not implemented yet: the HTTP status and time to first byte are only visible in the protocol layer (`src/ai/http.ts`, the `apis/*` modules), while retries live in `agent/session-run.ts`, so recording needs to touch all of these at once, overlapping with the timeout / retry feedback changes. For now `ama stats` approximates with existing data: turn duration from write-time differences, retries from `context_edit{reason:"retry"}`, failures from `stopReason: "error"`. The implementation would add a request-finished callback next to `StreamOptions.onResponse`, letting the session layer write the fields above as a `custom` entry; once `ama stats` reads them it can show per-request duration distributions and HTTP status counts.
