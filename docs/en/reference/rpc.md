# RPC protocol (stdio JSONL)

English · [简体中文](../../reference/rpc.md)

> Translated from the Chinese [docs/reference/rpc.md](../../reference/rpc.md) as of commit `a567833`. When the two differ, the Chinese version is
> authoritative.

`ama --mode rpc` reads commands from stdin and writes responses and events to stdout, one JSON value per line. The types are defined in `@armadra/agent/rpc` (`src/rpc.ts`) and implemented in `src/modes/rpc/`. The events printed by `ama -p --output-format stream-json` have the same shapes. The design rationale is in [design.md](../../design/design.md) §13.2 (Chinese).

## Wire

- Reading: lines are split on `\n` only (a trailing `\r` is removed, empty lines are skipped), never on U+2028 / U+2029; multi-byte UTF-8 is reassembled across chunks; when stdin ends, a final segment without a newline still counts as a line.
- Writing: each line is one `JSON.stringify` result, with U+2028 / U+2029 escaped as `\u2028` / `\u2029`, `Error` serialized as `{ name, message }`, bigint as a string, and image base64 never truncated. Large lines are written in 64 KiB pieces honoring backpressure, and lines never interleave.
- stdout carries protocol lines only; logs and the human-readable copy of host notifications go to stderr.

## Handshake

On startup the server first sends `hello`, then the current session's `session_start`:

```json
{"type":"hello","protocolVersion":1,"agent":"ama","version":"0.1.0","capabilities":["approvals","images","hooks","plans","compact_events"]}
{"type":"session_start","sessionId":"…","cwd":"/work","reason":"startup"}
```

`protocolVersion` is `RPC_PROTOCOL_VERSION` (currently 1). `capabilities` lists what the server supports; a client that wants to handle approvals declares so with `set_client_capabilities` (see "Approvals").

## Commands and responses

A command has the shape `{ "id"?: string, "type": <command name>, ...parameters }`. Responses:

```json
{ "id": "1", "type": "response", "command": "prompt", "success": true, "data": { "disposition": "started" } }
{ "id": "2", "type": "response", "command": "set_model", "success": false, "error": "…", "code": "model_not_found" }
```

- A response carries the request's `id` back (only string ids). Commands are processed concurrently: `prompt` does not block later commands, so responses may arrive in a different order than requests; match them by `id`.
- On failure `error` is human-readable text and `code` is the `AmaError.code` (when there is one). Unknown commands → `code: "invalid_arguments"`.
  **Hosts must decide by `code` and never parse `error` / `message`**: human-readable text follows the interface language (`AMA_LANG`, `--lang`, `ui.language`; bilingual since wave 6, see [i18n.md](../../guides/i18n.md), Chinese). The same holds for the `message` of `notification` events.
- A line that is not valid JSON or lacks `type` → `{ "type": "response", "command": "parse", "success": false, "error": … }`, without `id`.
- Commands that need extension methods of the session implementation (marked † below) return `code: "not_implemented"` on sessions that are not `AgentSessionImpl`; sessions created by the CLI and the SDK are all `AgentSessionImpl`.

### Prompts

| Command       | Parameters                                                                                                     | `data`                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `prompt`      | `message: string`, `images?: ImageBlock[]`, `streamingBehavior?: "steer" \| "followUp"`, `interrupt?: boolean` | `{ disposition: "started" \| "queued" \| "handled" }`           |
| `steer`       | `message`, `images?`, `interrupt?: boolean`                                                                    | Same as above                                                   |
| `follow_up`   | `message`, `images?`                                                                                           | Same as above                                                   |
| `abort`       | —                                                                                                              | `{}` (answered once idle again; the queue is not cleared)       |
| `clear_queue` | —                                                                                                              | `{ steering: string[], followUp: string[] }` (the cleared text) |

Prompt commands **do not wait for the run to finish**: they are answered as soon as the session starts running (`before_agent_start` / `agent_start`), or the message is queued or handled (for example a slash command, or a hook block); progress arrives as events. Sending `prompt` while running without `streamingBehavior` fails with `code: "busy"`; with `steer` / `followUp` it is queued. Run failures after the response are reported as `{"type":"notification","level":"error","message":…}`.

**Interrupt and send now**: with `interrupt: true` on `prompt` / `steer` (it takes precedence over `streamingBehavior`), a running session first takes the queued steers, stops the current turn (the model stream is cut, running tools finish as interrupted so every tool call has exactly one `aborted by user` result, and the interrupted assistant message is persisted with `stopReason: "aborted"`), then immediately starts a new turn with "queued steers… + this message" (joined by blank lines) and answers `{ disposition: "started" }`; the new user message has `origin: "interrupt"`. followUp messages stay queued and are delivered after the new turn; background sub-agents are not affected. When idle it is the same as leaving it out. A non-boolean `interrupt` → `invalid_arguments`; running with both the message and the queued steers empty → `invalid_arguments` (nothing is interrupted). Event order: `queue_update` (steers taken) → the old turn's `message_end` (aborted) → `agent_settled` → `agent_start` → the response → the new user `message_end` … (golden record `test/fixtures/rpc/interrupt.out.jsonl`). The new request starts with every message of the interrupted request, so the cache keeps hitting. In the SDK: `session.prompt(text, { interrupt: true })` / `session.steer(text, { interrupt: true })`.

### State

| Command                   | Parameters | `data`                                                      |
| ------------------------- | ---------- | ----------------------------------------------------------- |
| `get_state`               | —          | `SessionState` (below)                                      |
| `get_messages`            | —          | `{ messages: AgentMessage[] }` (projected context messages) |
| `get_last_assistant_text` | —          | `{ text: string \| null }`                                  |
| `get_session_stats`       | —          | `SessionStats` (see "Session stats")                        |

`SessionState`: `isStreaming`, `isCompacting`, `isRetrying`, `model` (`{ provider, id, channel? }` or absent; `channel` appears only for multi-channel providers), `thinkingLevel`, `permissionMode`, `sessionId`, `sessionFile`, `cwd`, `sessionName`, `messageCount`, `pendingMessageCount`, `steeringMode`, `followUpMode`, `autoCompaction`, `autoRetry`.

### Models

| Command                         | Parameters                                                | `data`                                                                                |
| ------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `set_model`                     | `provider: string`, `modelId: string`, `channel?: string` | `{ model: { provider, id, channel? } }`                                               |
| `get_available_models`          | —                                                         | `{ models: RpcModelInfo[] }`                                                          |
| `set_thinking_level`            | `level: off \| minimal \| low \| medium \| high \| xhigh` | `{ level }`                                                                           |
| `get_available_thinking_levels` | —                                                         | `{ levels: string[] }` (levels the current model supports; `["off"]` without a model) |

`RpcModelInfo`: `provider`, `id`, `name`, `hasKey`, `keySource` (`cli` / `auth-file` / `config` / `env` / `oauth` / `none`; `oauth` is the wave 6 ChatGPT login), `contextWindow?`, `maxTokens`, `reasoning`, `input` (`"text"` / `"image"`). **Keys never leave the process**: only whether there is one and where it comes from are reported.

### Queue, compaction, retry

| Command                 | Parameters                       | `data`                                                                                      |
| ----------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| `set_steering_mode` †   | `mode: "one-at-a-time" \| "all"` | `{ mode }`                                                                                  |
| `set_follow_up_mode` †  | `mode`                           | `{ mode }`                                                                                  |
| `compact`               | `customInstructions?: string`    | `CompactionResult`: `summary`, `firstKeptEntryId`, `tokensBefore`, `tokensAfter?`, `usage?` |
| `set_auto_compaction` † | `enabled: boolean`               | `{ enabled }`                                                                               |
| `set_auto_retry` †      | `enabled: boolean`               | `{ enabled }`                                                                               |
| `abort_retry`           | —                                | `{ aborted: boolean }` (interrupts the run while waiting to retry)                          |

### Sessions

| Command               | Parameters               | `data`                                                                                          |
| --------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| `new_session`         | `parentSession?: string` | `{ sessionId, sessionFile }`                                                                    |
| `switch_session`      | `sessionPath: string`    | Same as above                                                                                   |
| `fork`                | `entryId: string`        | Same as above (copies a new session file up to before that entry)                               |
| `get_entries` †       | `since?: string`         | `{ entries: SessionEntry[], leafId: string \| null }`; `since` is an entry id cursor, exclusive |
| `get_tree` †          | —                        | `{ tree: SessionTreeNode[] }` (`{ entry, children, label? }`)                                   |
| `set_session_name` †  | `name: string`           | `{ name }`                                                                                      |
| `get_fork_messages` † | —                        | `{ messages: { entryId, text }[] }` (user messages on the active branch, candidates for `fork`) |

### Rewind

Details in [rewind-plan.md](../../history/rewind-plan.md) §3 (Chinese). Rewind points are the user messages on the active path that start new turns (steers and queued messages belong to the current turn and are not listed). Calling while running returns `busy`.

| Command             | Parameters                                                                                                | `data`                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_rewind_points` | —                                                                                                         | `{ points: { entryId, text, timestamp, hasCheckpoint }[] }`, oldest first; `hasCheckpoint: false` (in-memory sessions, checkpoints off, beyond the retention count) allows conversation only      |
| `rewind`            | `entryId`, `mode: both \| conversation \| code`, `dryRun?: boolean`, `onConflict?: "skip" \| "overwrite"` | `RewindResult`: `conversation?: { leafId, draft: { text, images? } }`, `code?: CodeRestoreResult`, `gitHint?: { recordedHead, currentHead }`; `dryRun` only returns a preview and changes nothing |
| `summarize_from`    | `entryId`, `instructions?: string`                                                                        | `{ leafId, draft, summary? }`: returns to before the message, writes a `branch_summary` for the abandoned branch and puts the original message back                                               |
| `summarize_up_to`   | `entryId`, `instructions?: string`                                                                        | `CompactionResult`: compacts the context before that message (`firstKeptEntryId` = the message) and stays at the end                                                                              |

`CodeRestoreResult`: `restored` / `deleted` / `conflicts` (left untouched with `skip`, overwritten with `overwrite`) / `skipped: { path, reason }[]` (`symlink` / `hardlink` / `not_regular` / `parent_moved` / `too_large` / `backup_missing`) / `failed: { path, message }[]` / `insertions` / `deletions`; paths inside cwd are relative (`/`-separated). Error codes: restoring code without a checkpoint → `no_checkpoint`; everything failed and nothing was restored → `rewind_failed` (the conversation is left alone); the entry is not a rewind point on the active path → `invalid_arguments`. For conversation-only or code-only rewinds, a `custom_message{customType: "ama.rewind-note"}` is appended to the end of the context before the next prompt, telling the model which files disagree with the conversation.

After a session switch the server re-subscribes to events and sends `session_start` for the new session (`reason` `new` / `resume` / `fork`). `new_session` does not use the `parentSession` parameter yet. Entry shapes are in [session-format.md](../../reference/session-format.md) (Chinese).

### Approvals

| Command                   | Parameters                                                                            | `data`                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `set_client_capabilities` | `capabilities: ("approvals" \| "images" \| "hooks" \| "plans" \| "compact_events")[]` | `{ capabilities }`                                                                                               |
| `permission_response`     | `requestId: string`, `decision: "allow" \| "deny" \| "allow_session"`                 | `{ accepted: boolean }` (false = not currently waiting for this id; kept and applied when that request is asked) |

`compact_events` (docs/history/memory-plan.md D9, Chinese): once declared, `turn_end.toolResults`, `message_start` and `entry_appended` no longer repeat the body of tool results and of user messages with images (marked `contentOmitted: true`); the body is sent only in `message_end` and `tool_execution_end`. Without it the event shapes are byte-for-byte unchanged. Shapes are in [Compact events](#compact-events-compact_events). `stream-json` has no such switch and always emits the full shapes.

### Tools, permissions, discovery

| Command               | Parameters                                                             | `data`                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `get_tools`           | —                                                                      | `{ tools: { name, description, parameters, permission, active }[] }` (every tool in the registry; `active` means the model sees it now) |
| `set_active_tools`    | `names: string[]`                                                      | `{ names }` (active tool names after the change)                                                                                        |
| `set_permission_mode` | `mode: plan \| allowlist \| default \| auto-edit \| auto \| full-auto` | `{ mode }` (unknown mode → `invalid_arguments`)                                                                                         |
| `get_commands`        | —                                                                      | `{ commands: { name, description?, source: "builtin" \| "template" \| "skill" }[] }`; Skill names are written `skill:<name>`            |
| `get_skills`          | —                                                                      | `{ skills: { name, description, location, … }[] }` (discovered Skills; `location` is the SKILL.md path)                                 |

### Plans and tasks (wave 5)

| Command         | Parameters                                                                                                                                               | `data`                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `plan_response` | `planId`, `decision: approve \| approve_fresh \| revise \| reject`, `mode?` (execution mode after approval), `feedback?` (for revise), `editedMarkdown?` | `{ planId, decision }`; a `planId` that is not awaiting approval → `plan_not_found`. See "Plan approval"        |
| `get_plan`      | `planId?`                                                                                                                                                | `PlanData \| null`: `{ id, version, status, markdown, steps, sourceEntryId, filePath? }`; the latest by default |
| `get_todos`     | —                                                                                                                                                        | `{ items: { id, text, status: pending \| in_progress \| done, planStep? }[] }`                                  |
| `get_tasks`     | —                                                                                                                                                        | `{ tasks: TaskInfo[] }` (a read-only view of the sub-agent task registry; empty when not wired)                 |
| `get_agents`    | —                                                                                                                                                        | `{ agents: AgentInfo[] }` (available sub-agent types and external agents; empty when not wired)                 |

### Traces (wave 6)

`get_trace` returns the session trace (the same tree as the TUI `/trace` and `ama sessions trace`, see [tui.md](../guides/tui.md)
"Traces"). There is no new event: after `entry_appended`, fetch again with the previous `cursor.since` to refresh incrementally.

| Parameter    | Meaning                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branch?`    | `leaf` (default, root to the current leaf) \| `all` (every entry in the file)                                                                                                             |
| `turnLimit?` | Number of turns, tail first; default 50, range 1–500                                                                                                                                      |
| `before?`    | A turn id (= the entry id of the turn's user message); returns the `turnLimit` turns before it (paging backwards)                                                                         |
| `since?`     | An entry id (as in `get_entries.since`): returns every turn from the one containing that entry to the end (no `turnLimit`); excludes `before`                                             |
| `taskId?`    | That task's sub-trace: an ama subagent returns its child session's trace (cursor and `leafId` refer to the child); an external agent returns no turns and its skeleton in `task.external` |
| `content?`   | `none` (default: structure, times and tokens only) \| `preview` (adds `previews`)                                                                                                         |

`data`: `{ trace, hasMoreBefore, cursor: { before?, since }, leafId, task?, previews? }`

- `trace` is a `Trace` (a type exported by `@armadra/agent`): `turns` is the requested window, while `totals` and `aux`
  (auxiliary requests such as cache warm-up and the permission classifier) always cover the whole branch.
- `cursor.before` is the id of the window's first turn (present only when there are earlier turns) for the next `before`;
  `cursor.since` is the id of the last entry on the branch for the next `since`.
- **Merging increments**: replace the tail of the local list starting at the first returned turn id; if the local list does
  not have that id (rewind switched branches), replace everything; an empty list means the branch has no turns. The turn that
  contains `since` is always sent again (it may still be running); when a late entry from a background task changes an earlier
  turn, the response starts from that turn. If `since` is not on the selected branch, every turn is returned from the first.
- `task`: with `taskId`, the subagent node itself (without `child`).
- `previews`: `<kind>:<node id>` → `{ input?, output?, args?, result? }` (the turn's prompt, the request's reply text, the
  tool's arguments JSON and result) for this session's nodes inside the window; redacted first (as `sessions export`) and then
  truncated — arguments to 500 characters, the rest to 2000 — with `…` at the cut.
- The whole `data` is redacted; nodes carry only ids, times, counts and usage, and content appears only in `previews`. Tools
  still running without a result are marked `running`.
- Errors: `invalid_arguments` (out-of-range parameters, `before` not a turn id on this branch, `before` together with
  `since`) and `task_not_found`.

### Background sub-agents (wave 7)

| Command           | Parameters | `data`                                                                                                                                                                                                                   |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `background_task` | `taskId?`  | `{ backgrounded: string[] }`: the task ids actually moved. Without `taskId`, every running foreground task; an empty list for finished, already-background or unknown tasks; a non-string `taskId` → `invalid_arguments` |

A moved foreground task is not interrupted: its `task` call returns at once with `tool_execution_end` (the result text starts with
`[task tN] Moved to the background`, `details.status: "running"`), followed by `subagent_background`; when the task ends you get
`subagent_end` as usual and, once the parent session is idle, the notification message with `origin: "task"`. Same semantics as
`Ctrl+B` in the interactive UI.

44 commands in total; their names are the keys of `RpcCommandMap`.

## Events

Events are the in-process `SessionEvent` (`src/agent/types.ts`); only `message_update` is replaced by pure deltas on the wire. Grouped by where they appear:

| Event                                                | Fields                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session_start`                                      | `sessionId`, `sessionFile?`, `cwd`, `reason: startup \| resume \| new \| fork`                                                                                                                                                                                                       |
| `session_changed`                                    | `sessionId`, `sessionFile?`                                                                                                                                                                                                                                                          |
| `session_rewound`                                    | `entryId`, `mode`, `restored`, `deleted`, `conflicts`, `skipped` (rewind finished; not sent for `dryRun`; file lists are empty for conversation only)                                                                                                                                |
| `before_agent_start`                                 | `prompt` (after the UserPromptSubmit hook and template expansion)                                                                                                                                                                                                                    |
| `agent_start` / `turn_start` / `agent_before_settle` | —                                                                                                                                                                                                                                                                                    |
| `turn_end`                                           | `message` (assistant message), `toolResults`                                                                                                                                                                                                                                         |
| `agent_end`                                          | `stopReason`, `willRetry`                                                                                                                                                                                                                                                            |
| `agent_settled`                                      | `warning?` (the run has fully ended, retries and followUps included)                                                                                                                                                                                                                 |
| `message_start` / `message_end`                      | `message` (`AgentMessage`)                                                                                                                                                                                                                                                           |
| `message_update`                                     | `assistantMessageEvent`, `usage?` (see below)                                                                                                                                                                                                                                        |
| `tool_execution_start`                               | `toolCallId`, `toolName`, `args`, `parentToolCallId?`                                                                                                                                                                                                                                |
| `tool_execution_update`                              | `toolCallId`, `toolName`, `partial` (output text while running), `parentToolCallId?`                                                                                                                                                                                                 |
| `tool_execution_end`                                 | `toolCallId`, `toolName`, `result`, `isError`, `parentToolCallId?`, `autoDecision?` (auto mode: `{ layer: rule \| static \| classifier, decision, reason, cached? }`), `denied?` (`true`: not executed because permissions / a hook / approval denied it; the reason is in `result`) |
| `queue_update`                                       | `steering: string[]`, `followUp: string[]`                                                                                                                                                                                                                                           |
| `compaction_start`                                   | `trigger: threshold \| overflow \| manual`                                                                                                                                                                                                                                           |
| `compaction_end`                                     | `trigger`, `result?`, `aborted`, `willRetry`, `error?`                                                                                                                                                                                                                               |
| `auto_retry_start`                                   | `attempt`, `maxAttempts`, `delayMs`, `errorMessage`                                                                                                                                                                                                                                  |
| `auto_retry_end`                                     | `success`, `attempt`, `finalError?`                                                                                                                                                                                                                                                  |
| `permission_request`                                 | `requestId`, `toolName`, `input`, `reason: mode \| dangerous \| hook`, `hookReason?`, `timeoutMs`, `preview?`, `autoDecision?` (why auto mode asks), `context?` (origin, see "Sub-agent events")                                                                                     |
| `permission_resolved`                                | `requestId`, `decision`                                                                                                                                                                                                                                                              |
| `permission_mode_changed`                            | `mode`                                                                                                                                                                                                                                                                               |
| `model_changed`                                      | `model: { provider, id, channel? }`                                                                                                                                                                                                                                                  |
| `thinking_level_changed`                             | `level`                                                                                                                                                                                                                                                                              |
| `entry_appended`                                     | `entry` (the session entry just written)                                                                                                                                                                                                                                             |
| `hook_executed`                                      | `event`, `command`, `exitCode` (null on timeout or when killed by a signal), `durationMs`                                                                                                                                                                                            |
| `cache_miss`                                         | `missedTokens`, `missedCost?`, `reason`, `detail?`, `idleMs`                                                                                                                                                                                                                         |
| `cache_warm`                                         | `phase: scheduled \| sent \| stopped`, `nextWarmAt?`, `usage?`, `cost?`, `reason?`                                                                                                                                                                                                   |
| `context_pressure`                                   | `percent`, `threshold: 70 \| 90`, `remainingTokens?`, `estimatedTurnsLeft?`                                                                                                                                                                                                          |

There is also the non-session event `{"type":"notification","level":"info"|"warn"|"error","message":…}`: the host's `ui.notify` and run failures after the response.

`parentToolCallId` appears only on inner calls made through `tools.*` inside codemode scripts; its value is the id of the outer `codemode` call, which clients use to fold the display. Inner calls do not enter the transcript.

Assistant messages in `message_end`, `turn_end`, `done` / `error` and in replays (`get_messages`, `get_entries`) may carry two optional fields (model efficiency batch, docs/history/model-efficiency-plan.md §1.10, Chinese): `retryAfterMs` on failed messages (`Retry-After`, in ms) and `rawArguments` on tool-call blocks (the raw argument string the model produced). `subagent_*` events are unchanged; `TaskInfo` from `get_tasks` may carry `context?: "fork" | "fresh"` (the sub-session's actual context mode). All are new optional fields, `RPC_PROTOCOL_VERSION` is unchanged, and clients can ignore fields they do not know.

### Compact events (`compact_events`)

In the full shapes, the result of one tool call appears once each in `message_start`, `message_end`, `tool_execution_end`, `turn_end` and `entry_appended`. After the client declares `compact_events` with `set_client_capabilities`, three of these change:

| Event            | Full (not declared)                         | With `compact_events` declared                                                                                                                    |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn_end`       | `toolResults`: complete toolResult messages | each `toolResults[]` item is only `{ toolCallId, toolName, isError, timestamp, contentOmitted: true }` (no `content`, no `details`)               |
| `message_start`  | `message` as is                             | when `message` is a toolResult or a user message with images: `content: ""`, `contentOmitted: true`, other fields unchanged; other messages as is |
| `entry_appended` | `entry` as is                               | `message` entries as above (toolResult, user with images); other entries as is                                                                    |

`message_end` and `tool_execution_end` are always full: the former is what clients use to replace the whole message, the latter carries `details`. Replay commands (`get_messages`, `get_entries`) are unaffected. The declaration keeps applying after a session switch; declaring a capability list without `compact_events` restores the full shapes. `RPC_PROTOCOL_VERSION` is unchanged.

### Sub-agent events (wave 5)

Sub-agents started by `task` / `task_ctl` (ama sub-sessions and external agents share the same events, see [agents.md](../../guides/agents.md), Chinese):

| Event                 | Fields                                                                                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent_start`      | `taskId`, `parentToolCallId`, `agent`, `runner` (`ama` / `claude` / `codex` / `acp:<program>`), `description`, `background`, `model?`, `sessionFile?`, `cwd`; sent again when the same `taskId` is continued                |
| `subagent_update`     | `taskId`, `kind: tool \| text \| turn`, `toolName?`, `textDelta?` (merged over ≥ 250 ms), `turn`, `usage?`                                                                                                                  |
| `subagent_background` | `taskId`, `parentToolCallId`, `reason: user \| timeout \| host` (a foreground task moved to the background: by hand in the interactive UI, when `subagents.autoBackgroundAfterMs` elapses, or by an RPC / SDK call; wave 7) |
| `subagent_end`        | `taskId`, `status: completed \| failed \| aborted \| max_turns \| interrupted`, `usage?`, `cache?`, `outputFile?`, `worktree?: { branch, changed }`                                                                         |

Approvals of sub-sessions and external agents are sent to this connection as `permission_request` as usual, with an optional `context` marking the origin (since wave 6, approvals of this session's own tool calls also carry `context.toolCallId`, the id of the tool call that triggered the approval, which traces use to compute approval wait time; external agent requests do not carry it): `depth` (1 = from a task sub-agent), `taskId` (the originating task), `origin` (permission requests from external agents: `agent`, `sessionId` (the external CLI's own session id), `toolCall: { title, kind, locations?, inputSummary? }`, `options`). Dialogs use it to show `[task:<agent>]` or `[claude · session abc1]`. For external agent requests `toolName` is `agent:<id>` and the answer applies to this one request only ("allow for this session" is remembered by the external agent itself); the first run of an external agent in a session additionally gets one confirmation with `toolName: "task"`, `input: { agent, mode, note }` (`context.taskId`). `test/fixtures/rpc/external.out.jsonl` is the golden record of the three approvals of `task(agent="acp:ama")` (the task tool, the first run, the child ama's bash), updated by `src/agents/external-rpc.test.ts` with `UPDATE_GOLDEN=1`. After a background task completes, the parent session receives a user message with `origin: "task"` (`<task-notification …>…</task-notification>`) and starts a new turn as usual. Task and type lists are returned by `get_tasks` / `get_agents` (shapes `TaskInfo` / `AgentInfo`; empty without the task tool), with data from the current session's `taskRegistryView(sessionId)` / `sessionAgents(sessionId)` (`src/agent/subagent-registry.ts`). `get_agents` also includes external agents (`installed` / `version` come from PATH and a `--version` probe, cached asynchronously when the session is created and refreshed when external tasks end or host injections change; before the cache is ready there is only the type catalog, see `cachedAgentInfos` in `src/agents/external.ts`). `test/fixtures/rpc/subagent.out.jsonl` is the golden record of a foreground `task(agent="explore")` plus `get_tasks` / `get_agents` (keeping only responses, `tool_execution_*`, `subagent_*` and `agent_settled`), updated by `src/agent/subagent-rpc.test.ts` with `UPDATE_GOLDEN=1`. `test/fixtures/rpc/background.out.jsonl` is the golden record of `background_task` moving a running foreground `task` to the background, the task ending and its notification turn, updated by `src/modes/rpc/rpc-background.test.ts`.

### Throughput telemetry (wave 5)

The main session has a telemetry extension (`src/agent/session-telemetry.ts`) that only counts chat requests (`purpose: "turn"`; compaction summaries, warming, probes and the classifier are not counted):

- Event `{"type":"telemetry_tick"}`: about every 500 ms after the first token while streaming (≤ 2 Hz, driven by deltas; not sent for short replies that finish instantly), and not sent with `ui.animation: false`; it has no payload, the data comes from `get_session_stats`'s `telemetry`.
- `SessionStats.telemetry`: `{ sessionStartedAt, last?, live?, avgTps? }`. `last` is the latest request (`requestAt`, `firstTokenAt?`, `ttftMs?`, `doneAt?`, `outputTokens?`, `tps?`; a request in progress becomes `last` once its first token arrives, and `doneAt` etc. are filled in when it ends); `live` exists only while streaming (`tps` estimated over the last 2 s window, `outputTokens` estimated from delta characters, `elapsedMs` since the first token); `avgTps` = Σoutput / Σ(end − first token), excluding requests that generated for less than 250 ms (their `tps` stays empty too). All times are millisecond timestamps.

### Budget, fallback and background command events (wave 5 W5-H2)

| Event            | Fields                                                                                                                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit_reached`  | `kind: turns \| cost`, `value` (turns / USD of this run), `limit`; once per kind per run when `limits.*` (config; `-p` also has `--max-turns` / `--max-cost`) is reached, followed by `agent_settled{warning:"limit_reached"}`                           |
| `model_fallback` | `from`, `to` (`{ provider, id, channel? }`), `reason` (the triggering error text); when a retryable error is overloaded or retries are exhausted, switches to `fallbackModel` for one retry and switches back after the reply (plus two `model_changed`) |
| `background_job` | `jobId`, `phase: started \| exited \| stopped`, `command`, `pid?`, `outputPath?`, `exitCode?`; background commands started by `bash{background:true}`                                                                                                    |

When repeated-call detection (the 5th call with the same name and arguments in one run) ends a run, it ends with `agent_settled{warning:"repeated_tool_call"}`.

### `message_update` and rebuilding messages

On the wire `message_update` drops the accumulated message and `partial`, keeping only deltas:

```json
{
  "type": "message_update",
  "assistantMessageEvent": { "type": "text_delta", "contentIndex": 0, "delta": "hello" },
  "usage": { "input": 12, "output": 3, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 15 }
}
```

Values of `assistantMessageEvent.type`: `start`, `text_start` / `text_delta` / `text_end`, `thinking_start` / `thinking_delta` / `thinking_end`, `toolcall_start` (with `id`, `name`) / `toolcall_delta` (argument JSON fragments) / `toolcall_end` (with the complete `toolCall`), `done` (`reason: stop | length | toolUse`, with the final `message`), `error` (`reason: aborted | error`, with the final `message`). Rebuilding on the client:

1. `message_start` gives the initial assistant message (`content: []`);
2. keep content blocks by `contentIndex`: `*_start` creates a block, `*_delta` appends text (tool arguments are concatenated as a string first), `toolcall_end` replaces the block with the complete `toolCall`;
3. `usage` is the latest usage at that moment and simply overwrites;
4. replace the whole message with `message_end` (or the `message` of `done` / `error`); the rebuilt result is only for streaming display.

### Session stats

The `data` of `get_session_stats` is `SessionStats`:

| Field                                                              | Description                                                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `sessionId` / `sessionFile`                                        | Session identity                                                                                    |
| `userMessages` / `assistantMessages` / `toolCalls` / `toolResults` | Counts                                                                                              |
| `tokens`                                                           | `{ input, output, cacheRead, cacheWrite, total }`, including warming requests                       |
| `cost`                                                             | USD; absent when any message lacks a cost (the interface shows `$?`)                                |
| `contextTokens` / `contextWindow` / `contextPercent`               | Current context estimate, window and usage (0–100); absent when the model has no window             |
| `context`                                                          | Estimate source and auto-compaction thresholds (fields: sessions.md)                                |
| `cacheHitRate`                                                     | The legacy hit rate: cacheRead / (input + cacheRead + cacheWrite), every request in the denominator |
| `cache`                                                            | `SessionCacheStats` (example below), present only when the session-layer cache controller is wired  |

```json
{
  "type": "response",
  "command": "get_session_stats",
  "success": true,
  "data": {
    "tokens": { "input": 1177, "output": 64, "cacheRead": 2176, "cacheWrite": 0, "total": 3417 },
    "cacheHitRate": 0.65,
    "cache": {
      "reporting": "reported",
      "lastHitRate": 0.84,
      "hitRate": 0.65,
      "reBilledTokens": 0,
      "reBilledUsd": 0,
      "misses": { "count": 0, "byReason": {} },
      "warming": { "mode": "streaming", "state": "stopped", "reason": "no_ttl" },
      "contextRemainingTokens": 127077,
      "estimatedTurnsLeft": 2443
    }
  }
}
```

| `cache` field                                   | Description                                                                                                                                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reporting`                                     | The three states of the current endpoint (provider, baseUrl host, model): `unknown` / `reported` / `silent`; in memory only, reused across sessions in the same process                                                                      |
| `lastHitRate` / `hitRate`                       | Latest / cumulative session hit rate (0–1); no `lastHitRate` for `unknown` / `silent`, and requests not reporting cache usage stay out of the `hitRate` denominator                                                                          |
| `reBilledTokens` / `reBilledUsd`                | Total re-billing from misses; no `reBilledUsd` when unpriced models are involved                                                                                                                                                             |
| `misses`                                        | `count` and `byReason` (`prefix_changed` / `model_changed` / `idle` / `subtask` / `evicted`); every miss counts, regardless of the interface notice threshold                                                                                |
| `warming`                                       | `mode` (`off` / `streaming` / `idle`), `state` (`inactive` / `scheduled` / `stopped`), `phase?`, `nextWarmAt?`, stop reason `reason?`, `sent?`, `costUsd?`, `expectedSavingsUsd?`                                                            |
| `contextRemainingTokens` / `estimatedTurnsLeft` | Remaining context and the turns left estimated from the growth of the last 5 turns                                                                                                                                                           |
| `subagents`                                     | Summary of task sub-sessions: `count`, `hitRate?`, `reBilledTokens`                                                                                                                                                                          |
| `granularity`                                   | Optional: the inferred cache-read chunk granularity of the current endpoint (tokens; the GCD of non-zero cacheRead values, given only with ≥ 2 samples and within 128–8192); the miss noise floor is the largest of it, 1024 and `minTokens` |

`tokens` / `cacheHitRate` keep the legacy definitions; new clients use `cache`. Cache event examples:

```json
{"type":"cache_miss","missedTokens":142000,"missedCost":0.1278,"reason":"evicted","idleMs":3}
{"type":"cache_warm","phase":"scheduled","nextWarmAt":1790000000000}
{"type":"cache_warm","phase":"sent","usage":{"input":1,"output":1,"cacheRead":12000,"cacheWrite":0,"totalTokens":12002},"cost":0.0012}
{"type":"cache_warm","phase":"stopped","reason":"no_cache_hits"}
{"type":"context_pressure","percent":71,"threshold":70,"remainingTokens":57990,"estimatedTurnsLeft":6}
```

`cache_miss` gives `detail` only for `prefix_changed` (`tools`, `system`, or `system:<section,…>` naming the changed sections, such as `system:hooks,memory`). The values and meanings of `reason` for `cache_warm{stopped}` are in [tui.md](../guides/tui.md) "Cache and context". The result object of `ama -p --output-format json` also has a `cache` field of the same shape.

It also carries `context: { tokens, window, percent }` (context used, window size and usage 0–100, defined like `contextTokens` / `contextWindow` / `contextPercent` in the table above); an unknown item is omitted (for a model without a window only `tokens` is present), and when all are unknown there is no `context`.

## Approvals

1. When a tool call needs confirmation, the server sends `permission_request`. `preview` (optional) is the pre-execution preview: `{ kind: "bash" | "write" | "edit" | "other", lines: string[], severity: "info" | "warn" | "danger", affected?: { path, exists, bytes?, files? }[] }`; `lines` are already laid out without colors and can be shown as is. The preview is read-only and bounded, and absent when it cannot be computed.
2. The client is asked only if it sent `set_client_capabilities{capabilities:["approvals"]}` earlier; otherwise nobody answers the ask → deny. Removing `approvals` from the declaration withdraws the client and makes all pending approvals resolve as unanswered.
3. The client replies with `permission_response{requestId, decision}`. `allow_session` remembers the same tool and normalized input prefix within this session, without writing to disk. Answers arriving before their request are kept and used once the request appears.
4. Order of answerers: host broker (`HostApi.approvals.setBroker`) → RPC client → deny when nobody answers. Approvals are serial: only one waits at a time.
5. Timeout: without an answer within `timeoutMs` (default 600 000, i.e. 10 minutes; the `AMA_APPROVAL_TIMEOUT_MS` environment variable changes it), the server treats it as deny and sends `permission_resolved`. When the run is interrupted it is also deny, even if the client already allowed.

## Plan approval

Plan mode and the plan format are described in [plan.md](../../guides/plan.md) (Chinese).

1. When a turn ends in plan mode with plain text and the reply contains a `<proposed_plan>` block, the server saves the plan and sends `plan_proposed{ planId, version, markdown, steps, filePath? }` (`steps[]`: `{ id, text, dependsOn?, agent? }`), followed by `agent_settled` as usual.
2. The client answers only if it declared `set_client_capabilities{capabilities:["plans"]}`; otherwise the config `plan.unattended` applies: `stop` by default (the plan stays proposed, no mode switch, no execution; the client can still answer later with `plan_response`), and `approve` approves and executes within the same run.
3. `plan_response`:
   - `approve`: the plan is marked approved, its steps become todos (the first one in_progress, `todo_updated` sent), `plan_resolved{ planId, decision, mode }` is sent, and the permission mode switches to `mode` (default: the mode before entering plan; `default` when that was plan already). Then a new turn starts automatically: the user message `The plan is approved. Go ahead.` (`origin: "plan"`) + `custom_message{ama.plan_approved}` (the full plan, the file path, and the progress convention: with the todo tool, progress goes through todo; without it the model writes a `[DONE:<step>]` line per finished step, which ama uses to advance the todos and send `todo_updated`).
   - `approve_fresh`: marked approved and the mode switched as above, then a new session is created (`session_start{reason:"new"}` sent), the todos are written in the new session, and a turn starts with the full plan as the first user message.
   - `revise`: stays in plan; a non-empty `feedback` starts a turn as an ordinary user message, and the model rewrites the plan into a new version (the old one is marked superseded).
   - `reject`: the plan is marked rejected and the session stays in plan.
   - `editedMarkdown`: the full text as edited by the client; if it differs from the original, a new version is saved first (`plan_proposed` sent again) and then `decision` is applied.
4. `todo_updated{ items }`: sent on every change of the todo list (set / update of the `todo` tool, generation on approval), shaped like `get_todos`.

`test/fixtures/rpc/plan.out.jsonl` is the golden file of a complete approval round trip (without `entry_appended` and `message_update`): declare `plans` → `set_permission_mode plan` → prompt → the `ama.plan_mode` note → a reply with a plan block → `plan_proposed` → `agent_settled` → `get_plan` → `plan_response approve` → `todo_updated`, `plan_resolved`, `permission_mode_changed` → the execution turn (`ama.plan_approved`) → `get_todos`. It is updated by `src/modes/rpc/rpc-plan.test.ts` with `UPDATE_GOLDEN=1`.

## Exit

- stdin closed: no more commands are accepted and approvals are withdrawn (later asks resolve as unanswered → deny); in-flight commands and started runs finish and their responses are written, then the exit code is 0. So `printf '{"type":"prompt","message":"hi"}\n' | ama --mode rpc` gets a complete reply; to stop early, send `abort` first.
- SIGINT / SIGTERM: the current run is interrupted and the process exits in order, with exit code 130 / 143.
- Startup failures use the CLI exit codes ([design.md](../../design/design.md) §11.3, Chinese): config error 3, no model or key 4, session error 5, host / hook startup failure 6, host API version mismatch 78.

## Examples

`test/fixtures/rpc/prompt.out.jsonl` is the golden file of a complete round trip (fake provider; `prompt` → `get_last_assistant_text`, with session ids, timestamps and paths normalized): `hello` → `session_start` → `entry_appended` (model, thinking level, the first system message) → `before_agent_start` → `agent_start` → `turn_start` → the `prompt` response → the user message → `message_update` deltas of the assistant message → `turn_end` → `agent_end` → `agent_before_settle` → `agent_settled` → the response to the second command. After protocol changes, update it with `UPDATE_GOLDEN=1` via `src/modes/rpc/rpc-mode.test.ts` and review the diff. `test/fixtures/rpc/rewind.out.jsonl` records rewind round trips (without `entry_appended`; the second turn created `c.txt` with write): `get_rewind_points` → `rewind{mode:"both", dryRun:true}` returns only a preview → `rewind{mode:"both"}` sends `session_rewound` first, then returns `RewindResult` (`c.txt` deleted, the conversation back to before the second message) → `summarize_up_to` on a non-rewind point returns `invalid_arguments` → `get_rewind_points` after the rewind.

A minimal session (closing stdin withdraws approvals, so piping only suits prompts that need no approval; to answer approvals, keep stdin open and send `set_client_capabilities` first):

```sh
printf '%s\n' '{"id":"1","type":"prompt","message":"hi"}' | ama --mode rpc --model anthropic/<model-id>
```
