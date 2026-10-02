# Changelog

English · [简体中文](CHANGELOG.zh-CN.md)

> This file is in English starting with 0.6.0. Release notes for 0.1 through 0.5.1 are in Chinese in
> [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md). New entries go into both files.

## Unreleased

Wave 6 (docs/wave6-plan.md) contracts and infrastructure (W6-C0):

- **Interface language**: new `AMA_LANG`, `--lang zh|en`, config `ui.language` (`auto` / `zh` / `en`), and `language` for
  profiles and the SDK. `auto` decides from `LC_ALL` / `LC_MESSAGES` / `LANG` and falls back to English. Message catalogs live in
  `src/i18n/`; interface text is migrated by later batches, so this build's interface is still Chinese. Development conventions
  are in [docs/i18n.md](docs/i18n.md); `pnpm check:i18n` runs in CI (a baseline of Chinese lines that may only shrink).
- **Text sent to the model is always English** (independent of the interface language; requests are byte-identical in both
  languages): the tool-result truncation marker `[… N chars omitted …]`, the compaction prune placeholder `[pruned: …]`, summary
  serialization truncation, `Tool calls:` / `Files changed:` and failure notes in external agent reports, hook block reasons and
  allowlist denial notes. Only tool results in new sessions are affected, the cache prefix is untouched; scripts that parse tool
  results by the old Chinese markers need updating.
- **Trace persistence**: session files gain `custom{customType:"ama.trace"}` entries (one `step` per model request, plus retry
  waits, fallbacks, compaction, auxiliary requests and external agent turn skeletons). They hold only ids, times and counts, no
  content, never enter the context and do not change requests. RPC clients see extra `entry_appended` events for them.
  Sub-sessions also measure time to first token and throughput.
- **RPC**: `permission_request.context` may carry `toolCallId` (approvals for this session's own tool calls now have `context`
  too); `keySource` may be `oauth`; the new command `get_trace` is registered (returns `not_implemented` until the trace batch
  lands).
- **Config**: the new keys `ui.replyLanguage`, `ui.agentBar`, `memory.*` and `auth.chatgpt.*` are validated and written to
  `config.schema.json` (the features arrive with later batches). Project level can only set `memory.enabled` to `false`;
  `ui.replyLanguage` and `auth` are user level only; the agent bar is off by default in embedding hosts. Command-line
  `--memory` / `--no-memory`; `auth.json` can hold OAuth entries (`type: "oauth"`).
- `ama memory`, `/config`, `/trace` and `/memory` are registered and currently reply "not available yet".
- The bundle is emitted as UTF-8 (Chinese is no longer escaped as `\uXXXX`), about 40 KB smaller.
- **English CLI interface** (W6-I1): `ama --help`, the startup screen and startup errors, exit code descriptions, and the
  output and errors of `ama providers` / `models` / `stats` / `sessions export` · `search` / `init` follow the interface
  language (`AMA_LANG=en` / `--lang en`); Chinese output is unchanged word for word. The `advice` of
  `ama models cache-probe --json` is human-readable text and follows the interface language too.
- **English interactive interface** (W6-I2): the TUI and line mode follow the interface language — startup header, status
  line, approval dialog (including the pre-execution preview and origin labels), Plan dialog, rewind list and panel, `/session`,
  `/cache`, `/permissions`, pickers, `/agents`, `/tasks`, Bypass confirmation, notices and key hints. Chinese output is
  byte-for-byte unchanged; compact status line notation (`ctx`, `cache`, `$`, `↑ ↓`) is not translated. Approval previews in
  `permission_request` events follow the interface language too.
- **`/config` settings panel** (W6-S): lists scalar settings by group with their effective value, source (default / user /
  profile / project / cli / env) and when a change takes effect (immediately / new session / restart); ↑↓ Enter / Space to
  change, `/` to search, Tab to switch the target layer (project level may only tighten), and overridden items are marked
  locked. Changes are written to disk at once (re-read before writing, one key only, `.bak` kept); immediate items apply to
  the current session right away, with a summary on close. `/config key=value` sets a single key (line mode too).
- **`ama config get | set | unset | list`**: `--project` writes the project level, `--json-value` passes lists / objects;
  unknown keys, invalid values and loosening at project level exit with 3; persisting `permission.mode full-auto` asks for
  confirmation in a terminal and needs `--yes` otherwise.
- **`ui.replyLanguage`**: when set, `Reply to the user in <language>.` is appended to the end of the system prompt's
  `rules` section at session start; requests are byte-identical when unset.
- **Bilingual docs and config descriptions** (W6-I4): `README.md` and `CHANGELOG.md` are now English (shown on the npm page);
  the Chinese versions moved to `README.zh-CN.md` and `CHANGELOG.zh-CN.md` (which keeps the full 0.1–0.5.1 history).
  `docs/en/` adds English versions of `tui`, `permissions`, `providers`, `rpc`, `host-api` and `sessions`; the Chinese docs keep
  their paths. Config key descriptions, validation diagnostics and `ama init` output follow the interface language;
  `config.schema.json` descriptions are written in the current interface language and rewritten by the next `ama init` (or any
  command that auto-initializes) after switching. `pnpm release:check` understands the new CHANGELOG layout.
- **`/trace`** (W6-T1): interactive mode opens a trace overlay — turn → request → tool → sub-call / subagent, each row with
  duration, TTFT / decode / tool bars, tokens and cache hits; Enter shows details, subagents expand into their child sessions,
  long sessions load from the tail and follow while running; `/trace <task id>` shows one task; line mode prints a text tree.
  Old sessions without timing records are estimated from entry timestamps and marked `≈` (session files are not changed).
  The SDK exports the pure function `buildTrace()`. See [docs/tui.md](docs/tui.md) "Trace".
- **Agent bar** (W6-A): above the status line, lists subagent tasks (queued / running · elapsed · turns · last tool / awaiting
  approval / done / failed / stopped), up to 3 rows + "N more"; finished tasks stay until viewed, at most 10 minutes. With an
  empty input, `Ctrl+B` or `↓` focuses it (`app.agents.focus`; with text `Ctrl+B` still moves the cursor left; use `↓` in tmux),
  ↑↓ selects, Enter opens. Hidden by default when embedded in a host (`ui.agentBar: "off"`).
- **Subagent view** (W6-A): a full-screen overlay on the main screen (rows − 1) that follows the child session's messages and
  tool calls live; external agents show in-memory live output (≤ 2000 events / 1 MB, not persisted). The input box talks to the
  subagent directly: queued until the end of its current turn while running, until the end of the run for external agents, or
  resumed in the background when finished; recorded as `origin: "direct"` in the child session. Esc returns without
  interrupting; the subagent's approvals pop up in the view with their origin. `/tasks` now focuses the agent bar and
  `/tasks <id>` opens the view directly (the old picker remains when `ui.agentBar` is `"off"`).
- **ChatGPT login** (W6-O): `ama auth login chatgpt` drives ama with your own ChatGPT Plus / Pro subscription. The default is
  OpenAI's official Sign in with ChatGPT (dynamic registration, JWKS-verified id_token); `--flavor codex` is an explicit
  opt-in fallback that borrows the Codex CLI public client (first use asks you to confirm it is unofficial and for personal use
  only). `--paste` pastes the callback URL (SSH / hosts), `--device` uses a device code (codex only); `ama auth status` /
  `logout chatgpt`; `ama auth list` shows `oauth · <flavor> · <plan>`. New built-in provider `chatgpt` (channels `siwc` /
  `codex`, defaulting to the login flavor); list models with `ama models discover chatgpt`. Credentials are stored as an OAuth
  entry in auth.json (0600) and refreshed automatically, serialized across processes with `auth.json.lock`; failures report
  `auth_expired`; tokens never reach logs, sessions, events or errors. Subscription requests record `cost = 0` with
  `billing: "subscription"`; `/session` lists subscription usage and quota; new event `quota_update`; an exhausted quota
  reports `quota_exceeded` without retrying. See [docs/providers.md](docs/providers.md) "ChatGPT login".
- **Memory** (W6-M, [docs/memory.md](docs/memory.md)): cross-session memory, **off by default**; enable with `ama memory enable`,
  `--memory` or `AMA_MEMORY=1`. Entries are Markdown files with frontmatter under
  `<data dir>/memory/{user,projects/<dir>-<sha8>}/`, with an auto-rebuilt `MEMORY.md` index; the project scope requires a trusted
  project; when disabled the request body is byte-for-byte unchanged. New `memory` tool (`view` / `create` / `str_replace` /
  `delete`, paths limited to `/memories/<scope>/`) with a `memory` permission class: in default mode the first write asks and
  can be allowed for the session; content that looks like a credential is refused; subagents are read-only; `memory(...)`
  rules match by command or logical path. New `memory` system-prompt section (after `skills`, index only): fixed at session
  start, writes take effect next session, refreshed by `/memory reload` and after compaction; **enabling it causes one cache
  miss on the first request.** `/memory` (panel, show, edit, rm, on|off, reload) and
  `ama memory list|show|edit|rm|path|enable|disable`; post-compaction notes list memory paths read or written. Disabled by
  default for embedding hosts and the SDK; enable with `memory: { enabled, dir }` (workspace scope only, no user scope).
- **Trace HTML, `ama sessions trace` and RPC `get_trace`** (W6-T2): `ama sessions trace <id|file>` exports a self-contained
  single-file HTML page (tree + waterfall, TTFT / decode / tool colors, nested subagents and external agents, search, jump to
  turn, zoom, details, a virtual list for long sessions, light and dark; inline styles and script with a CSP that blocks all
  external loads; data and content redacted twice and the data block escaped against injection). `--json` prints the same shape
  as `get_trace`, `--no-content` keeps only structure and numbers, `--children` embeds child-session previews, `--open` opens a
  browser and `--now` pins the generation time (deterministic output). RPC `get_trace` is implemented: tail-first paging
  (`turnLimit` / `before`), increments by `since` (driven by `entry_appended`), `taskId` sub-traces and redacted previews with
  `content: "preview"` (the result gains the optional fields `task` and `previews`). SDK `session.trace()`. See
  [docs/en/sessions.md](docs/en/sessions.md) "Trace" and [docs/en/rpc.md](docs/en/rpc.md) "Trace".
- **English for the remaining modes and areas** (W6-I3): the stderr of `ama -p` (retries, budget limits, pending plans,
  denied tools), human-readable RPC `error` and ACP error messages / permission option names, slash command descriptions and
  replies, `/session` and `/cache` reports and cache notices, the `--no-tui` startup questions, `ama doctor` (now also shows
  "UI language: en (source …)"), `ama sessions list / show / prune` (usage now lists `ama sessions trace`), Markdown session
  export, checkpoint / sandbox / hook / host adapter / external agent notices, model lookup failures and models.dev
  descriptions follow the interface language. Chinese output is unchanged word for word; JSON fields of RPC and
  `-p --output-format json` do not change. Errors that land in `task` tool results (unknown external agent, host-only agent,
  queued interrupt) and the "… N more tool calls" summary line are now always English, like other model-facing text.

## Earlier releases

See [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) (Chinese).
