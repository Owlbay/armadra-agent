# Terminal UI

English · [简体中文](../tui.md)

> Translated from the Chinese [docs/tui.md](../tui.md) as of commit `ee89edb`. When the two differ, the Chinese version is
> authoritative. Screens below are illustrative; the exact interface wording follows the interface language
> (`ui.language`, `--lang`, `AMA_LANG`).

How to use interactive mode, plus the API of the terminal component library `@armadra/agent/tui`. The design rationale is in [design.md](../design.md) §12 (Chinese).

Running `ama` directly in a terminal (stdin / stdout both TTYs, `TERM` not `dumb`, no `--no-tui`) enters interactive mode. The interface uses the **main screen** only: the conversation history scrolls into the terminal scrollback without switching to the alternate screen, so `capture-pane` in tmux can read the whole conversation, and it stays on screen after exit.

## Layout

The visual spec (colors, glyphs, screen-by-screen mockups) is in [tui-design.md](../tui-design.md) (Chinese). Hierarchy is expressed by indentation: column 0 holds the user `›`, the tool `⏺` and notice symbols, column 2 the result connector `⎿`, column 4 the tool output; the structure stays readable without colors (`NO_COLOR`, `capture-pane` without `-e`).

```
╭──────────────────────────────────────────────────────────────╮
│ ✻ ama 0.3.0                                                  │   ← startup header (normal)
│                                                              │
│ Model   anthropic/claude-sonnet-4-5 · thinking medium        │
│ Dir     ~/Projects/demo · trusted (trust.json)               │
│ Mode    Accept edits · preset default                        │
│ Loaded  AGENTS.md · 2 Skills                                 │
│                                                              │
│ /help commands · Shift+Tab mode · Ctrl+O expand tool output  │
╰──────────────────────────────────────────────────────────────╯

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
Accept edits     claude-opus-5-5 medium | Ctx 3.0% | proj ⎇ main 5ae9e54 (+12,-3) | $0.26 | 2h24m
```

- **User messages**: start with `›`, continuation lines indented 2 columns; steers while running are marked `↳ steer`, messages queued after this turn `↳ after`, and messages injected by the host (the Armadra canvas) `↳ host` (the `origin` in the session file stays steer / followUp / host).
- **Thinking blocks**: `ui.showThinking` = `collapsed` (default: "thinking…" → "thinking · 1.2k tokens", `Ctrl+O` expands it to an indented body of at most 60 lines) / `full` (always expanded) / `hidden`.
- **Tool calls**: titled `⏺ tool name summary`; `⏺` is the accent color while running, green on success, red on failure. The second line after `⎿` is the result summary: lines read, `N changes · +a −b`, `exit 0 · 2.1s · 48 lines`, matches and files, `N inner calls · M lines of script output`, `sub-agent · running 1m05s` / `done · 1m42s · ↑28k ↓4.1k`; while running the summary line carries a spinner in the same frame as the bottom and the seconds. Bodies show the first 3 lines folded; `edit` shows a diff (first 12 lines, with line numbers at ≥ 60 columns); running `bash` scrolls its last 8 lines. `Ctrl+O` expands / folds everything (thinking blocks included). Inner calls of a codemode script hang under the outer call (folded, only the titles and summaries of the latest 5 are listed).
- **Notices**: `✗` errors, `↻ retry n/m`, `!` warnings (cache misses, remaining context), `⛔` hook blocks, host notifications, explanations of denied or timed-out approvals; compaction / branch summaries are left-bar cards (`▎ context compacted  128k → 24k tokens`).
- **Running**: `⠋ verb · elapsed · …`, with the verb taken from the deepest current state: waiting for confirmation (approval open), `running bash` / `running 3 tools`, `retry 2/3 · in 2s`, compacting context, replying `· ↓≈1.2k` (estimated tokens of this output), thinking.
- **Status bar**: always the last line, with the mode always on the far left. In `compact` the separator is always `·` (embedding hosts parse it), in `full` it is `|`. The layout follows `ui.statusLine`: `full` (two lines) by default in a standalone terminal, `compact` (one line, same layout as before) by default in an embedding host with a profile; `Ctrl+G` or `/statusline [full|compact]` switches at runtime for this session only. With `full` the input box is the 4th line from the bottom (`compact` keeps it 3rd from the bottom).
  - **`full` top line (rate line)**: `tps: <rate> tok/s • <output tokens> tok / <elapsed> (avg <session average> · ttft <time to first token>)`. While streaming the rate is the instantaneous value over the last 2 s (`tps:` in the accent color); afterwards it is the request's average; whole replies generated in under 0.25 s get no rate and show `—`; elapsed time starts at the first token; in ASCII `•` becomes `*`. The right side holds usage items: `↑` input (including cache reads and writes) `↓` output · cache · re-billing · queue count · codemode · tool preset (when not default) · host status, with `[-]` at the end hinting that it folds. Only chat requests count (compaction summaries, warming and the classifier do not). When narrow, these drop in order: output / elapsed, codemode, queue count, tokens, cache, re-billing, preset, host status, avg, ttft; `tps` and `[-]` never drop.
  - **`full` bottom line**: on the left `permission mode | shift+tab to switch`, on the right `model thinking-level | Ctx 3.0% | <dir name> ⎇ <branch> <short commit> (+a,-d) | $cost | session duration` (Ctx with one decimal, no meter even when wide); when narrow, these drop in order: the switch hint, thinking level, line changes, directory name, branch and commit, duration, cost, context, model.
  - **`compact`**: one line; on the right model · thinking level · `↑ ↓` · cache · cost · re-billing · context usage · dir ⎇ branch commit +a −b · session duration · queue count · codemode · preset · host status; when narrow, these drop in order: the switch hint, host status, preset, re-billing, cost, cache, tokens, thinking level, queue count, codemode, line changes, directory name, branch and commit, duration, context, model.
  - **git**: branch and short commit are read directly from `.git/HEAD` (worktrees understood; detached shows only the short commit; outside git the whole part is omitted, leaving only the directory name). `+a −b` is the working tree (staged included) line diff against HEAD, computed in the background with `git diff --numstat HEAD` after a turn ends, a writing tool finishes, a rewind or `/tree`, at most once every 10 seconds; if it takes longer than 2 seconds or fails, line changes are hidden for the rest of the session; `AMA_STATUS_GIT=0` turns it off.
  - **Cost** includes sub-tasks, warming, the classifier and external agent usage priced in USD (other units only in `/session`); **duration** counts from when this process opened the current session (`Ns` / `Nm` / `NhMm`).
  - When bash commands run in the OS sandbox (`sandbox.bash: "auto"` and available on this machine, see [sandbox.md](../sandbox.md), Chinese), the usage items gain a sandbox marker, dropped first together with codemode when space runs out.
  - During a model fallback (`fallbackModel`: when the main model is overloaded or retries are exhausted, one retry with the fallback model) the model item shows `main model → fallback model` (the fallback in yellow); it disappears once the fallback model replies and the main model is restored, and the message area gets an explanatory line.
  - Model names abbreviate with width (provider dropped below 100 columns, channel below 60, version suffix below 48); `compact` at ≥ 110 columns shows context as a meter `ctx ▮▮▮▯▯▯▯▯▯▯ 34%`; changing numbers reserve their widest shape, so items never flicker in and out as values change. In ASCII mode `⎇` → `git`, `−` → `-`, `♨` → `~`.
- **Exit**: a session summary line and the resume command are appended at the end of the message area and stay in the terminal scrollback:

```
─ session 3f2a9c1e · 12 min · 7 turns · ↑128k ↓9.4k · cache 81% · $0.42 (re-billed $0.03)
  resume: ama --resume 3f2a9c1e
```

## Cache and context

Status bar items:

| Item                   | Meaning                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cache 83%`            | Hit rate of the **latest** request (cache read / (input + cache read + cache write)); the session total is in `/session`                         |
| `cache —`              | The endpoint has not reported cache usage yet (`unknown`: no long enough comparable request so far)                                              |
| `cache` "not reported" | The endpoint does not report cache usage (`silent`: reads and writes were 0 for 3 comparable requests in a row, or `compat.cacheReporting: "silent"`); such requests stay out of the hit-rate denominator |
| `♨`                    | Warming timer running (during long tool runs the prefix is replayed per TTL; `/cache warm` switches it)                                         |
| `rebill $0.11`         | Re-billing caused by cache misses in this session; token count for models without prices; hidden when 0                                         |
| `ctx 72%`              | Context usage: green below 70%, yellow at ≥ 70%, red at ≥ 90%; `ctx ?` means the model has no window information                               |
| `codemode only`        | codemode active (`on` / `only`); a red `net!` is appended when the network is not isolated (Node 22 / 24 without an OS sandbox, see sandbox.md) |

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

| Key                  | Effect                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enter                | Send; while running = steer (inserted into the current turn)                                                                                                                |
| Alt+Enter            | While running, queue after this turn (followUp); when idle, same as Enter                                                                                                   |
| Shift+Enter / Ctrl+J | New line                                                                                                                                                                    |
| Esc                  | Interrupt: queued messages go back into the input box, then the current run stops; closes completion first when it is open                                                 |
| Esc Esc (idle)       | Empty input: open the rewind list (same as `/rewind`); with text: clear it and save it into input history                                                                   |
| Alt+↑                | Recall the last queued message                                                                                                                                              |
| Shift+Tab / Tab      | Cycle permission modes Manual → Accept edits → Plan → Auto → Bypass permissions (Tab only on an empty input with completion closed, otherwise still completion; entering Bypass asks to confirm, see "Entering Bypass" below) |
| Ctrl+O               | Expand / fold tool output and thinking blocks                                                                                                                               |
| Ctrl+L / Ctrl+T      | Pick model / thinking level                                                                                                                                                 |
| Ctrl+G               | Bottom info line two lines (full) ↔ one line (compact), this session only                                                                                                   |
| Ctrl+V               | Paste an image from the clipboard: saved in the data directory, `@<path>` inserted at the cursor (same as `/paste`)                                                         |
| Ctrl+C               | Clear the input; on an empty input, press again within 1.5 seconds to quit (exit code 130)                                                                                 |
| Ctrl+D               | Quit on an empty input                                                                                                                                                      |
| Tab                  | Complete                                                                                                                                                                    |
| ↑ / ↓                | Browse history on a single line (`<data dir>/history`, 500 entries)                                                                                                         |
| Ctrl+B / ↓ (empty input) | Enter the agent bar (when there are sub-agent tasks; with text Ctrl+B still moves the cursor left, use ↓ in tmux), see "Sub-agents" (from wave 6 W6-A)                |

Keys can be overridden in `~/.config/ama/keybindings.json`: keys are action ids (`app.interrupt`, `app.rewind`, `app.message.followUp`, `app.statusLine.toggle`, `app.paste.image`, `tui.editor.newLine` …), values are a key or an array of keys, and an empty array disables the action. `app.rewind` is the key double-pressed while idle (Esc by default, at most 800 ms apart).

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
- Pickers have a key hint line at the bottom (`↑↓ select · Enter confirm · Esc cancel`) and a background on the selected row (≥ 256 colors; accent bold with fewer). The `/model` picker checks the current model with `✓` and shows an `(i/n)` count; it groups by "provider · channel" (multi-channel models get one item per channel, non-preferred channels marked `@channel`), and descriptions include context size and `img` (accepts images); `/model packy/kimi-k2.5@messages` switches to a specific channel directly.
- An `@image-path` in the input (quotes allowed, Tab completes the path), or a pasted / dropped image file path, is sent as an image attachment with the message; when the current model does not accept images an `@` attachment is an error and nothing is sent, while paths without `@` are ignored (see [providers.md](providers.md) "Image input").
- `/statusline [full|compact]`: switch the bottom info line (without arguments it toggles, same as `Ctrl+G`), this session only; line mode has no bottom info line.
- `/session`, `/cache`: session usage and cache stats panels (see "Cache and context" above); `/permissions` is a panel too, with allow in green, deny in red and the decision order wrapped and aligned. With sub-agent tasks `/session` gains a "Sub-agents" line (task count and states), and after using external agents an "External agents" section (runs and usage per agent, USD / tokens / requests each in its own unit, never converted).
- `/plan`: the current plan panel (see "Plan approval" below); `/plan <goal>` enters Plan mode and sends the goal; `/plan approve [mode|fresh]` and `/plan reject` approve / discard directly without a dialog.
- `/tasks`: the sub-agent task list; `/agents`: the available sub-agent types (see "Sub-agents" below).
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

| Where                                                      | Keys                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| Approval dialog (including the external agent first-run confirmation) | ↑↓ Enter · 1–3 · y / a / n · Esc deny · v full input   |
| Plan approval box (main options, execution mode)           | ↑↓ Enter · 1–4 / 1–3 · e edit plan · Esc stay in Plan / back      |
| Rewind confirmation panel, second confirmation for overwriting conflicts | ↑↓ Enter · numbers run directly · Esc cancel / back |
| Entering Bypass confirmation                               | ↑↓ Enter · 1–2 · y / n · Esc cancel                               |
| Permission mode and thinking level pickers                 | ↑↓ Enter · numbers pick directly · Esc cancel                     |
| Model, session, tree and task pickers                      | ↑↓ Enter · type to filter · Esc cancel (filterable lists have no number keys) |
| Trusting the directory at startup                          | ↑↓ Enter · 1–4 pick directly · Esc / Ctrl+C = do not trust this time |
| CLI subcommand billing / write confirmations (TTY)         | ↑↓ Enter · 1–2 · y / n · Esc / Ctrl+C cancel (cancel by default)  |

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
  ⎿ done · 0.0s
    ↳ t2 explore · running 40s · 1 turn · read
```

- The status line shows the type (external agents show a runner such as `claude (claude)`), status and elapsed time, turns, the latest 3 tools and usage; after a foreground task ends it is replaced by the result summary. A background task's (`background: true`) tool call returns immediately, with an extra follow-up status line below (refreshed every second while running); when it completes, the `<task-notification>` the model receives shows in the message area as a single line (e.g. "↳ sub-agent notification: t2 explore done · 7 turns · see /tasks for output"), plus a yellow notice on failure or stop.
- `/tasks`: a task picker (newest on top; each line shows task id, type, status, elapsed time, turns, usage, cost, background, description); Enter shows the output (the output so far while running; a full-text file when truncated); running tasks can be stopped. Line mode: `/tasks` lists, `/tasks <id>` shows output, `/tasks stop <id>` stops.
- `/agents`: the available types: name, runner, source (built-in / user / project / profile / host), external agents marked installed with a version or not installed, plus a one-line description.
- Notices reported by external agents themselves (budget exhausted, timeout, mode downgrade …) show in the message area as a single line `[claude · t3] …`.

Origin labels on approval boxes:

| Origin                                                    | Title prefix                                         | Body                                                                          |
| --------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| Tool calls of a task sub-agent                            | `[task:explore]` (`[task]` when the type is unknown) | Same as the main session                                                      |
| Permission requests from external agents (claude / codex / ACP) | `[claude · session abc12345]`                  | The title, kind, paths involved and input summary given by the external agent |
| First run of an external agent in this session            | Title "first run of an external agent"               | An explanation (runs with your login in that CLI) and the mode                |

All three offer only "allow / allow this kind for the session / deny" (for external agents, "allow for the session" is remembered by the agent itself). In Manual mode `task(agent="claude")` would ask twice (once for the task call, once for the first run): the approval box of the task call already says it runs with your login in the claude CLI (including the first-run confirmation for this session), so after allowing it the immediately following first-run confirmation passes automatically, with one line in the message area saying task was allowed along with the previous confirmation; if another approval comes in between, it is denied, more than 60 seconds pass, or the task was not created by this call, the first-run confirmation pops up as usual.

## Traces

(Wave 6 W6-T1: the `/trace` overlay.)

## Memory

(Wave 6 W6-M: `/memory` and the memory panel.)

## Clipboard images

`Ctrl+V` or `/paste` reads an image from the system clipboard (macOS `osascript` / `pngpaste`, Linux `wl-paste` / `xclip`, Windows PowerShell), saves it as `<data dir>/clipboard/<time>.png` and inserts `@<path>` at the cursor in the input box; on send it is handled as an `@image` attachment (resized per `images.resize` when above the current model's per-image limit). When no usable command exists or the clipboard holds no image, a line appears at the bottom and the input box is unchanged. Text still uses the terminal's own paste (Cmd+V / Ctrl+Shift+V). `ama sessions prune` cleans clipboard files older than 7 days.

## Startup screen

`ui.quietStartup` / `--quiet-startup`: `normal` shows a boxed startup header: title, model and thinking level, directory (`~` abbreviated) and trust state, permission mode / preset / codemode, loaded context files / Skills / prompt templates / hooks, warning count and common keys; below 56 columns or with `ui.compact` the box is dropped and each item takes one line. `header` is a single line `✻ ama version · model · mode · /help` (the profile default); `silent` shows nothing. When `--resume` has no id, the model has no key, the session directory does not exist or project resources need trust, a small selection / input prompt appears before the interface starts, collapsing into one line on screen once answered.

## In tmux / Armadra terminal nodes

- Bracketed paste: enabled at startup; pasted multi-line content enters the input box as a whole (folded into a paste placeholder with the line count beyond 10 lines or 1 000 characters), and an Enter right after a paste sends directly, which suits writes from external programs.
- Terminal capabilities are not queried, and mouse and the Kitty keyboard protocol are not enabled, so no replies get mixed into input; tmux ≥ 3.4 passes synchronized output through, and older versions display fine too.
- When the window size changes the last screen is redrawn in full; history in the scrollback is unaffected.
- Automatic fallback: non-TTY, `TERM=dumb`, `--no-tui` or a failed terminal initialization use line mode, with the same commands and approval prompts.

## Configuration and troubleshooting

The `ui` section of `config.json` (settable at project level too):

| Key               | Default       | Effect                                                                                                         |
| ----------------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| `ui.theme`        | `dark`        | `dark` / `light` / `auto`; auto only looks at `COLORFGBG` (no terminal query) and uses dark when unsure; configuring it explicitly is recommended |
| `ui.ascii`        | auto-detected | ASCII glyphs (`›` → `>`, `⏺` → `*`, `⎿` → `L`, box lines → `+ - \|`, a 4-frame spinner)                        |
| `ui.compact`      | `false`       | No blank lines between message blocks, no box around the startup header                                        |
| `ui.animation`    | `true`        | `false`: the spinner stays still as `·` while running and redraws only when seconds change                     |
| `ui.markdown`     | `true`        | `false`: assistant text is not rendered as Markdown                                                            |
| `ui.showThinking` | `collapsed`   | See "Layout"                                                                                                   |
| `ui.quietStartup` | `normal`      | See "Startup screen"                                                                                           |

- **ASCII mode**: `AMA_ASCII=1` (or `ui.ascii: true`) forces it on, `AMA_ASCII=0` forces it off; auto-detection turns it on when the locale (`LC_ALL` > `LC_CTYPE` > `LANG`) is set but lacks UTF-8, with `TERM=linux`, or on Windows without `WT_SESSION` or `TERM_PROGRAM` (legacy conhost). Windows Terminal uses Unicode.
- **Misaligned characters**: `⏺` (U+23FA), `⎿` and `▎` render two cells wide in some fonts (emoji fallback fonts in particular), while width is computed per wcwidth (one cell), causing misaligned columns or ghosting; switch to a monospace font or set `AMA_ASCII=1`.
- **Colors**: no color with `NO_COLOR` or `TERM=dumb`; 16-color terminals take the nearest color from a built-in table and mark the selected row with accent bold instead of a background; on light terminals set `ui.theme: "light"`.

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

| Export                                                                    | Purpose                                                                                                                                                         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Component`, `Focusable`, `CURSOR_MARKER`                                 | The component contract: `render(width)` returns lines (each with visible width ≤ width), `handleInput?(data)`, `invalidate()`; the focused component emits `CURSOR_MARKER` at the cursor |
| `TUI`                                                                     | Root container and differential rendering (main screen, synchronized output): `addChild`, `start` / `stop`, `requestRender`, `setFocus`, `addInputListener`, `showOverlay` |
| `ProcessTerminal`, `MemoryTerminal`, `VirtualScreen`                      | A real terminal (raw mode, bracketed paste); an in-memory terminal and a VT screen (tests, frame goldens)                                                       |
| `Container`, `Text`, `TruncatedText`, `Markdown`, `Box`, `Card`, `Spacer` | Basic components; `Card` is a left-bar card, `Box` accepts `borderColor`                                                                                        |
| `Loader`                                                                  | Running indicator: `setVerb(verb, extras, { elapsed })`, `frame` / `onFrame` (changes glyph in the same frame as other components), `animation: false`         |
| `Editor`, `EditorBuffer`, `PasteStore`                                    | Multi-line editor (history, the `AutocompleteProvider` completion interface, paste folding)                                                                     |
| `SelectList`                                                              | Filterable selection list: groups, badges, number keys, `stacked`, `currentValue` (✓), `footer` key hints                                                       |
| `KeyValue`, `Meter`                                                       | Two-column aligned key-value table (`wrap` wraps aligned to the value column); a meter (`levelColor` threshold coloring)                                        |
| `compositeOverlays`, `OverlayOptions`                                     | Overlay compositing (centered / bottom-anchored)                                                                                                                |
| `createTheme`, `plainTheme`, `detectCapabilities`, `Theme`                | Themes and color capability detection (`NO_COLOR`, 16 / 256 / truecolor); 14 semantic colors, `resolveThemeName("auto")`                                        |
| `Theme.glyphs`, `UNICODE_GLYPHS`, `ASCII_GLYPHS`, `detectAscii`           | Glyph tables (`›` `⏺` `⎿` `✻` `▎`, box lines, spinner frames …) with ASCII fallback; `createTheme(name, { ascii })`                                            |
| `Keybindings`, `DEFAULT_KEYBINDINGS`, `loadKeybindingsFile`               | Action id → keys, overridden by `keybindings.json`                                                                                                              |
| `parseKey`, `matchesKey`, `StdinBuffer`                                   | Key sequence parsing and Esc timeout splitting (`AMA_TUI_ESC_TIMEOUT`)                                                                                          |
| `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `sliceByColumn` …  | Width computation and truncation aware of ANSI and wide characters                                                                                              |

## Testing

Frame goldens all live in `test/fixtures/tui/`; `MemoryTerminal` reconstructs the screen (without color, verifying only layout and glyphs):

- `src/modes/interactive/interactive-mode.test.ts`: a complete read-file run at 80x24 and 40x24 (startup, input, tool running, finish, `Ctrl+O` expand, exit summary) → `run-*.txt`; approvals, cache notices and more.
- `src/modes/interactive/interactive-frames.test.ts`: startup headers (`startup-normal-*`, `header-quiet-*`), tool hierarchy (`tools-*`), notices (`notices-*`), running verbs (`loader-verbs-*`), the `/session` panel (`panel-session-*`), a whole run in ASCII mode (`ascii-run-*`).
- Wave 5 (W5-U): `plan-dialog.test.ts` (`plan-dialog-*`: four options, execution mode, feedback, external editor, ASCII, 40 columns), `approval-origin.test.ts` (`approval-origin-*`, `approval-task-agent-*`, `approval-first-run-*`, `approval-task-external-*` and the first-run merge), `subagent-view.test.ts` (`subagent-view-*`), `tasks-panel.test.ts` (`tasks-picker-*`, `tasks-output-*`, `agents-panel-*`), `harness-notices.test.ts` (`harness-notices-*`), `interactive-w5.test.ts` (plan → approval → execution, `/plan`, background tasks into `/tasks`, Ctrl+V; `interactive-plan-*`, `interactive-tasks-*`).
- `src/tui/tui-frames.test.ts`: component level (conversation, Markdown, editor placeholder / multi-line / paste / completion); `status-widths.txt` of `status-bar.test.ts`; approvals and mode pickers in `approval-dialog.test.ts` and `pickers.test.ts`.

After interface changes, update with `AMA_UPDATE_GOLDEN=1 pnpm vitest run src/modes/interactive src/tui` and review `git diff test/fixtures/tui` one by one.
