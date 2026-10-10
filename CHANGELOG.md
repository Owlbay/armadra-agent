# Changelog

English · [简体中文](CHANGELOG.zh-CN.md)

> This file is in English starting with 0.6.0. Release notes for 0.1 through 0.5.1 are in Chinese in
> [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md). New entries go into both files.

## 0.8.1 (2026-10-11)

### Maintenance

- **Repository moved to the AMA-Link organization**: the source, issues and releases now live at github.com/AMA-Link/armadra-agent; the package metadata, the built-in docs link, the OpenRouter `HTTP-Referer` and the config schema `$id` point there. Old links redirect (#206, #207).
- **Toolchain**: development uses pnpm 12.8.1 and CI runs single-version jobs on Node 24; the published package still supports Node ≥ 22 and is tested on 22 and 24 (#205).

## 0.8.0 (2026-10-10)

### External agents

- **New `pi` driver**: `task(agent="pi")` drives `pi --mode rpc` (verified with pi 1.1.0). pi has no approval channel of its own, so ama loads a minimal extension for that run (`-e`, written to a per-session temp dir and deleted on close; pi's config is untouched) that routes every non-read-only tool call to ama: rejected in `plan` / `allowlist` (which also only enable `read,grep,find,ls`), `edit` / `write` allowed from `auto-edit` up, everything else asks you. Dialogs from your own pi extensions are cancelled, never answered. Two-turn resume, steer, interrupt, USD usage and context occupancy are reported. The community `pi-acp` adapter is not listed: it never sends permission requests (#198).
- **Cursor CLI listed as unverified**: `task(agent="cursor")` runs `cursor-agent acp` per Cursor's ACP docs (modes `agent` / `plan` / `ask`); not tested locally because it is not installed (#198).
- **Codex one-shot mode works outside git repos**: `codex exec` / `exec resume` now pass `--skip-git-repo-check` (ama only starts external agents in directories it already trusts); previously they failed immediately in a non-git directory (#198).
- **ACP adapters no longer stay in a looser mode**: explicit mode maps for claude-agent-acp (`auto-edit` → `acceptEdits`, `full-auto` → `auto`, so a user default of `bypassPermissions` is replaced), codex-acp (`plan` / `default` → `read-only`, `auto-edit` → `workspace-write`, `auto` / `full-auto` → `agent`; `plan` used to refuse to start) and Copilot (URL mode ids `…#plan` / `…#agent`). Modes that open every permission are never chosen (#198).
- **`model` reaches ACP agents**: `agents.<id>.model` and the `task` `model` argument are now applied through the agent's `model` session config option (matched by value, name, or the model part of `provider/model`); when nothing matches you get a notice and the agent's default model (#198).
- **Usage numbers corrected**: Codex (app-server and `exec`) and Copilot report input tokens including cache hits, and Copilot's ACP usage is a session total; ama now subtracts the cached part and takes per-turn differences, so totals no longer count cache reads twice. Claude stream-json now reports context occupancy and window like the other drivers (#198).
- **Verified ranges updated** after a real-CLI audit on 2026-10-10: claude-agent-acp 0.89, codex-acp 2.2, Copilot 1.0.95, OpenCode 1.18, pi 1.1; capability matrix in docs/guides/agents.md, numbers in docs/benchmarks/external-agents-2026-10.md (#198).
- **`model_unavailable` for ChatGPT models the account cannot use**: a codex-backend 400 "model is not supported when using Codex with a ChatGPT account" now fails with `model_unavailable` and tells you to refresh the list with `ama models discover chatgpt` (the backend withdrew `gpt-6-astra`, which an older discovery cache still listed) (#198).

## 0.7.6 (2026-10-10)

### Model efficiency

- **The auto-mode classifier picks a small model on relays and custom providers too**: when the session model inherits an official catalog entry by id (e.g. `packy/deepseek-v4-pro`), the classifier uses the same vendor's catalog `small` model if the provider's model table lists it (`packy/deepseek-v4-flash`); only listed models are used, never synthesized ones. `permission.autoModel` still overrides (#153).
- **Fork sub-agents are steered back to their task when `task` / `task_ctl` is rejected**: the rejection now says the caller is a forked sub-agent that cannot start sub-agents, asks it to do the sub-task itself, and quotes the first line of its `<task>` instructions (fresh sub-agents keep the old text; the tool list and the first request are unchanged). DeepSeek retest: one run made no `task` call, the other made one and then read the file and reported (#191).
- **Learned `max_tokens` limits persist across processes**: when an endpoint rejects with a 400 stating its output limit, the limit is now also written to `<dataDir>/models/max-tokens-caps.json` and loaded back on startup, so later processes no longer get the first request rejected once per model (packy `kimi-k2.5`: second process 0 rejections, previously 1). Entries expire after 30 days; delete the file to re-probe.
- **Warning for a wrong `models[].catalog` reference**: `catalog: "provider/id"` that matches no catalog entry now produces a registry warning (startup header count, `ama models list`, `AMA_LOG`) instead of silently inheriting nothing.

### Sessions

- **Unreadable session images are reported**: when a downgraded image cannot be read back because the session file was changed by another process, the warning now reaches the session log (`ama: [warn] cannot read session entry …` on stderr, filtered by `AMA_LOG`; a notice in the TUI) instead of being dropped. Warnings raised while the file is being opened are buffered and shown once the session is ready (at most 16, the rest counted); the source session of `--fork` reports through the same log.
- **`subagents.forkMaxContextRatio`**: the share of (window − `compaction.reserveTokens`) above which a fork sub-agent falls back to fresh is now configurable (0.05–0.95, default 0.5, user level only). Built-in types, `general` included, stay fresh by default; docs/guides/agents.md explains the per-turn cost of re-reading the parent context.
- **Fork sub-agents are told `task` / `task_ctl` are unavailable**: the `<task>` message now lists them and asks not to call them (they stay in the tool list and are still rejected by depth). In two DeepSeek retests the sub-agent still made one rejected `task` call each time.
- **Background fork tasks report their mode right away**: the `running` result of a background `task` now carries `details.context` (`fork` / `fresh`) once the mode is known; a queued task or one waiting for its worktree still gets it later in `TaskInfo.context`.
- **Background `bash` job output fits the session result limit in one cut**: `{job, action: "wait" | "output" | "stop"}` now tail-truncates to the same byte limit as foreground `bash` (50 KB or `maxToolResultChars` − 512, whichever is smaller) instead of a fixed 2000 lines / 50 KB that the session then cut again in the middle; the note still gives the shown line count and `Full output: <path>`.

### Checkpoints

- **A slow first shadow snapshot no longer downgrades the session**: the first snapshot (which builds the index) is no longer timed, and the session downgrades to `tools` only after two snapshots in a row exceed 3 seconds (one slow snapshot followed by a normal one keeps shadow-git). The one-time notice now says so (#194).

## 0.7.5 (2026-10-10)

### Memory footprint

- **`read` no longer blocks the event loop on large files**: the byte-window path for text files over 1 MiB now reads 64 KiB chunks asynchronously, awaiting once per chunk, so TUI/RPC/ACP stay responsive while a 256 MB file is scanned (longest event-loop stall about 170–320 ms → under 20 ms). Output is byte-for-byte identical (the sync and async readers share one line parser); peak memory is unchanged (still one chunk buffer).
- **Request bodies with images no longer copy each image**: image data goes from the transcript straight into the request body instead of first being joined into a new data-URL string on every request, its escape check runs once per image, and the body is encoded in chunks of at most 256 Ki characters instead of one whole image at a time. Mock 300-step session with 15 images: peak RSS about 630–690 → 390–400 MB, peak heapUsed about 270 → 85 MB. Request bytes are unchanged; SDK `onPayload` callbacks now see large images as objects with `toJSON` (`JSON.stringify` gives the same text).
- **Old images released after downgrade**: once `context_edit` (for example `image_budget`) replaces a message on the active branch, its image base64 is no longer kept in memory — only the line's position in the session file — and is read back on demand: `get_entries` and fork return the original, and moving the leaf back before the edit (`/tree`, rewind) restores the images. Resuming a session also strips those images while reading, so they no longer count toward the peak (55 MB session with 10 downgraded 3 MB images: peak RSS about 254 → 210 MB). The JSONL format is unchanged; in `entries()` / `branch()` / SDK `session.entries` such image blocks now have `data: ""`.
- **Closed ACP sessions free the startup session too**: `Runtime.session` and `Runtime.sessionManager` now follow the current session instead of staying on the one created at startup, so after `session/close` its transcript and images are garbage-collected like any other session's (8 sessions × 4 rounds, all closed: external 16.3 → 7.0 MB). SDK code that reads `runtime.session` after a session switch now gets the new session.
- **ACP `session/prompt` usage covers only its own turn**: a prompt that waited for a background subagent's notification turn no longer counts that turn's tokens in `usage`.
- **`session/close` during a notification turn**: it used to fail with -32603 and keep the session in memory; now running background subagents are stopped, the running turn (notification turns included) is interrupted, already queued notifications no longer start a turn, and the session is released with no further `session/update`. Closing stdin quiets sessions the same way.

## 0.7.4 (2026-10-10)

- **Parallel worktree isolation**: two isolated tasks starting together could fail with `could not read .git/worktrees/<id>/commondir`, because `git worktree add` read the other task's half-created admin directory. Worktree add / remove and branch deletion now run one at a time per repository, and the same transient errors from another ama process are retried briefly.

### Model efficiency

Fewer full-price re-reads of the prompt prefix and fewer failed requests (docs/history/model-efficiency-plan.md; measurements in docs/benchmarks/efficiency-2026-10.md). Grouped by area: sub-agents, prompt prefix and compaction, the request layer, then catalog and tools.

- **Fork-style sub-agents** (`task.context: "fork"`, or `context: fork` in an agent definition; default stays `fresh`): the sub-agent inherits the conversation up to the `task` call, with the same system prompt and tool table as the parent, so its first request reuses the parent's cached prefix (measured on relays: Kimi 97.5% cached, DeepSeek the same as the parent's own next turn). Type tool limits are enforced at execution time instead of changing the tool table. Falls back to `fresh` (logged, `details.context` and `TaskInfo.context` show the actual mode) when another model or thinking level is requested, the parent has not sent a request yet, or the parent context exceeds half of the usable window. The turn-limit final round no longer sends `toolChoice: "none"`, which broke the cached prefix; the report prompt alone asks for no tools.
- **The head of the prompt is written once per session**: compaction no longer folds mid-session system patches back into the leading system prompt — the checkpoint replays only what was sent before the conversation started and later patches follow the summary as a `<system-reminder>`, so the first request after compaction has the same system + tools bytes as before. Removing a tool mid-session keeps its declaration in the tool table, adds a reminder that it is no longer available and rejects calls with `Tool "X" is not available in this session.` (also the text for unknown tools, which used to be `Tool X not found`); adding it back only says it is available again. The reminder's closing sentence now also mentions tool availability notes.
- **Compaction summarizes by continuation instead of pruning first**: when pruning tool results would still leave the context over budget and the cache is warm, the summary continues the last request's cached prefix without pruning (pruning would break that prefix and force a full-price standalone summary); with a cold cache it prunes first as before and no longer attempts the continuation. With thinking enabled, the continuation's output limit is the summary limit plus the thinking budget.
- **Soft context window and per-section fingerprints**: `compaction.contextBudget` now takes effect — pruning, summarization, the circuit breaker and `context_pressure` use min(model window, budget). `cache_miss.detail` names the changed system sections (`system:hooks,memory`) and `/cache fingerprint` lists a hash per section. Cache warming on `openai-responses` uses `maxTokens` 16 (the protocol minimum) instead of 1.
- **Fourth Anthropic cache breakpoint**: besides the last user message, end of system and last tool, the second-to-last user message (where the previous request wrote) is now marked too, so a turn with many parallel tool results no longer rewrites the whole stretch when it falls outside the lookback window. With `maxCacheBreakpoints` below 4, the last tool is dropped first.
- **Retries honor Retry-After and treat rate limits separately**: the backoff is `max(exponential backoff, Retry-After)`, capped at `retry.maxDelayMs`, with ±20 % jitter; 429 / 529 / "rate limit" errors get two more attempts than `retry.maxRetries` (`auto_retry_start.maxAttempts` shows it). 5xx is only recognized as a leading status code or after `status` / `HTTP`, so "500 tokens" in an error is no longer a server error. With `fallbackModel` set, overloaded is retried once quickly (1 s) before switching models.
- **max_tokens no longer fails the first request**: when the context window is known, `max_tokens` is clamped to what is left in the window (Anthropic budgeted thinking excepted); a 400 that states the endpoint's limit (`Range of max_tokens should be [1, N]` and similar) is resent once with that limit, and later requests in the same process use it directly. Anthropic's `input length and max_tokens exceed context limit` is resent with the room left, or handled as an overflow when under 1024 tokens.
- **Tool-call arguments are replayed byte for byte**: Completions and Responses requests send back the model's own arguments string instead of re-serializing it, so spacing differences no longer break the prefix cache. Older sessions fall back to serializing.
- **Separate idle timeout inside the stream**: `request.idleTimeoutMs` (300 s) now only covers waiting for the response headers; gaps between chunks once the stream has started use the new `request.streamIdleTimeoutMs` (default 180 s, `AMA_STREAM_IDLE_TIMEOUT_MS`, 0 disables). Previously `idleTimeoutMs` covered both, so if you raised or disabled it for a slow endpoint, set `streamIdleTimeoutMs` as well.
- **Relay models inherit the official catalog**: a relay or custom model whose id uniquely matches a built-in catalog entry (lowercased, one vendor prefix and `:latest` stripped, also via catalog `aliases`) inherits `reasoning`, `input`, `thinkingLevelMap`, `promptCache.minTokens` and `compat.requiresReasoningContentOnAssistantMessages`, and models.dev matches that entry's snapshot; prices, TTLs and `thinkingFormat` are not inherited. Ids with a thinking-tier suffix (`gemini-3.8-flash-low`) match after stripping it, inheriting images and window without turning thinking on — relay Gemini Flash models now accept images instead of being refused. `models[].catalog: false` turns it off, `"provider/id"` names the entry; `ama models list` shows `catalog (via id)` and the entry. `deepseek-v4-flash` is an alias of `deepseek-flash`.
- **Tool results are cut once**: `read`, `grep` and `bash` truncate to the session's `tools.maxToolResultChars` (capped at 50 KB) themselves, so the note states the real limit and where to continue instead of a second middle cut by the session; their descriptions no longer quote fixed sizes (shorter prefix). `glob` now returns at most 200 files by default (was 1000).
- **auto mode classifies with a small model**: without `permission.autoModel`, the classifier uses the session provider's catalog small model (`small` in the catalog: deepseek-flash, claude-haiku-4-5, gpt-6-luna, gemini-3.5-flash-lite, kimi-k2.6, …) when it exists and has a key, otherwise the session model.
- **Compatibility**: everything above adds only optional fields — `rawArguments` on tool-call blocks and `retryAfterMs` on failed assistant messages (session files and RPC), `context` on `ama.task` data and `TaskInfo`, `system:<sections>` values of `cache_miss.detail`, `aliases` / `small` in the built-in catalog, and the config keys `compaction.contextBudget`, `request.streamIdleTimeoutMs` and `models[].catalog`. Session format and RPC / ACP protocol versions are unchanged.

### Memory footprint

Lower peaks with large inputs and long sessions, and closed ACP sessions are freed (docs/history/memory-plan.md; report in docs/research/memory-2026-10.md, before / after measurements in docs/benchmarks/memory-2026-10.md). Grouped by area: large files and sessions, requests and images, protocol modes, then distribution and limits. Session files, request bytes and tool output are unchanged.

- **`read` on large files no longer loads the whole file**: text files over 1 MiB are scanned in 64 KiB blocks and only the lines being shown are decoded; reading 100 lines of a 256 MB file peaks at about 103 MB instead of 775 MB. Output (line numbers, total line count, truncation notes) is byte-for-byte the same.
- **Session list and resume no longer read whole files**: session files are read line by line in chunks. `ama sessions list` (and the resume picker and ACP `session/list`, which share it) only parses each file's header, first entry, renames and first prompt — 4 × 55 MB sessions: about 540 → 88 MB; `--resume` parses line by line without a whole-file string and split array — 55 MB session: about 300 → 218 MB. The listed fields are unchanged.
- **Request bodies with images no longer go through one giant string**: when a request carries strings of 64 KiB or more (image base64), the body is assembled piece by piece and streamed with an exact `content-length` (never chunked); small requests are sent exactly as before. The bytes on the wire are identical (byte-for-byte tests against `JSON.stringify`), so prompt caching is unaffected. A local 300-step run with 15 image reads peaks at about 0.7 GB instead of 1.03 GB.
- **Images are deduplicated by content**: an image read several times by `read`, attached with `--image` / `@path` and then read again, or repeated in a resumed session keeps a single base64 copy in memory. With these changes a TUI session with three 2.4 MB images peaked at 218 MB instead of 276 MB on a real model.
- **ACP: closed sessions are freed**: a closed session stayed in memory with its transcript and images — the cancel listener of each `session/prompt` was never removed, a session opened next to it kept a reference to the session that was in the foreground at the time, and the process-wide cache-reporting table kept each endpoint's last request whole. All three are fixed; after 8 sessions × 4 rounds are closed, heap and external memory return to about 16 MB each. The session created at process start (claimed by the first `session/new`) is still held until exit.
- **ACP: `session/prompt` during a background subagent's notification turn** (#139): the prompt failed with "a run is in progress" (-32603) because the notification turn does not go through the ACP prompt queue. It now waits for that turn to end and then starts; `session/cancel` while it waits answers `cancelled` and the prompt is not sent later.
- **RPC `compact_events`**: a client that declares it with `set_client_capabilities` no longer gets the body of tool results (and of user messages with images) repeated in `turn_end`, `message_start` and `entry_appended` — marked `contentOmitted: true`, the body still comes in `message_end` and `tool_execution_end`. In a 100-step fake run stdout drops from 91.6 MB to 37.0 MB. `hello.capabilities` now lists it; without the declaration, and in `stream-json`, events are unchanged.
- **The global `ama` command runs the single-file bundle**: `bin.ama` now points to `dist/bundle/ama.cjs` instead of the ESM entry, so an npm-installed `ama --version` starts in about 0.10 s instead of 0.18 s with about 25 MB less peak RSS; library imports (`@armadra/agent`, `/host`, `/rpc`, `/tui`, `/acp`) are unchanged. After `pnpm link`, run `pnpm build` so the bundle exists.
- **Fewer retained sub-agent sessions**: finished sub-agent sessions kept in memory for `taskId` follow-ups drop from 16 to 4 (least recently used are released; the JSONL stays and a released task reopens from it when continued). Configure with `subagents.retainSessions` (user-level, 0 releases on finish).
- **Codemode heap limit**: the script subprocess starts with `--max-old-space-size=256`; a script that exceeds it ends with the script error `Script exceeded the codemode memory limit (256 MB)` instead of growing until the timeout. Configure with `codemode.maxHeapMb` (user-level, 0 disables).

## 0.7.3 (2026-10-09)

- **`/context` before the first request**: it showed `0 / <window>` and left the system prompt and tool declarations out while the status bar already showed the baseline; it now estimates both from what the first request will send (shared with the status-bar baseline), and "Used" always matches the status bar and `getStats()`.

## 0.7.2 (2026-10-09)

- **Prompt cache survives mid-session context changes**: when AGENTS.md, Skills or SessionStart hook output changed on
  resume, host instructions were refreshed or the memory section was re-rendered after compaction, the changed section
  used to be folded back into the leading system prompt on endpoints without mid-conversation system messages, so the
  whole context was billed at full price from token 0. It is now delivered as a `<system-reminder>` user message at the
  end, and the previous request stays a byte-for-byte prefix; only a patch that removes tools still rewrites the head.
  DeepSeek accepts a mid-conversation system message but measurably keeps answering from the leading one, so it stays off
  there (docs/benchmarks/cache-midconvo-2026-10-09.md).
- **No early pruning on a guessed cache lifetime**: tier-one pruning no longer treats the cache as cold after an implicit
  10 minutes when the catalog promises no TTL (implicit caches may live for hours); the 10 minutes remain for miss
  attribution only.
- **DeepSeek catalog cache data**: `promptCache: { short: 3600, minTokens: 2048 }` (the vendor says unused cache is
  cleared after a few hours to a few days; reads were measured in 2048-token blocks).
- **`ama models cache-probe` advice**: without a catalog lifetime it no longer suggests filling in `short: 300`; it
  explains that ama then neither warms nor prunes early and to fill in only a documented lifetime.
- **Terminal program status (OSC 7501)**: the interactive interface reports idle / working / blocked (permission,
  question, auth) / done / error to the terminal with the
  [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status), sub-agent tasks as child records
  `task/<id>`, and clears its records on exit. `ui.programStatus`: `auto` (default, only after the terminal answers the
  detection query; off inside tmux), `on` (no detection; tmux passthrough), `off`. Detection replies never reach the input
  box. Print / RPC / ACP modes send nothing.
- **ACP context usage right away**: `ama --mode acp` now sends `usage_update` after the `session/new`, `session/load`
  (after the replay) and `session/resume` responses, after a model change and at the end of every assistant message (so
  multi-tool turns update too), instead of only at the end of a turn; unchanged values are not resent. With an unknown
  context window there is still no `usage_update` (`size` is required by the schema).
- **`-p --output-format json` context**: the result object carries `context: { tokens, window, percent }`; unknown items
  are omitted.
- **External agents' context**: when an external agent reports its context usage and window (ACP `usage_update`, Codex
  app-server `tokenUsage`), the numbers go into the task record and `ama.agent-usage`, `getStats().external.byAgent`
  keeps the latest, and `/tasks` and the Agent bar show `ctx 34%`.
- **`/context`**: a new command that breaks the context down by category — system prompt (per section), tool
  declarations (per tool), user messages, assistant text, reasoning, tool-call arguments, tool results (per tool name),
  images, summaries and custom messages — with estimated tokens, share and a bar each. The top shows used / window, tokens
  left, the source ("reported usage X + estimated Y" or "estimated in full") and the auto-compact trigger; the bottom
  lists the largest tool results by ordinal, tool name and size only, never their content. Panel in the TUI, plain text
  in line mode. Read-only; the request body and cache prefix are unchanged.
- **Context usage from the start**: before the first request, `contextTokens` is now a baseline estimated from the system
  prompt and tool declarations that are about to be sent (stats only; nothing is written to the session and the request
  body is unchanged), so a new session no longer shows `Ctx 0.0%`. `SessionStats.context` (`getStats()`, RPC
  `get_session_stats`) tells where the number comes from (`usage` / `estimate` / `prefix`) and carries the
  auto-compaction thresholds `autoCompactAt` / `pruneAt`; absent fields mean "unknown" (docs/guides/sessions.md).
- **Status bar**: `full` shows `Ctx 3.0% 8.2k/272k auto` (used / window, `auto` while auto-compaction is on; narrow
  screens drop `auto`, then `/window`, then the used tokens); estimates get a leading `≈`; the warning color starts at
  the tier-one pruning threshold; `compact` keeps one decimal below 1%. Ctx refreshes right after a message is submitted
  and, while streaming, follows usage reported by the reply (at most twice a second). The rate line marks billed tokens
  as the session total `Σ↑ ↓` with cache reads / writes as `R` / `W`. A model without a context window gets a one-time
  hint on how to set one.
- **`/session`**: the usage row is labeled as the session total; the context row adds the distance to auto-compaction
  (or "auto-compaction off") and `≈` for estimates.
- **Contributing**: the repository now has issue forms (bug report, feature request, provider / model compatibility,
  documentation), a pull request template, `CONTRIBUTING.md`, `SECURITY.md` and an `AGENTS.md` with the hard constraints
  and review rules. None of these ship in the npm package.
- **Docs**: design notes, plans and research reports no longer name the third-party projects they were compared with;
  those are described generically or by code names. Agents, providers and protocols that ama actually drives or supports
  keep their names.

## 0.7.1 (2026-10-05)

- **Windows: concurrent OAuth refresh**: while one ama process releases the `auth.json.lock`, another one opening it
  got EPERM (the file is "delete pending" on NTFS) and failed the refresh; it now keeps waiting for the lock. Replacing
  or reading `auth.json` while another process has it open retries briefly on EPERM / EACCES / EBUSY (Windows only).
- **Checkpoints (shadow-git)**: the 3-second snapshot budget no longer includes creating the shadow repository the first
  time (a dozen `git` processes, several seconds on Windows), which could downgrade a session to `tools` on its first turn.

## 0.7.0 (2026-10-04)

ACP completion: `ama --mode acp` as an agent for editors (Zed and other ACP clients) and `AcpClient` / `AcpDriver` as a
client, checked in-repo against the official ACP v1 schema 1.24.1. Docs: docs/reference/acp.md (English: docs/en/reference/acp.md).

- **No model, no exit**: without a model `ama --mode acp` no longer exits with code 4. It answers `initialize` (two
  terminal auth methods when the client declares `clientCapabilities.auth.terminal`: their `args`,
  `--acp-terminal-auth chatgpt` / `api-key`, are appended to the configured command as the spec says, and ama then runs
  `ama auth login chatgpt` / `ama auth set` instead of ACP mode; the start-up `--auth-file` / profile `authFile` is passed on), answers session
  methods with -32000 (the no-model guidance, `data.authMethods`) and retries start-up on them at most once per second;
  once a model is available the same connection is handed to the normal ACP server (no new `initialize`). `authenticate`
  answers -32602; closing stdin exits 0. stdout is taken over before start-up in ACP mode. `ama auth set` without a
  provider on a TTY now lets you pick one with the arrow keys (non-TTY is still a usage error).
- **Several sessions**: every ACP session stays open in memory (an empty one can be switched back to); one turn runs at
  a time and `session/prompt` for another session is queued (FIFO) instead of failing busy. `session/new` / `load` /
  `resume` / `list` / `set_mode` / `set_config_option` / `close` work while a turn runs. Permission modes are kept per
  session and applied when its turn starts. `session/cancel` on a queued prompt answers `cancelled`. `session/list`
  filters by `cwd`, pages 50 at a time with `nextCursor` (an invalid cursor is invalid params) and strips embedded
  resources from titles; `session_info_update` (title, `updatedAt`) is sent at the end of each turn. A refusal (Anthropic
  `stop_reason: "refusal"`, new `StopReason` value) answers `refusal`; elsewhere the message still ends as an error
  (`stopReasonOf()` tells them apart; the fake provider script accepts `stopReason: "refusal"`). `mcpServers` /
  `additionalDirectories` are ignored with one stderr line. **Behavior change**: after `session/close`, requests for
  that id answer -32002 (it used to reopen); open it again with `session/load` / `session/resume`.
- **Tool calls in detail**: `tool_call` carries `name`; each tool call inside a codemode script is listed as its own
  `tool_call` (title prefixed `codemode › `, `_meta.ama.parentToolCallId` points at the outer call) and closes on its
  own, and permission requests use the requesting call's id, so they no longer point at unknown ids. While a permission
  request is open the call goes back to `pending`, then `in_progress` once allowed. `edit` / `write` fill the new
  `ToolResult.fileChange` (raw before / after text with BOM and CRLF, `oldText: null` for a new file, omitted above
  256 KiB per side; never persisted and stripped from RPC / stream-json events), and the completed update carries a
  `diff` plus the first 4 KB of text, with `locations[].line` at the first changed line. Replayed tool results
  (`session/load`) carry their first 4 KB of text (no diff). Permission modes get display names and localized
  descriptions.
- **Config options and command list**: session-open results carry `configOptions` — `mode` (the permission mode, the same state as `modes`; clients with config options such
  as Zed ignore `modes`), `model` (grouped by provider,
  values `provider/model-id`, the same "configured" view as the TUI `/model` picker: only providers with a key, an OAuth
  login or local, `models.enabled` respected, `fake` hidden by the usual rule) and `thinking` (category `thought_level`,
  only the levels the current model supports); no boolean options. `session/set_config_option`
  switches them (unknown ids / values answer -32602) and model / thinking level changes send `config_option_update`.
  After a session opens, `available_commands_update` lists skills as `skill:<name>` and prompt templates as `<name>`
  (`argument-hint` as `input.hint`); built-in slash commands are not listed. Prompt templates in
  `LoadedResources.prompts` now carry `description` / `argumentHint`.
- **`$/cancel_request` both ways**: `JsonRpcPeer` takes `cancelRequests` (on for both ACP sides, off by default so the
  Codex app-server wire is byte-for-byte unchanged): an aborted outgoing request notifies the peer, a peer-cancelled
  incoming request aborts its `ctx.signal` and answers -32800. A prompt withdrawn with `$/cancel_request` stops the turn
  and answers -32800; a permission request the agent no longer needs is withdrawn so the client can close its dialog.
- **Client side (`task(agent="acp:…")`)**: `AcpClient` declares `clientCapabilities.session.configOptions: {}`; an agent
  withdrawing a pending permission request closes the approval and answers `cancelled`. `AcpDriver` falls back to a
  `mode`-category config option when an agent has no `modes`, reports -32000 as `agent_auth_required` listing the
  agent's auth methods (terminal ones with the command to run), treats -32800 after a cancel as `cancelled`, and counts
  `diff` paths in `filesTouched`. Docs: docs/guides/agents.md.
- **Types and tests**: the ACP types gain `authenticate`, `$/cancel_request`, -32800, terminal auth methods, client
  `session` / `auth` capabilities, tool call `name` / `_meta`, `config_option_update` and `ACP_META_KEY` (exported from
  `@armadra/agent/acp`); the prompt `usage` is marked UNSTABLE; select config options are either all flat or all grouped
  (the fake agent's `model` option is now grouped). The fake ACP agent adds `--config-only`, `--auth-required` and
  `[cancel-request]`. Every ACP line in the tests and golden recordings is validated against the bundled schema.
- **Zed run-through fixes**: terminal auth `args` are now `--acp-terminal-auth chatgpt|api-key` because clients append them
  to the configured command; config options gain `mode` (Zed ignores `modes` once `configOptions` exist); a session's own
  mode changes are remembered for the queue; `session/load` / `resume` of an unknown UUID (an empty session that was never
  written before ama restarted) opens a new empty session with that id instead of -32002; tool call ids that the upstream reuses in a later turn get a `#n`
  suffix on the wire so they stay unique within the session (Zed merged them into one entry).

## 0.6.8 (2026-10-04)

- **ACP client: elicitation and session config options**: `AcpClient` takes an optional `onElicitation(params, signal)`;
  when given, `initialize` declares `clientCapabilities.elicitation` and `elicitation/create` goes to it (answers normalized
  to `accept` / `decline` / `cancel`; pending ones resolve `cancel` on `cancel(sessionId)` or connection close). New
  `setConfigOption(sessionId, configId, value)` and `configOptions` on session-open results. `AcpClient.features` gains
  `elicitation` and `configOptions`. Without a handler the wire is unchanged. The fake ACP agent adds `[elicit]`, `[model]`
  and `[env NAME]` markers and `--config-options`. Docs: docs/reference/acp.md.

## 0.6.7 (2026-10-03)

- **A host runner with id `ama` is used**: when the host registers a runner for `ama` via `HostApi.runners.provide`
  (for example another ama node on an Armadra canvas), `task(agent="ama")` now goes to it instead of being unknown; without
  one nothing changes, and the built-in types (`general` / `explore` / `plan`) are always ama sub-sessions. Docs:
  docs/guides/agents.md.

## 0.6.6 (2026-10-03)

- **Local search hints**: when both `grep` and `glob` are directly available, the system prompt's rules gain one line
  ("Locate code with grep/glob before reading; do not guess file paths."); the `grep` / `glob` descriptions now say when
  to use them; `grep` takes `filesOnly: true` to list only the matching files (deduplicated, sorted by path, `limit` counts
  files). `read` on a directory now points at a tool the model can actually call: `ls` when active, otherwise `glob`
  (e.g. `pattern "src/*"`), otherwise a file inside it. In `-p` with the `minimal` / `coordinator` preset, a denied bash
  `grep` / `rg` / `find` adds one stderr line on how to bring the tools back (`tools.default: ["+grep","+glob"]`). Tools
  get the session's active tool set as the optional, read-only `ToolContext.activeTools`. This changes the `default`
  prefix (about +35 tokens), so the first request after upgrading misses the cache once. Docs: docs/design/design.md §5.6,
  docs/guides/codemode.md.

## 0.6.5 (2026-10-03)

- **`AcpClient` can pass MCP servers when opening a session**: `newSession`, `resumeSession` and `loadSession` take an
  optional third argument `{ mcpServers }` that is forwarded as-is in `session/new|resume|load` (default still `[]`, the
  wire is unchanged when it is omitted). `AcpClient.features.mcpServers` lets a host detect support. ama itself still
  sends none. Docs: docs/reference/acp.md "As a client".

## 0.6.4 (2026-10-03)

- **Interrupt and send now**: while a run is in progress, Enter still queues the message as a steer (delivered at the next
  delivery point), and the new `Ctrl+X` (key action `app.message.interrupt`) stops the current turn at once (model stream and
  running tools; every tool call keeps exactly one result, `aborted by user`) and immediately starts a new turn with the
  input, queued steers joined in front (`origin: "interrupt"`, `↳ interrupt` in the message area); with an empty input it
  sends the queued steers now. Esc is unchanged. `ui.enterWhileRunning: "queue" | "interrupt"` (default queue, editable in
  `/config`) swaps Enter and `Ctrl+X`. The running line shows `Enter queue · Ctrl+X interrupt & send` while the input box has
  text. The sub-agent view supports the same key: an ama sub-agent stops its turn and starts a new one with the message; an
  external agent is interrupted when its driver can cancel a single turn (ACP, Claude stream-json, Codex) and otherwise the
  message is queued with a hint. Line mode accepts `/interrupt <text>`; RPC `prompt` / `steer` and the SDK take
  `interrupt: true`. The new request keeps the interrupted request as its prefix, so the cache keeps hitting. Docs:
  docs/guides/tui.md, docs/reference/rpc.md.
- **Status line split into sides; quota labels fixed**: the `full` layout now keeps state and switches on the left and
  metrics and the model on the right. The rate line's left side holds `codemode on` (with `net!`) · sandbox · preset ·
  `→ fallback model` · queue count · host status, and its right side `tps … (avg · ttft) · ↑ ↓ · cache · re-billing · [-]`;
  the status bar keeps the permission mode and the `shift+tab` hint on the left; the quota line is right-aligned. When
  narrow, right-side metrics drop before left-side switches; the permission mode, `tps` and `[-]` never drop; the
  single-line `compact` layout keeps its token order. Quota labels follow the window length: a weekly window sent as
  primary reads `Weekly` instead of `7d:`, and the 5-hour window comes first; the all-zero "no such window" the server
  sends is no longer rendered as `0d: 0.0%` (filtered both when parsing and when rendering). Docs: docs/guides/tui.md.

## 0.6.3 (2026-10-03)

- **TUI: `Ctrl+B` moves foreground tasks to the background; background approvals dock in the agent bar**: while the main
  turn waits for a foreground sub-agent task (or `task_ctl wait`), `Ctrl+B` moves it to the background whatever is in the
  input box: the tool line turns into `⎿ moved to the background · 12s` with a follow-up status line, the main turn carries
  on and you can keep chatting, and the task reports back with a `<task-notification>` turn. With nothing to move, `Ctrl+B`
  still moves the cursor left. The running line shows `Ctrl+B to background`; in tmux press `C-b C-b`. In the agent bar, `b`
  moves the selected task to the background and `x` stops it (press twice); `/tasks bg [id]` does the same from the command
  line (line mode too). Esc interrupts only the foreground and says which background tasks keep running. Approvals of
  background tasks no longer pop up while the main session is busy or the input box has a draft: they dock in the agent bar
  ("needs approval", running line `↓ handle approval`) and pop up once the main session is idle with an empty input, or
  when you open that task's view; approvals of the main session and of foreground tasks are unchanged. Docs: docs/guides/tui.md.
- **Background sub-agents: config, `-p` and RPC**: new `subagents.background: "auto" | "always" | "never"` (default auto:
  task runs in the background by default in the TUI / RPC / ACP and in the foreground with `-p`; the call argument and the
  agent type's `background:` take precedence) and `subagents.autoBackgroundAfterMs` (move a foreground task to the background
  after it has run this long; default 0, off). Both are accepted at project level and editable in `/config`. When background
  tasks are still running after the main turn, `-p` prints one stderr line and waits for them and their notification turns
  before printing the result (bounded by `--max-turns` / `--max-cost`, exit 8 at the limit; Ctrl+C still stops); the json
  result carries `tasks`. RPC adds `background_task { taskId? }` → `{ backgrounded }` and the `subagent_background` event
  (44 commands), and the SDK `session.backgroundTask(taskId?)`. Docs: docs/guides/agents.md, docs/reference/rpc.md.
- **Agent bar is reachable again**: `↓` on an empty input is now the only default key into the agent bar and works whenever
  the session has tasks, even after the bar collapsed (it used to require the bar to be visible). `Ctrl+B` no longer enters
  the bar (tmux's default prefix swallowed it); it is reserved for moving foreground tasks to the background and still moves
  the cursor left for now (`"app.agents.focus": ["down", "ctrl+b"]` restores the old key). Pressing `↓` with text in the input
  box, with `ui.agentBar: "off"` or with no tasks now shows a one-line hint instead of doing nothing silently; `↓` while
  browsing input history still steps through history. The running line ends with `↓ Agent bar` while the bar has tasks
  (dropped on narrow terminals). Embedding hosts (with a profile) no longer default to `ui.agentBar: "off"`; a host that does
  not want the bar sets it in its profile's config file.
- **Sub-agents run in the background by default; foreground tasks can be moved to the background**: in the TUI, RPC and
  ACP a `task` without `background` now returns a taskId at once and the result arrives later as a `<task-notification>`;
  `-p` keeps waiting in the foreground (setting `subagents.background`: `auto` (default) / `always` / `never`; an agent
  definition's `background:` and the call's own argument still win, and built-in types no longer pin `background: false`).
  A blocking foreground `task` or `task_ctl wait` can be moved to the background (`session.backgroundTask(taskId?)`, event
  `subagent_background`): the tool returns a fixed "Moved to the background …; it was not interrupted" result, the task is
  detached from the parent turn (Esc no longer stops it) and reports with the usual notification;
  `subagents.autoBackgroundAfterMs` (default 0, off) does the same after a timeout. The `task` description and its one rule
  were rewritten for the background default (session constants; the tool table differs between the TUI and `-p`).

- **ChatGPT subscription models use the backend's context window**: the context window reported by the ChatGPT backend's
  model list (codex `context_window`, and siwc entries when they carry it) now takes precedence over models.dev, which lists
  the API window (1.1M for some models) while the subscription backend accepts less (272k); auto-compaction used to plan for
  the larger window, so long sessions were rejected past 272k. models.dev still fills fields the backend leaves out (output
  limit and the like) but no longer overrides input modalities or reasoning efforts the backend reports; when neither has a
  context window, `chatgpt` models use a conservative 128k instead of turning auto-compaction off. `ama models discover chatgpt`
  shows the backend window marked "(backend)" and lists models the backend reported none for. Caches written by older
  versions without windows keep the models.dev value until `ama models discover chatgpt` refreshes them.

- **Status line: subscription quota line and reference colors**: with a ChatGPT subscription model the `full` layout gets a
  third line below the status bar, `Session: 10.0% | Reset: 2h 18m | Weekly: 31.0% | Weekly Reset: 6d 5h` (from
  `quota_update`; refreshed once a minute; `5h 10% ↻2h18m · wk 31% ↻6d5h` below 80 columns; the codex flavor shows a
  placeholder until the first request, siwc without data and non-subscription models show nothing). `compact` only appends a
  short `5h 10% wk 31%` item at the end, keeping the existing order. The `full` lines are recolored after the reference (dim
  labels; purple rates, durations and reset times; blue model, thinking level and amounts; green directory and branch; yellow
  cost; threshold-colored percentages), and the branch shows `↑N` / `↓N` ahead of / behind its upstream. Docs: docs/guides/tui.md
  "Layout".
- **Startup header with an AMA logo and a short light-up animation**: the boxed info block is replaced by a 5-row "AMA" logo
  (block characters, colored letter by letter with the theme's accent → user → tool; a `_ / \ |` version in ASCII mode) with
  the version, model, directory, mode and key hints beside it (72+ columns) or below it (48–71 columns); below 48 columns a
  two-line header is shown. On startup a one-off sweep of about a second lights the logo up and settles in place, leaving no
  frames in the scrollback; any key settles it at once and still reaches the input box. It does not play with
  `ui.animation: false`, without colors, outside a TTY, in an embedding host, under `CI`, with a command-line prompt or in a
  short terminal. New `ui.logo: "auto" | "off"` (off shows only the info lines). Docs: docs/en/guides/tui.md "Startup screen".

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
  docs/en/guides/providers.md "ChatGPT login".

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
  now be chosen as the default model. Docs: docs/en/guides/tui.md, docs/en/guides/providers.md "ChatGPT login".

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
(Chinese / English) interface. The design and decision table are in docs/history/wave6-plan.md; current docs per topic are linked below.

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

- **Agent bar** ([docs/en/guides/tui.md](docs/en/guides/tui.md) "Agent bar"): sub-agent tasks are listed above the status line (queued /
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
- **`/trace`** ([docs/en/guides/tui.md](docs/en/guides/tui.md) "Traces"): turn → request → tool → sub-call / sub-agent, each row with duration,
  TTFT / decode / tool bars, tokens and cache hits; Enter for details; sub-agents expand into their sub-sessions; long sessions
  load from the tail and follow while running; `/trace <task id>` for one task; line mode prints a text tree. Older sessions
  without timing records are estimated from entry times and marked `≈`, without changing the session file.
- **`ama sessions trace <id|file>`** ([docs/en/guides/sessions.md](docs/en/guides/sessions.md) "Traces"): exports a self-contained single-file
  HTML page (tree + waterfall, TTFT / decode / tool colors, nested sub-agents and external agents, search, jump to turn, zoom,
  details, virtual list, light and dark; inline styles and script with a CSP that blocks all external loads; data and content
  redacted twice and the data block escaped against injection). `--json` prints the same shape as `get_trace`, `--no-content`
  keeps only structure and numbers, `--children` embeds child-session previews, `--open` opens a browser and `--now` pins the
  generation time (byte-for-byte deterministic output).
- **RPC `get_trace`** ([docs/en/reference/rpc.md](docs/en/reference/rpc.md) "Traces"): tail-first paging (`turnLimit` / `before`), increments by
  `since` (driven by `entry_appended`), `taskId` sub-traces and redacted previews with `content: "preview"`; 43 RPC commands in
  total. SDK `session.trace()`; the pure function `buildTrace()` and the `Trace` type are exported from the package entry.

### Memory

- Cross-session memory ([docs/guides/memory.md](docs/guides/memory.md), Chinese), **off by default**: enable with `ama memory enable`,
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

- `ama auth login chatgpt` drives ama with your own ChatGPT Plus / Pro plan ([docs/en/guides/providers.md](docs/en/guides/providers.md)
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

- **`/config` settings panel** ([docs/en/guides/tui.md](docs/en/guides/tui.md) "The `/config` settings panel and `ama config`"): lists scalar
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
- **Hosts decide by `code`** and must never parse the human-readable `error` / `message` ([docs/en/reference/rpc.md](docs/en/reference/rpc.md)).
- **Bilingual docs**: `docs/en/` adds English versions of `tui`, `permissions`, `providers`, `rpc`, `host-api` and `sessions`
  (each header records the Chinese commit it translates); development conventions are in [docs/guides/i18n.md](docs/guides/i18n.md) (Chinese).

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

- Wave 6 contracts (docs/history/wave6-plan.md §7, all optional and backward compatible): the `Trace` type and `buildTrace()`, SDK
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
- The npm package now also ships `docs/guides/memory.md` and `docs/en/*.md`.

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
