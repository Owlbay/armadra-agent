# Changelog

English · [简体中文](CHANGELOG.zh-CN.md)

> This file is in English starting with 0.6.0. Release notes for 0.1 through 0.5.1 are in Chinese in
> [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md). New entries go into both files.

## Unreleased

- **Startup header with an AMA logo and a short light-up animation**: the boxed info block is replaced by a 5-row "AMA" logo
  (block characters, colored letter by letter with the theme's accent → user → tool; a `_ / \ |` version in ASCII mode) with
  the version, model, directory, mode and key hints beside it (72+ columns) or below it (48–71 columns); below 48 columns a
  two-line header is shown. On startup a one-off sweep of about a second lights the logo up and settles in place, leaving no
  frames in the scrollback; any key settles it at once and still reaches the input box. It does not play with
  `ui.animation: false`, without colors, outside a TTY, in an embedding host, under `CI`, with a command-line prompt or in a
  short terminal. New `ui.logo: "auto" | "off"` (off shows only the info lines). Docs: docs/en/tui.md "Startup screen".

## 0.6.2 (2026-10-03)

- **ChatGPT codex sign-in lists models, and the channel follows the sign-in method**: the codex model list
  (`GET /models?client_version=…`) used to send ama's own version, which the backend filters against each model's minimum
  Codex client version, so it returned no models; it now sends a Codex CLI version (default `0.160.0`, new user-level
  `auth.chatgpt.codexClientVersion`, environment `AMA_CHATGPT_CODEX_CLIENT_VERSION`) and suggests raising it when codex still
  returns none. The context window, input modalities and reasoning efforts from the codex response go into the discovery cache
  and are used when models.dev has no data. Requests to `chatgpt` now pick the channel from the current sign-in at request time:
  a model without an explicit `@channel` follows it, so a running session keeps working after switching between siwc and codex,
  and a resumed session ignores the channel it recorded; only an explicit `@channel` that differs reports
  `chatgpt_flavor_mismatch`, now with a clearer message. Login always rewrites the discovery cache (an empty list included)
  after deleting the old one, and a cache whose flavor differs from the current sign-in counts as stale. `not_eligible` now
  lists the likely causes (plan, workspace account, region or preview rollout — the most likely one for Pro accounts) and
  suggests `--flavor codex`; a siwc login notes that eligibility is only confirmed on the first request. Also fixed: an
  unlisted slug with an explicit `@channel` (`chatgpt/<slug>@siwc`) kept the default channel's endpoint. Docs:
  docs/en/providers.md "ChatGPT login".

## 0.6.1 (2026-10-03)

- **The model picker shows only configured models; ChatGPT models can be picked**: `/model` (and the startup picker and
  `/config` model items) lists only providers with a key, a valid OAuth sign-in or a local server, one row per model on
  multi-channel providers (other channels in the description; type `@` in the filter for `model@channel` rows); the current
  model is pinned when it is not listed. `Tab` switches to "all" (unconfigured providers marked "no key configured", with an
  `ama auth set` hint), `Space` adds / removes the highlighted model to / from the new user-level `models.enabled` list
  (`provider/model[@channel]`, `provider/*`), which, once set, is all the picker shows; `ama models enable | disable` and
  `ama models list --enabled` edit and show it. `ama auth login chatgpt` now fetches the models available to the account
  (read-only, no usage) into `<dataDir>/models/discovered/chatgpt.json`, `ama models discover chatgpt` rewrites it and
  logout deletes it; the registry merges the cache into providers with an empty model table, so ChatGPT models appear in
  `/model` and `ama models list`. Note: with only a ChatGPT sign-in and no `defaultModel`, the first cached ChatGPT model can
  now be chosen as the default model. Docs: docs/en/tui.md, docs/en/providers.md "ChatGPT login".

- **`ama auth login chatgpt` explains a refused sign-in**: when the OAuth callback carries `error=access_denied` (or another
  error) the message now lists the likely causes (the authorization page was cancelled or plan usage was not checked; the
  account / plan is not eligible — sharing is Plus / Pro only, Team / Enterprise workspaces may not offer it, the browser may be
  signed in to another account; the region is not supported) and, for siwc, suggests the fallback
  `ama auth login chatgpt --flavor codex`. Nothing is retried or switched automatically.

- **`ama config set` reports the written value when a higher layer overrides it**: with e.g. `AMA_LANG=zh`,
  `ama config set ui.language en` used to print the effective value `zh` labelled "(user)". The first line is now the value just
  written and its layer (`ui.language = en (written to user)`), and the second line names the override and the effective value
  (`Still overridden by AMA_LANG (zh); the effective value is zh`). `ama config get` still shows the effective value and its
  real source.

## 0.6.0 (2026-10-03)

Wave 6: the agent bar and sub-agent view, traces, memory, ChatGPT login, the `/config` settings panel, and a bilingual
(Chinese / English) interface. The design and decision table are in docs/wave6-plan.md; current docs per topic are linked below.

### Breaking changes and upgrade notes

- **The interface may switch to English**: the new default `ui.language: "auto"` decides from `LC_ALL` / `LC_MESSAGES` / `LANG`;
  `zh*` is Chinese and everything else (including undecidable) is English. The common macOS `LANG=en_US.UTF-8` makes Chinese
  users see English after upgrading; to keep Chinese, run `ama config set ui.language zh` (or use `--lang zh`, `AMA_LANG=zh`).
- **README and CHANGELOG are now English**: `README.md` / `CHANGELOG.md` are English (shown on the npm page); the Chinese versions
  are `README.zh-CN.md` / `CHANGELOG.zh-CN.md` (with all notes for 0.1–0.5.1). Chinese docs keep their paths; `docs/en/` has six
  English translations.
- **Markers sent to the model are now English** (independent of the interface language; requests are byte-identical in both):
  the tool-result truncation marker `[… N chars omitted …]`, the compaction prune placeholder `[pruned: …]`, summary
  serialization truncation, `Tool calls:` / `Files changed:` and failure notes in external agent reports, hook block reasons,
  allowlist denial notes, errors that land in `task` tool results (unknown external agent, host-only agent, queued interrupt) and
  the "… N more tool calls" summary line. Only tool results produced after upgrading are affected and the cache prefix is
  untouched; **scripts that parse tool results by the old Chinese markers need updating**.
- **Session files gain `custom{customType:"ama.trace"}` entries** (one per model request, plus retry waits, fallbacks,
  compaction, auxiliary requests and external agent turn skeletons; ids, times and counts only, never in the context and never
  changing requests). RPC clients see extra `entry_appended` events for them; scripts that walk session entries should skip them.
- **`/tasks` now focuses the agent bar**, and `/tasks <id>` opens the sub-agent view directly; with `ui.agentBar: "off"` (the
  default in embedding hosts) it is still the old picker.
- **`ama sessions list` hides sub-agent (task) sessions by default**; `--all` lists them marked `↳ subagent`. `ama -c` and the
  `--resume` / `/resume` pickers no longer pick them (see "Other fixes and improvements").
- **`ama --help` changed**: both languages now list `--lang`, `--memory` / `--no-memory`, `ama auth login | logout | status`,
  `ama config get | set | unset | list`, `ama memory` and `ama sessions trace`; scripts that parse the help text need updating.
- **The `ama stats` index version was bumped**: the first run rescans all sessions automatically (incremental afterwards).
- **`PresetResolution.warnings` is structured**: the warnings of `resolvePreset()` changed from Chinese strings to
  `{ kind: "codemode_only_fallback" | "codemode_unavailable" | "unknown_tool", … }`, rendered by the caller.
- **18 built-in providers** (new: `chatgpt`): scripts that enumerate built-in providers see one more.
- **One cache miss** (only when the matching feature is turned on): the first request after enabling memory (the new `memory`
  system section and `memory` tool), and the first session after setting `ui.replyLanguage` (one more line at the end of
  `rules`). With neither, the system prompt and tool table sent for the `default` / `minimal` presets are byte-identical to 0.5.1.
- Protocol version constants (`RPC_PROTOCOL_VERSION`, `HOST_API_VERSION`, session format version) are unchanged; all new events,
  commands and fields are optional; exit codes are unchanged.

### Agent bar and sub-agent view

- **Agent bar** ([docs/en/tui.md](docs/en/tui.md) "Agent bar"): sub-agent tasks are listed above the status line (queued /
  running · elapsed · turns · latest tool / awaiting approval / done / failed / stopped), at most 3 lines plus "N more"; finished
  tasks stay until viewed, at most 10 minutes. Enter it with `Ctrl+B` or `↓` on an empty input (key action `app.agents.focus`;
  with text `Ctrl+B` still moves the cursor left; use `↓` in tmux), ↑↓ to select, Enter to open. Hidden by default in embedding
  hosts (`ui.agentBar: "off"`).
- **Sub-agent view**: a full-screen overlay on the main screen (rows − 1) that follows the sub-session's messages and tool calls
  live; external agents show live output kept in memory (≤ 2000 items / 1 MB, never written to disk). The input box talks to the
  sub-agent directly: while it runs the message is queued until the turn ends, external agents get it after the current run, and
  finished tasks continue in the background; the sub-session records it as `origin: "direct"`. Esc goes back (no interrupt); the
  sub-agent's approvals pop up over the view with their origin; `/tasks stop <id>` works inside the view too.

### Traces

- **Timing on disk**: every model request records an `ama.trace` entry (time to first token, decode, tools, retry waits,
  fallbacks, compaction, auxiliary requests); sub-sessions measure time to first token and throughput too. Ids, times and counts
  only, no content.
- **`/trace`** ([docs/en/tui.md](docs/en/tui.md) "Traces"): turn → request → tool → sub-call / sub-agent, each row with duration,
  TTFT / decode / tool bars, tokens and cache hits; Enter for details; sub-agents expand into their sub-sessions; long sessions
  load from the tail and follow while running; `/trace <task id>` for one task; line mode prints a text tree. Older sessions
  without timing records are estimated from entry times and marked `≈`, without changing the session file.
- **`ama sessions trace <id|file>`** ([docs/en/sessions.md](docs/en/sessions.md) "Traces"): exports a self-contained single-file
  HTML page (tree + waterfall, TTFT / decode / tool colors, nested sub-agents and external agents, search, jump to turn, zoom,
  details, virtual list, light and dark; inline styles and script with a CSP that blocks all external loads; data and content
  redacted twice and the data block escaped against injection). `--json` prints the same shape as `get_trace`, `--no-content`
  keeps only structure and numbers, `--children` embeds child-session previews, `--open` opens a browser and `--now` pins the
  generation time (byte-for-byte deterministic output).
- **RPC `get_trace`** ([docs/en/rpc.md](docs/en/rpc.md) "Traces"): tail-first paging (`turnLimit` / `before`), increments by
  `since` (driven by `entry_appended`), `taskId` sub-traces and redacted previews with `content: "preview"`; 43 RPC commands in
  total. SDK `session.trace()`; the pure function `buildTrace()` and the `Trace` type are exported from the package entry.

### Memory

- Cross-session memory ([docs/memory.md](docs/memory.md), Chinese), **off by default**: enable with `ama memory enable`,
  `--memory` or `AMA_MEMORY=1`. Entries are Markdown files with frontmatter under
  `<data dir>/memory/{user,projects/<dir>-<sha8>}/`, with an auto-rebuilt `MEMORY.md` index; the project scope requires a
  trusted project; when disabled the request body is byte-for-byte unchanged.
- New `memory` tool (`view` / `create` / `str_replace` / `delete`, paths limited to `/memories/<scope>/`) with a `memory`
  permission class: in default mode the first write asks and can be allowed for the session; content that looks like a
  credential is refused; sub-agents are read-only; `memory(...)` rules match by command or logical path. Project level can only
  set `memory.enabled` to `false`.
- New `memory` system-prompt section (after `skills`, index only): fixed at session start, writes take effect next session,
  refreshed by `/memory reload` and after compaction; post-compaction notes list memory paths read or written.
- `/memory` (panel, show, edit, rm, on|off, reload) and `ama memory list|show|edit|rm|path|enable|disable`. Disabled by default
  for embedding hosts and the SDK; enable with `memory: { enabled, dir }` (workspace scope only, no user scope).

### ChatGPT login

- `ama auth login chatgpt` drives ama with your own ChatGPT Plus / Pro plan ([docs/en/providers.md](docs/en/providers.md)
  "ChatGPT login"). By default it uses OpenAI's official Sign in with ChatGPT (dynamic registration, id_token verified against
  JWKS); `--flavor codex` is an opt-in fallback (borrowing the Codex CLI public client after a one-time "unofficial, personal use
  only" confirmation). `--paste` pastes the callback URL (SSH / hosts), `--device` uses a device code (codex only);
  `ama auth status` / `logout chatgpt`; `ama auth list` shows `oauth · <flavor> · <plan>`.
- New built-in provider `chatgpt` (channels `siwc` / `codex`, defaulting to the signed-in flavor); list its models with
  `ama models discover chatgpt`.
- Credentials are an OAuth entry in `auth.json` (`type: "oauth"`, 0600), refreshed automatically and serialized across processes
  with `auth.json.lock`; failures report `auth_expired`; tokens never reach logs, sessions, events or errors; RPC `keySource` may
  be `oauth`.
- Plan requests record `cost = 0` with `billing: "subscription"`; `/session` lists subscription usage and quota, and `ama stats`
  has its own "Subscription" row (not in the cost, not counted as unpriced); new event `quota_update` (RPC and host events); an
  exhausted quota reports `quota_exceeded` without retrying.

### `/config` and `ama config`

- **`/config` settings panel** ([docs/en/tui.md](docs/en/tui.md) "The `/config` settings panel and `ama config`"): lists scalar
  settings by group with their effective value, source (default / user / profile / project / cli / env) and when a change takes
  effect (immediately / new session / restart); ↑↓ Enter / Space to change, `/` to search, Tab to switch the target layer
  (project level may only tighten), overridden items marked locked. Changes are written at once (re-read before writing, one key
  only, `.bak` kept); immediate items apply to the current session right away, with a summary on close. `/config key=value`
  sets a single key (line mode too).
- **`ama config get | set | unset | list`**: `--project` writes the project level, `--json-value` passes lists / objects; unknown
  keys, invalid values and loosening at project level exit with 3; persisting `permission.mode full-auto` asks for confirmation
  in a terminal and needs `--yes` otherwise.
- **`ui.replyLanguage`**: when set, `Reply to the user in <language>.` is appended to the end of the system prompt's `rules`
  section at session start; requests are byte-identical when unset (user level only).

### Bilingual interface

- **Interface language**: `AMA_LANG`, `--lang zh|en`, config `ui.language` (`auto` / `zh` / `en`), and `language` for profiles
  and the SDK. The CLI (`--help`, startup screen, errors, subcommand output), the TUI and line mode (startup header, status line,
  approval dialog and preview, Plan dialog, rewind, panels and pickers, notices and key hints), the stderr of `-p`,
  human-readable RPC `error` and ACP error / permission option names, approval previews in `permission_request`, slash command
  descriptions and replies, `ama doctor` (with a new "UI language" line), Markdown session export, config key descriptions and
  validation diagnostics, and `ama init` output all follow it. Chinese output is unchanged word for word; compact status line
  notation (`ctx`, `cache`, `$`, `↑ ↓`) is not translated; JSON fields of RPC and `-p --output-format json` do not change.
  `config.schema.json` descriptions are written in the current language; run `ama init` again after switching.
- **Hosts decide by `code`** and must never parse the human-readable `error` / `message` ([docs/en/rpc.md](docs/en/rpc.md)).
- **Bilingual docs**: `docs/en/` adds English versions of `tui`, `permissions`, `providers`, `rpc`, `host-api` and `sessions`
  (each header records the Chinese commit it translates); development conventions are in [docs/i18n.md](docs/i18n.md) (Chinese).

### Other fixes and improvements

- **Continue / resume skip sub-agent sessions**: `ama -c`, the `--resume` picker, the interactive `/resume` picker and ACP
  `session/list` no longer pick or list sub-agent (task) sessions — those whose header has `parentSession` and whose first
  entry is `custom{ama.task}` (forks still count). `-c` only reads the first two lines of each file. An explicit
  `--resume <sub-agent session id>` still works; `prune`, `stats` and `sessions search` are unchanged.
- The bundle is emitted as UTF-8 (Chinese is no longer escaped as `\uXXXX`), about 40 KB smaller.
- RPC `permission_request.context` may carry `toolCallId` (approvals for this session's own tool calls now have `context` too).
- `ama memory enable / disable` write through the same path as `/config` (re-read before writing, one key only, `.bak` kept).
- The `/trace` detail key column fits the longest key (no misalignment in English); the `/config` footer no longer truncates at
  80 columns in English.

### Interfaces, tests and release

- Wave 6 contracts (docs/wave6-plan.md §7, all optional and backward compatible): the `Trace` type and `buildTrace()`, SDK
  `session.trace()` and the `memory` option, RPC `get_trace` (optional result fields `task` and `previews`), the `quota_update`
  event, `oauth` in `KeySource`, OAuth entries in `auth.json`, and the config keys `ui.language` / `ui.replyLanguage` /
  `ui.agentBar` / `memory.*` / `auth.chatgpt.*` (written to `config.schema.json`).
- `pnpm check:i18n` runs in CI in strict mode: any Chinese line in `src/**` fails; the few allowed lines (input aliases, paste
  markers, `_reason` in price data) each carry a reason. Tests pin zh by default, plus English frame goldens and CLI samples.
- `release-check` understands the bilingual changelogs (both need a section for the current version) and notes (without failing)
  when a Chinese doc changed more than 5 times since the commit its `docs/en/` translation is based on.
- New bundle-level e2e: `ama auth status` without entries, deterministic `ama sessions trace --html` without external links,
  `AMA_LANG=en -p` requests byte-identical to zh, `ama config set / get / unset` round trips, and a `--memory` write visible in
  `ama memory list`.
- The npm package now also ships `docs/memory.md` and `docs/en/*.md`.

### Known limitations

- **ChatGPT login is not yet verified with a real account**: both flavors are tested against a local mock only. Three items
  await a real Plus / Pro account: the tool `namespace` shape on the official (siwc) path (`toolsInNamespace` stays off), whether
  the codex device code needs enabling in ChatGPT security settings, and the fields of the codex `wham/usage` quota response.
  Real-account checks run locally with `AMA_E2E_CHATGPT=1` (never in CI).
- The Linux sandbox (bubblewrap) is still not verified on real machines, only by unit tests and Ubuntu CI.
- Memory has no automatic extraction (writes happen only when the model calls the `memory` tool or the user runs a command);
  entering the agent bar with `↓` in tmux and the light / dark HTML trace are covered by automated tests only and await a manual
  check.

## Earlier releases

See [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) (Chinese).
