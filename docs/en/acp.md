# ACP (Agent Client Protocol)

English · [简体中文](../acp.md)

> Translated from the Chinese [docs/acp.md](../acp.md) as of commit `bd37706`. When the two differ, the Chinese version is
> authoritative.

ama works on both sides of ACP:

- **Agent**: `ama --mode acp` exposes ama as an ACP agent for Zed, JetBrains and Armadra's ACP nodes;
- **Client**: ama drives external agents over ACP (native ACP agents such as Gemini CLI, OpenCode, Kimi and Copilot, or Claude Code / Codex with an adapter installed); see [agents.md](../agents.md) (Chinese).

The protocol stack is hand-written with no dependencies and maintained in one place: `@armadra/agent/acp` exports the types, framing, client and fake agent, and Armadra reuses them directly. The design rationale is in [wave5-plan.md](../wave5-plan.md) §5 (D14, Chinese).

## Wire

JSON-RPC 2.0 over NDJSON (stdio): lines are split on `\n` only, large lines are written in 64 KiB chunks with backpressure, the same as the "Wire" section of [rpc.md](rpc.md). stdout carries protocol lines only; diagnostics go to stderr. The client starts with `initialize`; there is no `hello`.

## `ama --mode acp`

```sh
ama --mode acp                      # excludes -p; other flags (--model, --profile, --trust, …) work as usual
```

| Method                      | What ama does                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize`                | `protocolVersion: 1`; `loadSession: true`, `sessionCapabilities: { list, resume, close }`, `promptCapabilities: { image: true, embeddedContext: true }`; with a model, `authMethods` is empty (without one, see "Without a model" below)                                                                           |
| `authenticate`              | -32602: ama only offers terminal auth methods, which the spec says are not passed to `authenticate` (the same with or without a model)                                                                                                                                                                             |
| `session/new`               | Opens a session (the first one claims the empty session created at start-up); also allowed while a turn runs; `cwd` must be ama's start directory (compared by realpath), otherwise invalid params                                                                                                                 |
| `session/load`              | Opens the session and replays its history as `session/update` (user messages, replies, thinking, tool calls); a session that is already open is replayed from memory                                                                                                                                               |
| `session/resume`            | Opens the session without replay                                                                                                                                                                                                                                                                                   |
| `session/list`              | Sessions of the start directory: a different `cwd` gives an empty list; 50 per page (newest `updatedAt` first) with `nextCursor`, an invalid `cursor` is invalid params; the title is the session name or the first prompt (first line after removing embedded resource blocks, ≤ 80 characters)                   |
| `session/close`             | Interrupts the session's run (its queued prompts answer `cancelled`), releases it and removes it from this connection; later requests for that id answer -32002 — open it again with `session/load` / `session/resume` first                                                                                       |
| `session/prompt`            | Text and images are accepted; `resource_link` is passed as `@uri` text, embedded resources contribute their text. Queued while another session runs; an id that is not open answers -32002. End of turn: interrupted → `cancelled`, output truncated → `max_tokens`, refusal → `refusal`, failure → JSON-RPC error |
| `session/cancel` (notif.)   | Running → interrupted; queued → answers `cancelled` at once                                                                                                                                                                                                                                                        |
| `$/cancel_request` (notif.) | Withdraws a pending `session/prompt`: same as `session/cancel`, and that request answers -32800. For the other direction see "Approvals"                                                                                                                                                                           |
| `session/set_mode`          | Mode ids are ama's permission modes (`plan`, `allowlist`, `default`, `auto-edit`, `auto`, `full-auto`); kept per session, see "Multiple sessions" below                                                                                                                                                            |
| `session/set_config_option` | Changes a session config option; the answer is the new state of all options; see "Config options and commands" below                                                                                                                                                                                               |

`mcpServers` and `additionalDirectories` of `session/new` / `load` / `resume` have no effect: when non-empty, one line goes to stderr and the session opens as usual (reasons under "Deviations and non-goals"). Methods ama does not implement (`session/delete`, `logout`, …) answer -32601.

### Multiple sessions

One `ama --mode acp` process can keep several sessions open (Zed's threads share one connection):

- Every open session stays in memory; an empty session that never received a message can be switched away from and back to (empty sessions are not written to disk).
- **One turn runs at a time**: while another session runs, `session/prompt` goes into a FIFO queue and starts when the previous turn ends; it no longer fails busy. `session/new`, `load`, `resume`, `list`, `set_mode`, `set_config_option` and `close` can be called at any time.
- When a turn starts, its session becomes the "foreground" session: the host (`HostApi.session.*`), the common fields of hooks and the session seen by tools all switch to it, and "allowed for this session" grants are cleared (switching back means allowing again, as with `/resume` in the TUI).
- Permission modes are kept per session: `set_mode` on the foreground session applies at once; on another session it is only recorded (a `current_mode_update` is still sent) and applied to the permission pipeline when that session's turn starts, with another `current_mode_update`. So changing the mode of a queued session does not affect the one that is running.
- After every turn a `session_info_update` is sent (`updatedAt`; `title` only when it changed).
- Closing a session releases only that session (running the SessionEnd hook); when stdin closes, queued prompts answer `cancelled`, the running turn is allowed to finish, then all sessions are released in turn.

### Event mapping

| ama                                         | `session/update`                                                                                                                                                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text delta / thinking delta                 | `agent_message_chunk` / `agent_thought_chunk`                                                                                                                                                                                                                              |
| The model emits a tool call                 | `tool_call` (`pending`, with `name`, `rawInput`, `kind`, `locations`)                                                                                                                                                                                                      |
| A call inside a codemode script starts      | `tool_call` (`pending`, `title` prefixed `codemode › `, `_meta.ama.parentToolCallId` pointing at the outer `codemode` call), then `in_progress`                                                                                                                            |
| Tool starts                                 | `tool_call_update` (`in_progress`)                                                                                                                                                                                                                                         |
| Tool ends (inner calls included)            | `tool_call_update` (`completed` / `failed`); `content` is `[diff?, text]`: edit / write carry a `diff` (`path`, `oldText`, `newText`; `oldText: null` for a new file), the text is limited to the first 4 KB; `locations[].line` is the first changed line; no `rawOutput` |
| `todo` update                               | `plan`                                                                                                                                                                                                                                                                     |
| End of each turn                            | `usage_update` (context used, window size, session cost in USD)                                                                                                                                                                                                            |
| Permission mode change                      | `current_mode_update`                                                                                                                                                                                                                                                      |
| Model / thinking level change               | `config_option_update` (all options)                                                                                                                                                                                                                                       |
| After a session opens (new / load / resume) | `available_commands_update` and `config_option_update`                                                                                                                                                                                                                     |
| After a turn                                | `session_info_update` (`updatedAt`; `title` only when it differs from the last one)                                                                                                                                                                                        |

The full before / after text of a diff only travels with live events and is never written to the session file: above 256 KiB on either side there is no diff, and tool results replayed by `session/load` carry only their first 4 KB of text. The `name` of each mode is its display name (such as `Manual` or `Accept edits`); the `description` follows the UI language. The `session/prompt` result carries the turn's token usage `usage` (`inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedWriteTokens`, `totalTokens`); in schema 1.24.1 this field is still UNSTABLE (only in the unstable schema), so clients may ignore it and rely on `usage_update`.

### Approvals

Calls that ama needs to ask about go to the client as `session/request_permission` with three options: `allow_once` (Allow), `allow_always` (Allow for this session) and `reject_once` (Deny). `toolCall.toolCallId` refers to the id of an earlier `tool_call` — including calls inside codemode, which point at the inner `tool_call`, not the outer `codemode` one. While the question is open the call goes back to `pending`, then `in_progress` once allowed (so an approved call goes `pending → in_progress → pending → in_progress → completed`); a denied call goes straight to `failed`. When the client answers `cancelled`, the connection drops or the turn is interrupted, it counts as unanswered (denied). When ama no longer needs an answer (the turn was interrupted by `session/cancel` / `$/cancel_request`, or the 10-minute approval timeout passed), it withdraws the pending `session/request_permission` with `$/cancel_request { requestId }` so the client can close its dialog. In auto mode ama's own classifier still works — this only applies to ama's own tools; requests from external agents that ama drives go to a human only (see [agents.md](../agents.md), Chinese).

### Without a model

When no model is available (no key, no `--model`, `config.defaultModel` unusable), `ama --mode acp` no longer exits with code 4; it completes the handshake and waits for the user to sign in:

| Request                       | Behavior without a model                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`                  | Answered as usual; when the client declares `clientCapabilities.auth.terminal`, `authMethods` has the two terminal methods, otherwise it is empty                                                                                                                                                                                                                                                        |
| Session methods (`session/*`) | Start-up is retried first (at least 1 s after the last failure; concurrent requests share one retry): on success the same connection is handed to the normal server for this and later requests (no new `initialize`); still no model → `-32000` whose `message` is the no-model guidance (key environment variables and `ama auth set`) and whose `data.authMethods` are the ids of the offered methods |
| `authenticate`                | `-32602`: per the spec, terminal methods are not passed to `authenticate`                                                                                                                                                                                                                                                                                                                                |
| Anything else                 | `-32601`; notifications before the handover are ignored                                                                                                                                                                                                                                                                                                                                                  |

The two terminal methods. Per the spec, the client **appends** `args` to the configured agent command and runs it in a terminal (for example `ama --mode acp --acp-terminal-auth api-key`); when ama sees `--acp-terminal-auth` it ignores the other start-up arguments (`--mode acp`, `--model`, …) and runs the matching `auth` subcommand, still honouring `--auth-file` and `--lang` from the same command:

| id        | `args`                        | Same as                  | What it does                                                                                                                        |
| --------- | ----------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `chatgpt` | `--acp-terminal-auth chatgpt` | `ama auth login chatgpt` | ChatGPT subscription login (browser OAuth)                                                                                          |
| `api-key` | `--acp-terminal-auth api-key` | `ama auth set`           | Pick a built-in provider that needs a key with the arrow keys, then paste the key (not echoed; written to auth.json with mode 0600) |

When `--auth-file` (or a profile's `authFile`) was given at start-up, both methods append `--auth-file <absolute path>`, so the login writes the file ama reads. After signing in, the client just opens a session again; ama does not need a restart. Closing stdin exits 0 (after a handover, as in "Exit" below). A failed retry stops at model resolution: no host is loaded and no SessionStart hook runs.

Zed configuration (`settings.json`):

```json
{
  "agent_servers": {
    "ama": {
      "type": "custom",
      "command": "ama",
      "args": ["--mode", "acp"],
      "env": {}
    }
  }
}
```

Without a model, opening an ama thread in Zed asks you to sign in; pick a method and Zed runs the login flow above in its terminal, then retries opening the session once it exits successfully. You can also run `ama auth set` / `ama auth login chatgpt` in any terminal beforehand, or put a key environment variable in `env`.

### Config options and commands

Session-open answers (new / load / resume) carry `configOptions`, followed by an `available_commands_update`:

| Option id  | category        | Values                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`    | `model`         | Grouped by provider, values `provider/model-id` (channel rows of multi-channel providers carry `@channel`); the same view as "configured" in the TUI `/model` picker: only providers with a key, an OAuth login or local ones, only the list in `models.enabled` when set, the test provider `fake` hidden by default; the current model is always listed. Providers without a key are not listed — run `ama auth set` first |
| `thinking` | `thought_level` | The thinking levels the current model supports (`off`…`xhigh`; non-reasoning models only have `off`)                                                                                                                                                                                                                                                                                                                         |

- No option of category `mode`: modes only go through `modes` / `session/set_mode`, so clients do not show two mode switches. There are no boolean options.
- `session/set_config_option`: `model` switches the model, `thinking` changes the thinking level, and the answer is the new state of all options; unknown ids, unknown models and unknown levels answer invalid params (-32602). When the model or level changes during a session (including automatic switches in the plan flow), `config_option_update` is sent.
- Command list: skills are listed as `skill:<name>`, prompt templates as `<name>` (the frontmatter `argument-hint` becomes `input.hint`). Both already expand in prompt text (`/skill:<name> …`, `/<name> …`). Built-in slash commands such as `/new` and `/compact` do not run under ACP and are not listed.

### Exit

After stdin closes, ama waits for the run in progress to finish, then exits (0); from the first start-up step the stdout of the `ama` process carries only the protocol (`console.log` while hosts / hooks load is redirected to stderr); after SIGINT / SIGTERM it exits 130 / 143. Hosts see the mode as `rpc` (`HostApi.mode`). When the SDK calls `bootstrap(--mode acp)` directly it gets a Runtime with `mode: "rpc"` and hands it to `runAcpMode`.

## Deviations and non-goals

These are deliberate choices, not omissions:

| Item                                                         | What ama does and why                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The client's `fs/*` and `terminal/*`                         | Not used (even when the client declares them). ama reads and writes files and runs commands itself, all through its own permission pipeline, sandbox and checkpoints; borrowing the client's file system or terminal would bypass them and make TUI / RPC / ACP behave differently.                                                                                                                                                                                   |
| MCP (`mcpServers`, including stdio, which the spec requires) | Not connected; `mcpCapabilities.http` / `sse` are false; a non-empty `mcpServers` gets one stderr line and the session opens as usual. **This deviates from the spec's MUST "agents must support stdio MCP"**: ama's tools come only from itself and the host (profile), and extensions are skills; MCP would put external tool descriptions into the request prefix, breaking the byte-stable prompt cache, and bypass how the permission pipeline classifies tools. |
| elicitation (the agent asking a human for structured input)  | As an agent, ama never sends `elicitation/create`: the only thing it needs a human to decide is approvals, which go through `session/request_permission`. As a client it is supported (see below).                                                                                                                                                                                                                                                                    |
| `session/delete`                                             | Not implemented (-32601). Clean up session files with `ama sessions prune`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `logout`                                                     | Not implemented, and `agentCapabilities.auth.logout` is not declared (-32601). Sign out with `ama auth logout chatgpt` / `ama auth remove <provider>`.                                                                                                                                                                                                                                                                                                                |
| Session `cwd`                                                | Fixed to ama's start directory: `session/new` with another directory answers -32602 and `additionalDirectories` is ignored. Trust, project config, the session directory and the sandbox are all decided by the start directory, and changing directories inside one process would invalidate them. To work in another directory, start another `ama --mode acp` there.                                                                                               |

## As a client

The model uses ACP agents through `task(agent="acp:<program>")` (ama itself is `task(agent="acp:ama")`; see "Using them in task" in [agents.md](../agents.md), Chinese).

`AcpClient` (`@armadra/agent/acp`): `initialize`, `newSession`, `resumeSession` (preferred, no replay), `loadSession`, `listSessions`, `closeSession`, `prompt`, `setMode`, `cancel`.

- Declared client capabilities: `session.configOptions: {}` (select options; boolean is not declared); `fs` / `terminal` are not declared (`fs/*` and `terminal/*` requests from the agent answer method not found), and neither is `auth.terminal` (ama has no interactive terminal to lend to the agent).
- `$/cancel_request` is on in both directions: aborting the `signal` of a request after it was sent tells the agent to withdraw it; when the agent withdraws a pending `session/request_permission` / `elicitation/create`, the handler's `signal` aborts and the answer is `cancelled` / `cancel` (a choice the handler makes afterwards does not count).
- `session/request_permission` goes to `onPermission`; without a handler the first `reject_once` is answered (unattended).
- `cancel(sessionId)` sends `session/cancel` and answers `cancelled` to that session's pending permission requests (required by the spec).
- Only `optionId`s offered by the agent itself are accepted.
- `mcpServers` of session-open calls (`newSession` / `resumeSession` / `loadSession`) defaults to an empty array; a host can pass a third argument `{ mcpServers }` (for stdio, `{ name, command, args, env: [{ name, value }] }`), which is forwarded to the agent as is. `AcpClient.features.mcpServers === true` signals support (older versions have no `features`). ama itself, as a client, still passes none.
- `elicitation/create` (the agent asking a human for structured input): only when the constructor is given `onElicitation(params, signal)` does `initialize` declare `clientCapabilities.elicitation` and accept this request; otherwise it is not declared and the request answers method not found (as in older versions). Answers are normalized to `{ action: "accept" | "decline" | "cancel", content? }` (`content` only with accept; unknown actions count as cancel); pending ones answer `{ action: "cancel" }` on `cancel(sessionId)` and when the connection closes. ama itself, as a client, gives no handler and never fills in forms for a human.
- Session config options: the `configOptions` of session-open answers (new / load / resume) are passed through; `setConfigOption(sessionId, configId, value)` sends `session/set_config_option`, and the answer is the new state of all options.
- `AcpClient.features`: `{ mcpServers, elicitation, configOptions }`, for feature detection by hosts.

`AcpDriver` implements the driver contract (`AgentDriver`) on top of the client:

- Continuing prefers `session/resume`, then `session/load` (the replayed history is discarded); if neither is supported a new session is opened with a notice.
- `session/set_mode` follows ama's mode; when the agent gives no `modes`, it falls back to a select option of category `mode` in `configOptions`, finds the value with the same mapping and sets it with `session/set_config_option`. When neither has a matching mode: read-only modes refuse to start, other modes use the agent's default mode with a notice.
- When opening a session answers -32000 (sign-in required), it reports `agent_auth_required`, listing the auth methods from `initialize`; terminal ones include the command to run in a terminal (the agent program + its arguments + the method's `args`). ama does not sign in for you.
- When the agent answers `session/prompt` with -32800 (request withdrawn) after a cancel, the turn counts as `cancelled`; without a cancel it is an error as usual.
- The `path` of `diff` tool content joins the call's `locations` and counts in `filesTouched` once the call completes (whatever tool kind the agent reports).

## Test double

`runFakeAcpAgent(input, output, options?)` is an in-process fake ACP agent and `fakeAcpAgentPath()` its executable entry (`node <path> [flags]`). Its behavior follows markers in the prompt and start-up flags; any other prompt answers `echo: <text>`:

| Marker / flag                                           | Behavior                                                                                                                                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[permission]`                                          | Requests permission (four options)                                                                                                                                                             |
| `[slow]`                                                | Waits until `session/cancel`                                                                                                                                                                   |
| `[plan]` / `[think]` / `[refuse]`                       | Sends a `plan` (two entries) first / sends `agent_thought_chunk` first / ends with `refusal`                                                                                                   |
| `[elicit]`                                              | Sends `elicitation/create`; answers `elicit: unsupported` when the client did not declare the capability                                                                                       |
| `[model]` / `[env NAME]`                                | Answers `model <current model>` / `env NAME <sha256 of the value, or absent>` (the value is never echoed)                                                                                      |
| `--minimal` (`{ minimal: true }`)                       | Declares no resume / load / list / close and gives no modes, for testing fallbacks                                                                                                             |
| `--config-options` (`{ configOptions: true }`)          | Session-open answers carry a `model` config option (grouped options) and `session/set_config_option` is accepted                                                                               |
| `--config-only` (`{ configOnly: true }`)                | Session-open answers give no `modes` but a select option of category `mode` (id `mode`) in `configOptions`, switched with `session/set_config_option`; can be combined with `--config-options` |
| `--auth-required` (`{ authRequired: true }`)            | `initialize` offers one terminal auth method (id `login`); `session/new` / `load` / `resume` always answer -32000                                                                              |
| `[cancel-request]` (`{ cancelRequestMs }`, default 2 s) | Requests permission, and once the wait expires the agent withdraws it with `$/cancel_request`; the tool call fails and the turn answers `permission withdrawn` and `end_turn`                  |

Both sides of the fake agent's wire have `$/cancel_request` on. In the repository, `test/helpers/acp-schema.ts` validates every wire line against the official v1 schema (1.24.1, `test/fixtures/acp/schema-v1.24.1.json`): `assertAcpWire(wire)`.

The golden recordings are in `test/fixtures/acp/`: `driver-{allow,reject,cancel}.jsonl` (three paths of ama driving the fake agent) and `mode-prompt.jsonl` (one round trip of `ama --mode acp`). `UPDATE_GOLDEN=1` rewrites them.

## Compatibility

Implemented against the official ACP v1 schema **1.24.1** (the stable part, including `session/list`, `session/resume`, `session/close`, `$/cancel_request`, `usage_update`, `session_info_update`, `config_option_update` and terminal auth methods); the schema ships with the repository as `test/fixtures/acp/schema-v1.24.1.json`, and every wire line in the tests and golden recordings is validated against it. The only unstable field in use is `usage` in the `session/prompt` result (see "Event mapping"). v2 plans to drop `session/load`; as a client ama already prefers `resume`.
