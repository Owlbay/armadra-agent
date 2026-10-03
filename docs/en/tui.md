# Terminal UI

English · [简体中文](../tui.md)

> Translated from the Chinese [docs/tui.md](../tui.md) as of commit `6a7b5eb`. When the two differ, the Chinese version is
> authoritative. Screens below are illustrative; the exact interface wording follows the interface language
> (`ui.language`, `--lang`, `AMA_LANG`).

How to use interactive mode, plus the API of the terminal component library `@armadra/agent/tui`. The design rationale is in [design.md](../design.md) §12 (Chinese).

Running `ama` directly in a terminal (stdin / stdout both TTYs, `TERM` not `dumb`, no `--no-tui`) enters interactive mode. The interface uses the **main screen** only: the conversation history scrolls into the terminal scrollback without switching to the alternate screen, so `capture-pane` in tmux can read the whole conversation, and it stays on screen after exit.

## Layout

The visual spec (colors, glyphs, screen-by-screen mockups) is in [tui-design.md](../tui-design.md) (Chinese). Hierarchy is expressed by indentation: column 0 holds the user `›`, the tool `⏺` and notice symbols, column 2 the result connector `⎿`, column 4 the tool output; the structure stays readable without colors (`NO_COLOR`, `capture-pane` without `-e`).

```
 ▄███▄  ██▄   ▄██  ▄███▄    ama 0.6.2                     ← startup header (normal)
██▀ ▀██ ███▄ ▄███ ██▀ ▀██   anthropic/claude-sonnet-4-5@messages · thinking medium
███████ ██ ▀█▀ ██ ███████   ~/Projects/demo · trusted (trust.json)
██   ██ ██     ██ ██   ██   Accept edits · preset default
▀▀   ▀▀ ▀▀     ▀▀ ▀▀   ▀▀   AGENTS.md · 2 Skill
                            /help commands · Shift+Tab mode · Ctrl+O expand tool output

› read the README                                  ← user message (continuation lines indented 2)

✻ Thinking · 120 tokens                            ← thinking block (folded; Ctrl+O expands)

⏺ read README.md                                   ← tool call: ⏺ tool name summary
  ⎿ Read 5 lines                                    ← one-line result summary
      1  # Demo                                     ← output body (indented 4)
    … 2 more lines (Ctrl+O to expand)
⏺ bash pnpm test                                   ← no blank line between adjacent tool calls
  ⎿ ⠋ running · 4s

  ↳ after  also update the docs                     ← queued message
    Alt+↑ recall · Esc restore and interrupt
⠋ running bash · 4s · Esc to interrupt              ← running verb
────────────────────────────────────────────────
› Type a message, / commands, @ files, Shift+Enter newline   ← input box (placeholder)
────────────────────────────────────────────────
tps: 100 tok/s • 546 tok / 5.5s (avg 100 · ttft 1.4s)    ↑12k ↓1.2k · cache 80% ♨ · [-]   ← rate line (full)
Accept edits     claude-opus-5-5 medium | Ctx 3.0% | proj ⎇ main 5ae9e54 ↑2 (+12,-3) | $0.26 | 2h24m
Session: 10.0% | Reset: 2h 18m | Weekly: 31.0% | Weekly Reset: 6d 5h     ← subscription quota line (full, ChatGPT subscription model)
```

- **User messages**: start with `›`, continuation lines indented 2 columns; steers while running are marked `↳ steer`, messages queued after this turn `↳ after`, and messages injected by the host (the Armadra canvas) `↳ host` (the `origin` in the session file stays steer / followUp / host).
- **Thinking blocks**: `ui.showThinking` = `collapsed` (default: "thinking…" → "thinking · 1.2k tokens", `Ctrl+O` expands it to an indented body of at most 60 lines) / `full` (always expanded) / `hidden`.
- **Tool calls**: titled `⏺ tool name summary`; `⏺` is the accent color while running, green on success, red on failure. The second line after `⎿` is the result summary: lines read, `N changes · +a −b`, `exit 0 · 2.1s · 48 lines`, matches and files, `N inner calls · M lines of script output`, `sub-agent · running 1m05s` / `done · 1m42s · ↑28k ↓4.1k`; while running the summary line carries a spinner in the same frame as the bottom and the seconds. Bodies show the first 3 lines folded; `edit` shows a diff (first 12 lines, with line numbers at ≥ 60 columns); running `bash` scrolls its last 8 lines. `Ctrl+O` expands / folds everything (thinking blocks included). Inner calls of a codemode script hang under the outer call (folded, only the titles and summaries of the latest 5 are listed).
- **Notices**: `✗` errors, `↻ retry n/m`, `!` warnings (cache misses, remaining context), `⛔` hook blocks, host notifications, explanations of denied or timed-out approvals; compaction / branch summaries are left-bar cards (`▎ context compacted  128k → 24k tokens`).
- **Running**: `⠋ verb · elapsed · …`, with the verb taken from the deepest current state: waiting for confirmation (approval open), `running bash` / `running 3 tools`, `retry 2/3 · in 2s`, compacting context, replying `· ↓≈1.2k` (estimated tokens of this output), thinking. While a foreground sub-agent task blocks the turn, `Ctrl+B to background` is appended; while the agent bar has tasks, `↓ Agent bar` is appended (`↓ handle approval` instead when an approval is docked): `⠏ running task · 4s · Esc to interrupt · Ctrl+B to background · ↓ Agent bar`; items are dropped whole from the end when the line does not fit.
- **Status bar**: the mode is always on the far left; the status bar is the last line except for the subscription quota line in the `full` layout (`compact` always keeps it last). In `compact` the separator is always `·` (embedding hosts parse it), in `full` it is `|`. The layout follows `ui.statusLine`: `full` (two lines) by default in a standalone terminal, `compact` (one line, same layout as before) by default in an embedding host with a profile; `Ctrl+G` or `/statusline [full|compact]` switches at runtime for this session only. With `full` the input box is the 4th line from the bottom (`compact` keeps it 3rd from the bottom).
  - **`full` top line (rate line)**: `tps: <rate> tok/s • <output tokens> tok / <elapsed> (avg <session average> · ttft <time to first token>)`. While streaming the rate is the instantaneous value over the last 2 s (`tps:` in the accent color); afterwards it is the request's average; whole replies generated in under 0.25 s get no rate and show `—`; elapsed time starts at the first token; in ASCII `•` becomes `*`. The right side holds usage items: `↑` input (including cache reads and writes) `↓` output · cache · re-billing · queue count · codemode · tool preset (when not default) · host status, with `[-]` at the end hinting that it folds. Only chat requests count (compaction summaries, warming and the classifier do not). When narrow, these drop in order: output / elapsed, codemode, queue count, tokens, cache, re-billing, preset, host status, avg, ttft; `tps` and `[-]` never drop.
  - **`full` bottom line**: on the left `permission mode | shift+tab to switch`, on the right `model thinking-level | Ctx 3.0% | <dir name> ⎇ <branch> <short commit> ↑N ↓N (+a,-d) | $cost | session duration` (Ctx with one decimal, no meter even when wide); when narrow, these drop in order: the switch hint, thinking level, line changes, directory name, branch and commit, duration, cost, context, model.
  - **Subscription quota line** (third `full` line, below the status bar): when the current model uses a ChatGPT subscription (the `chatgpt` provider) it shows `Session: <used %> | Reset: <time to reset> | Weekly: <used %> | Weekly Reset: <time to reset>` (Chinese labels in the Chinese interface), from the latest `quota_update` (the codex flavor's `x-codex-primary/secondary-*` response headers and `codex.rate_limits` events; siwc only has it after a 429). Reset times are relative (`2h 18m`, `6d 5h`) and refresh once a minute. Before the first request the codex flavor shows "Quota: shown after the first request" (the first request brings the quota back, so holding the line avoids the row count jumping); siwc without data takes no line (it only gets a quota when over the limit, so a placeholder would stay forever); non-subscription models show nothing. Below 80 columns it compresses to `5h 10% ↻2h18m · wk 31% ↻6d5h`, dropping the reset times first when narrower. A window that is not 5 hours / 7 days is labelled with its actual length. `Ctrl+G` / `/statusline compact` folds the quota line together with the rate line (`compact` stays a single line; hosts anchor on "last line = status bar").
  - **Colors** (`full`): labels, units, separators and parentheses dim gray; the rate number purple, output / elapsed / avg blue, ttft purple; model and thinking level blue; Ctx and quota percentages by threshold green / yellow / red (≥ 70% yellow, ≥ 90% red); directory and branch green, short commit dim, `↑N` ahead orange, `↓N` behind red, `(+a,-d)` green / red; cost yellow; duration and reset times purple. All come from theme semantic colors with dark / light and 16-color mappings; `NO_COLOR` and ASCII drop the colors and keep the structure. `compact` colors are unchanged.
  - **`compact`**: one line; on the right model · thinking level · `↑ ↓` · cache · cost · re-billing · context usage · dir ⎇ branch commit +a −b · session duration · queue count · codemode · preset · host status · a short subscription quota item (`5h 10% wk 31%`, only with quota data; no `·` inside the item); when narrow, these drop in order: the quota item, the switch hint, host status, preset, re-billing, cost, cache, tokens, thinking level, queue count, codemode, line changes, directory name, branch and commit, duration, context, model.
  - **git**: branch and short commit are read directly from `.git/HEAD` (worktrees understood; detached shows only the short commit; outside git the whole part is omitted, leaving only the directory name). `+a −b` is the working tree (staged included) line diff against HEAD, computed in the background with `git diff --numstat HEAD` after a turn ends, a writing tool finishes, a rewind or `/tree`, at most once every 10 seconds; if it takes longer than 2 seconds or fails, line changes are hidden for the rest of the session; `AMA_STATUS_GIT=0` turns it off. In `full`, `↑N` / `↓N` count the commits the current branch is ahead of / behind its upstream: when the branch has an upstream in the git config (`branch.<name>.merge`), the same throttled cycle then runs `git rev-list --left-right --count @{upstream}...HEAD` (same 2-second timeout; after a timeout it stops for the session); zero, no upstream or detached shows nothing; ASCII uses `^N` / `vN`.
  - **Cost** includes sub-tasks, warming, the classifier and external agent usage priced in USD (other units only in `/session`); **duration** counts from when this process opened the current session (`Ns` / `Nm` / `NhMm`).
  - When bash commands run in the OS sandbox (`sandbox.bash: "auto"` and available on this machine, see [sandbox.md](../sandbox.md), Chinese), the usage items gain a sandbox marker, dropped first together with codemode when space runs out.
  - During a model fallback (`fallbackModel`: when the main model is overloaded or retries are exhausted, one retry with the fallback model) the model item shows `main model → fallback model` (the fallback in yellow); it disappears once the fallback model replies and the main model is restored, and the message area gets an explanatory line.
  - Model names abbreviate with width (provider dropped below 100 columns, channel below 60, version suffix below 48); `compact` at ≥ 110 columns shows context as a meter `ctx ▮▮▮▯▯▯▯▯▯▯ 34%`; changing numbers reserve their widest shape, so items never flicker in and out as values change. In ASCII mode `⎇` → `git`, `−` → `-`, `♨` → `~`, `↻` → `@`.
- **Exit**: a session summary line and the resume command are appended at the end of the message area and stay in the terminal scrollback:

```
─ session 3f2a9c1e · 12 min · 7 turns · ↑128k ↓9.4k · cache 81% · $0.42 (re-billed $0.03)
  resume: ama --resume 3f2a9c1e
```

## Cache and context

Status bar items:

| Item                   | Meaning                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cache 83%`            | Hit rate of the **latest** request (cache read / (input + cache read + cache write)); the session total is in `/session`                                                                                  |
| `cache —`              | The endpoint has not reported cache usage yet (`unknown`: no long enough comparable request so far)                                                                                                       |
| `cache` "not reported" | The endpoint does not report cache usage (`silent`: reads and writes were 0 for 3 comparable requests in a row, or `compat.cacheReporting: "silent"`); such requests stay out of the hit-rate denominator |
| `♨`                    | Warming timer running (during long tool runs the prefix is replayed per TTL; `/cache warm` switches it)                                                                                                   |
| `rebill $0.11`         | Re-billing caused by cache misses in this session; token count for models without prices; hidden when 0                                                                                                   |
| `ctx 72%`              | Context usage: green below 70%, yellow at ≥ 70%, red at ≥ 90%; `ctx ?` means the model has no window information                                                                                          |
| `codemode only`        | codemode active (`on` / `only`); a red `net!` is appended when the network is not isolated (Node 22 / 24 without an OS sandbox, see sandbox.md)                                                           |

The message area (stderr with an `ama: ` prefix in line mode) shows one line in only two cases; `cache.missNotices: false` turns them off:

- One miss re-bills ≥ 20k tokens or ≥ $0.10, e.g. "cache miss (after 7 minutes idle): re-billed 38.2k tokens (about $0.11)". Causes are idle timeout, a sub-task running, a model switch, a system prompt / tool table change, server eviction; smaller misses only go into the stats.
- Context usage crosses 70% / 90% (once each), e.g. "context 72% used, about 9 turns left (average of the last 5 turns)"; when turns cannot be estimated, the remaining tokens are given.
- In line mode with `AMA_LOG=info`, successful warming is also written, e.g. "cache warmed (read 12k tokens, $0.001)".

`/session` draws a left-bar panel in the message area with a "Cache" section after the session information; `/cache` shows only that section (line mode and RPC get the same content as plain text):

```
▎ Session 3f2a9c1e  ~/.local/share/ama/sessions/…/3f2a9c1e.jsonl
▎ Model    anthropic/claude-sonnet-4-5 · thinking medium · permission Accept edits
▎ Messages user 7 · assistant 9 · tool calls 23
▎ Usage    input 3.4k · output 9.4k · cache read 118k · cache write 6.2k · $0.42
▎ Context  ▮▮▮▯▯▯▯▯▯▯ 34% · 68k / 200k
▎
▎ Cache
▎   Input      3.4k = cache read 2.2k (65%) + uncached 1.2k
▎   Reporting  reported
▎   Hit rate   latest 84% · session 65%
▎   Misses     0
▎   Warming    streaming · stopped: the model catalog has no cache TTL
▎   Context    1%, remaining ≈ 127k tokens ≈ 2443 turns
```

The misses line is broken down by cause (`3, re-billed 61k tokens ≈ $0.18 (idle timeout 2 · prefix change 1)`); while the warming timer runs, the warming line shows `streaming · next in 2m 10s · expected saving $0.18 ≥ $0.05`, and when stopped it gives the reason; with task sub-sessions there is an extra "Sub-tasks" line.

- `/cache warm off|streaming|idle`: switch warming for this session (the config is not written; `idle` also warms while idle, for expensive models).
- `/cache fingerprint`: the prefix fingerprint of the latest real request: one 16-character hash each for the system prompt and the tool table, plus the model name. If a hash changed between two requests, the host or a hook modified the system prompt / tool table mid-session.

Trade-offs: the status bar shows the latest hit rate (the session total lives in `/session`); `cache.missNotices` is on by default (the thresholds make it rare); the `Meter` component is not in the default status bar. The rules for hit rate, misses and warming are in [providers.md](providers.md) "Caching".

`ama models cache-probe <provider/model>` sends two minimal requests with a fixed prefix a few seconds apart, classifies the endpoint as `reported` / `silent` / `inconclusive` and suggests configuration (this is billed: an estimate is printed first, and non-interactive use needs `--yes`).

## Keys

| Key                  | Effect                                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enter                | Send; while running = steer (inserted into the current turn)                                                                                                                                                                  |
| Alt+Enter            | While running, queue after this turn (followUp); when idle, same as Enter                                                                                                                                                     |
| Shift+Enter / Ctrl+J | New line                                                                                                                                                                                                                      |
| Esc                  | Interrupt: queued messages go back into the input box, then the current run stops (with foreground sub-agent tasks; background tasks keep running, as the hint says); closes completion first when it is open                 |
| Esc Esc (idle)       | Empty input: open the rewind list (same as `/rewind`); with text: clear it and save it into input history                                                                                                                     |
| Alt+↑                | Recall the last queued message                                                                                                                                                                                                |
| Shift+Tab / Tab      | Cycle permission modes Manual → Accept edits → Plan → Auto → Bypass permissions (Tab only on an empty input with completion closed, otherwise still completion; entering Bypass asks to confirm, see "Entering Bypass" below) |
| Ctrl+O               | Expand / fold tool output and thinking blocks                                                                                                                                                                                 |
| Ctrl+L / Ctrl+T      | Pick model / thinking level                                                                                                                                                                                                   |
| Ctrl+G               | Bottom info line two lines (full) ↔ one line (compact), this session only                                                                                                                                                     |
| Ctrl+V               | Paste an image from the clipboard: saved in the data directory, `@<path>` inserted at the cursor (same as `/paste`)                                                                                                           |
| Ctrl+C               | Clear the input; on an empty input, press again within 1.5 seconds to quit (exit code 130)                                                                                                                                    |
| Ctrl+D               | Quit on an empty input                                                                                                                                                                                                        |
| Tab                  | Complete                                                                                                                                                                                                                      |
| ↑ / ↓                | Browse history on a single line (`<data dir>/history`, 500 entries)                                                                                                                                                           |
| ↓ (empty input)      | Enter the agent bar (whenever there are sub-agent tasks); with text it still moves down / through history and hints once, see "Sub-agents"                                                                                    |
| Ctrl+B               | When foreground sub-agent tasks (or a `task_ctl wait`) block the turn, move them all to the background, whatever is in the input box; otherwise cursor left. In tmux press `C-b C-b`, see "Sub-agents"                        |

Keys can be overridden in `~/.config/ama/keybindings.json`: keys are action ids (`app.interrupt`, `app.rewind`, `app.message.followUp`, `app.statusLine.toggle`, `app.paste.image`, `app.agents.focus`, `app.tasks.background`, `tui.editor.newLine` …), values are a key or an array of keys, and an empty array disables the action. `app.rewind` is the key double-pressed while idle (Esc by default, at most 800 ms apart).

## Rewind

Design in [rewind-plan.md](../rewind-plan.md) (Chinese). Every user message that starts a new turn is a rewind point; files changed by edit / write have a checkpoint before the message is sent (`checkpoints.mode`; bash changes are only picked up when the next turn re-snapshots tracked files).

- **Entry**: `/rewind`, or double Esc while idle with an empty input box: the first press shows a hint at the bottom to press Esc again to rewind (gone after 1 second), and a second press within 800 ms opens the list. With text in the input box, double Esc clears it instead (with a matching hint), and the text goes into input history, recallable with ↑. While running, Esc still interrupts; when an approval dialog or a picker is open, Esc belongs to them.
- **Interrupt to withdraw**: when Esc interrupts a run and this turn has no reply text or tool call yet and the input box is empty (`ui.restoreOnCancel`, default true), the message is withdrawn automatically and the original text put back into the input box, with a line in the message area saying the interrupted message was withdrawn.
- **List**: rewind points on the active path, oldest at the top, newest at the bottom, with the last one selected by default. On the right of the highlighted row is the code change summary (a preview of that row, cached): `3 files +12 −48` / no code changes, `…` while computing, `—` when the preview fails; rows without a checkpoint (in-memory sessions, checkpoints off, beyond the retention count) are marked conversation only.
- **Confirmation panel**: a left-bar panel at the bottom with the original message (at most 3 lines) and its time, followed by numbered options, each with a preview on the next line:

```
▎ Rewind to before this message  3 minutes ago
▎ › change the differential rendering in src/tui/tui.ts to compare by line,
▎   and add tests
▎
▎ › 1. Restore code and conversation
▎      will restore 3 files +12 −48 · the conversation will fork
▎   2. Restore conversation
▎      code unchanged (later changes kept) · the conversation will fork
▎   3. Restore code
▎      will restore 3 files +12 −48 · conversation unchanged
▎   4. Summarize from here
▎      the conversation forks; the abandoned part becomes a summary
▎   5. Summarize up to here
▎      earlier conversation is compacted into a summary, later kept
▎   6. Cancel
▎
▎ git HEAD changed: 3f2a9c1 → 9e8d7c6 (ama does not touch git)
▎   git log --oneline 3f2a9c1e0b7d..HEAD
▎   git reset --soft 3f2a9c1e0b7d
▎
▎ ↑↓ select · 1-6 run directly · Enter confirm · Esc cancel
```

- The two "restore code" items only appear when the preview has changes. "The conversation will fork": it goes back to before this message, and the original continuation stays in the session tree (reachable via `/tree`); after conversation operations the message area is redrawn and the original message put back into the input box (images are sent with the next message). The model, thinking level and permission mode stay unchanged.
- The two summary items accept inline instructions: once selected, just type and press Enter to submit; number keys run directly without instructions; with instructions present, Esc clears them first.
- Conflicts (files changed outside the turn) and unrecoverable files (symbolic links, hard links, moved parent directories, too large to back up …) are listed below the options; choosing a code option with conflicts adds a step: skip conflicting files and restore the rest / overwrite conflicting files / back.
- When git HEAD differs from what the checkpoint recorded, two commands are shown; ama only shows them and never runs them.
- **Result**: one notification in the message area (e.g. restored 3 files, skipped 1 (1 conflict); no files restored, skipped 2 (1 symbolic link, 1 moved parent directory); code unchanged), followed by at most 5 lines of skip details; running, no checkpoint and total failure each have their own message (cannot rewind while running, press Esc to interrupt first; this message has no code checkpoint, only the conversation can be restored; no files were restored: …).
- Below 56 columns the panel drops blank lines and only draws the preview for the selected item. In ASCII mode (`AMA_ASCII=1`) the bar is `|`, the minus `-` and the arrows `^v`.
- **Line mode** (`--no-tui`): `/rewind` lists numbers (1 = oldest); `/rewind <n> [both|conversation|code] [overwrite]` (default both, conversation when there is no checkpoint; `overwrite` overwrites conflicting files); `/rewind <n> summarize-from|summarize-up-to [instructions]`. A single-line original message goes back into the edit line.

## Commands

`/help` lists all commands. Interactive mode also has:

- `/rewind`: the rewind list and confirmation panel (see "Rewind" above); with arguments it behaves like line mode.
- `/tree`: lists every user message in the session (forks indented, `●` marks the current branch); picking one goes back to before it with the text put back into the input box, and sending an edited version creates a new branch.
- `/fork` (no arguments): also picks a user message, then copies a new session up to before it.
- `/model`, `/resume`, `/permission` and `/thinking` without arguments open pickers; `/permissions` shows the permission decision order, loaded rules and the latest 20 auto decisions (tier, result, reason).
- The `/permission` picker, titled permission mode: Manual / Accept edits / Plan / Auto / Bypass permissions / Allowlist only, each with a one-line explanation and number keys 1–6 on the right for direct selection; the current mode is checked `✓`, the default mode from config is marked `Default`, Auto is marked `Recommended`, with a key hint line at the bottom. `/permission auto` and `/permission Accept edits` switch directly. The far left of the status bar is the mode's display name. When auto mode needs confirmation, the approval dialog has an extra line naming the auto rule tier / classifier and the reason. Details in [permissions.md](permissions.md).
- Pickers have a key hint line at the bottom (`↑↓ select · Enter confirm · Esc cancel`) and a background on the selected row (≥ 256 colors; accent bold with fewer).
- The `/model` picker (also `Ctrl+L`) checks the current model with `✓`, shows an `(i/n)` count, and descriptions include context size and `img` (accepts images):
  - **Only configured providers by default**: a key, a valid OAuth sign-in (not one that needs signing in again) or a local server; group titles are "provider · status". When the current model is not in the list it is pinned at the top (group "current").
  - **`Tab` switches to "all"** (press again to go back; the filter text is kept): providers without configuration are listed too, marked "no key configured"; picking one of their models does not switch and the bottom line suggests `ama auth set <provider>` (custom providers: `ama providers add`). `Tab` was chosen over an "add model" item at the end of the list: it takes no list row, never shows up in filter results, and works in the middle of filtering.
  - **`Space` adds / removes the highlighted model to / from the list** (user-level `models.enabled`, written back to config.json): once the list is set, the "configured" view shows only listed models (plus the current one); removing the last entry deletes the key. Models listed through `provider/*` cannot be removed one by one; the hint points to `ama models disable`. While a list is in use, picking an unlisted model from "all" adds it to the list and then switches. Because of this `Space` no longer splits filter terms (the filter matches one term; `provider/model` works as a filter).
  - **Multi-channel providers get one row per model** (the preferred channel); the description says "also @channel". With an `@` in the filter text (such as `@messages`) the `model@channel` rows are listed and picking one uses that channel. `@` was chosen over expanding with `→`: it matches the `provider/model@channel` syntax and works the same way in the startup picker. `/model packy/kimi-k2.5@messages` still switches to a specific channel directly.
  - **ChatGPT subscription**: after `ama auth login chatgpt` the models available to the account are fetched (the read-only model list endpoint, no usage consumed) and cached in `<dataDir>/models/discovered/chatgpt.json`; the picker lists them like any other model. Without the cache the chatgpt group has a row "Run ama models discover chatgpt to list its models" (see [providers.md](providers.md#chatgpt-login)).
  - The same list from the command line: `ama models enable <provider/model[@channel]|provider/*>…`, `ama models disable …`, `ama models list --enabled` (without a list it prints what the picker shows by default).
- An `@image-path` in the input (quotes allowed, Tab completes the path), or a pasted / dropped image file path, is sent as an image attachment with the message; when the current model does not accept images an `@` attachment is an error and nothing is sent, while paths without `@` are ignored (see [providers.md](providers.md) "Image input").
- `/statusline [full|compact]`: switch the bottom info line (without arguments it toggles, same as `Ctrl+G`), this session only; line mode has no bottom info line.
- `/session`, `/cache`: session usage and cache stats panels (see "Cache and context" above); `/permissions` is a panel too, with allow in green, deny in red and the decision order wrapped and aligned. With sub-agent tasks `/session` gains a "Sub-agents" line (task count and states), and after using external agents an "External agents" section (runs and usage per agent, USD / tokens / requests each in its own unit, never converted).
- `/plan`: the current plan panel (see "Plan approval" below); `/plan <goal>` enters Plan mode and sends the goal; `/plan approve [mode|fresh]` and `/plan reject` approve / discard directly without a dialog.
- `/tasks`: focus the agent bar, `/tasks <id>` opens the sub-agent view; `/agents`: the available sub-agent types (see "Sub-agents" below).
- `/paste`: same as `Ctrl+V`.

## Entering Bypass

Before switching to Bypass permissions (`full-auto`), a confirmation box pops up at the bottom, styled like the approval dialog (yellow border):

```
╭─ Enter Bypass permissions? ──────────────────────────────────────────────────╮
│ No tool call will ask anymore: writes, commands and network are allowed      │
│ Only dangerous commands still ask and deny rules still apply; use it only in │
│ throwaway sandboxes or containers                                            │
│                                                                              │
│   1. Enter Bypass                                                      y     │
│ › 2. Cancel                                                            n Esc │
│                                                                              │
│ ↑↓ select · Enter confirm · 1-2 pick · Esc cancel                            │
╰──────────────────────────────────────────────────────────────────────────────╯
```

- Triggers: cycling to Bypass with Tab / Shift+Tab, choosing Bypass in the `/permission` picker, `/permission full-auto`. "Cancel" is selected by default: ↑↓ move, Enter confirms, `1` / `2` or `y` / `n` pick directly, Esc / Ctrl+C cancel (Ctrl+C here does not count as the first press of quitting).
- Cancelling: while cycling, it **skips Bypass and returns to the start of the cycle, Manual** (with a bottom hint that Bypass was not entered and the mode is Manual), so you can Tab all the way round without entering Bypass and always land on something stricter than Auto; cancelling from the picker or the command keeps the previous mode (with a message saying so).
- Once confirmed in a run, switching to Bypass again does not ask; if the run started in Bypass (`--permission-mode full-auto`, config, profile) it counts as confirmed and nothing pops up.
- Below 56 columns blank lines are removed and the key hint shortened; in ASCII mode the border is `+ - |`, the selection marker `>` and the arrows `^v`. Frame goldens: `test/fixtures/tui/bypass-confirm-*.txt`.
- Line mode (`--no-tui`): `/permission full-auto` first prints the two explanatory lines above, then asks a `[y/N]` question (single key, Enter = N); piped input has no such step.

## Keys for choices and confirmations

Every place that asks for a choice supports ↑↓ to move + Enter to confirm, keeping the existing shortcuts:

| Where                                                                    | Keys                                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Approval dialog (including the external agent first-run confirmation)    | ↑↓ Enter · 1–3 · y / a / n · Esc deny · v full input                          |
| Plan approval box (main options, execution mode)                         | ↑↓ Enter · 1–4 / 1–3 · e edit plan · Esc stay in Plan / back                  |
| Rewind confirmation panel, second confirmation for overwriting conflicts | ↑↓ Enter · numbers run directly · Esc cancel / back                           |
| Entering Bypass confirmation                                             | ↑↓ Enter · 1–2 · y / n · Esc cancel                                           |
| Permission mode and thinking level pickers                               | ↑↓ Enter · numbers pick directly · Esc cancel                                 |
| Model, session, tree and task pickers                                    | ↑↓ Enter · type to filter · Esc cancel (filterable lists have no number keys) |
| Trusting the directory at startup                                        | ↑↓ Enter · 1–4 pick directly · Esc / Ctrl+C = do not trust this time          |
| CLI subcommand billing / write confirmations (TTY)                       | ↑↓ Enter · 1–2 · y / n · Esc / Ctrl+C cancel (cancel by default)              |

CLI subcommands (write confirmations of `ama providers add` / `refresh` and the `--probe` billing confirmation, `ama models cache-probe`) use the same arrow-key selection on a TTY, collapsing to a single answered line and restoring the terminal afterwards; when stdin is not a TTY (pipes, CI) it is still a text `[y/N]` question (these commands require `--yes` when non-interactive anyway), and `--yes` skips the confirmation.

## Completion

- `/` at the start of the first line: commands, prompt templates (`/<name>`), Skills (`/skill:<name>`).
- `@` (at the start of a line or after a space): files and directories under the current directory (respecting `.gitignore`); with `*` `?` `[` `{` it matches relative paths as a glob.

## Approvals

When a tool call needs confirmation, a dialog pops up at the bottom: the title is the reason (confirmation needed / dangerous command / a hook asked for confirmation; requests from sub-agents and external agents carry origin labels, see "Sub-agents" below), and the border turns red / yellow with the preview's severity; bash shows the full command, write shows the path and line count, edit shows a −/+ summary per change. Numbered options follow:

```
╭─ Dangerous command ─────────────────────────────────────╮
│ bash  dangerous command                                 │
│ $ rm -rf build dist/*.map > out.log                     │
│                                                         │
│ delete build/: directory, 132 files, 1.2 MB             │
│ This command may be destructive, please confirm         │
│                                                         │
│   1. Allow                                        y     │
│   2. Allow this kind for the session              a     │
│ › 3. Deny                                         n Esc │
│                                                         │
│ ↑↓ select · Enter confirm · v full input                │
╰─────────────────────────────────────────────────────────╯
```

Pick with `1`–`3` or `↑↓` + Enter; `y` allows, `a` stops asking for the same kind in this session, `n` / Esc / Ctrl+C deny, `v` shows the full input. The default selection is "Deny" for dangerous commands and "Allow" otherwise. Below 56 columns it is compact (the tool name on its own line, no blank lines). Without an answer for 10 minutes it counts as deny (`AMA_APPROVAL_TIMEOUT_MS` changes it).

After the input summary comes the **pre-execution preview**: what this step will touch.

- bash: in every command segment (including commands nested in `sh -c`, `eval`, `xargs`, `find -exec`) it recognizes `rm` / `rmdir` / `unlink`, `mv`, `git clean`, `git checkout -- <path>`, `git reset --hard` and `>` / `>>` redirect targets, and lists whether the paths exist, their size and how many files a directory holds; globs and variables are not expanded but shown as is, with a note that the real scope may be larger.
- write: whether the target exists, its current line count and size → the new content; overwriting a file not read in this session is marked yellow.
- edit: a dry run against the original, listing −n/+m lines per change and the total; when a match fails or is not unique, this is said up front.

The preview is colored by severity (danger red, warning yellow, the rest dim), read-only and bounded: at most 2000 entries counted per directory and a 200 ms budget for the whole preview; beyond that it only gives a hint without lowering severity; files over 2 MiB only report their size. A failed preview does not affect the approval. Line mode prints the same preview line by line before the question; RPC clients get it from `permission_request.preview` ([rpc.md](rpc.md) "Approvals").

## Plan approval

In Plan mode (Shift+Tab, `/permission plan`, `/plan <goal>`, `--permission-mode plan`) the model researches read-only and ends with a `<proposed_plan>` block (rules in [plan.md](../plan.md), Chinese). When the turn ends and the session is idle, an approval box pops up at the bottom:

```
╭─ Plan awaiting approval ─────────────────────────────────────────────────────╮
│ Plan v1 · 3 steps · ~/.local/share/ama/plans/3f2a9c1e-…-v1.md                │
│ Show the fallback model in the status bar                                    │
│   S1 read status-bar.ts and status-area.ts                                   │
│   S2 record the main and fallback models on model_fallback                   │
│   S3 frame goldens and docs                                                  │
│                                                                              │
│ › 1. Approve and execute                                                     │
│   2. Approve, execute in a fresh context                                     │
│   3. Keep revising…                                                          │
│   4. Discard and leave Plan mode                                             │
│                                                                              │
│ ↑↓ select · Enter confirm · e edit plan · Esc stay in Plan                   │
╰──────────────────────────────────────────────────────────────────────────────╯
```

- **1 Approve and execute** / **2 Approve, execute in a fresh context**: then pick the execution mode: back to the previous mode (default) / Accept edits / Auto; Esc goes back. After approval the plan's steps become todos (the first in progress), the mode switches and execution starts. "Fresh context" creates a new session carrying the approved plan and todos and starts executing with the full plan as the first message (the original session stays in the tree).
- **3 Keep revising**: write feedback in the box (Enter sends, `Ctrl+E` switches to an external editor, Esc goes back); the feedback is sent to the model as an ordinary message, still in Plan mode, and the box pops up again after the model rewrites the plan. Typing into the input box and sending has the same effect.
- **4 Discard**: the plan is marked discarded and the mode returns to the one before Plan. **Esc**: the plan is marked discarded but you stay in Plan mode (keep talking, let the model plan again).
- **e Edit plan**: opens the full plan with `$VISUAL` / `$EDITOR` (default `vi`, `notepad` on Windows) while the interface is suspended; after saving and exiting the box notes that the plan was edited, and approval executes the edited version (with a new version number).
- `/plan`: the panel lists the version, status (awaiting approval / approved / discarded / superseded by a new version), plan file, current mode and the mode to return to after approval, steps and todo progress; when a plan awaits approval it also reopens the approval box (on resume the message area mentions it in one line).
- Below 56 columns it is compact (no blank lines, shortened key hints, truncated summary); in ASCII mode the selection marker is `>` and the arrows `^v`.
- **Line mode**: when a plan is proposed it prints one line saying plan v1 awaits approval (with the file), and that `/plan approve [mode|fresh]` approves, `/plan reject` discards and typing feedback revises; replying `1` / `2` / `3` also approves (the mode before entering such as Manual / Accept edits / Auto). After `/plan approve` starts execution, the next line is read only once that round finishes.

## Sub-agents

Sub-agents started by the `task` tool ([agents.md](../agents.md), Chinese) fold into a task tool line in the message area, with one status line while running:

```
⏺ task check test coverage gaps in src/tui
  ⎿ ⠋ explore · running 1m05s · 3 turns · read grep bash · ↑12k ↓3.4k
⏺ task background review
  ⎿ started in the background
    ↳ t2 explore · running 40s · 1 turn · read
⏺ task scan
  ⎿ moved to the background · 12s
    ↳ t3 explore · running 30s · 2 turns · grep
```

- The status line shows the type (external agents show a runner such as `claude (claude)`), status and elapsed time, turns, the latest 3 tools and usage; after a foreground task ends it is replaced by the result summary. A background task's tool call (background is the default in the interactive UI, see [agents.md](../agents.md) "foreground and background", Chinese) returns immediately; the summary line says "started in the background", with an extra follow-up status line below (refreshed every second while running). A foreground task moved to the background shows "moved to the background · elapsed" with the same follow-up line (the explanation meant for the model is hidden; `Ctrl+O` shows it). A task moved by the auto timeout (`subagents.autoBackgroundAfterMs`) or by the host also gets a one-line notice; when it completes, the `<task-notification>` the model receives shows in the message area as a single line (e.g. "↳ sub-agent notification: t2 explore done · 7 turns · see /tasks for output"), plus a yellow notice on failure or stop.
- `/tasks`: focus the agent bar (below); `/tasks <id>` opens that task's sub-agent view directly; `/tasks stop <id>` stops it; `/tasks bg [id]` moves it to the background (without an id: every blocking foreground task, same as `Ctrl+B`). With `ui.agentBar: "off"` `/tasks` is still the task picker (newest on top, Enter shows the output, running tasks can be stopped). Line mode: `/tasks` lists, `/tasks <id>` shows output, `/tasks stop <id>` stops, `/tasks bg [id]` moves to the background (typed while running it is still a command, not a steer).
- Moving to the background (`Ctrl+B`, key action `app.tasks.background`): while the main turn waits for a foreground task (`task` with `background: false`, the `-p` default, or `task_ctl wait`), press it and the tool call returns at once, the task keeps running, the main turn carries on and you can keep sending messages; when the task ends the `<task-notification>` arrives and opens a turn as usual. The hint says "Moved to the background: t2; you'll be notified when it finishes". With nothing to move, `Ctrl+B` falls through to the editor (cursor left) and is not swallowed. tmux's default prefix is `C-b`: in tmux press `C-b C-b` (default `send-prefix`) to pass it to ama, or press `b` in the agent bar; you can also rebind it in `keybindings.json`.
- Esc interrupts only the foreground: Esc while running stops the main turn and the sub-tasks still in the foreground; tasks already in the background keep running, and the hint says "Interrupted (background task t2 keeps running; Esc doesn't affect it)".
- `/agents`: the available types: name, runner, source (built-in / user / project / profile / host), external agents marked installed with a version or not installed, plus a one-line description.
- Notices reported by external agents themselves (budget exhausted, timeout, mode downgrade …) show in the message area as a single line `[claude · t3] …`.

### Agent bar

Above the status line (below the hint line) the bar lists sub-agent tasks, one line each, at most 3 lines, with an "N more" line for the rest:

```
⏺ t1 explore · running 1m05s · 3 turns · grep  find test gaps in src/tui
⏺ t2 codex · awaiting approval 40s  review the diff
⏺ t3 explore · queued  a queued task
1 more
```

- States: queued (the concurrency pool is full) / running (elapsed time, turns, latest tool) / awaiting approval (the approval dialog currently holds its request, or it is docked in the bar; the row is yellow) / done / failed / stopped (plus out of turns and interrupted); `⏺` is the accent color while running, green when done, red on failure, yellow / dim otherwise; `*` in ASCII.
- When it shows: while any task is queued, running or awaiting approval; tasks that ended in this session and have not been looked at in the view stay until viewed, at most 10 minutes. Tasks already finished when a session is resumed are not shown (`/tasks` lists them).
- Entering: press `↓` with an empty input box and no completion open, whenever the session has tasks (even after the bar has collapsed, same as `/tasks`); the same inside and outside tmux. It works while a turn runs too; the `↓ Agent bar` at the end of the running line is the reminder. The key action is `app.agents.focus` (only `down` by default), configurable in `keybindings.json`.
- When the key does not get you in, a one-line hint shows for 3 seconds: text in the input box — "Input is not empty; clear it and press ↓ for the Agent bar" (once per draft, with the cursor on the last line; `↓` still moves down); the bar is off — "Agent bar is off (ui.agentBar); use /tasks"; no tasks — "No sub-agent tasks yet". While browsing input history with `↑` `↓`, `↓` only steps through history.
- `Ctrl+B` does not enter the bar; it moves foreground tasks to the background (above). For the old "`Ctrl+B` enters the bar", set `"app.agents.focus": ["down", "ctrl+b"]` in `keybindings.json` and rebind `app.tasks.background`.
- In the bar: `↑` `↓` select (lists every task of the session, the window scrolls along; `↑` on the first item returns to the input box), Enter opens the sub-agent view (a docked approval of the selected task pops up right away), `b` / `Ctrl+B` moves the selected foreground task to the background (a one-line hint when it is not running in the foreground), `x` stops the selected task (the first press hints "Press x again to stop t2"; it stops only on a second press within 1.5 seconds), Esc returns to the input box; other letters return to the input box with the text filled in. The last line is the key hint `↑↓ select · Enter open · b background · x stop · Esc back`; narrow screens drop the `b` / `x` items.
- Embedding hosts (with a profile) no longer turn the bar off by default; a host that shows sub-tasks itself and does not want the bar sets `ui.agentBar: "off"` in its profile (see [host-api.md](host-api.md) "Embedding in Armadra"). With the bar off it is not shown, and `↓` with tasks points to `/tasks`.

### Sub-agent view

Opened with Enter in the bar or `/tasks <id>`. It is a bottom overlay on the main screen, terminal rows − 1 tall (no alternate screen), so the message area and scrollback are unchanged after closing it:

```
t2 explore · running 1m05s · 3 turns · ↑12k ↓3.4k · Esc back · /tasks stop t2 to stop
› find test gaps in src/tui

⏺ grep "describe(" src/tui
  ⎿ 14 matches · 6 files
…
────────────────────────────────────────
› message t2
────────────────────────────────────────
```

- The body follows live: for ama sub-agents it shows every message and tool call of the sub-session (rendered like the message area); when the sub-session handle has been released (at most 16 are kept) or the session was resumed, the sub-session file is loaded read-only and live events are attached when the task runs again. External agents (claude / codex / ACP) show the live output held in this process's memory (text, thinking, tool start / end, turns, notices; at most 2000 items / 1 MB, never written to disk); after ama restarts only one line remains, saying to use the original CLI's resume <session id> for the full text.
- With an empty input box: `↑` / PgUp scroll up (pausing follow, with "follow paused · End to resume" at the bottom), `↓` / PgDn scroll down, End (or `f` while paused) resumes following; `←` `→` switch to the previous / next task; Esc returns to the main screen. With text in the input box, Esc clears it first.
- Enter sends the input to this sub-agent (recorded in the sub-session as a user message with `origin: "direct"`, see [session-format.md](../session-format.md), Chinese): ama sub-agent running → delivered when its current turn ends; external agent running or task still queued → continued after this run ends; finished → continued in the background (like `task_ctl send`; the main session receives the `<task-notification>` as usual when it completes). A line at the bottom reports the result. The parent session's model does not know you talked to the sub-agent directly; the result comes back through the completion notification.
- Nothing is interrupted from the view: Esc only goes back. To stop the task use `/tasks stop <id>`; to move it to the background use `Ctrl+B` or `/tasks bg [id]`. Both work in the view's input box (the only commands the view accepts).
- When the viewed task waits for approval the title says "awaiting approval", and the approval dialog pops up over the view as usual (with the `[task:<type>]` origin); if its approval is docked in the bar, opening the view pops it up.

### Docked approvals of background tasks

When a background task (including one moved to the background) needs approval, it does not interrupt what you are doing:

- While the main session is running, the input box has a draft, or another overlay is open, no dialog pops up; the request is **docked**: the task's row in the agent bar says "needs approval" (yellow) and the running line shows `↓ handle approval`; the sub-task waits meanwhile.
- It pops up on its own once the main session is idle, the input box is empty and no overlay is open; entering the bar, selecting it and pressing Enter (opening the view) pops it up immediately.
- If the main session or a foreground task asks for approval while one is docked: approvals are serialized, so the docked one pops up first and theirs follow; the main session's approvals are never held back.
- Approvals of foreground tasks and of the main session pop up immediately as before; timeouts (deny after 10 minutes by default), aborts and unattended rules are unchanged. RPC clients receive `permission_request` as usual and decide how to present it.

Origin labels on approval boxes:

| Origin                                                          | Title prefix                                         | Body                                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| Tool calls of a task sub-agent                                  | `[task:explore]` (`[task]` when the type is unknown) | Same as the main session                                                      |
| Permission requests from external agents (claude / codex / ACP) | `[claude · session abc12345]`                        | The title, kind, paths involved and input summary given by the external agent |
| First run of an external agent in this session                  | Title "first run of an external agent"               | An explanation (runs with your login in that CLI) and the mode                |

All three offer only "allow / allow this kind for the session / deny" (for external agents, "allow for the session" is remembered by the agent itself). In Manual mode `task(agent="claude")` would ask twice (once for the task call, once for the first run): the approval box of the task call already says it runs with your login in the claude CLI (including the first-run confirmation for this session), so after allowing it the immediately following first-run confirmation passes automatically, with one line in the message area saying task was allowed along with the previous confirmation; if another approval comes in between, it is denied, more than 60 seconds pass, or the task was not created by this call, the first-run confirmation pops up as usual.

## Traces

`/trace` opens the current session's trace: layered as turn → request → tool → sub-call / sub-agent, each row showing duration, tokens and cache hits, so you can see where a reply was slow (first token, decoding, tools, approvals, retries, compaction). `/trace t2` looks at task t2 directly: an ama sub-agent shows its own sub-trace, external agents (claude / codex …) only have a turn skeleton (kind, state, times and counts, no command lines or paths).

The overlay sits at the bottom of the main screen, `rows − 1` tall, and leaves the message area unchanged when closed:

```text
Trace · 1 turn · 2 requests · 3 tool calls · 12s · ↑8.1k ↓240 · cache 70% · ttft p50 0.8s / p90 0.9s · 120 tok/s
 ▾ #1 run the tests and find TODOs                         12s ▕██░░░░░░░▒██▏ ↑8.1k ↓240     70%
   ▾ request claude-sonnet-4-5 · ttft 0.8s · 167 tok/s    1.7s ▕██░░░░░░░░  ▏ ↑3.9k ↓150     46%
       bash pnpm test                                     8.0s ▕ ░░░░░░░░░  ▏
       grep TODO                                          0.3s ▕ ░░         ▏
       ⛔ write notes.md                                  2.2s ▕ ░░░░       ▏
›    request claude-sonnet-4-5 · ttft 0.9s · 82 tok/s     2.0s ▕         ▒██▏ ↑4.2k ↓90      93%
↑↓ move · → expand · ← collapse · Enter details · f follow · Esc close
```

- **Bars** are a relative timeline of the turn: `▒` waiting for the first token (TTFT), `█` decoding, `░` tools; in-progress nodes only draw a start mark `│` and no made-up duration. With ASCII (`ui.ascii` / `AMA_ASCII=1`) or no color (`NO_COLOR`) they degrade to `[==..--]` (`.` TTFT, `=` decoding, `-` tools, `|` start).
- **Columns**: ↑ is prompt tokens (including cache reads and writes), ↓ is output tokens, the percentage is the cache hit rate (cache reads / prompt tokens). Below 60 columns only the label and duration remain; 40 columns works.
- **Marks**: `✗` failed, `⛔` denied, `↻` a request replaced by a retry, `!` interrupted or unfinished, `·` in progress; `≈` (ASCII `~`) before a duration means **estimated** — sessions from before 0.6 have no timing records, so durations are estimated from entry times, first token and throughput are not shown, and the summary's ttft percentiles use exact values only.
- **Keys**: `↑↓` / `PgUp` `PgDn` / `Home` `End` move; `→` expands (expanding a sub-agent reads its sub-session) or moves to the first child, `←` collapses or returns to the parent; `Enter` opens a detail card (kind, state, start time, duration, model and attempts, fallback source, TTFT, throughput, tokens and cache, cost, approval wait; the turn's prompt, the request's reply text, tool arguments (cut at 500 characters) and results (cut at 2000 characters)), with `↑↓` to scroll in the card and `Esc` / `Enter` to go back; `f` toggles following; `Esc` closes the details first, then the view.
- **Long sessions**: the last 50 turns show first; `Enter` on the top line "N earlier turns" (or `↑` again on the first line) loads 50 more; only visible rows are rendered.
- **While running**: the trace refreshes with session events (at most twice a second); with in-progress nodes it follows the newest row, moving up manually pauses it ("follow paused" at the right of the title), and `End` or `f` resumes.
- Auxiliary requests such as warming and permission classification are grouped at the end under "N auxiliary requests", collapsed by default.
- In line mode (`--ui line`, pipes) `/trace [task id]` prints the same tree as text (fully expanded, no bars).

Timing comes from `custom{customType:"ama.trace"}` entries in the session file ([session-format.md](../session-format.md), Chinese), which hold only ids, times and counts; previews of prompts, arguments and results are read from session entries on demand and never enter the trace itself. The HTML export `ama sessions trace` and RPC `get_trace` are described in [sessions.md](sessions.md) and [rpc.md](rpc.md).

## Memory

Requires memory to be enabled (`ama memory enable` or `--memory`, see [memory.md](../memory.md), Chinese). `/memory` draws a card in the message area: one section per scope (`user /memories/user/ · N entries · index X / 4.0 KiB`), one line per entry "name — description updated date", entries not updated for over 90 days greyed out; when the index exceeds its limit a yellow line says how many entries did not make it into the system prompt; an untrusted project and writes disabled for this session each add a line at the bottom of the card.

`/memory show <name>` renders the body as a card; `/memory edit [name|scope]` suspends the interface and opens `$VISUAL` / `$EDITOR` (on a temporary copy, saved back and the index rebuilt after you save and quit, with the same credential and size checks as model writes); `/memory rm <name>` asks for confirmation (default "Cancel", `y` deletes, `n` / Esc cancels); `/memory on|off` toggles writes for this session; `/memory reload` re-renders the system prompt's `memory` section (breaking the cache once). Line mode has the same commands with text output; `edit` uses `ama memory edit` instead and `rm` needs `--yes`. When memory is not enabled for the session it only explains how to enable it.

## Clipboard images

`Ctrl+V` or `/paste` reads an image from the system clipboard (macOS `osascript` / `pngpaste`, Linux `wl-paste` / `xclip`, Windows PowerShell), saves it as `<data dir>/clipboard/<time>.png` and inserts `@<path>` at the cursor in the input box; on send it is handled as an `@image` attachment (resized per `images.resize` when above the current model's per-image limit). When no usable command exists or the clipboard holds no image, a line appears at the bottom and the input box is unchanged. Text still uses the terminal's own paste (Cmd+V / Ctrl+Shift+V). `ama sessions prune` cleans clipboard files older than 7 days.

## Startup screen

`ui.quietStartup` / `--quiet-startup`: `normal` shows an "AMA" logo with an info column: version, model and thinking level, directory (`~` abbreviated) and trust state, permission mode / preset / codemode, loaded context files / Skills / prompt templates / hooks, warning count and common keys. At 72 columns or wider the logo sits on the left and the info on the right; at 48–71 columns the logo is on top; below 48 columns a two-line header is shown instead (version · model · thinking / mode · directory · trust). `ui.logo: "off"` or `ui.compact` shows only the info column. The logo takes the theme's accent → user → tool colors letter by letter; ASCII mode swaps in a glyph made of `_ / \ |`. On startup a one-off "light-up" sweep plays for about a second (the glyph starts dim, a highlight band sweeps left to right, then it settles); it redraws in place and leaves no frames in the scrollback, and any key settles it at once while the key still goes to the input box. The settled frame is shown directly with `ui.animation: false`, `NO_COLOR` / a colorless terminal, a non-TTY, an embedding host (profile.host), a `CI` environment, a prompt given on the command line (`ama "…"`), a terminal shorter than 16 rows or content taller than one screen; the line interface, `-p`, RPC and ACP draw no startup header. `header` is a single line `✻ ama version · model · mode · /help` (the profile default); `silent` shows nothing. When `--resume` has no id, the model has no key, the session directory does not exist or project resources need trust, a small selection / input prompt appears before the interface starts, collapsing into one line on screen once answered.

## In tmux / Armadra terminal nodes

- Bracketed paste: enabled at startup; pasted multi-line content enters the input box as a whole (folded into a paste placeholder with the line count beyond 10 lines or 1 000 characters), and an Enter right after a paste sends directly, which suits writes from external programs.
- Terminal capabilities are not queried, and mouse and the Kitty keyboard protocol are not enabled, so no replies get mixed into input; tmux ≥ 3.4 passes synchronized output through, and older versions display fine too.
- tmux's default prefix `C-b` is taken by the tmux client: to move tasks to the background press `C-b C-b` (`send-prefix` passes it through), or `↓` into the agent bar and press `b`; entering the bar uses `↓`, which the prefix does not affect.
- When the window size changes the last screen is redrawn in full; history in the scrollback is unaffected.
- Automatic fallback: non-TTY, `TERM=dumb`, `--no-tui` or a failed terminal initialization use line mode, with the same commands and approval prompts.

## Configuration and troubleshooting

The `ui` section of `config.json` (settable at project level too):

| Key               | Default       | Effect                                                                                                                                            |
| ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui.theme`        | `dark`        | `dark` / `light` / `auto`; auto only looks at `COLORFGBG` (no terminal query) and uses dark when unsure; configuring it explicitly is recommended |
| `ui.ascii`        | auto-detected | ASCII glyphs (`›` → `>`, `⏺` → `*`, `⎿` → `L`, box lines → `+ - \|`, a 4-frame spinner)                                                           |
| `ui.compact`      | `false`       | No blank lines between message blocks, no logo in the startup header                                                                              |
| `ui.logo`         | `auto`        | The "AMA" logo in the startup header; `off` shows only the info column                                                                            |
| `ui.animation`    | `true`        | `false`: the spinner stays still as `·` while running and redraws only when seconds change; the startup logo does not animate                     |
| `ui.markdown`     | `true`        | `false`: assistant text is not rendered as Markdown                                                                                               |
| `ui.showThinking` | `collapsed`   | See "Layout"                                                                                                                                      |
| `ui.quietStartup` | `normal`      | See "Startup screen"                                                                                                                              |

- **ASCII mode**: `AMA_ASCII=1` (or `ui.ascii: true`) forces it on, `AMA_ASCII=0` forces it off; auto-detection turns it on when the locale (`LC_ALL` > `LC_CTYPE` > `LANG`) is set but lacks UTF-8, with `TERM=linux`, or on Windows without `WT_SESSION` or `TERM_PROGRAM` (legacy conhost). Windows Terminal uses Unicode.
- **Misaligned characters**: `⏺` (U+23FA), `⎿` and `▎` render two cells wide in some fonts (emoji fallback fonts in particular), while width is computed per wcwidth (one cell), causing misaligned columns or ghosting; switch to a monospace font or set `AMA_ASCII=1`.
- **Colors**: no color with `NO_COLOR` or `TERM=dumb`; 16-color terminals take the nearest color from a built-in table and mark the selected row with accent bold instead of a background; on light terminals set `ui.theme: "light"`.

### The `/config` settings panel and `ama config`

`/config` opens the settings panel (a bottom overlay): about 60 scalar settings listed by group, each row "label · effective value · when it takes effect · source".

```text
▎ Settings  writing to: user level ~/.config/ama/config.json  [Tab to switch]
▎ / search
▎ Interface
▎ › Theme                     light             restart          source user
▎   Markdown rendering        true              immediate
▎ Permissions
▎   Permission mode           plan              immediate        [locked] project
▎ ────────────────────────────────────────────────────────────
▎ Color theme: dark, light, or auto (…)
▎ ↑↓ select · Enter/Space change · / search · Tab user/project · Backspace reset · Esc close
```

- **Keys**: ↑↓ move; Enter / Space: toggles booleans, cycles enums of ≤ 4 values, opens a picker for longer enums (thinking level, permission mode …) and models, and inline input for numbers and text (invalid values stay in the box in red, Esc gives up); `/` searches key names, labels, enum values and descriptions, Esc clears the search first and then closes; pressing Backspace / Delete twice removes the key from the target layer (falling back to the value below).
- **Target layer**: writes go to the user-level `~/.config/ama/config.json` by default; Tab switches to the project-level `.ama/config.json`, which may only tighten (the same check as the merge rules), with user-level-only items greyed out and Enter explaining why. Changes are **written to disk immediately** (the file is re-read before writing, only this key changes, it is validated, a `.bak` is kept); there is no "save" button and no file lock, so when `ama config edit` changes the same key concurrently, the last writer wins for that key. Hand-made formatting is normalized to 2-space indentation.
- **Source and locking**: the source is default / user / profile / project / cli / env; items overridden by a higher layer (profile, project level, command-line flags, environment variables such as `AMA_CACHE_WARMING`) are marked `[locked]`, the description line gives the reason, and they cannot be changed. In an embedding host (with a profile) the title notes that writes go to the user-level config.
- **When it takes effect**: "immediate" items apply to this session and the interface right away (`ui` display items except the theme, `defaultModel`, `thinkingLevel`, `permission.mode`, `compaction.enabled`, `retry.enabled`, `cache.warming`); "new session" items apply after `/new` / `/resume`; "restart" items (tool preset, codemode, sandbox, `ui.theme`, `ui.ascii`, `ui.language` …) apply at the next start. The panel = persistence; `/model` `/thinking` `/permission` `/statusline` still change only this session.
- **Cache**: items marked as affecting the cache change the cache prefix; the first time such an item is changed after the conversation already has replies, the bottom of the panel notes once that the next request will be billed as a miss.
- Setting `permission.mode` to `full-auto` in the panel first shows the Bypass confirmation, explaining that it will apply on every start from now on.
- On close, the message area gets a summary such as "Theme: dark → light (user level)", with items that need a restart / new session on a separate line; nothing is shown without changes.
- List and object keys are not in the panel; the last group, "change elsewhere", gives the entry points (`ama providers`, `/permissions`, `ama config edit`, `--json-value` …).

`/config key=value` (or `/config key value`) writes one user-level key without opening the panel, echoing like the command line; it works in line mode too, and without arguments lists all settings.

Command line (sharing the editing core with the panel):

```text
ama config get <key> [--json]                              effective value, source, when it takes effect
ama config set <key> <value> [--project] [--json-value] [--yes]
ama config unset <key> [--project]
ama config list [prefix] [--json] [--all]                  by default only the settings shown in the panel
```

Values are parsed by type: `true/false/on/off/1/0`, numbers (`30_000` allowed), enums case-insensitively, `none` / `unset` = delete; lists and objects use `--json-value` (e.g. `ama config set tools.disabled '["bash"]' --json-value`). Unknown keys, invalid values and loosening rejected at project level all exit with 3 and leave the file alone; `get` / `list` never create the config directory. `ama config set permission.mode full-auto` asks for confirmation in a terminal and needs `--yes` otherwise.

The optional `ui.replyLanguage` (e.g. `Chinese`): at session start one English rule, `Reply to the user in Chinese.`, is appended to the end of the system prompt's `rules` section; requests are byte-identical when unset; user level / profile only.

## Component library (`@armadra/agent/tui`)

The terminal components used by interactive mode are exported separately with zero dependencies, so hosts and other Node programs can use them to draw main-screen interfaces.

```ts
import { TUI, ProcessTerminal, Text, Editor, createTheme } from "@armadra/agent/tui";

const tui = new TUI(new ProcessTerminal());
const theme = createTheme("dark");
const log = new Text("");
const editor = new Editor({
  theme,
  requestRender: () => tui.requestRender(),
  onSubmit: (text) => {
    log.setText(`you said: ${text}`);
    tui.requestRender();
  },
});
tui.addChild(log);
tui.addChild(editor);
tui.setFocus(editor);
tui.start();
```

| Export                                                                    | Purpose                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Component`, `Focusable`, `CURSOR_MARKER`                                 | The component contract: `render(width)` returns lines (each with visible width ≤ width), `handleInput?(data)`, `invalidate()`; the focused component emits `CURSOR_MARKER` at the cursor                                          |
| `TUI`                                                                     | Root container and differential rendering (main screen, synchronized output): `addChild`, `start` / `stop`, `requestRender`, `setFocus`, `addInputListener`, `showOverlay`                                                        |
| `ProcessTerminal`, `MemoryTerminal`, `VirtualScreen`                      | A real terminal (raw mode, bracketed paste); an in-memory terminal and a VT screen (tests, frame goldens)                                                                                                                         |
| `Container`, `Text`, `TruncatedText`, `Markdown`, `Box`, `Card`, `Spacer` | Basic components; `Card` is a left-bar card, `Box` accepts `borderColor`                                                                                                                                                          |
| `Loader`                                                                  | Running indicator: `setVerb(verb, extras, { elapsed, optional })` (`optional` extras are dropped whole when the line does not fit), `frame` / `onFrame` (changes glyph in the same frame as other components), `animation: false` |
| `Editor`, `EditorBuffer`, `PasteStore`                                    | Multi-line editor (history, the `AutocompleteProvider` completion interface, paste folding)                                                                                                                                       |
| `SelectList`                                                              | Filterable selection list: groups, badges, number keys, `stacked`, `currentValue` (✓), `footer` key hints                                                                                                                         |
| `KeyValue`, `Meter`                                                       | Two-column aligned key-value table (`wrap` wraps aligned to the value column); a meter (`levelColor` threshold coloring)                                                                                                          |
| `compositeOverlays`, `OverlayOptions`                                     | Overlay compositing (centered / bottom-anchored)                                                                                                                                                                                  |
| `createTheme`, `plainTheme`, `detectCapabilities`, `Theme`                | Themes and color capability detection (`NO_COLOR`, 16 / 256 / truecolor); 14 semantic colors, `resolveThemeName("auto")`                                                                                                          |
| `Theme.glyphs`, `UNICODE_GLYPHS`, `ASCII_GLYPHS`, `detectAscii`           | Glyph tables (`›` `⏺` `⎿` `✻` `▎`, box lines, spinner frames …) with ASCII fallback; `createTheme(name, { ascii })`                                                                                                               |
| `Keybindings`, `DEFAULT_KEYBINDINGS`, `loadKeybindingsFile`               | Action id → keys, overridden by `keybindings.json`                                                                                                                                                                                |
| `parseKey`, `matchesKey`, `StdinBuffer`                                   | Key sequence parsing and Esc timeout splitting (`AMA_TUI_ESC_TIMEOUT`)                                                                                                                                                            |
| `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `sliceByColumn` …  | Width computation and truncation aware of ANSI and wide characters                                                                                                                                                                |

## Testing

Frame goldens all live in `test/fixtures/tui/`; `MemoryTerminal` reconstructs the screen (without color, verifying only layout and glyphs):

- `src/modes/interactive/interactive-mode.test.ts`: a complete read-file run at 80x24 and 40x24 (startup, input, tool running, finish, `Ctrl+O` expand, exit summary) → `run-*.txt`; approvals, cache notices and more.
- `src/modes/interactive/interactive-frames.test.ts`: startup headers (`startup-normal-*`, `header-quiet-*`; logo variants and the animation in `startup-logo.test.ts` / `startup-logo-*`), tool hierarchy (`tools-*`), notices (`notices-*`), running verbs (`loader-verbs-*`), the `/session` panel (`panel-session-*`), a whole run in ASCII mode (`ascii-run-*`).
- Wave 5 (W5-U): `plan-dialog.test.ts` (`plan-dialog-*`: four options, execution mode, feedback, external editor, ASCII, 40 columns), `approval-origin.test.ts` (`approval-origin-*`, `approval-task-agent-*`, `approval-first-run-*`, `approval-task-external-*` and the first-run merge), `subagent-view.test.ts` (`subagent-view-*`), `tasks-panel.test.ts` (`tasks-picker-*`, `tasks-output-*`, `agents-panel-*`), `harness-notices.test.ts` (`harness-notices-*`), `interactive-w5.test.ts` (plan → approval → execution, `/plan`, background tasks into `/tasks`, Ctrl+V; `interactive-plan-*`, `interactive-tasks-*`).
- `src/tui/tui-frames.test.ts`: component level (conversation, Markdown, editor placeholder / multi-line / paste / completion); `status-widths.txt` of `status-bar.test.ts`; approvals and mode pickers in `approval-dialog.test.ts` and `pickers.test.ts`.

After interface changes, update with `AMA_UPDATE_GOLDEN=1 pnpm vitest run src/modes/interactive src/tui` and review `git diff test/fixtures/tui` one by one.
